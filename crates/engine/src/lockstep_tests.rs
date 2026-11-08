//! Lockstep equivalence for the incremental passes (round 18): two engines run the same seeded
//! random command stream on the same file, one forced to the whole-document passes
//! (`Engine::reference`), and after every step the documents, the fingerprints, the canvas output
//! and the collaboration deltas must be identical. The stream covers variable and mode edits,
//! re-parenting, groups, copy and paste, components and instances, undo and redo, gestures,
//! remote deltas and create_nodes with bindings by name.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::text::HeuristicMeasurer;
use crate::variables::{self, Collection, VarKind, VarMode, Variable};

struct Lcg(u64);

impl Lcg {
  fn next(&mut self) -> u64 {
    self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    self.0 >> 33
  }

  fn below(&mut self, n: usize) -> usize {
    (self.next() % n.max(1) as u64) as usize
  }

  fn chance(&mut self, percent: usize) -> bool {
    self.below(100) < percent
  }

  fn hex(&mut self) -> String {
    format!("#{:06X}", self.next() % 0x1000000)
  }
}

fn ai(e: &mut Engine, tool: &str, input: Value) -> Value {
  e.dispatch(Command::Ai { tool: tool.into(), input }).unwrap()
}

const SCREENS: usize = 24;

/// A file of about 1,300 layers: screens of rows, cards (a component), tab bars (another one) and
/// panels (a component holding an instance of the first), two variable collections with an alias,
/// and bindings of fills, radii, gaps, opacities and labels; some screens pinned to Dark / Brand B.
fn build() -> Engine {
  let mut e = Engine::new(Box::new(HeuristicMeasurer), 7);
  let card = ai(
    &mut e,
    "create_nodes",
    json!({"nodes":[{"type":"frame","name":"Card","x":-1000,"y":0,"width":300,"layout":{"direction":"vertical","gap":8,"padding":12},"cornerRadius":12,"fill":"#FFFFFF","children":[
      {"type":"rectangle","name":"Cover","width":"fill","height":90,"cornerRadius":8,"fill":"#ddd"},
      {"type":"text","name":"Title","text":"Card title","fontSize":17,"fontWeight":600,"fill":"#111827"},
      {"type":"text","name":"Body","text":"Secondary copy that explains the card","fontSize":13,"fill":"#6B7280","width":"fill"}]}]}),
  );
  let card_id = card["created"][0]["id"].as_str().unwrap().to_string();
  let cm = ai(&mut e, "arrange", json!({"action":"create_component","ids":[card_id]}));
  let card_main = cm["id"].as_str().map(String::from).unwrap_or(card_id);
  let nav = ai(
    &mut e,
    "create_nodes",
    json!({"nodes":[{"type":"frame","name":"NavItem","x":-1000,"y":500,"width":78,"height":56,"layout":{"direction":"vertical","gap":4,"padding":4},"children":[
      {"type":"rectangle","name":"Icon","width":24,"height":24,"fill":"#9CA3AF","cornerRadius":6},{"type":"text","name":"Label","text":"Home","fontSize":11,"fill":"#6B7280"}]}]}),
  );
  let nav_id = nav["created"][0]["id"].as_str().unwrap().to_string();
  let nm = ai(&mut e, "arrange", json!({"action":"create_component","ids":[nav_id]}));
  let nav_main = nm["id"].as_str().map(String::from).unwrap_or(nav_id);
  let panel = ai(
    &mut e,
    "create_nodes",
    json!({"nodes":[{"type":"frame","name":"Panel","x":-1000,"y":900,"width":340,"layout":{"direction":"vertical","gap":6,"padding":6},"children":[
      {"type":"text","name":"Heading","text":"Panel","fontSize":15,"fill":"#222222"},
      {"type":"instance","name":"Inner card","componentId":card_main,"width":300}]}]}),
  );
  let panel_id = panel["created"][0]["id"].as_str().unwrap().to_string();
  let pm = ai(&mut e, "arrange", json!({"action":"create_component","ids":[panel_id]}));
  let panel_main = pm["id"].as_str().map(String::from).unwrap_or(panel_id);
  let screen = |i: usize| {
    let rows: Vec<Value> = (0..5)
      .map(|k| {
        json!({"type":"frame","name":format!("Row {k}"),"width":"fill","layout":{"direction":"horizontal","gap":12,"crossAxis":"center"},"children":[
          {"type":"rectangle","name":"Avatar","width":40,"height":40,"cornerRadius":20,"fill":"#ccc"},
          {"type":"frame","name":"Text","width":"fill","layout":{"direction":"vertical","gap":2},"children":[
            {"type":"text","name":"Name","text":format!("Project {i}-{k}"),"fontSize":16,"fontWeight":600,"fill":"#111827"},
            {"type":"text","name":"Meta","text":"Updated 2h ago","fontSize":13,"fill":"#6B7280"}]},
          {"type":"rectangle","name":"Chevron","width":8,"height":14,"fill":"#9CA3AF"}]})
      })
      .collect();
    let mut ch = vec![
      json!({"type":"frame","name":"Header","width":"fill","layout":{"direction":"horizontal","gap":8},"children":[{"type":"text","name":"Greeting","text":format!("Good morning {i}"),"fontSize":24,"fontWeight":700,"width":"fill","fill":"#111827"},{"type":"rectangle","name":"Bell","width":24,"height":24,"fill":"#E5E7EB","cornerRadius":12}]}),
    ];
    ch.extend(rows);
    ch.push(json!({"type":"instance","name":"Card","componentId":card_main,"width":300}));
    ch.push(json!({"type":"instance","name":"Panel","componentId":panel_main,"width":340}));
    ch.push(json!({"type":"frame","name":"Tab bar","width":"fill","height":64,"fill":"#FFFFFF","layout":{"direction":"horizontal","padding":4},"children":(0..3).map(|k| json!({"type":"instance","name":format!("Tab {k}"),"componentId":nav_main})).collect::<Vec<_>>()}));
    json!({"type":"frame","name":format!("Screen {i}"),"x":(i%4)*440,"y":(i/4)*900,"width":390,"height":844,"fill":"#FFFFFF","layout":{"direction":"vertical","gap":12,"padding":16},"children":ch})
  };
  for s in (0..SCREENS).step_by(4) {
    let specs: Vec<Value> = (s..(s + 4).min(SCREENS)).map(screen).collect();
    ai(&mut e, "create_nodes", json!({ "nodes": specs }));
  }
  let value = |light: Value, dark: Value, l: &str, d: &str| -> BTreeMap<String, Value> {
    [(l.to_string(), light), (d.to_string(), dark)].into_iter().collect()
  };
  let var = |id: &str, name: &str, kind: VarKind, values: BTreeMap<String, Value>| {
    Arc::new(Variable {
      id: id.into(),
      name: name.into(),
      kind,
      values,
      ..Default::default()
    })
  };
  let mode = |id: &str, name: &str| VarMode {
    id: id.into(),
    name: name.into(),
  };
  e.dispatch(Command::SetVariables {
    collections: vec![
      Collection {
        id: "c_theme".into(),
        name: "Theme".into(),
        modes: vec![mode("m_light", "Light"), mode("m_dark", "Dark")],
        variables: vec![
          var(
            "v_surface",
            "Surface",
            VarKind::Color,
            value(json!("#FFFFFF"), json!("#0B0F19"), "m_light", "m_dark"),
          ),
          var(
            "v_text",
            "Text",
            VarKind::Color,
            value(json!("#111827"), json!("#F9FAFB"), "m_light", "m_dark"),
          ),
          var(
            "v_muted",
            "Muted",
            VarKind::Color,
            value(json!("#6B7280"), json!("#9CA3AF"), "m_light", "m_dark"),
          ),
          var(
            "v_primary",
            "Primary",
            VarKind::Color,
            value(json!({"alias": "v_accent"}), json!("#60A5FA"), "m_light", "m_dark"),
          ),
        ],
      },
      Collection {
        id: "c_brand".into(),
        name: "Brand".into(),
        modes: vec![mode("b_a", "A"), mode("b_b", "B")],
        variables: vec![
          var(
            "v_accent",
            "Accent",
            VarKind::Color,
            value(json!("#2563EB"), json!("#DB2777"), "b_a", "b_b"),
          ),
          var("v_radius", "Radius", VarKind::Number, value(json!(4), json!(14), "b_a", "b_b")),
          var("v_gap", "Gap", VarKind::Number, value(json!(8), json!(16), "b_a", "b_b")),
          var("v_fade", "Fade", VarKind::Number, value(json!(1), json!(0.6), "b_a", "b_b")),
          var(
            "v_label",
            "Label",
            VarKind::String,
            value(json!("Hello"), json!("Hello there"), "b_a", "b_b"),
          ),
        ],
      },
    ],
  })
  .unwrap();
  let nodes: Vec<Arc<Node>> = e.doc.nodes.values().cloned().collect();
  let ids = |f: &dyn Fn(&Node) -> bool| -> Vec<NodeId> { nodes.iter().filter(|n| f(n)).map(|n| n.id.clone()).collect() };
  let screens = ids(&|n| n.name.starts_with("Screen ") && n.parent.is_none());
  let texts = ids(&|n| n.text.is_some() && n.master_id.is_none() && n.name != "Label");
  let rects = ids(&|n| n.kind == NodeType::Rectangle && n.master_id.is_none() && n.name != "Icon");
  let frames = ids(&|n| n.name.starts_with("Row ") && n.master_id.is_none());
  let names = ids(&|n| n.name == "Meta" && n.master_id.is_none());
  let bind = |e: &mut Engine, ids: &[NodeId], prop: &str, var: &str| {
    e.dispatch(Command::BindVariable {
      ids: ids.to_vec(),
      property: prop.into(),
      variable: Some(var.into()),
    })
    .unwrap();
  };
  bind(&mut e, &screens, "fill", "v_surface");
  bind(&mut e, &texts, "fill", "v_text");
  bind(&mut e, &rects.iter().step_by(2).cloned().collect::<Vec<_>>(), "fill", "v_primary");
  bind(
    &mut e,
    &rects.iter().skip(1).step_by(3).cloned().collect::<Vec<_>>(),
    "cornerRadius",
    "v_radius",
  );
  // Glass: a background blur on every fifth rectangle, so the canvas copies what lies below it.
  e.dispatch(Command::Update {
    ids: rects.iter().step_by(5).cloned().collect(),
    patch: json!({ "effects": [{"type": "backgroundBlur", "color": "#00000040", "x": 0, "y": 0, "blur": 12, "spread": 0, "visible": true}] }),
  })
  .unwrap();
  bind(&mut e, &frames, "gap", "v_gap");
  bind(&mut e, &names, "opacity", "v_fade");
  bind(
    &mut e,
    &names.iter().step_by(4).cloned().collect::<Vec<_>>(),
    "characters",
    "v_label",
  );
  for (i, s) in screens.iter().enumerate() {
    if i % 3 == 1 {
      e.dispatch(Command::SetVariableMode {
        ids: vec![s.clone()],
        collection: "c_theme".into(),
        mode: Some("m_dark".into()),
      })
      .unwrap();
    }
    if i % 4 == 2 {
      e.dispatch(Command::SetVariableMode {
        ids: vec![s.clone()],
        collection: "c_brand".into(),
        mode: Some("b_b".into()),
      })
      .unwrap();
    }
  }
  e
}

