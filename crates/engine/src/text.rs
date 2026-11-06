//! Text measurement, mixed-style runs and line breaking. The browser build
//! measures with a real canvas; native builds (bridge, tests) use a width heuristic.

use crate::model::{Node, TextAutoResize, TextDecoration, TextProps, TextRun};

pub struct FontSpec<'a> {
  pub family: &'a str,
  pub size: f64,
  pub weight: u32,
  pub italic: bool,
  pub letter_spacing: f64,
}

pub trait TextMeasurer {
  /// Advance width of `text` in px, including letter spacing.
  fn measure(&self, text: &str, font: &FontSpec) -> f64;
}

/// Approximate glyph widths for a typical sans-serif.
pub struct HeuristicMeasurer;

impl TextMeasurer for HeuristicMeasurer {
  fn measure(&self, text: &str, font: &FontSpec) -> f64 {
    let weight_factor = 1.0 + (font.weight as f64 - 400.0) / 4000.0;
    let em: f64 = text
      .chars()
      .map(|c| match c {
        'i' | 'l' | 'j' | '.' | ',' | ':' | ';' | '\'' | '|' | '!' => 0.26,
        ' ' => 0.27,
        'f' | 't' | 'r' | 'I' | '(' | ')' | '[' | ']' => 0.36,
        'm' | 'w' => 0.82,
        'M' | 'W' => 0.9,
        c if c.is_ascii_digit() => 0.56,
        c if c.is_uppercase() => 0.66,
        c if c.is_ascii() => 0.53,
        _ => 0.9,
      })
      .sum();
    let n = text.chars().count() as f64;
    em * font.size * weight_factor + n * font.letter_spacing
  }
}

/// Fully resolved style of a span of text.
#[derive(Debug, Clone, PartialEq)]
pub struct SpanStyle {
  pub family: String,
  pub size: f64,
  pub weight: u32,
  pub italic: bool,
  pub letter_spacing: f64,
  pub decoration: TextDecoration,
  /// Overrides the layer fill when set.
  pub color: Option<String>,
  pub link: Option<String>,
  /// The range sets its own decoration (even "none"): a link then doesn't add an underline.
  pub own_decoration: bool,
}

impl SpanStyle {
  pub fn base(p: &TextProps) -> Self {
    SpanStyle {
      family: p.font_family.clone(),
      size: p.font_size,
      weight: p.font_weight,
      italic: p.italic,
      letter_spacing: p.letter_spacing,
      decoration: p.decoration,
      color: None,
      link: None,
      own_decoration: false,
    }
  }

  fn with(&self, r: &TextRun) -> Self {
    SpanStyle {
      family: r.font_family.clone().unwrap_or_else(|| self.family.clone()),
      size: r.font_size.unwrap_or(self.size),
      weight: r.font_weight.unwrap_or(self.weight),
      italic: r.italic.unwrap_or(self.italic),
      letter_spacing: r.letter_spacing.unwrap_or(self.letter_spacing),
      decoration: r.decoration.unwrap_or(self.decoration),
      color: r.color.clone().or_else(|| self.color.clone()),
      link: r.link.clone().or_else(|| self.link.clone()),
      own_decoration: r.decoration.is_some() || self.own_decoration,
    }
  }

  fn font(&self) -> FontSpec<'_> {
    FontSpec {
      family: &self.family,
      size: self.size,
      weight: self.weight,
      italic: self.italic,
      letter_spacing: self.letter_spacing,
    }
  }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
  pub text: String,
  pub width: f64,
  pub style: SpanStyle,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
  pub text: String,
  pub width: f64,
  pub height: f64,
  /// Top of the line inside the layout, including paragraph spacing above it.
  pub top: f64,
  pub segments: Vec<Segment>,
  /// The line ends because the paragraph wrapped, not at a hard break or the end: justified
  /// text stretches only these.
  pub soft_wrap: bool,
  /// Char range of the display text this line consumed: trailing spaces trimmed at a soft wrap
  /// belong to it, the `\n` after it does not.
  pub start: usize,
  pub end: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextLayout {
  pub lines: Vec<TextLine>,
  pub width: f64,
  pub height: f64,
  /// Base line height (unstyled text).
  pub line_height: f64,
}

/// A piece of text with one style.
struct Piece {
  text: String,
  style: usize,
  /// Char index of the piece's first character in the display text.
  start: usize,
}

/// Breaks text into lines. `max_width` of `None` disables wrapping. Does not truncate.
pub fn layout_text(props: &TextProps, max_width: Option<f64>, m: &dyn TextMeasurer) -> TextLayout {
  layout_limited(props, max_width, None, m)
}

/// Number of lines a text may show, or `None` for all. `max_lines` always limits; `truncate`
/// alone limits fixed-size text to the lines that fit its height.
pub fn line_limit(props: &TextProps, height: Option<f64>) -> Option<usize> {
  if let Some(n) = props.max_lines {
    return Some(n.max(1) as usize);
  }
  match (props.truncate, props.auto_resize, height) {
    (true, TextAutoResize::None, Some(h)) => Some(((h / props.line_height_px().max(1.0)).floor() as usize).max(1)),
    _ => None,
  }
}

/// Lays out a text with an optional line limit; the last visible line ends in "…" when text
/// was cut.
pub fn layout_limited(props: &TextProps, max_width: Option<f64>, limit: Option<usize>, m: &dyn TextMeasurer) -> TextLayout {
  let text = props.display_text();
  let chars: Vec<char> = text.chars().collect();
  let (styles, char_style) = resolve_styles(props, chars.len());
  let lh_of = |s: &SpanStyle| props.line_height.unwrap_or(s.size * 1.2);
  let base_lh = props.line_height_px();

  let mut lines: Vec<TextLine> = Vec::new();
  // Index of each paragraph's first line.
  let mut para_starts: Vec<usize> = Vec::new();
  let mut offset = 0;
  for para in text.split('\n') {
    para_starts.push(lines.len());
    let n = para.chars().count();
    let para_start = offset;
    let words = split_words(&chars[offset..offset + n], &char_style[offset..offset + n], offset);
    offset += n + 1;
    let mut cur: Vec<Piece> = Vec::new();
    let mut cur_w = 0.0;
    let measure = |p: &Piece| m.measure(&p.text, &styles[p.style].font());
    let trimmed_width = |pieces: &[Piece]| -> f64 {
      let mut w: f64 = pieces.iter().map(measure).sum();
      if let Some(last) = pieces.last() {
        let t = last.text.trim_end();
        if t.len() != last.text.len() {
          w -= measure(last) - m.measure(t, &styles[last.style].font());
        }
      }
      w
    };
    for word in words {
      let word_w: f64 = word.iter().map(measure).sum();
      let mw = max_width.filter(|w| *w > 0.0).unwrap_or(f64::INFINITY);
      let word_fit_w = trimmed_width(&word);
      // A word wider than the whole line never fits, even alone on a line.
      let fits = if cur.is_empty() {
        word_fit_w <= mw + 0.01
      } else {
        cur_w + word_fit_w <= mw + 0.01
      };
      if fits {
        cur_w += word_w;
        for p in word {
          push_piece(&mut cur, p);
        }
        continue;
      }
      if !cur.is_empty() {
        lines.push(make_line(std::mem::take(&mut cur), para_start, &styles, m, lh_of, base_lh));
      }
      cur_w = 0.0;
      if word_fit_w > mw + 0.01 {
        // Overlong words break by character.
        for piece in word {
          for (char_i, c) in piece.text.chars().enumerate() {
            let p = Piece {
              text: c.to_string(),
              style: piece.style,
              start: piece.start + char_i,
            };
            let w = measure(&p);
            if !cur.is_empty() && cur_w + w > mw && c != ' ' {
              lines.push(make_line(std::mem::take(&mut cur), para_start, &styles, m, lh_of, base_lh));
              cur_w = 0.0;
            }
            cur_w += w;
            push_piece(&mut cur, p);
          }
        }
      } else {
        cur_w = word_w;
        cur = word;
      }
    }
    lines.push(make_line(cur, para_start, &styles, m, lh_of, base_lh));
  }
  if let Some(limit) = limit.filter(|l| *l < lines.len()) {
    // Blank lines after the limit are no content: nothing is cut then.
    let cut = lines[limit..].iter().any(|l| !l.text.is_empty());
    lines.truncate(limit);
    if cut {
      ellipsize(lines.last_mut().unwrap(), max_width, &styles[0], m);
    }
  }
  // Stack the lines, adding paragraph spacing before every paragraph but the first.
  let mut top = 0.0;
  let mut next_para = 1;
  let count = lines.len();
  for (i, line) in lines.iter_mut().enumerate() {
    if para_starts.get(next_para) == Some(&i) {
      top += props.paragraph_spacing;
      next_para += 1;
    }
    line.top = top;
    line.soft_wrap = i + 1 < count && para_starts.get(next_para) != Some(&(i + 1));
    top += line.height;
  }
  let width = lines.iter().map(|l| l.width).fold(0.0, f64::max);
  TextLayout {
    lines,
    width,
    height: top,
    line_height: base_lh,
  }
}