/// A canvas as the client keeps it: each root's markup with its transform applied.
#[derive(Default)]
struct Canvas {
  roots: BTreeMap<NodeId, String>,
}

/// Generated def ids differ between renders of the same layers: number them by first appearance.
fn scrub(svg: &str) -> String {
  let mut seen: Vec<String> = Vec::new();
  let mut out = String::with_capacity(svg.len());
  let mut rest = svg;
  while let Some(at) = rest
    .find("id=\"")
    .map(|i| (i, 4))
    .into_iter()
    .chain(rest.find("url(#").map(|i| (i, 5)))
    .min()
  {
    let (i, skip) = at;
    out.push_str(&rest[..i + skip]);
    rest = &rest[i + skip..];
    let end = rest.find(['"', ')']).unwrap_or(rest.len());
    let id = &rest[..end];
    // data-id="…" holds layer ids, which are real and must match as they are.
    let is_data = out.ends_with("data-id=\"");
    if is_data {
      out.push_str(id);
    } else {
      let n = seen.iter().position(|s| s == id).unwrap_or_else(|| {
        seen.push(id.to_string());
        seen.len() - 1
      });
      out.push_str(&format!("#{n}"));
    }
    rest = &rest[end..];
  }
  out.push_str(rest);
  out
}

/// `svg` with the transform of the root's own element replaced (the client does the same).
fn with_transform(svg: &str, root: &str, t: &str) -> String {
  let Some(i) = svg.find(&format!("data-id=\"{root}\"")) else {
    return svg.to_string();
  };
  let end = i + svg[i..].find('>').unwrap_or(svg.len() - i);
  let tag = &svg[i..end];
  match tag.find("transform=\"") {
    Some(j) => {
      let from = i + j + "transform=\"".len();
      let to = from + svg[from..].find('"').unwrap();
      format!("{}{}{}", &svg[..from], t, &svg[to..])
    }
    None => format!("{} transform=\"{}\"{}", &svg[..i + tag.len()], t, &svg[end..]),
  }
  .replace(" transform=\"matrix(1 0 0 1 0 0)\"", "")
}

impl Canvas {
  fn absorb(&mut self, v: &Value) {
    if let Some(order) = v.get("order").and_then(|o| o.as_array()) {
      let keep: Vec<&str> = order.iter().filter_map(|o| o.as_str()).collect();
      self.roots.retain(|k, _| keep.contains(&k.as_str()));
    }
    if let Some(ch) = v.get("changed").and_then(|c| c.as_object()) {
      for (id, svg) in ch {
        self.roots.insert(id.clone(), scrub(svg.as_str().unwrap()));
      }
    }
    if let Some(mv) = v.get("moved").and_then(|c| c.as_object()) {
      for (id, t) in mv {
        if let Some(svg) = self.roots.get(id).cloned() {
          self.roots.insert(id.clone(), with_transform(&svg, id, t.as_str().unwrap()));
        }
      }
    }
  }
}

/// A canvas redrawn from nothing, for checking the cached ones against.
fn fresh_canvas(e: &mut Engine) -> Canvas {
  let page = e.page.clone();
  e.reset_render_cache();
  let mut c = Canvas::default();
  c.absorb(&e.render_incremental(&page, &[], None));
  c
}