/// Replaces the end of a line with "…" so the line, ellipsis included, fits `max_width`.
fn ellipsize(line: &mut TextLine, max_width: Option<f64>, base: &SpanStyle, m: &dyn TextMeasurer) {
  const ELLIPSIS: char = '\u{2026}';
  let style = line.segments.last().map(|s| s.style.clone()).unwrap_or_else(|| base.clone());
  let ell = m.measure(&ELLIPSIS.to_string(), &style.font());
  let width = |segs: &[Segment]| segs.iter().map(|s| s.width).sum::<f64>();
  // Spaces before the cut would only make a gap before the ellipsis.
  let trim_spaces = |segs: &mut Vec<Segment>| {
    while let Some(last) = segs.last_mut() {
      let t = last.text.trim_end().to_string();
      if t.is_empty() {
        segs.pop();
      } else {
        if t.len() != last.text.len() {
          last.width = m.measure(&t, &last.style.font());
          last.text = t;
        }
        break;
      }
    }
  };
  trim_spaces(&mut line.segments);
  if let Some(mw) = max_width.filter(|w| *w > 0.0) {
    while width(&line.segments) + ell > mw + 0.01 {
      let Some(last) = line.segments.last_mut() else { break };
      last.text.pop();
      last.width = m.measure(&last.text, &last.style.font());
      if last.text.is_empty() {
        line.segments.pop();
      }
      trim_spaces(&mut line.segments);
    }
  }
  match line.segments.last_mut() {
    Some(last) if last.style == style => {
      last.text.push(ELLIPSIS);
      last.width = m.measure(&last.text, &style.font());
    }
    _ => line.segments.push(Segment {
      text: ELLIPSIS.to_string(),
      width: ell,
      style,
    }),
  }
  line.text = line.segments.iter().map(|s| s.text.as_str()).collect();
  line.width = width(&line.segments);
}

/// Style table and per-character style index for the text.
fn resolve_styles(props: &TextProps, len: usize) -> (Vec<SpanStyle>, Vec<usize>) {
  let base = SpanStyle::base(props);
  let mut styles = vec![base.clone()];
  let mut per_char = vec![0usize; len];
  for r in &props.runs {
    let s = base.with(r);
    let idx = match styles.iter().position(|x| *x == s) {
      Some(i) => i,
      None => {
        styles.push(s);
        styles.len() - 1
      }
    };
    for slot in per_char.iter_mut().take(r.end.min(len)).skip(r.start.min(len)) {
      *slot = idx;
    }
  }
  (styles, per_char)
}

/// Words (with trailing spaces) as style pieces.
fn split_words(chars: &[char], styles: &[usize], base: usize) -> Vec<Vec<Piece>> {
  let mut words: Vec<Vec<Piece>> = Vec::new();
  let mut cur: Vec<Piece> = Vec::new();
  let mut prev_space = false;
  for (i, c) in chars.iter().enumerate() {
    if prev_space && *c != ' ' {
      words.push(std::mem::take(&mut cur));
    }
    push_piece(
      &mut cur,
      Piece {
        text: c.to_string(),
        style: styles[i],
        start: base + i,
      },
    );
    prev_space = *c == ' ';
  }
  if !cur.is_empty() {
    words.push(cur);
  }
  words
}

fn push_piece(pieces: &mut Vec<Piece>, p: Piece) {
  match pieces.last_mut() {
    Some(last) if last.style == p.style => last.text.push_str(&p.text),
    _ => pieces.push(p),
  }
}

fn make_line(
  pieces: Vec<Piece>,
  para_start: usize,
  styles: &[SpanStyle],
  m: &dyn TextMeasurer,
  lh_of: impl Fn(&SpanStyle) -> f64,
  base_lh: f64,
) -> TextLine {
  let mut segments: Vec<Segment> = Vec::new();
  let count = pieces.len();
  let start = pieces.first().map_or(para_start, |p| p.start);
  let end = pieces.last().map_or(para_start, |p| p.start + p.text.chars().count());
  for (i, p) in pieces.into_iter().enumerate() {
    let text = if i + 1 == count { p.text.trim_end().to_string() } else { p.text };
    if text.is_empty() {
      continue;
    }
    let style = styles[p.style].clone();
    let width = m.measure(&text, &style.font());
    segments.push(Segment { text, width, style });
  }
  let height = segments.iter().map(|s| lh_of(&s.style)).fold(0.0, f64::max);
  TextLine {
    text: segments.iter().map(|s| s.text.as_str()).collect(),
    width: segments.iter().map(|s| s.width).sum(),
    height: height.max(base_lh),
    top: 0.0,
    segments,
    soft_wrap: false,
    start,
    end,
  }
}

/// Lays out a text for its box: auto-resize, line limit and, for auto-width text, the wrap
/// width its layer's `max_width` imposes.
pub fn layout_for_box(props: &TextProps, width: f64, height: Option<f64>, max_width: Option<f64>, m: &dyn TextMeasurer) -> TextLayout {
  layout_for_box_with(props, width, height, max_width, false, m)
}

/// `layout_for_box`, optionally ignoring the line limit: text being edited shows all its lines.
pub fn layout_for_box_with(
  props: &TextProps,
  width: f64,
  height: Option<f64>,
  max_width: Option<f64>,
  full: bool,
  m: &dyn TextMeasurer,
) -> TextLayout {
  let limit = if full { None } else { line_limit(props, height) };
  match props.auto_resize {
    TextAutoResize::Width => {
      let lay = layout_limited(props, None, limit, m);
      match max_width {
        Some(mx) if lay.width > mx => layout_limited(props, Some(mx.max(1.0)), limit, m),
        _ => lay,
      }
    }
    TextAutoResize::Height | TextAutoResize::None => layout_limited(props, Some(width), limit, m),
  }
}

/// Layout of a text node in its current box.
pub fn layout_of_node(n: &Node, props: &TextProps, m: &dyn TextMeasurer) -> TextLayout {
  layout_for_box(props, n.width, Some(n.height), n.max_width, m)
}

/// One line of a text for the editor's caret and selection.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CaretLine {
  /// Top in layer px, vertical alignment included.
  pub top: f64,
  pub height: f64,
  /// Char range in the layer's `characters` (not the case-converted display text).
  pub start: usize,
  pub end: usize,
  /// `end - start + 1` x positions in layer px: the left edge of every char and the end. Empty
  /// for lines outside the range asked for (see `caret_geometry`).
  pub xs: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CaretGeometry {
  pub lines: Vec<CaretLine>,
  /// Height of all lines.
  pub height: f64,
}

/// Where every character of a text node sits, as drawn by the renderer. With `full`, the line
/// limit is ignored (editing shows all the text). Measuring every character of a long text on
/// each keystroke is wasted work: with `range` (chars) only the lines it touches, and one line
/// either side (for ArrowUp and ArrowDown), get their `xs`.
pub fn caret_geometry(n: &Node, props: &TextProps, m: &dyn TextMeasurer, full: bool, range: Option<(usize, usize)>) -> CaretGeometry {
  use crate::model::TextAlignH;
  let lay = layout_for_box_with(props, n.width, Some(n.height), n.max_width, full, m);
  let offset = match props.align_v {
    crate::model::TextAlignV::Top => 0.0,
    crate::model::TextAlignV::Middle => (n.height - lay.height) / 2.0,
    crate::model::TextAlignV::Bottom => n.height - lay.height,
  };
  let shown = props.display_text().chars().count();
  let real = props.characters.chars().count();
  // A case change can alter the char count (ß becomes SS): scale indices back proportionally.
  let back = |i: usize| -> usize {
    if shown == real || shown == 0 {
      i
    } else {
      ((i as f64) * real as f64 / shown as f64).round() as usize
    }
  };
  let mut lines = Vec::with_capacity(lay.lines.len());
  // Lines whose positions are wanted.
  let wanted: Vec<bool> = match range {
    None => vec![true; lay.lines.len()],
    Some((a, b)) => {
      let hit: Vec<usize> = lay
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| back(l.end) >= a && back(l.start) <= b)
        .map(|(i, _)| i)
        .collect();
      let (lo, hi) = (
        hit.first().copied().unwrap_or(0),
        hit.last().copied().unwrap_or(lay.lines.len().saturating_sub(1)),
      );
      (0..lay.lines.len()).map(|i| i + 1 >= lo && i <= hi + 1).collect()
    }
  };
  for (li, line) in lay.lines.iter().enumerate() {
    if !wanted[li] {
      lines.push(CaretLine {
        top: offset + line.top,
        height: line.height,
        start: back(line.start),
        end: back(line.end),
        xs: Vec::new(),
      });
      continue;
    }
    let x0 = match props.align_h {
      TextAlignH::Left | TextAlignH::Justify => 0.0,
      TextAlignH::Center => (n.width - line.width) / 2.0,
      TextAlignH::Right => n.width - line.width,
    };
    // Justify adds the same gap to every space of a wrapped line (as the renderer does).
    let gap = if props.align_h == TextAlignH::Justify && line.soft_wrap && props.auto_resize != TextAutoResize::Width {
      let spaces = line.text.chars().filter(|c| matches!(*c, ' ' | '\u{a0}')).count();
      let extra = n.width - line.width;
      if spaces > 0 && extra > 0.01 {
        extra / spaces as f64
      } else {
        0.0
      }
    } else {
      0.0
    };
    let count = line.end - line.start;
    let mut xs = Vec::with_capacity(count + 1);
    xs.push(x0);
    let mut x = x0;
    for sg in &line.segments {
      // Measure growing prefixes so kerning and letter spacing within the segment are kept.
      let font = sg.style.font();
      let mut prefix = String::new();
      let mut prev = 0.0;
      for c in sg.text.chars() {
        prefix.push(c);
        let w = m.measure(&prefix, &font);
        let extra = if matches!(c, ' ' | '\u{a0}') { gap } else { 0.0 };
        x += w - prev + extra;
        prev = w;
        xs.push(x);
      }
      x = *xs.last().unwrap();
    }
    // Spaces the layout trimmed: at a soft wrap they are swallowed (pinned to the line end); on
    // a hard line they are really there, so the caret advances over them as you type them.
    if !line.soft_wrap && xs.len() < count + 1 {
      let font = line
        .segments
        .last()
        .map(|sg| sg.style.clone())
        .unwrap_or_else(|| SpanStyle::base(props));
      let w = m.measure(" ", &font.font());
      let mut x = *xs.last().unwrap();
      while xs.len() < count + 1 {
        x += w;
        xs.push(x);
      }
    }
    let end_x = *xs.last().unwrap();
    xs.resize(count + 1, end_x);
    xs.truncate(count + 1);
    lines.push(CaretLine {
      top: offset + line.top,
      height: line.height,
      start: back(line.start),
      end: back(line.end),
      xs,
    });
  }
  CaretGeometry { lines, height: lay.height }
}