fn wire(v: &Value) -> Value {
  serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

struct Run {
  seed: u64,
  a: Engine,
  b: Engine,
  peer: Engine,
  r: Lcg,
  canvas: [Canvas; 2],
  ordered: bool,
  steps: usize,
  log: Vec<String>,
  /// Per command: how often it ran, succeeded and changed the document.
  stats: BTreeMap<String, [usize; 3]>,
}

impl Run {
  fn new(seed: u64) -> Run {
    let (ordered, lists, loaded) = match seed % 5 {
      0 => (false, false, false),
      1 => (false, true, false),
      2 => (true, true, false),
      3 => (true, false, false),
      _ => (false, true, true),
    };
    let mut a = build();
    let mut b = build();
    let mut peer = build();
    if loaded {
      // A file just opened: not yet settled, so the first change runs the passes over everything.
      let json = a.to_json();
      a.load(&json).unwrap();
      b.load(&json).unwrap();
      peer.load(&json).unwrap();
    }
    assert!(a.doc == b.doc);
    b.reference = true;
    for e in [&mut a, &mut b, &mut peer] {
      e.collab_reset(ordered, ordered || lists, lists);
    }
    let page = a.page.clone();
    let mut canvas = [Canvas::default(), Canvas::default()];
    canvas[0].absorb(&a.render_incremental(&page, &[], None));
    canvas[1].absorb(&b.render_incremental(&page, &[], None));
    Run {
      seed,
      a,
      b,
      peer,
      r: Lcg(seed * 7919 + 17),
      canvas,
      ordered,
      steps: 0,
      log: Vec::new(),
      stats: BTreeMap::new(),
    }
  }

  fn pick(&mut self, f: impl Fn(&Node) -> bool) -> Option<NodeId> {
    let ids: Vec<&NodeId> = self.a.doc.nodes.values().filter(|n| f(n)).map(|n| &n.id).collect();
    if ids.is_empty() {
      return None;
    }
    let i = self.r.below(ids.len());
    Some(ids[i].clone())
  }

  fn pick_up_to(&mut self, max: usize, f: impl Fn(&Node) -> bool + Copy) -> Vec<NodeId> {
    let n = 1 + self.r.below(max);
    self.pick_many(n, f)
  }

  fn pick_many(&mut self, n: usize, f: impl Fn(&Node) -> bool + Copy) -> Vec<NodeId> {
    let mut out: Vec<NodeId> = Vec::new();
    for _ in 0..n {
      if let Some(id) = self.pick(f) {
        if !out.contains(&id) {
          out.push(id);
        }
      }
    }
    out
  }

  /// A command for both engines; the outcomes must agree.
  fn both(&mut self, cmd: Command) {
    self.log.push(format!("{cmd:?}").chars().take(600).collect());
    let name: String = format!("{cmd:?}").split([' ', '{']).next().unwrap_or("").to_string();
    let before = self.a.doc.clone();
    let ra = self.a.dispatch(cmd.clone());
    let rb = self.b.dispatch(cmd);
    let st = self.stats.entry(name).or_default();
    st[0] += 1;
    st[1] += usize::from(ra.is_ok());
    st[2] += usize::from(before != self.a.doc);
    assert_eq!(ra, rb, "seed {} step {}: results differ\n{}", self.seed, self.steps, self.tail());
    assert_eq!(
      self.a.fingerprints,
      self.b.fingerprints,
      "seed {} step {}: fingerprints differ right after\n{}",
      self.seed,
      self.steps,
      self.tail()
    );
  }

  fn tail(&self) -> String {
    self.log.iter().rev().take(6).rev().cloned().collect::<Vec<_>>().join("\n")
  }

  fn variable_ids(&self, kind: VarKind) -> Vec<String> {
    self
      .a
      .doc
      .variables
      .iter()
      .flat_map(|c| c.variables.iter())
      .filter(|v| v.kind == kind)
      .map(|v| v.id.clone())
      .collect()
  }

  fn edit_variables(&mut self) -> Vec<Collection> {
    let mut cols = variables::plain(&self.a.doc.variables);
    if cols.is_empty() {
      return cols;
    }
    let ci = self.r.below(cols.len());
    let kind = self.r.below(9);
    let n_vars = cols[ci].variables.len();
    match kind {
      0 | 1 if n_vars > 0 => {
        let vi = self.r.below(n_vars);
        let color = self.r.hex();
        let num = self.r.below(40) as f64;
        let word = format!("w{}", self.r.below(100));
        let mi = self.r.below(cols[ci].modes.len().max(1));
        let Some(mode) = cols[ci].modes.get(mi).map(|m| m.id.clone()) else {
          return cols;
        };
        let v = Arc::make_mut(&mut cols[ci].variables[vi]);
        let val = match v.kind {
          VarKind::Color => json!(color),
          VarKind::Number => json!(num),
          VarKind::String => json!(word),
          VarKind::Boolean => json!(true),
        };
        v.values.insert(mode, val);
      }
      2 if n_vars > 0 => {
        // An alias to another variable of the same kind (a cycle is refused, alike on both).
        let vi = self.r.below(n_vars);
        let kind = cols[ci].variables[vi].kind;
        let targets = self.variable_ids(kind);
        if targets.is_empty() {
          return cols;
        }
        let t = targets[self.r.below(targets.len())].clone();
        let mode = cols[ci].modes[self.r.below(cols[ci].modes.len().max(1)).min(cols[ci].modes.len() - 1)]
          .id
          .clone();
        Arc::make_mut(&mut cols[ci].variables[vi])
          .values
          .insert(mode, json!({ "alias": t }));
      }
      3 if n_vars > 0 => {
        let vi = self.r.below(n_vars);
        let v = Arc::make_mut(&mut cols[ci].variables[vi]);
        v.name = format!("{} {}", v.name, self.r.below(9));
      }
      4 => {
        let id = format!("m_new{}", self.r.below(1000));
        let first = cols[ci].modes[0].id.clone();
        cols[ci].modes.push(VarMode {
          id: id.clone(),
          name: id.clone(),
        });
        for v in &mut cols[ci].variables {
          let val = v.values.get(&first).cloned();
          if let Some(val) = val {
            Arc::make_mut(v).values.insert(id.clone(), val);
          }
        }
      }
      5 if cols[ci].modes.len() > 1 => {
        let mi = 1 + self.r.below(cols[ci].modes.len() - 1);
        cols[ci].modes.remove(mi);
      }
      6 if n_vars > 0 => {
        let vi = self.r.below(n_vars);
        cols[ci].variables.remove(vi);
      }
      7 => {
        // A variable a layer may already name by its name (a binding made before it existed).
        let modes: Vec<String> = cols[ci].modes.iter().map(|m| m.id.clone()).collect();
        let color = self.r.hex();
        let var = Variable {
          id: format!("v_later{}", self.r.below(3)),
          name: "Later".into(),
          kind: VarKind::Color,
          values: modes.iter().map(|m| (m.clone(), json!(color))).collect(),
          ..Default::default()
        };
        if !cols.iter().any(|c| c.variables.iter().any(|v| v.id == var.id)) {
          cols[ci].variables.push(Arc::new(var));
        }
      }
      8 if self.r.chance(15) && cols.len() > 1 => {
        cols.remove(ci);
      }
      _ => {}
    }
    cols
  }

  fn step(&mut self) {
    self.steps += 1;
    let k = self.r.below(130);
    match k {
      0..=9 => {
        if let Some(id) = self.pick(|n| n.text.is_some() && n.instance.is_none()) {
          let cur = self
            .a
            .doc
            .get(&id)
            .and_then(|n| n.text.as_ref())
            .map(|t| t.characters.clone())
            .unwrap_or_default();
          let next = if self.r.chance(30) && !cur.is_empty() {
            cur.chars().take(cur.chars().count() - 1).collect()
          } else {
            format!("{cur}{}", ["a", "b", " ", "xyz"][self.r.below(4)])
          };
          self.both(Command::SetText {
            id,
            characters: next,
            runs: None,
          });
        }
      }
      10..=17 => {
        let ids = self.pick_up_to(3, |n| n.kind != NodeType::Instance);
        let color = self.r.hex();
        let op = (self.r.below(100) as f64) / 100.0;
        let x = self.r.below(300) as f64;
        let patch = match self.r.below(9) {
          8 => {
            json!({ "effects": [{"type": "backgroundBlur", "color": "#00000040", "x": 0, "y": 0, "blur": x / 10.0, "spread": 0, "visible": self.r.chance(70)}] })
          }
          0 => json!({ "fills": [{"type": "solid", "color": color}] }),
          1 => json!({ "opacity": op }),
          2 => json!({ "x": x }),
          3 => json!({ "visible": self.r.chance(70) }),
          4 => json!({ "name": format!("N{x}") }),
          5 => json!({ "width": 20.0 + x }),
          6 => json!({ "cornerRadius": x / 10.0 }),
          _ => json!({ "strokes": [{"type": "solid", "color": color}], "strokeWeight": 2 }),
        };
        self.both(Command::Update { ids, patch });
      }
      18..=22 => {
        // Pins and bindings written straight into layers, by id and by name, and stale ones.
        let ids = self.pick_up_to(2, |_| true);
        let patch = match self.r.below(6) {
          0 => json!({ "variableModes": { "c_theme": "m_dark" } }),
          1 => json!({ "variableModes": { "Theme": "Light", "Brand": "B" } }),
          2 => json!({ "variableModes": { "c_theme": null } }),
          3 => json!({ "bindings": { "fill": "v_surface" } }),
          4 => {
            let name = ["Surface", "Theme/Text", "Later", "Brand/Accent", "nope"][self.r.below(5)];
            json!({ "bindings": { "fill": name } })
          }
          _ => json!({ "bindings": { "fill": null, "opacity": "Fade" } }),
        };
        self.both(Command::Update { ids, patch });
      }
      23..=29 => {
        let ids = self.pick_up_to(3, |_| true);
        let props = [
          ("fill", VarKind::Color),
          ("stroke", VarKind::Color),
          ("cornerRadius", VarKind::Number),
          ("gap", VarKind::Number),
          ("opacity", VarKind::Number),
          ("characters", VarKind::String),
        ];
        let (prop, kind) = props[self.r.below(props.len())];
        let vars = self.variable_ids(kind);
        let variable = if vars.is_empty() || self.r.chance(25) {
          None
        } else {
          Some(vars[self.r.below(vars.len())].clone())
        };
        self.both(Command::BindVariable {
          ids,
          property: prop.into(),
          variable,
        });
      }
      30..=36 => {
        let ids = self.pick_up_to(2, |n| n.kind.is_frame_like() || n.kind == NodeType::Group);
        let (collection, modes): (String, Vec<String>) = {
          let cols = &self.a.doc.variables;
          if cols.is_empty() {
            return;
          }
          let c = &cols[self.r.below(cols.len())];
          (c.id.clone(), c.modes.iter().map(|m| m.id.clone()).collect())
        };
        let mode = if modes.is_empty() || self.r.chance(30) {
          None
        } else {
          Some(modes[self.r.below(modes.len())].clone())
        };
        self.both(Command::SetVariableMode { ids, collection, mode });
      }
      37..=43 => {
        let collections = self.edit_variables();
        self.both(Command::SetVariables { collections });
      }
      44..=49 => {
        let ids = self.pick_up_to(2, |n| n.parent.is_some() && n.kind != NodeType::Component);
        let parent = if self.r.chance(15) {
          None
        } else {
          self.pick(|n| n.kind == NodeType::Frame && n.instance.is_none())
        };
        let index = self.r.chance(50).then(|| self.r.below(4));
        self.both(Command::MoveToParent { ids, parent, index });
      }
      50..=53 => {
        let ids = self.pick_up_to(3, |n| n.parent.is_some() && n.instance.is_none() && n.master_id.is_none());
        let to = [ReorderTo::Front, ReorderTo::Back, ReorderTo::Forward, ReorderTo::Backward][self.r.below(4)];
        self.both(Command::Reorder { ids, to });
      }
      54..=57 => match self.r.below(4) {
        0 => {
          let ids = self.pick_many(2, |n| n.parent.is_some() && n.master_id.is_none() && n.kind != NodeType::Component);
          self.both(Command::Group { ids });
        }
        1 => {
          let ids = self.pick_many(1, |n| n.kind == NodeType::Group);
          self.both(Command::Ungroup { ids });
        }
        2 => {
          let ids = self.pick_many(2, |n| n.parent.is_some() && n.master_id.is_none() && n.kind != NodeType::Component);
          self.both(Command::FrameSelection { ids });
        }
        _ => {
          let ids = self.pick_many(1, |n| n.kind != NodeType::Component && n.master_id.is_none() && n.parent.is_some());
          self.both(Command::Duplicate { ids });
        }
      },
      58..=59 => {
        if self.r.chance(60) {
          let ids = self.pick_many(1, |n| n.master_id.is_none() && n.kind != NodeType::Component && n.parent.is_some());
          self.both(Command::Delete { ids });
        }
      }
      60..=65 => {
        // Copy, then paste into a frame (or the page), each engine from its own copy.
        let ids = self.pick_up_to(4, |n| n.master_id.is_none() && n.kind != NodeType::Component);
        let ca = self.a.query(Query::Copy { ids: ids.clone() }).unwrap();
        let cb = self.b.query(Query::Copy { ids }).unwrap();
        assert_eq!(ca, cb, "seed {} step {}: copies differ", self.seed, self.steps);
        let parent = self
          .r
          .chance(50)
          .then(|| self.pick(|n| n.kind == NodeType::Frame && n.instance.is_none() && n.master_id.is_none()))
          .flatten();
        let (x, y) = (self.r.chance(50).then_some(5000.0), self.r.chance(50).then_some(-300.0));
        let (da, db) = (ca.as_str().unwrap().to_string(), cb.as_str().unwrap().to_string());
        self.log.push("paste".into());
        let ra = self.a.dispatch(Command::Paste {
          data: da,
          parent: parent.clone(),
          x,
          y,
        });
        let rb = self.b.dispatch(Command::Paste { data: db, parent, x, y });
        assert_eq!(ra, rb, "seed {} step {}: paste results differ", self.seed, self.steps);
      }
      66..=69 => {
        let comp = self.pick(|n| n.kind == NodeType::Component);
        let parent = self.pick(|n| n.kind == NodeType::Frame && n.instance.is_none() && n.master_id.is_none());
        if let Some(component_id) = comp {
          self.both(Command::CreateInstance {
            component_id,
            x: 10.0,
            y: 10.0,
            parent,
            anchor: None,
            into_components: false,
          });
        }
      }
      70..=76 => {
        // An edit inside a main component, and an override inside an instance.
        let in_main = self.r.chance(60);
        let id = if in_main {
          let comps: Vec<NodeId> = self.a.doc.components().iter().map(|c| c.id.clone()).collect();
          if comps.is_empty() {
            return;
          }
          let c = comps[self.r.below(comps.len())].clone();
          let sub = self.a.doc.subtree(&c);
          sub[self.r.below(sub.len())].clone()
        } else {
          match self.pick(|n| n.master_id.is_some()) {
            Some(id) => id,
            None => return,
          }
        };
        let color = self.r.hex();
        let patch = match self.r.below(4) {
          0 => json!({ "fills": [{"type": "solid", "color": color}] }),
          1 => json!({ "opacity": 0.5 }),
          2 => json!({ "width": 40.0 + self.r.below(80) as f64 }),
          _ => json!({ "bindings": { "fill": "v_muted" } }),
        };
        self.both(Command::Update { ids: vec![id], patch });
      }
      77..=82 => {
        if self.r.chance(60) {
          self.both(Command::Undo);
        } else {
          self.both(Command::Redo);
        }
      }
      83..=87 => {
        let ids = self.pick_up_to(3, |n| n.parent.is_none());
        self.both(Command::BeginGesture);
        for _ in 0..1 + self.r.below(3) {
          let (dx, dy) = (self.r.below(60) as f64 - 30.0, self.r.below(60) as f64 - 30.0);
          self.both(Command::Translate {
            ids: ids.clone(),
            dx,
            dy,
            snap: false,
            zoom: 1.0,
            axis: None,
          });
          if self.r.chance(35) {
            self.remote();
          }
        }
        if self.r.chance(80) {
          self.both(Command::EndGesture);
        } else {
          self.both(Command::CancelGesture);
        }
      }
      88..=91 => self.remote(),
      92..=95 => {
        let parent = self
          .r
          .chance(40)
          .then(|| self.pick(|n| n.kind == NodeType::Frame && n.instance.is_none() && n.master_id.is_none()))
          .flatten();
        let fill = ["Theme/Surface", "Surface", "Brand/Accent"][self.r.below(3)];
        let theme = ["Dark", "Light"][self.r.below(2)];
        let mut input = json!({"nodes": [{"type":"frame","name":"Made","width":220,"height":100,"layout":{"direction":"vertical","gap":4,"padding":8},
          "bind":{"fill": fill, "gap": "Gap"},
          "variableModes": {"Theme": theme},
          "children":[{"type":"text","text":"made here","bind":{"fill":"Text"}},{"type":"rectangle","width":30,"height":30,"bind":{"cornerRadius":"Radius","fill":"Primary"}}]}]});
        if let Some(p) = parent {
          input["parentId"] = json!(p);
        }
        self.both(Command::Ai {
          tool: "create_nodes".into(),
          input,
        });
      }
      96..=97 => {
        let ids = self.pick_up_to(6, |n| n.parent.is_none());
        self.both(Command::Nudge { ids, dx: 10.0, dy: 5.0 });
      }
      98 => {
        // Constraints: absolute layers pinned inside auto layout frames (those frames grow and
        // shrink with text edits and resizes), and wrap frames spread by Space between.
        let parent = self.pick(|n| n.kind == NodeType::Frame && n.layout.is_some() && n.instance.is_none() && n.master_id.is_none());
        if let Some(p) = parent {
          let h = ["left", "right", "left-right", "center", "scale"][self.r.below(5)];
          let v = ["top", "bottom", "top-bottom", "center", "scale"][self.r.below(5)];
          let (x, y) = (self.r.below(200) as f64, self.r.below(60) as f64);
          self.both(Command::Ai {
            tool: "create_nodes".into(),
            input: json!({"parentId": p, "nodes": [{"type":"frame","name":"Pinned","absolute":true,"x":x,"y":y,"width":40,"height":24,
              "constraints":{"horizontal":h,"vertical":v},
              "layout":{"direction":"horizontal"},
              "children":[{"type":"text","text":"pin"}]}]}),
          });
        }
        if self.r.chance(50) {
          let ids = self.pick_up_to(2, |n| n.layout.as_ref().is_some_and(|l| l.direction == LayoutDirection::Horizontal));
          self.both(Command::Update {
            ids,
            patch: json!({ "layout": { "wrap": true, "primaryAlign": "spaceBetween" } }),
          });
        }
        let ids = self.pick_up_to(2, |n| n.kind == NodeType::Frame && n.layout.is_some() && n.master_id.is_none());
        let patch = match self.r.below(3) {
          0 => json!({ "sizingH": "hug", "sizingV": "hug" }),
          1 => json!({ "width": 120.0 + self.r.below(300) as f64 }),
          _ => json!({ "height": 80.0 + self.r.below(200) as f64 }),
        };
        self.both(Command::Update { ids, patch });
      }
      100.. => self.extra(k - 100),
      _ => {
        // A colour style made, applied to a few layers and sometimes deleted.
        if self.r.chance(50) {
          let color = self.r.hex();
          self.both(Command::AddColorStyle { name: "S".into(), color });
        } else if let Some(id) = self.a.doc.styles.colors.last().map(|s| s.id.clone()) {
          if self.r.chance(50) {
            let ids = self.pick_many(3, |n| n.parent.is_some() && n.master_id.is_none());
            self.both(Command::ApplyStyle {
              ids,
              style_id: id,
              kind: None,
            });
          } else {
            self.both(Command::DeleteStyle { id });
          }
        }
      }
    }
  }

  fn other_page(&mut self) -> Option<String> {
    let pages: Vec<String> = self.a.doc.pages.iter().map(|p| p.id.clone()).collect();
    if pages.len() < 2 {
      return None;
    }
    Some(pages[self.r.below(pages.len())].clone())
  }

  fn extra(&mut self, k: usize) {
    match k % 27 {
      0..=2 => {
        // Bindings and pins by name on layers inside instances (recorded as overrides), then a main edit.
        let ids = self.pick_up_to(2, |n| n.master_id.is_some() || n.kind == NodeType::Instance);
        let patch = match self.r.below(5) {
          0 => json!({ "bindings": { "fill": (["Surface", "Theme/Text", "Muted", "Brand/Accent", "Later"][self.r.below(5)]) } }),
          1 => json!({ "variableModes": { "Theme": (["Dark", "Light"][self.r.below(2)]) } }),
          2 => json!({ "variableModes": { "c_brand": "b_b" } }),
          3 => json!({ "bindings": { "opacity": "Fade", "cornerRadius": "Radius" } }),
          _ => json!({ "variableModes": { "Brand": "B", "c_theme": null } }),
        };
        self.both(Command::Update { ids, patch });
      }
      3 => {
        let inst = self.pick(|n| n.kind == NodeType::Instance);
        let comp = self.pick(|n| n.kind == NodeType::Component);
        if let (Some(id), Some(component_id)) = (inst, comp) {
          self.both(Command::SwapComponent { id, component_id });
        }
      }
      4 => {
        let ids = self.pick_many(1, |n| n.kind == NodeType::Instance);
        self.both(Command::DetachInstance { ids });
      }
      5 => {
        let ids = self.pick_many(2, |n| n.master_id.is_some() || n.kind == NodeType::Instance);
        if self.r.chance(50) {
          self.both(Command::ResetInstance { ids });
        } else {
          self.both(Command::ResetOverrideGroups { ids, groups: vec![] });
        }
      }
      6 => self.both(Command::AddPage { name: None }),
      7 => {
        // Only a page this run added and that holds little (a run that loses its screens tests nothing).
        let small: Vec<String> = self
          .a
          .doc
          .pages
          .iter()
          .skip(1)
          .filter(|p| p.children.len() <= 3)
          .map(|p| p.id.clone())
          .collect();
        if !small.is_empty() {
          let id = small[self.r.below(small.len())].clone();
          self.both(Command::DeletePage { id });
        }
      }
      8 | 9 => {
        let ids = self.pick_up_to(2, |n| n.parent.is_some() && n.master_id.is_none() && n.kind != NodeType::Component);
        if let Some(page) = self.other_page() {
          self.both(Command::MoveToPage { ids, page });
          // and back to the first page now and then
          if self.r.chance(50) {
            let first = self.a.doc.pages[0].id.clone();
            let ids = self.pick_up_to(2, |n| n.parent.is_none() && n.kind != NodeType::Component);
            self.both(Command::MoveToPage { ids, page: first.clone() });
            self.both(Command::SetPage { id: first });
          }
        }
      }
      10 => {
        if self.r.chance(30) {
          let id = self.a.page.clone();
          self.both(Command::DuplicatePage { id });
        } else if let Some(id) = self.other_page() {
          self.both(Command::SetPage { id });
        }
      }
      11 => {
        // A whole document replaced by an edited copy (a version restore, an import).
        let mut v: Value = serde_json::from_str(&self.a.to_json()).unwrap();
        let color = self.r.hex();
        if let Some(c) = v["variables"].get_mut(0).and_then(|c| c["variables"].get_mut(0)) {
          c["values"]["m_light"] = json!(color);
        }
        if let Some(nodes) = v["nodes"].as_object_mut() {
          let keys: Vec<String> = nodes.keys().cloned().collect();
          if !keys.is_empty() {
            let k = &keys[self.r.below(keys.len())];
            nodes[k]["variableModes"] = json!({"c_theme": "m_dark"});
          }
        }
        let keep_comments = self.r.chance(50);
        self.both(Command::ReplaceDocument { doc: v, keep_comments });
      }
      12 | 13 => {
        if let Some(id) = self.pick(|n| n.text.as_ref().is_some_and(|t| t.characters.chars().count() > 3) && n.instance.is_none()) {
          let color = self.r.hex();
          let style = if self.r.chance(70) {
            json!({ "color": color })
          } else {
            json!({ "link": "https://example.com" })
          };
          self.both(Command::StyleText {
            id,
            start: 1,
            end: 3,
            style,
            clear: vec![],
          });
        }
      }
      14 | 15 => {
        let ids = self.pick_up_to(2, |n| n.parent.is_some());
        let mut ups = Vec::new();
        for id in ids {
          ups.push(match self.r.below(3) {
            0 => json!({ "id": id, "bind": { "fill": (["Muted", "Theme/Surface", "Primary"][self.r.below(3)]) } }),
            1 => json!({ "id": id, "variableModes": { "Brand": (["A", "B"][self.r.below(2)]) } }),
            _ => json!({ "id": id, "opacity": 0.4, "bind": { "cornerRadius": "Radius" } }),
          });
        }
        self.both(Command::Ai {
          tool: "update_nodes".into(),
          input: json!({ "updates": ups }),
        });
      }
      16 => self.both(Command::Relayout),
      17 => {
        // The file reopened (every engine loads the same text).
        let json = self.a.to_json();
        self.log.push("load".into());
        self.a.load(&json).unwrap();
        self.b.load(&json).unwrap();
        let (o, l) = (self.ordered, self.ordered);
        self.a.collab_reset(o, true, l || true);
        self.b.collab_reset(o, true, l || true);
        self.peer.load(&json).unwrap();
        self.peer.collab_reset(o, true, true);
      }
      18 => {
        let ids = self.pick_many(2, |n| n.kind == NodeType::Component);
        self.both(Command::CombineVariants { ids });
      }
      19 => {
        // A main component deleted (its instances keep their layers), sometimes restored.
        if self.r.chance(50) {
          let ids = self.pick_many(1, |n| n.kind == NodeType::Component);
          self.both(Command::Delete { ids });
        } else if let Some(id) = self.pick(|n| n.kind == NodeType::Instance) {
          self.both(Command::RestoreComponent { id });
        }
      }
      20 | 21 => {
        // A variable bound inside an instance (an override), then deleted.
        let ids = self.pick_many(2, |n| n.master_id.is_some());
        let vars = self.variable_ids(VarKind::Color);
        if vars.is_empty() {
          return;
        }
        let v = vars[self.r.below(vars.len())].clone();
        self.both(Command::BindVariable {
          ids,
          property: "fill".into(),
          variable: Some(v.clone()),
        });
        if self.r.chance(50) {
          let mut cols = variables::plain(&self.a.doc.variables);
          for c in &mut cols {
            c.variables.retain(|x| x.id != v);
          }
          self.both(Command::SetVariables { collections: cols });
        }
      }
      22 => {
        // A mode removed from a collection layers are pinned to.
        let mut cols = variables::plain(&self.a.doc.variables);
        if let Some(c) = cols.iter_mut().find(|c| c.modes.len() > 1) {
          c.modes.pop();
          self.both(Command::SetVariables { collections: cols });
        }
      }
      23 => {
        // A variable renamed while layers name it by name (in overrides too).
        let mut cols = variables::plain(&self.a.doc.variables);
        if let Some(v) = cols
          .iter_mut()
          .flat_map(|c| c.variables.iter_mut())
          .find(|v| ["Surface", "Muted", "Text", "Accent", "Radius", "Fade"].contains(&v.name.as_str()))
        {
          Arc::make_mut(v).name.push('X');
          self.both(Command::SetVariables { collections: cols });
        }
      }
      24 => {
        for _ in 0..1 + self.r.below(4) {
          self.both(Command::Undo);
        }
      }
      25 => {
        // Wrap rows: a layout frame starts wrapping, its fill children get a min and max width.
        let frames = self.pick_up_to(2, |n| n.layout.as_ref().is_some_and(|l| l.direction == LayoutDirection::Horizontal));
        let wrap = self.r.chance(70);
        self.both(Command::Update {
          ids: frames,
          patch: json!({ "layout": { "wrap": wrap } }),
        });
        let kids = self.pick_up_to(3, |n| n.sizing_h == Sizing::Fill);
        let (lo, hi) = (40.0 + self.r.below(80) as f64, 120.0 + self.r.below(200) as f64);
        self.both(Command::Update {
          ids: kids,
          patch: json!({ "minWidth": lo, "maxWidth": hi }),
        });
      }
      _ => {
        let ids = self.pick_up_to(3, |n| n.parent.is_none());
        self.both(Command::BeginGesture);
        let (dx, dy) = (self.r.below(60) as f64 - 30.0, 7.0);
        self.both(Command::Translate {
          ids: ids.clone(),
          dx,
          dy,
          snap: false,
          zoom: 1.0,
          axis: None,
        });
        self.remote();
        self.remote();
        if self.r.chance(50) {
          self.both(Command::Undo);
        }
        self.both(Command::Translate {
          ids,
          dx: dx * 2.0,
          dy,
          snap: false,
          zoom: 1.0,
          axis: None,
        });
        if self.r.chance(50) {
          self.both(Command::EndGesture);
        } else {
          self.both(Command::CancelGesture);
        }
      }
    }
  }

  /// An edit by a third editor, delivered to both as a remote delta.
  fn remote(&mut self) {
    let peer = &mut self.peer;
    let ids: Vec<NodeId> = peer
      .doc
      .nodes
      .values()
      .filter(|n| n.instance.is_none())
      .map(|n| n.id.clone())
      .collect();
    let id = ids[self.r.below(ids.len())].clone();
    let color = self.r.hex();
    let cmd = match self.r.below(7) {
      0 => Command::Update {
        ids: vec![id],
        patch: json!({ "fills": [{"type": "solid", "color": color}] }),
      },
      1 => Command::Update {
        ids: vec![id],
        patch: json!({ "variableModes": { "c_theme": "m_dark" } }),
      },
      2 => Command::BindVariable {
        ids: vec![id],
        property: "fill".into(),
        variable: Some("v_text".into()),
      },
      3 => Command::SetVariableMode {
        ids: vec![id],
        collection: "c_brand".into(),
        mode: Some("b_b".into()),
      },
      4 => Command::Update {
        ids: vec![id],
        patch: json!({ "x": self.r.below(100) as f64 }),
      },
      5 => {
        let mut cols = variables::plain(&peer.doc.variables);
        if let Some(v) = cols.get_mut(0).and_then(|c| c.variables.first_mut()) {
          Arc::make_mut(v).values.insert("m_light".into(), json!(color));
        }
        Command::SetVariables { collections: cols }
      }
      _ => Command::Delete { ids: vec![id] },
    };
    let _ = peer.dispatch(cmd);
    let d = peer.collab_delta();
    if d.get("full").is_some() || crate::collab::is_empty(&d) {
      return;
    }
    let d = wire(&d);
    self.log.push(format!("remote {d}").chars().take(600).collect());
    let ra = self.a.dispatch(Command::ApplyRemote {
      delta: d.clone(),
      local: false,
    });
    let rb = self.b.dispatch(Command::ApplyRemote { delta: d, local: false });
    assert_eq!(ra, rb, "seed {} step {}: remote results differ", self.seed, self.steps);
    assert_eq!(
      self.a.fingerprints,
      self.b.fingerprints,
      "seed {} step {}: fingerprints differ right after a remote delta\n{}",
      self.seed,
      self.steps,
      self.tail()
    );
  }

  /// Everything that must agree after a step.
  fn check(&mut self) {
    let (seed, step) = (self.seed, self.steps);
    if self.a.doc != self.b.doc {
      let diff = self
        .b
        .doc
        .nodes
        .diff(&self.a.doc.nodes)
        .take(3)
        .map(|d| match d {
          imbl::ordmap::DiffItem::Update { old, new } => format!(
            "reference {}\nincremental {}",
            serde_json::to_string(old.1).unwrap(),
            serde_json::to_string(new.1).unwrap()
          ),
          imbl::ordmap::DiffItem::Add(k, _) => format!("only incremental: {k}"),
          imbl::ordmap::DiffItem::Remove(k, _) => format!("only reference: {k}"),
        })
        .collect::<Vec<_>>()
        .join("\n---\n");
      panic!("seed {seed} step {step}: documents differ\n{diff}\n{}", self.tail());
    }
    assert_eq!(
      self.a.fingerprints,
      self.b.fingerprints,
      "seed {seed} step {step}: fingerprints differ\n{}",
      self.tail()
    );
    // The canvas, as each client would hold it.
    let page = self.a.page.clone();
    let ra = self.a.render_incremental(&page, &[], None);
    let rb = self.b.render_incremental(&page, &[], None);
    self.canvas[0].absorb(&ra);
    self.canvas[1].absorb(&rb);
    for (id, svg) in &self.canvas[1].roots {
      assert_eq!(
        self.canvas[0].roots.get(id),
        Some(svg),
        "seed {seed} step {step}: canvas of {id} differs\n{}",
        self.tail()
      );
    }
    assert_eq!(
      self.canvas[0].roots.len(),
      self.canvas[1].roots.len(),
      "seed {seed} step {step}: roots differ"
    );
    // What the incremental engine kept is what a redraw from nothing gives, too.
    if step % 25 == 0 {
      let fresh = fresh_canvas(&mut self.a);
      if fresh.roots != self.canvas[0].roots {
        for (id, svg) in &fresh.roots {
          let c = self.canvas[0].roots.get(id);
          if c != Some(svg) {
            let c = c.cloned().unwrap_or_default();
            let at = svg.chars().zip(c.chars()).position(|(x, y)| x != y).unwrap_or(0);
            let from = at.saturating_sub(150);
            eprintln!(
              "DBG root {id} differs at {at}\nfresh  ...{}\ncached ...{}",
              svg.chars().skip(from).take(400).collect::<String>(),
              c.chars().skip(from).take(400).collect::<String>()
            );
            break;
          }
        }
      }
      assert!(
        fresh.roots == self.canvas[0].roots,
        "seed {seed} step {step}: a redraw differs from the cached canvas\n{}",
        self.tail()
      );
    }
    // Collaboration deltas from the last synced copy.
    let (da, db) = (self.a.collab_delta(), self.b.collab_delta());
    assert_eq!(da, db, "seed {seed} step {step}: deltas differ\n{}", self.tail());
    if self.ordered && !crate::collab::is_empty(&da) && da.get("full").is_none() {
      let (ra, rb) = (
        self.a.dispatch(Command::CollabAck { rejected: false }),
        self.b.dispatch(Command::CollabAck { rejected: false }),
      );
      assert_eq!(ra, rb);
      assert!(
        self.a.doc == self.b.doc,
        "seed {seed} step {step}: documents differ after the ack\n{}",
        self.tail()
      );
    }
    // A settled document is a fixed point of the whole-file passes.
    if self.a.vars_settled {
      let mut again = self.a.doc.clone();
      variables::normalize(&mut again);
      variables::apply(&mut again);
      assert!(
        again == self.a.doc,
        "seed {seed} step {step}: not a fixed point of normalize + apply\n{}",
        self.tail()
      );
    }
  }
}

fn run(seed: u64, steps: usize) {
  let mut run = Run::new(seed);
  for _ in 0..steps {
    run.step();
    run.check();
  }
  assert!(run.a.doc.nodes.len() > 100);
  let changed: usize = run.stats.values().map(|s| s[2]).sum();
  eprintln!(
    "seed {seed}: {steps} steps, {changed} changed the document, {} layers at the end",
    run.a.doc.nodes.len()
  );
  for (k, [n, ok, ch]) in &run.stats {
    eprintln!("  {k:<18} {n:>4} run {ok:>4} ok {ch:>4} changed");
  }
  assert!(changed * 3 > steps, "most steps should change something");
}

#[cfg(debug_assertions)]
const STEPS: usize = 150;
#[cfg(not(debug_assertions))]
const STEPS: usize = 400;

#[test]
fn incremental_passes_match_the_whole_file_passes_seed_0() {
  run(0, STEPS);
}

#[test]
fn incremental_passes_match_the_whole_file_passes_seed_1() {
  run(1, STEPS);
}

#[test]
fn incremental_passes_match_the_whole_file_passes_seed_2_ordered_room() {
  run(2, STEPS);
}

#[test]
fn incremental_passes_match_the_whole_file_passes_seed_3_ordered_room_without_lists() {
  run(3, STEPS);
}

#[test]
fn incremental_passes_match_the_whole_file_passes_seed_4_on_a_loaded_file() {
  run(4, STEPS);
}

/// Hunting: `cargo test --release -p designotron-engine -- --ignored lockstep_many_seeds`.
#[test]
#[ignore]
fn lockstep_many_seeds() {
  let from: u64 = std::env::var("LOCKSTEP_FROM").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
  for seed in from..from + 40 {
    run(seed, 400);
  }
}

#[test]
fn a_freshly_loaded_file_is_settled_by_the_first_change_only() {
  let mut e = build();
  // A stored fill that disagrees with its variable stays as it is until something changes.
  let screen = e
    .doc
    .nodes
    .values()
    .find(|n| n.name.starts_with("Screen ") && n.variable_modes.is_empty())
    .unwrap()
    .id
    .clone();
  e.doc.get_mut(&screen).unwrap().fills = vec![crate::model::Paint::solid("#123456")];
  let json = e.to_json();
  e.load(&json).unwrap();
  assert!(!e.vars_settled);
  assert_eq!(e.doc.get(&screen).unwrap().fills[0], crate::model::Paint::solid("#123456"));
  let other = e
    .doc
    .nodes
    .values()
    .find(|n| n.name.starts_with("Screen ") && n.id != screen)
    .unwrap()
    .id
    .clone();
  e.dispatch(Command::Update {
    ids: vec![other],
    patch: json!({ "name": "renamed" }),
  })
  .unwrap();
  assert!(e.vars_settled);
  assert_eq!(
    e.doc.get(&screen).unwrap().fills[0],
    crate::model::Paint::solid("#FFFFFF"),
    "the first change settles the whole file"
  );
  // Undo returns to the unsettled file; the next change settles it again.
  e.dispatch(Command::Undo).unwrap();
  assert!(!e.vars_settled);
  assert_eq!(e.doc.get(&screen).unwrap().fills[0], crate::model::Paint::solid("#123456"));
  let other = e
    .doc
    .nodes
    .values()
    .find(|n| n.name.starts_with("Screen ") && n.id != screen)
    .unwrap()
    .id
    .clone();
  e.dispatch(Command::Update {
    ids: vec![other],
    patch: json!({ "name": "again" }),
  })
  .unwrap();
  assert_eq!(e.doc.get(&screen).unwrap().fills[0], crate::model::Paint::solid("#FFFFFF"));
}

#[test]
fn deleting_a_bound_variable_leaves_nothing_dangling_and_costs_one_pass() {
  let mut e = build();
  let count = || AFTER_MUTATIONS.with(|c| c.get());
  let mut cols = variables::plain(&e.doc.variables);
  cols[0].variables.retain(|v| v.id != "v_text");
  let before = count();
  e.dispatch(Command::SetVariables { collections: cols.clone() }).unwrap();
  // The delete records what instance layers show first, so nothing re-syncs afterwards.
  assert_eq!(count() - before, 1, "{} passes", count() - before);
  assert!(!e.doc.nodes.values().any(|n| n.bindings.values().any(|v| v == "v_text")));
  let mut r = build();
  r.reference = true;
  r.dispatch(Command::SetVariables { collections: cols }).unwrap();
  assert!(r.doc == e.doc);
  // Undo and redo are exact and run no pass.
  let before = count();
  e.dispatch(Command::Undo).unwrap();
  e.dispatch(Command::Redo).unwrap();
  assert_eq!(count(), before);
}

/// A layer inside an instance bound (an override) to a variable that is then deleted keeps what it
/// shows and loses the link; it does not take its main's binding on the way, also when the same
/// edit changes the main (so the instance is synced in that very pass).
#[test]
fn an_instance_layer_bound_to_a_deleted_variable_keeps_its_value_and_loses_the_link() {
  for with_main_change in [false, true] {
    let mut e = build();
    let title = e
      .doc
      .nodes
      .values()
      .find(|n| {
        n.name == "Title"
          && n.master_id.is_some()
          && n
            .parent
            .as_ref()
            .and_then(|p| e.doc.get(p))
            .is_some_and(|p| p.name == "Card" && p.instance.is_some())
      })
      .unwrap()
      .id
      .clone();
    e.dispatch(Command::BindVariable {
      ids: vec![title.clone()],
      property: "fill".into(),
      variable: Some("v_muted".into()),
    })
    .unwrap();
    assert_eq!(e.doc.get(&title).unwrap().bindings.get("fill").map(String::as_str), Some("v_muted"));
    let shown = e.doc.get(&title).unwrap().fills.clone();
    let mut cols = variables::plain(&e.doc.variables);
    cols[0]
      .variables
      .retain(|v| v.id != "v_muted" && (!with_main_change || v.id != "v_text"));
    e.dispatch(Command::SetVariables { collections: cols }).unwrap();
    let n = e.doc.get(&title).unwrap();
    assert!(
      n.bindings.is_empty(),
      "main change {with_main_change}: the link is gone, not replaced by the main's: {:?}",
      n.bindings
    );
    assert_eq!(n.fills, shown, "main change {with_main_change}: the value it showed stays");
    // Nothing keeps naming the variable, in the layers or in the instances' records.
    assert!(!e.to_json().contains("v_muted"), "a dangling name is left");
  }
}

/// A binding given by name on a layer inside an instance is recorded in the override by id, so
/// pruning keeps it (it used to drop the name as dangling).
#[test]
fn a_binding_by_name_on_an_instance_layer_survives_pruning() {
  let mut e = build();
  let layer = e
    .doc
    .nodes
    .values()
    .find(|n| (n.name == "Body" || n.name == "Title") && n.master_id.is_some())
    .unwrap()
    .id
    .clone();
  e.dispatch(Command::Update {
    ids: vec![layer.clone()],
    patch: json!({ "bindings": { "opacity": "Fade" }, "variableModes": { "Brand": "B" } }),
  })
  .unwrap();
  let n = e.doc.get(&layer).unwrap();
  assert_eq!(n.bindings.get("opacity").map(String::as_str), Some("v_fade"));
  assert_eq!(n.variable_modes.get("c_brand").map(String::as_str), Some("b_b"));
  let inst = e
    .doc
    .ancestors(&layer)
    .into_iter()
    .find(|a| e.doc.get(a).is_some_and(|n| n.kind == NodeType::Instance))
    .unwrap();
  let ov = serde_json::to_string(&e.doc.get(&inst).unwrap().instance.as_ref().unwrap().overrides).unwrap();
  assert!(ov.contains("v_fade") && !ov.contains("\"Fade\""), "{ov}");
  // An unrelated edit runs the prune over what changed; the layer is still bound.
  e.dispatch(Command::Update {
    ids: vec![inst],
    patch: json!({ "name": "renamed" }),
  })
  .unwrap();
  assert_eq!(
    e.doc.get(&layer).unwrap().bindings.get("opacity").map(String::as_str),
    Some("v_fade")
  );
}

/// A binding that is already a variable id keeps that id even when an earlier variable is named
/// like it (patch name resolution must not rewrite ids, as `normalize` doesn't).
#[test]
fn a_binding_by_id_is_not_rewritten_to_a_variable_named_like_that_id() {
  let mut e = build();
  let mut cols = variables::plain(&e.doc.variables);
  cols[0].variables.insert(
    0,
    Arc::new(Variable {
      id: "v_clash".into(),
      name: "v_fade".into(),
      kind: VarKind::Number,
      values: [("m_light".to_string(), json!(0.5)), ("m_dark".to_string(), json!(0.5))]
        .into_iter()
        .collect(),
      ..Default::default()
    }),
  );
  e.dispatch(Command::SetVariables { collections: cols }).unwrap();
  for inside in [false, true] {
    let layer = e
      .doc
      .nodes
      .values()
      .find(|n| (n.name == "Body" || n.name == "Title") && n.master_id.is_some() == inside)
      .unwrap()
      .id
      .clone();
    e.dispatch(Command::Update {
      ids: vec![layer.clone()],
      patch: json!({ "bindings": { "opacity": "v_fade" } }),
    })
    .unwrap();
    assert_eq!(
      e.doc.get(&layer).unwrap().bindings.get("opacity").map(String::as_str),
      Some("v_fade"),
      "inside an instance: {inside}"
    );
  }
}

/// `Resolver` answers what `find` + `mode_for` + `resolve` answer, for every key a binding could
/// hold (ids, names, `Collection/name`, a name that is another variable's id) from layers at every
/// depth under different pins.
#[test]
fn the_resolver_gives_the_same_answers_as_find_and_resolve() {
  let mut e = build();
  let mut cols = variables::plain(&e.doc.variables);
  // A variable named like another's id, a name two variables share, and an alias chain.
  let mk = |id: &str, name: &str, v: Value| {
    Arc::new(Variable {
      id: id.into(),
      name: name.into(),
      kind: VarKind::Color,
      values: [("m_light".to_string(), v.clone()), ("m_dark".to_string(), v)]
        .into_iter()
        .collect(),
      ..Default::default()
    })
  };
  cols[0].variables.push(mk("v_x1", "v_text", json!("#010101")));
  cols[0].variables.push(mk("v_x2", "Brand/Accent", json!("#020202")));
  cols[0].variables.push(mk("v_x3", "twin", json!({"alias": "v_x4"})));
  cols[1].variables.push(mk("v_x4", "twin", json!({"alias": "v_surface"})));
  cols[1].variables.push(mk("Theme/Surface", "Surface", json!("#030303")));
  e.dispatch(Command::SetVariables { collections: cols }).unwrap();
  let doc = &e.doc;
  let mut keys: Vec<String> = vec!["nope".into(), "".into(), "Theme/nope".into()];
  for c in &doc.variables {
    for v in &c.variables {
      keys.extend([v.id.clone(), v.name.clone(), format!("{}/{}", c.name, v.name)]);
    }
  }
  let mut r = variables::Resolver::new(doc);
  let mut checked = 0;
  for n in doc.nodes.values().step_by(3) {
    for key in &keys {
      assert_eq!(r.resolve(&n.id, key), variables::resolve(doc, &n.id, key), "{} / {key}", n.name);
      checked += 1;
    }
    for (ci, c) in doc.variables.iter().enumerate() {
      assert_eq!(
        r.mode(&n.id, ci).map(String::from),
        variables::mode_for(doc, &n.id, c),
        "mode of {} in {}",
        n.name,
        c.name
      );
    }
  }
  assert!(checked > 3000);
  // A layer that isn't there has no mode, and nothing resolves for it.
  assert_eq!(r.resolve("missing", "v_surface"), variables::resolve(doc, "missing", "v_surface"));
}

/// `apply_since` after edits made straight to a settled document equals the whole-file `apply`: a
/// bound layer moved into or out of a pinned frame, a pin set and cleared on a frame with many
/// descendants, a bound layer added, a binding changed, a variable value changed.
#[test]
fn apply_since_matches_apply_on_edited_settled_documents() {
  let e = build();
  let base = e.doc.clone();
  let pinned = |d: &Document| {
    d.nodes
      .values()
      .find(|n| n.name.starts_with("Screen ") && n.variable_modes.get("c_theme").map(|s| s.as_str()) == Some("m_dark"))
      .unwrap()
      .id
      .clone()
  };
  let plain = |d: &Document| {
    d.nodes
      .values()
      .find(|n| n.name.starts_with("Screen ") && n.variable_modes.is_empty())
      .unwrap()
      .id
      .clone()
  };
  let bound_text = |d: &Document, under: &str| {
    d.subtree(under)
      .into_iter()
      .find(|i| {
        d.get(i)
          .is_some_and(|n| n.text.is_some() && n.bindings.contains_key("fill") && n.master_id.is_none())
      })
      .unwrap()
  };
  let check = |what: &str, doc: Document| {
    let mut inc = doc.clone();
    variables::normalize_since(&mut inc, &base);
    variables::apply_since(&mut inc, &base);
    let mut full = doc.clone();
    variables::normalize(&mut full);
    variables::apply(&mut full);
    assert!(inc == full, "{what}: incremental differs from the whole pass");
    assert!(
      inc != doc || what.contains("nothing"),
      "{what}: the edit changed nothing, so it tests nothing"
    );
  };
  let (d, l) = (pinned(&base), plain(&base));
  // Into and out of a pinned frame (the bound layer keeps its own binding).
  let t_plain = bound_text(&base, &l);
  let mut doc = base.clone();
  doc.reparent(&t_plain, Some(&d), None, true);
  check("a bound layer moved into a Dark screen", doc);
  let t_dark = bound_text(&base, &d);
  let mut doc = base.clone();
  doc.reparent(&t_dark, Some(&l), None, true);
  check("a bound layer moved out of a Dark screen", doc);
  // A pin set and cleared on a top-level frame with a whole tree below it.
  let mut doc = base.clone();
  doc.get_mut(&l).unwrap().variable_modes.insert("c_theme".into(), "m_dark".into());
  check("a pin set on a screen", doc);
  let mut doc = base.clone();
  doc.get_mut(&d).unwrap().variable_modes.clear();
  check("a pin cleared on a screen", doc);
  // A pin by name on a layer (normalised to ids), and a binding by name.
  let mut doc = base.clone();
  doc.get_mut(&l).unwrap().variable_modes.insert("Theme".into(), "Dark".into());
  doc.get_mut(&t_plain).unwrap().bindings.insert("fill".into(), "Theme/Muted".into());
  check("pins and bindings given by name", doc);
  // A bound layer added to a Dark screen.
  let mut doc = base.clone();
  let mut copy = (**base.nodes.get(&t_plain).unwrap()).clone();
  copy.id = "added".into();
  copy.parent = Some(d.clone());
  doc.nodes.insert("added".into(), Arc::new(copy));
  doc.get_mut(&d).unwrap().children.push("added".into());
  check("a bound layer added to a Dark screen", doc);
  // A changed fill on a bound layer is put back; a binding removed leaves the colour as it is.
  let mut doc = base.clone();
  doc.get_mut(&t_plain).unwrap().fills = vec![crate::model::Paint::solid("#ABCDEF")];
  check("a bound fill edited", doc);
  let mut doc = base.clone();
  doc.get_mut(&t_plain).unwrap().bindings.clear();
  doc.get_mut(&t_plain).unwrap().fills = vec![crate::model::Paint::solid("#ABCDEF")];
  check("nothing to resolve once unbound", doc);
  // A variable value, an alias target and a deleted variable (every bound layer is looked at).
  let mut cols = variables::plain(&base.variables);
  Arc::make_mut(&mut cols[0].variables[0])
    .values
    .insert("m_light".into(), json!("#112233"));
  let mut doc = base.clone();
  doc.variables = variables::intern(cols.clone(), &base.variables);
  check("a variable value changed", doc);
  Arc::make_mut(&mut cols[0].variables[3])
    .values
    .insert("m_dark".into(), json!({"alias": "v_muted"}));
  let mut doc = base.clone();
  doc.variables = variables::intern(cols.clone(), &base.variables);
  check("an alias retargeted", doc);
  cols[0].variables.remove(1);
  let mut doc = base.clone();
  doc.variables = variables::intern(cols, &base.variables);
  check("a variable deleted (bindings left dangling)", doc);
}

/// `copy` as it was before the clipboard was written straight to a string: a `Value` tree built
/// with `json!`.
fn copy_as_before(e: &Engine, ids: &[NodeId]) -> String {
  let roots = ops::paint_order_slow(&e.doc, &ops::top_most_slow(&e.doc, ids));
  let mut nodes: Vec<Node> = roots.iter().flat_map(|r| e.clipboard_subtree(r)).collect();
  let mut seen: HashSet<NodeId> = nodes.iter().map(|n| n.id.clone()).collect();
  let mut wanted: Vec<NodeId> = nodes
    .iter()
    .filter_map(|n| n.instance.as_ref())
    .map(|i| i.component_id.clone())
    .collect();
  let mut components: Vec<Node> = Vec::new();
  while let Some(cid) = wanted.pop() {
    if seen.contains(&cid) || e.doc.get(&cid).map(|c| c.kind != NodeType::Component).unwrap_or(true) {
      continue;
    }
    let sub = e.clipboard_subtree(&cid);
    seen.extend(sub.iter().map(|n| n.id.clone()));
    wanted.extend(sub.iter().filter_map(|n| n.instance.as_ref()).map(|i| i.component_id.clone()));
    components.extend(sub);
  }
  let tokens = crate::clipboard::attach(&e.doc, &mut nodes, &mut components);
  let mut out = json!({ "type": CLIPBOARD_TAG, "roots": roots, "nodes": nodes, "components": components });
  for (key, value) in tokens {
    out[key] = value;
  }
  out.to_string()
}

/// The clipboard text is the same JSON value as before (screens with variables, instances and a
/// style; a thousand layers), and both texts paste to the same layers.
#[test]
fn copy_writes_the_clipboard_the_old_way_and_both_paste_alike() {
  let mut e = build();
  let sid = e.doc.nodes.values().find(|n| n.name.starts_with("Screen ")).unwrap().id.clone();
  let layer = e
    .doc
    .subtree(&sid)
    .into_iter()
    .find(|i| e.doc.get(i).is_some_and(|n| n.kind == NodeType::Rectangle && n.master_id.is_none()))
    .unwrap();
  e.dispatch(Command::AddColorStyle {
    name: "Brand".into(),
    color: "#445566".into(),
  })
  .unwrap();
  let style = e.doc.styles.colors[0].id.clone();
  e.dispatch(Command::ApplyStyle {
    ids: vec![layer.clone()],
    style_id: style,
    kind: None,
  })
  .unwrap();
  let all: Vec<NodeId> = e
    .doc
    .nodes
    .values()
    .filter(|n| n.parent.is_none() && n.kind == NodeType::Frame)
    .take(6)
    .map(|n| n.id.clone())
    .collect();
  for ids in [
    vec![sid.clone()],
    vec![layer.clone()],
    vec![sid.clone(), layer.clone()],
    all,
    vec![],
  ] {
    let new: Value = serde_json::from_str(&e.copy(&ids)).unwrap();
    let old: Value = serde_json::from_str(&copy_as_before(&e, &ids)).unwrap();
    assert_eq!(new, old, "copy of {} layers", ids.len());
  }
  // Pasting into a frame, and into another file (which lacks the variables and the style).
  let ids = vec![sid.clone(), layer];
  let (new, old) = (e.copy(&ids), copy_as_before(&e, &ids));
  let frame = e
    .doc
    .nodes
    .values()
    .find(|n| n.name == "Row 0" && n.master_id.is_none())
    .unwrap()
    .id
    .clone();
  let paste = |text: String, parent: Option<NodeId>, into: &mut Engine| {
    into
      .dispatch(Command::Paste {
        data: text,
        parent,
        x: Some(10.0),
        y: Some(20.0),
      })
      .unwrap()
  };
  let (mut a, mut b) = (build(), build());
  assert_eq!(
    paste(new.clone(), Some(frame.clone()), &mut a),
    paste(old.clone(), Some(frame), &mut b)
  );
  assert!(a.doc == b.doc, "the same layers either way");
  let mut fresh_new = Engine::new(Box::new(HeuristicMeasurer), 3);
  let mut fresh_old = Engine::new(Box::new(HeuristicMeasurer), 3);
  let (rn, ro) = (paste(new, None, &mut fresh_new), paste(old, None, &mut fresh_old));
  assert_eq!(rn, ro);
  assert!(fresh_new.doc == fresh_old.doc);
  assert!(
    !fresh_new.doc.variables.is_empty() && !fresh_new.doc.styles.colors.is_empty(),
    "tokens came along"
  );
}

/// A clipboard text from an older editor (no `components`, keys in another order, extra keys)
/// still pastes, and texts that aren't ours are refused with the same words as before.
#[test]
fn old_clipboard_texts_still_paste_and_bad_ones_are_refused_alike() {
  let e = build();
  let sid = e.doc.nodes.values().find(|n| n.name.starts_with("Screen ")).unwrap().id.clone();
  let mut v: Value = serde_json::from_str(&e.copy(&[sid])).unwrap();
  v.as_object_mut().unwrap().remove("components");
  v["somethingNew"] = json!({"from": "a later editor"});
  let text = serde_json::to_string(&v).unwrap();
  let mut other = Engine::new(Box::new(HeuristicMeasurer), 4);
  let r = other
    .dispatch(Command::Paste {
      data: text,
      parent: None,
      x: None,
      y: None,
    })
    .unwrap();
  assert!(r["created"].as_array().is_some_and(|c| c.len() == 1));
  assert!(!other.doc.variables.is_empty());
  let mut refused = |data: &str| {
    other
      .dispatch(Command::Paste {
        data: data.into(),
        parent: None,
        x: None,
        y: None,
      })
      .unwrap_err()
  };
  assert_eq!(refused("not json"), "clipboard does not contain Designotron layers");
  assert_eq!(
    refused("{\"type\":\"other\",\"nodes\":[],\"roots\":[]}"),
    "clipboard does not contain Designotron layers"
  );
  assert_eq!(refused("[1]"), "clipboard does not contain Designotron layers");
  assert!(refused("{\"type\":\"designotron/nodes\",\"nodes\":5,\"roots\":[]}").contains("expected a sequence"));
  assert!(refused("{\"type\":\"designotron/nodes\",\"nodes\":[],\"roots\":7}").contains("expected a sequence"));
}

/// create_nodes lays out only the screens it touched, and ends with the file the whole-file layout
/// gave: top-level layers, a layer inside one, and a layer inside a component main.
#[test]
fn create_nodes_lays_out_only_what_it_touched() {
  let spec = |name: &str| {
    json!({"type":"frame","name":name,"width":200,"layout":{"direction":"vertical","gap":4,"padding":8},"children":[
    {"type":"text","text":"hello world, a line long enough to wrap in a narrow frame","width":"fill"},{"type":"rectangle","width":30,"height":30}]})
  };
  let (mut a, mut b) = (build(), build());
  b.reference = true;
  let main = a.doc.components().first().map(|c| c.id.clone()).unwrap();
  let inner = a
    .doc
    .nodes
    .values()
    .find(|n| n.name == "Row 1" && n.master_id.is_none())
    .unwrap()
    .id
    .clone();
  for parent in [None, Some(inner), Some(main)] {
    let mut input = json!({ "nodes": [spec("One"), spec("Two")] });
    if let Some(p) = &parent {
      input["parentId"] = json!(p);
    }
    let cmd = Command::Ai {
      tool: "create_nodes".into(),
      input,
    };
    let (ra, rb) = (a.dispatch(cmd.clone()).unwrap(), b.dispatch(cmd).unwrap());
    assert_eq!(ra, rb, "parent {parent:?}");
    assert!(a.doc == b.doc, "parent {parent:?}: documents differ");
  }
}

/// A measurer that kerns "AV" like a real font does (the browser's `measureText` isn't additive).
struct Kern;
impl crate::text::TextMeasurer for Kern {
  fn measure(&self, text: &str, font: &crate::text::FontSpec) -> f64 {
    let n = text.chars().count() as f64;
    n * font.size * 0.6 - text.matches("AV").count() as f64 * font.size * 0.2 + n * font.letter_spacing
  }
}

/// With a measurer whose widths aren't additive, changing the colour or link of a text run (which
/// splits or merges the measured pieces) gives the same layout whether or not layout is skipped.
#[test]
fn run_colour_and_link_changes_lay_out_like_the_whole_file_passes_with_a_kerning_measurer() {
  let make = |reference: bool| {
    let mut e = Engine::new(Box::new(Kern), 3);
    e.reference = reference;
    let r = e
      .dispatch(Command::Ai {
        tool: "create_nodes".into(),
        input: json!({"nodes":[{"type":"frame","name":"F","layout":{"direction":"horizontal","gap":0,"padding":0},"children":[
          {"type":"text","name":"T","text":"AVAVAVAV","fontSize":20},{"type":"rectangle","name":"R","width":10,"height":10}]}]}),
      })
      .unwrap();
    let f = r["created"][0]["id"].as_str().unwrap().to_string();
    (e, f)
  };
  let (mut a, f) = make(false);
  let (mut b, _) = make(true);
  let t = a.doc.get(&f).unwrap().children[0].clone();
  let steps = [
    Command::StyleText {
      id: t.clone(),
      start: 1,
      end: 2,
      style: json!({"color": "#FF0000"}),
      clear: vec![],
    },
    Command::StyleText {
      id: t.clone(),
      start: 3,
      end: 4,
      style: json!({"link": "https://example.com"}),
      clear: vec![],
    },
    Command::Update {
      ids: vec![t.clone()],
      patch: json!({"text": {"runs": [{"start": 0, "end": 1, "color": "#FF0000"}, {"start": 1, "end": 2, "color": "#0000FF"}]}}),
    },
    Command::Update {
      ids: vec![t.clone()],
      patch: json!({"text": {"runs": [{"start": 0, "end": 1, "color": "#FF0000"}, {"start": 1, "end": 2, "color": "#FF0000"}]}}),
    },
    Command::Update {
      ids: vec![t.clone()],
      patch: json!({"text": {"runs": []}}),
    },
  ];
  for c in steps {
    let (ra, rb) = (a.dispatch(c.clone()), b.dispatch(c.clone()));
    assert_eq!(ra, rb);
    assert!(a.doc == b.doc, "{c:?}: the documents differ");
  }
}