/// Distance from the top of a text node to its first baseline (what baseline alignment lines
/// up): the line centre plus 0.35 em, as the renderer places mixed sizes.
pub fn first_baseline(n: &Node, props: &TextProps, m: &dyn TextMeasurer) -> f64 {
  let lay = layout_of_node(n, props, m);
  let offset = match props.align_v {
    crate::model::TextAlignV::Top => 0.0,
    crate::model::TextAlignV::Middle => (n.height - lay.height) / 2.0,
    crate::model::TextAlignV::Bottom => n.height - lay.height,
  };
  let Some(line) = lay.lines.first() else { return n.height };
  let size = if line.segments.is_empty() {
    props.font_size
  } else {
    line.segments.iter().map(|s| s.style.size).fold(0.0, f64::max)
  };
  offset + line.top + line.height / 2.0 + 0.35 * size
}

// ---------- Editing runs ----------

/// Keeps runs attached to the right characters after the text changes from `old` to `new`.
pub fn remap_runs(old: &str, new: &str, runs: &[TextRun]) -> Vec<TextRun> {
  let a: Vec<char> = old.chars().collect();
  let b: Vec<char> = new.chars().collect();
  let prefix = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
  let max_suffix = a.len().min(b.len()) - prefix;
  let suffix = a
    .iter()
    .rev()
    .zip(b.iter().rev())
    .take(max_suffix)
    .take_while(|(x, y)| x == y)
    .count();
  let del_end = a.len() - suffix; // removed old range: prefix..del_end
  let ins_len = b.len() - suffix - prefix;
  let map = |i: usize, is_end: bool| -> usize {
    if i < prefix || (i == prefix && !is_end) {
      i
    } else if i >= del_end {
      i - del_end + prefix + ins_len
    } else {
      // Inside the replaced range: collapse to the insertion point.
      prefix + if is_end { ins_len } else { 0 }
    }
  };
  let mut out: Vec<TextRun> = runs
    .iter()
    .map(|r| {
      // Typing at the end of a styled run extends it (like a word processor).
      let end = if r.end == prefix && del_end == prefix {
        prefix + ins_len
      } else {
        map(r.end, true)
      };
      TextRun {
        start: map(r.start, false),
        end,
        ..r.clone()
      }
    })
    .filter(|r| r.end > r.start)
    .collect();
  normalize_runs(&mut out, b.len());
  out
}

/// Applies style overrides (a run with `start`/`end` ignored) to `start..end`.
pub fn style_range(runs: &[TextRun], len: usize, start: usize, end: usize, patch: &TextRun, clear: &[&str]) -> Vec<TextRun> {
  let (start, end) = (start.min(len), end.min(len));
  if start >= end {
    return runs.to_vec();
  }
  // Explode into per-character override sets, apply, then re-merge.
  let mut per_char: Vec<TextRun> = vec![TextRun::default(); len];
  for r in runs {
    for slot in per_char.iter_mut().take(r.end.min(len)).skip(r.start.min(len)) {
      *slot = r.clone();
    }
  }
  for slot in per_char.iter_mut().take(end).skip(start) {
    merge_style(slot, patch);
    for key in clear {
      clear_key(slot, key);
    }
  }
  let mut out: Vec<TextRun> = Vec::new();
  for (i, r) in per_char.into_iter().enumerate() {
    match out.last_mut() {
      Some(last) if last.end == i && last.same_style(&r) => last.end = i + 1,
      _ => out.push(TextRun { start: i, end: i + 1, ..r }),
    }
  }
  normalize_runs(&mut out, len);
  out
}

fn merge_style(t: &mut TextRun, p: &TextRun) {
  if p.font_family.is_some() {
    t.font_family = p.font_family.clone();
  }
  if p.font_size.is_some() {
    t.font_size = p.font_size;
  }
  if p.font_weight.is_some() {
    t.font_weight = p.font_weight;
  }
  if p.italic.is_some() {
    t.italic = p.italic;
  }
  if p.color.is_some() {
    t.color = p.color.clone();
  }
  if p.decoration.is_some() {
    t.decoration = p.decoration;
  }
  if p.letter_spacing.is_some() {
    t.letter_spacing = p.letter_spacing;
  }
  if p.link.is_some() {
    t.link = p.link.clone();
  }
}

fn clear_key(t: &mut TextRun, key: &str) {
  match key {
    "fontFamily" => t.font_family = None,
    "fontSize" => t.font_size = None,
    "fontWeight" => t.font_weight = None,
    "italic" => t.italic = None,
    "color" => t.color = None,
    "decoration" => t.decoration = None,
    "letterSpacing" => t.letter_spacing = None,
    "link" => t.link = None,
    _ => {}
  }
}

/// Sorts, clamps, drops empty/plain runs and merges adjacent identical ones.
pub fn normalize_runs(runs: &mut Vec<TextRun>, len: usize) {
  for r in runs.iter_mut() {
    r.start = r.start.min(len);
    r.end = r.end.min(len);
  }
  runs.retain(|r| r.end > r.start && !r.is_plain());
  runs.sort_by_key(|r| r.start);
  let mut merged: Vec<TextRun> = Vec::new();
  for r in runs.drain(..) {
    match merged.last_mut() {
      Some(last) if last.end >= r.start && last.same_style(&r) => last.end = last.end.max(r.end),
      _ => merged.push(r),
    }
  }
  *runs = merged;
}

#[cfg(test)]
mod tests {
  use super::*;

  fn bold(start: usize, end: usize) -> TextRun {
    TextRun {
      start,
      end,
      font_weight: Some(700),
      ..Default::default()
    }
  }

  #[test]
  fn wraps_long_text() {
    let props = TextProps {
      characters: "hello world this is a long line".into(),
      ..Default::default()
    };
    let l = layout_text(&props, Some(80.0), &HeuristicMeasurer);
    assert!(l.lines.len() > 1);
    assert!(l.lines.iter().all(|x| x.width <= 80.0 + 0.01 || !x.text.contains(' ')));
  }

  #[test]
  fn long_word_breaks_by_character() {
    let props = TextProps {
      characters: "Supercalifragilisticexpialidocious and more".into(),
      ..Default::default()
    };
    let l = layout_text(&props, Some(120.0), &HeuristicMeasurer);
    assert_eq!(l.lines.len(), 3, "{:?}", l.lines.iter().map(|x| &x.text).collect::<Vec<_>>());
    assert!(l.lines.iter().all(|x| x.width <= 120.01), "no line passes the box");
    assert!(l.lines[0].width > 100.0, "the first line is filled before breaking");
    assert!(l.lines[0].text.starts_with("Super") && l.lines[1].text.starts_with("ti"));
    assert_eq!(l.lines[2].text, "and more");
    // A word that fits on its own line still moves down as a whole.
    let props = TextProps {
      characters: "abcdef ghijklm".into(),
      ..Default::default()
    };
    let l = layout_text(&props, Some(80.0), &HeuristicMeasurer);
    assert_eq!(l.lines.iter().map(|x| x.text.as_str()).collect::<Vec<_>>(), ["abcdef", "ghijklm"]);
  }

  #[test]
  fn max_lines_cut_with_ellipsis() {
    let mut props = TextProps {
      characters: "one two three four five six seven eight nine ten eleven twelve".into(),
      ..Default::default()
    };
    let all = layout_text(&props, Some(100.0), &HeuristicMeasurer);
    assert!(all.lines.len() > 3);
    props.max_lines = Some(2);
    let l = layout_limited(&props, Some(100.0), line_limit(&props, None), &HeuristicMeasurer);
    assert_eq!(l.lines.len(), 2);
    assert_eq!(l.height, 2.0 * 16.0 * 1.2);
    assert!(l.lines[1].text.ends_with('\u{2026}'), "{}", l.lines[1].text);
    assert!(!l.lines[0].text.contains('\u{2026}'));
    assert!(l.lines[1].width <= 100.01, "ellipsis included in the width");
    // Text that fits is left alone.
    props.max_lines = Some(20);
    let l = layout_limited(&props, Some(100.0), line_limit(&props, None), &HeuristicMeasurer);
    assert_eq!(l.lines.len(), all.lines.len());
    assert!(l.lines.iter().all(|x| !x.text.contains('\u{2026}')));
  }

  #[test]
  fn truncate_in_a_fixed_box_shows_the_lines_that_fit() {
    let props = TextProps {
      characters: "one two three four five six seven eight nine ten eleven twelve".into(),
      truncate: true,
      auto_resize: TextAutoResize::None,
      ..Default::default()
    };
    // 60 px tall at 19.2 px per line: three lines.
    assert_eq!(line_limit(&props, Some(60.0)), Some(3));
    assert_eq!(line_limit(&props, Some(5.0)), Some(1), "always at least one line");
    let l = layout_for_box(&props, 100.0, Some(60.0), None, &HeuristicMeasurer);
    assert_eq!(l.lines.len(), 3);
    assert!(l.lines[2].text.ends_with('\u{2026}'));
    // Without a fixed height there is nothing to cut at.
    let auto = TextProps {
      auto_resize: TextAutoResize::Height,
      ..props.clone()
    };
    assert_eq!(line_limit(&auto, Some(60.0)), None);
  }

  #[test]
  fn paragraph_spacing_separates_paragraphs() {
    let props = TextProps {
      characters: "a\nb\n\nc".into(),
      paragraph_spacing: 10.0,
      ..Default::default()
    };
    let l = layout_text(&props, None, &HeuristicMeasurer);
    let lh = 16.0 * 1.2;
    let tops: Vec<f64> = l.lines.iter().map(|x| x.top).collect();
    assert_eq!(tops, vec![0.0, lh + 10.0, 2.0 * (lh + 10.0), 3.0 * (lh + 10.0)]);
    assert_eq!(l.height, 4.0 * lh + 30.0);
    // Wrapped lines inside one paragraph get no extra space.
    let props = TextProps {
      characters: "one two three four five six\nnext".into(),
      paragraph_spacing: 10.0,
      ..Default::default()
    };
    let l = layout_text(&props, Some(60.0), &HeuristicMeasurer);
    assert!(l.lines.len() > 2);
    assert_eq!(l.lines[1].top, lh);
    assert_eq!(l.height, l.lines.len() as f64 * lh + 10.0);
  }

  #[test]
  fn newline_splits() {
    let props = TextProps {
      characters: "a\nb".into(),
      ..Default::default()
    };
    let l = layout_text(&props, None, &HeuristicMeasurer);
    assert_eq!(l.lines.len(), 2);
    assert_eq!(l.height, 2.0 * 16.0 * 1.2);
  }

  #[test]
  fn runs_make_segments() {
    let props = TextProps {
      characters: "Hello bold world".into(),
      runs: vec![bold(6, 10)],
      ..Default::default()
    };
    let l = layout_text(&props, None, &HeuristicMeasurer);
    let segs: Vec<(&str, u32)> = l.lines[0].segments.iter().map(|s| (s.text.as_str(), s.style.weight)).collect();
    assert_eq!(segs, vec![("Hello ", 400), ("bold", 700), (" world", 400)]);
  }

  #[test]
  fn bigger_run_grows_line_height() {
    let props = TextProps {
      characters: "a b".into(),
      runs: vec![TextRun {
        start: 2,
        end: 3,
        font_size: Some(32.0),
        ..Default::default()
      }],
      ..Default::default()
    };
    let l = layout_text(&props, None, &HeuristicMeasurer);
    assert_eq!(l.lines[0].height, 32.0 * 1.2);
  }

  #[test]
  fn remap_insert_delete_and_extend() {
    // "Hello bold" with "bold" bold; insert "X" at start shifts the run.
    let r = remap_runs("Hello bold", "XHello bold", &[bold(6, 10)]);
    assert_eq!((r[0].start, r[0].end), (7, 11));
    // Typing at the end of the bold run extends it.
    let r = remap_runs("Hello bold", "Hello bolder", &[bold(6, 10)]);
    assert_eq!((r[0].start, r[0].end), (6, 12));
    // Deleting inside shrinks it; deleting all of it removes it.
    let r = remap_runs("Hello bold", "Hello bd", &[bold(6, 10)]);
    assert_eq!((r[0].start, r[0].end), (6, 8));
    assert!(remap_runs("Hello bold", "Hello ", &[bold(6, 10)]).is_empty());
  }

  #[test]
  fn style_range_splits_and_merges() {
    let r = style_range(
      &[bold(0, 10)],
      10,
      3,
      6,
      &TextRun {
        italic: Some(true),
        ..Default::default()
      },
      &[],
    );
    assert_eq!(r.len(), 3);
    assert_eq!(r[1].italic, Some(true));
    assert_eq!(r[1].font_weight, Some(700));
    // Clearing bold over the whole range leaves only the italic part.
    let r = style_range(&r, 10, 0, 10, &TextRun::default(), &["fontWeight"]);
    assert_eq!(r.len(), 1);
    assert_eq!((r[0].start, r[0].end), (3, 6));
  }
  fn text_node(chars: &str, w: f64, h: f64, f: impl FnOnce(&mut Node, &mut TextProps)) -> (Node, TextProps) {
    let mut n = crate::ops::default_node(crate::model::NodeType::Text, "t".into(), "T".into());
    n.width = w;
    n.height = h;
    let mut t = TextProps {
      characters: chars.into(),
      ..Default::default()
    };
    f(&mut n, &mut t);
    (n, t)
  }

  #[test]
  fn lines_know_their_char_ranges() {
    // Soft wrap: the first line owns the space it wrapped at.
    let props = TextProps {
      characters: "aaaa bbbb cccc".into(),
      ..Default::default()
    };
    let l = layout_text(&props, Some(50.0), &HeuristicMeasurer);
    let ranges: Vec<_> = l.lines.iter().map(|x| (x.start, x.end)).collect();
    assert_eq!(
      ranges,
      vec![(0, 5), (5, 10), (10, 14)],
      "{:?}",
      l.lines.iter().map(|x| &x.text).collect::<Vec<_>>()
    );
    // Hard breaks and an empty paragraph: the \n belongs to no line.
    let props = TextProps {
      characters: "ab\n\ncd".into(),
      ..Default::default()
    };
    let l = layout_text(&props, None, &HeuristicMeasurer);
    let ranges: Vec<_> = l.lines.iter().map(|x| (x.start, x.end)).collect();
    assert_eq!(ranges, vec![(0, 2), (3, 3), (4, 6)]);
    // An overlong word breaks by character and keeps contiguous ranges.
    let props = TextProps {
      characters: "Supercalifragilisticexpialidocious and".into(),
      ..Default::default()
    };
    let l = layout_text(&props, Some(120.0), &HeuristicMeasurer);
    assert_eq!(l.lines[0].start, 0);
    for w in l.lines.windows(2) {
      assert_eq!(w[0].end, w[1].start);
    }
    assert_eq!(l.lines.last().unwrap().end, props.characters.chars().count());
  }

  #[test]
  fn caret_xs_follow_alignment_spacing_and_sizes() {
    let (n, t) = text_node("abc", 200.0, 20.0, |_, _| {});
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    let xs = &g.lines[0].xs;
    assert_eq!(xs.len(), 4);
    assert_eq!(xs[0], 0.0);
    assert!((xs[3] - HeuristicMeasurer.measure("abc", &SpanStyle::base(&t).font())).abs() < 1e-9);
    // Centre and right shift the whole line.
    let (n, t) = text_node("abc", 200.0, 20.0, |_, t| t.align_h = crate::model::TextAlignH::Center);
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    let w = g.lines[0].xs[3] - g.lines[0].xs[0];
    assert!((g.lines[0].xs[0] - (200.0 - w) / 2.0).abs() < 1e-9);
    let (n, t) = text_node("abc", 200.0, 20.0, |_, t| t.align_h = crate::model::TextAlignH::Right);
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    assert!((g.lines[0].xs[3] - 200.0).abs() < 1e-9);
    // Letter spacing widens every char.
    let (n, t) = text_node("abc", 200.0, 20.0, |_, t| t.letter_spacing = 2.0);
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    let plain = text_node("abc", 200.0, 20.0, |_, _| {});
    let gp = caret_geometry(&plain.0, &plain.1, &HeuristicMeasurer, true, None);
    assert!((g.lines[0].xs[3] - gp.lines[0].xs[3] - 6.0).abs() < 1e-9);
    // A larger run advances more than a base char.
    let (n, t) = text_node("abc", 200.0, 40.0, |_, t| {
      t.runs = vec![TextRun {
        start: 1,
        end: 2,
        font_size: Some(32.0),
        ..Default::default()
      }]
    });
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    let xs = &g.lines[0].xs;
    assert!(xs[2] - xs[1] > 1.5 * (xs[1] - xs[0]), "{xs:?}");
  }

  #[test]
  fn caret_justify_widens_each_space_of_wrapped_lines() {
    let (n, t) = text_node("aa bb cc dd", 60.0, 60.0, |_, t| {
      t.align_h = crate::model::TextAlignH::Justify;
      t.auto_resize = TextAutoResize::None;
    });
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    assert!(g.lines.len() > 1);
    let first = &g.lines[0];
    assert!((first.xs[first.xs.len() - 1] - 60.0).abs() < 0.5, "{:?}", first.xs);
    // The last line is not stretched.
    let last = g.lines.last().unwrap();
    assert!(last.xs[last.xs.len() - 1] < 59.0);
  }

  #[test]
  fn caret_top_includes_paragraph_spacing_and_vertical_alignment() {
    let (n, t) = text_node("a\nb", 100.0, 100.0, |_, t| {
      t.paragraph_spacing = 10.0;
      t.align_v = crate::model::TextAlignV::Middle;
    });
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    let lh = g.lines[0].height;
    assert!((g.height - (2.0 * lh + 10.0)).abs() < 1e-9);
    assert!((g.lines[0].top - (100.0 - g.height) / 2.0).abs() < 1e-9);
    assert!((g.lines[1].top - g.lines[0].top - lh - 10.0).abs() < 1e-9);
    let (n, t) = text_node("a\nb", 100.0, 100.0, |_, t| t.align_v = crate::model::TextAlignV::Bottom);
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    assert!((g.lines[1].top + g.lines[1].height - 100.0).abs() < 1e-9);
  }

  #[test]
  fn caret_range_measures_only_nearby_lines() {
    let (n, t) = text_node("aaa bbb ccc ddd eee fff ggg hhh", 40.0, 200.0, |_, t| {
      t.auto_resize = TextAutoResize::None
    });
    let all = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    assert!(all.lines.len() >= 6, "{}", all.lines.len());
    // A caret inside line 3 measures lines 2 to 4 and leaves the others without positions.
    let at = all.lines[3].start + 1;
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, Some((at, at)));
    for (i, l) in g.lines.iter().enumerate() {
      assert_eq!(l.xs.is_empty(), !(2..=4).contains(&i), "line {i}");
      assert_eq!((l.start, l.end, l.top), (all.lines[i].start, all.lines[i].end, all.lines[i].top));
      if !l.xs.is_empty() {
        assert_eq!(l.xs, all.lines[i].xs);
      }
    }
  }

  #[test]
  fn caret_full_ignores_the_line_limit() {
    let (n, t) = text_node("one two three four five six seven", 60.0, 40.0, |_, t| {
      t.max_lines = Some(1);
      t.auto_resize = TextAutoResize::None;
    });
    assert_eq!(caret_geometry(&n, &t, &HeuristicMeasurer, false, None).lines.len(), 1);
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    assert!(g.lines.len() > 2);
    assert_eq!(g.lines.last().unwrap().end, t.characters.chars().count());
  }
}
