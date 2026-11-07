//! Paint servers and stroke outlines beyond plain colours: gradient handles, angular and
//! diamond gradients (SVG patterns, so they work as fill and stroke and rasterise in PNG
//! export), image crop rectangles and the filled ring that draws per-side strokes.

use std::f64::consts::TAU;

use crate::color::{self, Rgba};
use crate::geom::fmt;
use crate::model::{GradientHandles, GradientStop, ImageCrop, ImageFilters, ScaleMode, StrokeAlign};
use crate::render::stops_svg;

/// Whether an image source may be written into the SVG `href` (and so fetched by the editor):
/// `asset:` ids, `data:image/` URLs and absolute `http(s)://` URLs. Protocol-relative
/// (`//host`), scheme-without-slashes (`https:host`) and anything with whitespace or control
/// characters (browsers strip tabs and newlines inside a URL, so `ht<TAB>tps://` works) are out.
pub fn safe_image_src(src: &str) -> bool {
  let lower = src.to_ascii_lowercase();
  if src.chars().any(|c| c.is_control()) {
    return false;
  }
  if lower.starts_with("data:image/") {
    return true;
  }
  if src.chars().any(char::is_whitespace) {
    return false;
  }
  lower.starts_with("asset:") || lower.starts_with("https://") || lower.starts_with("http://")
}

/// `src` for an `href`, or empty when it isn't a safe image source.
pub fn image_href(src: &str) -> &str {
  if safe_image_src(src) {
    src
  } else {
    ""
  }
}

/// Wedges in an angular gradient, by the larger side of the layer: a wedge is one solid colour,
/// so bigger layers need finer steps to stay smooth. (A linear gradient across each wedge was
/// tried to save nodes: it bands near the centre, because the stripes are parallel, not rays.)
fn wedge_count(side: f64) -> usize {
  match side {
    s if s <= 160.0 => 72,
    s if s <= 600.0 => 120,
    s if s <= 1000.0 => 144,
    _ => 180,
  }
}
/// Each wedge reaches this many pixels (a third of the way out) into the next, hiding anti-aliasing seams.
const WEDGE_OVERLAP_PX: f64 = 2.0;

/// Handles of a gradient that has none: what the renderer draws today, in the unit box.
pub fn default_handles(angular: bool) -> GradientHandles {
  GradientHandles {
    start: [0.5, 0.5],
    end: if angular { [0.5, 0.0] } else { [1.0, 0.5] },
    width: [0.5, 1.0],
  }
}

/// CSS angle (0 = up, 90 = right) of the start-to-end line of a layer `w` x `h`.
pub fn handle_angle(hd: &GradientHandles, w: f64, h: f64) -> f64 {
  let dx = (hd.end[0] - hd.start[0]) * w;
  let dy = (hd.end[1] - hd.start[1]) * h;
  let deg = dx.atan2(-dy).to_degrees();
  (deg.rem_euclid(360.0) * 100.0).round() / 100.0
}

/// Where the start and end handles sit on the CSS gradient line of a `w` x `h` layer (0 and 1
/// are its two ends, which CSS puts at the box corners along the angle).
pub fn linear_extent(hd: &GradientHandles, w: f64, h: f64) -> (f64, f64) {
  let a = handle_angle(hd, w, h).to_radians();
  let (dx, dy) = (a.sin(), -a.cos());
  let len = (w * a.sin()).abs() + (h * a.cos()).abs();
  if len < 1e-9 {
    return (0.0, 1.0);
  }
  let at = |p: [f64; 2]| ((p[0] * w - w / 2.0) * dx + (p[1] * h - h / 2.0) * dy) / len + 0.5;
  (at(hd.start), at(hd.end))
}

/// Radii of the two axes as a percentage of the layer's width and height.
pub fn handle_radii(hd: &GradientHandles, w: f64, h: f64) -> (f64, f64) {
  let a = ((hd.end[0] - hd.start[0]) * w).hypot((hd.end[1] - hd.start[1]) * h);
  let b = ((hd.width[0] - hd.start[0]) * w).hypot((hd.width[1] - hd.start[1]) * h);
  (a / w.max(1.0) * 100.0, b / h.max(1.0) * 100.0)
}

/// `<linearGradient>` from the start handle to the end handle.
pub fn linear_def(id: &str, stops: &[GradientStop], opacity: f64, hd: &GradientHandles, w: f64, h: f64) -> String {
  format!(
    "<linearGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\">{}</linearGradient>",
    fmt(hd.start[0] * w),
    fmt(hd.start[1] * h),
    fmt(hd.end[0] * w),
    fmt(hd.end[1] * h),
    stops_svg(stops, opacity)
  )
}

/// `<radialGradient>` whose unit circle is mapped onto the ellipse the handles span.
pub fn radial_def(id: &str, stops: &[GradientStop], opacity: f64, hd: &GradientHandles, w: f64, h: f64) -> String {
  let ax = Axes::new(hd, w, h);
  format!(
    "<radialGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" cx=\"0\" cy=\"0\" r=\"1\" gradientTransform=\"{}\">{}</radialGradient>",
    ax.matrix(),
    stops_svg(stops, opacity)
  )
}

/// Pattern holding four quadrants whose linear gradients run perpendicular to the diamond's
/// edges: inside each quadrant |u| + |v| is linear, so this is exact. `None` when the axes
/// are parallel and there is no diamond to draw.
pub fn diamond_pattern(id: &str, stops: &[GradientStop], opacity: f64, hd: &GradientHandles, w: f64, h: f64, pad: f64) -> Option<String> {
  let ax = Axes::new(hd, w, h);
  let det = ax.det();
  if det.abs() < 1e-6 {
    return None;
  }
  // The pattern tile in axis space: farthest corner decides how far the quadrants must reach.
  let reach = ax
    .corners(w, h, pad)
    .iter()
    .map(|&p| {
      let [u, v] = ax.to_uv(p);
      u.abs().max(v.abs())
    })
    .fold(0.0_f64, f64::max)
    + 1.0;
  let overlap = (1.0 / ax.min_len().max(1e-6)).min(0.05);
  let stops = stops_svg(stops, opacity);
  let mut grads = String::new();
  let mut rects = String::new();
  for (i, (sx, sy)) in [(1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0), (1.0, -1.0)].into_iter().enumerate() {
    let gid = format!("{id}q{i}");
    grads.push_str(&format!(
      "<linearGradient id=\"{gid}\" gradientUnits=\"userSpaceOnUse\" x1=\"0\" y1=\"0\" x2=\"{}\" y2=\"{}\">{stops}</linearGradient>",
      fmt(sx * 0.5),
      fmt(sy * 0.5)
    ));
    let x = if sx > 0.0 { -overlap } else { -reach };
    let y = if sy > 0.0 { -overlap } else { -reach };
    rects.push_str(&format!(
      "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"url(#{gid})\"/>",
      fmt(x),
      fmt(y),
      fmt(reach + overlap),
      fmt(reach + overlap)
    ));
  }
  Some(format!(
    "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\">{grads}<g transform=\"translate({} {})\"><g transform=\"{}\">{rects}</g></g></pattern>",
    fmt(-pad),
    fmt(-pad),
    fmt(w + 2.0 * pad),
    fmt(h + 2.0 * pad),
    fmt(pad),
    fmt(pad),
    ax.matrix()
  ))
}

/// Pattern of wedges around the start handle; the sweep begins towards the end handle and runs
/// clockwise. Wedges are opaque solids, the paint's opacity sits on a group and stop alpha on a luminance mask, so overlaps
/// never composite twice. `None` when the stops are empty.
pub fn angular_pattern(id: &str, stops: &[GradientStop], opacity: f64, hd: &GradientHandles, w: f64, h: f64, pad: f64) -> Option<String> {
  let samples = Sampler::new(stops, opacity)?;
  let n = wedge_count(w.max(h));
  let (cx, cy) = (hd.start[0] * w, hd.start[1] * h);
  let (dx, dy) = ((hd.end[0] - hd.start[0]) * w, (hd.end[1] - hd.start[1]) * h);
  let start = if dx == 0.0 && dy == 0.0 {
    -std::f64::consts::FRAC_PI_2
  } else {
    dy.atan2(dx)
  };
  let far = [(-pad, -pad), (w + pad, -pad), (w + pad, h + pad), (-pad, h + pad)]
    .iter()
    .map(|(x, y)| (x - cx).hypot(y - cy))
    .fold(0.0_f64, f64::max)
    + 2.0;
  let ring = Ring { n, cx, cy, start, far };
  let translucent = samples.stops.iter().any(|s| s.1.a < 0.999);
  let colour = |t: f64| samples.at(t).0;
  let body = ring.wedges(&colour);
  let (mask_def, group_open) = if translucent {
    // Stop alpha as grey levels: white is opaque.
    let grey = |t: f64| {
      let a = (samples.at(t).1 / samples.opacity.max(1e-9)).clamp(0.0, 1.0);
      let v = (a * 255.0).round() as u8;
      Rgba { r: v, g: v, b: v, a: 1.0 }
    };
    let mid = format!("{id}m");
    (
      format!(
        "<mask id=\"{mid}\" maskUnits=\"userSpaceOnUse\" x=\"-100000\" y=\"-100000\" width=\"200000\" height=\"200000\">{}</mask>",
        ring.wedges(&grey)
      ),
      format!("<g mask=\"url(#{mid})\">"),
    )
  } else {
    (String::new(), "<g>".to_string())
  };
  let op = if samples.opacity < 0.999 {
    format!(" opacity=\"{}\"", fmt(samples.opacity))
  } else {
    String::new()
  };
  Some(format!(
    "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\">{mask_def}<g transform=\"translate({} {})\"{op}>{group_open}{body}</g></g></pattern>",
    fmt(-pad),
    fmt(-pad),
    fmt(w + 2.0 * pad),
    fmt(h + 2.0 * pad),
    fmt(pad),
    fmt(pad)
  ))
}

/// One decimal is plenty for wedge corners and keeps the markup small.
fn f1(v: f64) -> String {
  fmt((v * 10.0).round() / 10.0)
}

/// Geometry shared by the colour wedges and the alpha-mask wedges of one angular gradient.
struct Ring {
  n: usize,
  cx: f64,
  cy: f64,
  start: f64,
  far: f64,
}

impl Ring {
  /// A disc of the closing colour (so no seam can show the background), then the wedges.
  /// Each wedge reaches a little into the next; the last one does not reach into the first.
  fn wedges(&self, colour: &dyn Fn(f64) -> Rgba) -> String {
    let step = TAU / self.n as f64;
    let overlap = (WEDGE_OVERLAP_PX / (self.far * 0.3)).min(step * 0.5);
    let rim = self.far / ((step + overlap) / 2.0).cos();
    let at = |a: f64| (self.cx + rim * a.cos(), self.cy + rim * a.sin());
    let mut out = String::new();
    let last = colour(1.0);
    let disc = |r: f64| {
      format!(
        "<path d=\"M{} {}A{r} {r} 0 1 1 {} {}A{r} {r} 0 1 1 {} {}Z\" fill=\"{}\"/>",
        fmt(self.cx - r),
        fmt(self.cy),
        fmt(self.cx + r),
        fmt(self.cy),
        fmt(self.cx - r),
        fmt(self.cy),
        last.hex6(),
        r = fmt(r)
      )
    };
    out.push_str(&disc(self.far));
    for i in 0..self.n {
      let (t0, t1) = (i as f64 / self.n as f64, (i + 1) as f64 / self.n as f64);
      let a0 = self.start + step * i as f64;
      let a1 = a0 + step + if i + 1 < self.n { overlap } else { 0.0 };
      let (p0, p1) = (at(a0), at(a1));
      let fill = colour((t0 + t1) / 2.0).hex6();
      out.push_str(&format!(
        "<path d=\"M{} {}L{} {}L{} {}Z\" fill=\"{fill}\"/>",
        f1(self.cx),
        f1(self.cy),
        f1(p0.0),
        f1(p0.1),
        f1(p1.0),
        f1(p1.1)
      ));
    }
    out
  }
}

/// Image pattern for `ScaleMode::Crop`: the whole image stretched over `crop`, which is given
/// relative to the layer box and may reach outside it.
pub fn crop_pattern(id: &str, src: &str, opacity: f64, crop: &ImageCrop, w: f64, h: f64) -> String {
  let p = ImagePaint {
    src,
    scale_mode: ScaleMode::Crop,
    opacity,
    crop: Some(crop),
    scaling_factor: 1.0,
    rotation: 0.0,
    filters: None,
    natural: None,
  };
  image_pattern(id, &p, w, h)
}

/// Everything the SVG of one image fill depends on.
pub struct ImagePaint<'a> {
  pub src: &'a str,
  pub scale_mode: ScaleMode,
  pub opacity: f64,
  pub crop: Option<&'a ImageCrop>,
  pub scaling_factor: f64,
  pub rotation: f64,
  pub filters: Option<&'a ImageFilters>,
  /// The image's own size in px, when the measurer knows it.
  pub natural: Option<(f64, f64)>,
}

/// Rotation as 0, 90, 180 or 270.
pub fn quarter_turns(rotation: f64) -> u32 {
  if !rotation.is_finite() {
    return 0;
  }
  ((rotation / 90.0).round() as i64).rem_euclid(4) as u32 * 90
}

/// Cell of a tiled image: its own size times the factor, or the old 64 px cell without a size.
pub fn tile_cell(natural: Option<(f64, f64)>, factor: f64, w: f64, h: f64) -> (f64, f64) {
  let f = if factor.is_finite() && factor > 0.0 {
    factor.clamp(0.01, 100.0)
  } else {
    1.0
  };
  match natural {
    Some((nw, nh)) if nw > 0.0 && nh > 0.0 => (nw * f, nh * f),
    _ => ((64.0 * f).min(w), (64.0 * f).min(h)),
  }
}

/// The `<filter>` (when there are adjustments) and `<pattern>` of an image fill. The filter id
/// is `{id}_f`; the pattern's `<image>` references it.
pub fn image_pattern(id: &str, p: &ImagePaint, w: f64, h: f64) -> String {
  let rot = quarter_turns(p.rotation);
  let (w, h) = (w.max(1.0), h.max(1.0));
  let filter = p.filters.filter(|f| !f.is_identity()).map(|f| image_filter(&format!("{id}_f"), f));
  let fattr = if filter.is_some() {
    format!(" filter=\"url(#{id}_f)\"")
  } else {
    String::new()
  };
  let src = crate::render::esc(image_href(p.src));
  let op = fmt(p.opacity);
  let image = |x: f64, y: f64, iw: f64, ih: f64, par: &str| {
    format!(
      "<image href=\"{src}\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"{par}\" opacity=\"{op}\"{fattr}/>",
      fmt(x),
      fmt(y),
      fmt(iw),
      fmt(ih)
    )
  };
  // Draws the image in the box (x, y, bw, bh) turned about its centre; 90 and 270 swap the
  // box so the turned image fills it.
  let turned = |x: f64, y: f64, bw: f64, bh: f64, par: &str| {
    if rot == 0 {
      return image(x, y, bw, bh, par);
    }
    let (cx, cy) = (x + bw / 2.0, y + bh / 2.0);
    let (iw, ih) = if rot == 90 || rot == 270 { (bh, bw) } else { (bw, bh) };
    format!(
      "<g transform=\"rotate({rot} {} {})\">{}</g>",
      fmt(cx),
      fmt(cy),
      image(cx - iw / 2.0, cy - ih / 2.0, iw, ih, par)
    )
  };
  let pattern = match (p.scale_mode, p.crop) {
    (ScaleMode::Crop, Some(c)) => format!(
      "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" width=\"{}\" height=\"{}\">{}</pattern>",
      fmt(w),
      fmt(h),
      turned(c.x * w, c.y * h, c.w * w, c.h * h, "none")
    ),
    (ScaleMode::Tile, _) => {
      let (cw, ch) = tile_cell(p.natural, p.scaling_factor, w, h);
      let (cw, ch) = (cw.max(1.0), ch.max(1.0));
      let par = if p.natural.is_some() { "none" } else { "xMidYMid slice" };
      let tf = if rot == 0 {
        String::new()
      } else {
        format!(" patternTransform=\"rotate({rot})\"")
      };
      format!(
        "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" width=\"{}\" height=\"{}\"{tf}>{}</pattern>",
        fmt(cw),
        fmt(ch),
        image(0.0, 0.0, cw, ch, par)
      )
    }
    (mode, _) => {
      let par = match mode {
        ScaleMode::Fit => "xMidYMid meet",
        ScaleMode::Stretch => "none",
        _ => "xMidYMid slice",
      };
      format!(
        "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" width=\"{}\" height=\"{}\">{}</pattern>",
        fmt(w),
        fmt(h),
        turned(0.0, 0.0, w, h, par)
      )
    }
  };
  format!("{}{pattern}", filter.unwrap_or_default())
}

/// Nine samples of the shadows/highlights curve: `y = x + 0.12 s (27/4) x (1-x)^2 + 0.12 h (27/4) x^2 (1-x)`,
/// clamped. Starting constants (Figma's exact curves are not known here); monotone for |s|, |h| <= 1.
pub fn tone_table(shadows: f64, highlights: f64) -> [f64; 9] {
  let mut out = [0.0; 9];
  for (i, v) in out.iter_mut().enumerate() {
    let x = i as f64 / 8.0;
    let y = x + 0.12 * shadows * 6.75 * x * (1.0 - x) * (1.0 - x) + 0.12 * highlights * 6.75 * x * x * (1.0 - x);
    *v = y.clamp(0.0, 1.0);
  }
  out
}

/// One SVG `<filter>` for the seven image adjustments, steps in a fixed order (exposure, contrast,
/// shadows and highlights, temperature and tint, saturation). Identity steps are left out.
pub fn image_filter(id: &str, f: &ImageFilters) -> String {
  let f = f.clamped();
  let mut out = format!("<filter id=\"{id}\" color-interpolation-filters=\"sRGB\">");
  let linear = |slope: f64, intercept: f64| {
    let one = |c: char| {
      format!(
        "<feFunc{c} type=\"linear\" slope=\"{}\" intercept=\"{}\"/>",
        fmt(slope),
        fmt(intercept)
      )
    };
    format!("<feComponentTransfer>{}{}{}</feComponentTransfer>", one('R'), one('G'), one('B'))
  };
  if f.exposure != 0.0 {
    out.push_str(&linear(2f64.powf(f.exposure), 0.0));
  }
  if f.contrast != 0.0 {
    let k = 1.0 + f.contrast;
    out.push_str(&linear(k, 0.5 * (1.0 - k)));
  }
  if f.shadows != 0.0 || f.highlights != 0.0 {
    let t = tone_table(f.shadows, f.highlights)
      .iter()
      .map(|v| fmt(*v))
      .collect::<Vec<_>>()
      .join(" ");
    let one = |c: char| format!("<feFunc{c} type=\"table\" tableValues=\"{t}\"/>");
    out.push_str(&format!(
      "<feComponentTransfer>{}{}{}</feComponentTransfer>",
      one('R'),
      one('G'),
      one('B')
    ));
  }
  if f.temperature != 0.0 || f.tint != 0.0 {
    let (r, g, b) = (1.0 + 0.15 * f.temperature, 1.0 - 0.15 * f.tint, 1.0 - 0.15 * f.temperature);
    out.push_str(&format!(
      "<feColorMatrix type=\"matrix\" values=\"{} 0 0 0 0 0 {} 0 0 0 0 0 {} 0 0 0 0 0 1 0\"/>",
      fmt(r),
      fmt(g),
      fmt(b)
    ));
  }
  if f.saturation != 0.0 {
    out.push_str(&format!(
      "<feColorMatrix type=\"saturate\" values=\"{}\"/>",
      fmt(1.0 + f.saturation)
    ));
  }
  out.push_str("</filter>");
  out
}

/// Outline of a stroke with one weight per side (top, right, bottom, left) as a ring to fill
/// with `fill-rule="evenodd"`. `radii` are the corner radii (top-left, top-right,
/// bottom-right, bottom-left). Inner radii shrink by the weights next to the corner.
pub fn ring_path(w: f64, h: f64, weights: [f64; 4], align: StrokeAlign, radii: [f64; 4]) -> String {
  let [t, r, b, l] = weights.map(|v| v.max(0.0));
  let (out, inn) = match align {
    StrokeAlign::Inside => ([0.0; 4], [t, r, b, l]),
    StrokeAlign::Center => ([t / 2.0, r / 2.0, b / 2.0, l / 2.0], [t / 2.0, r / 2.0, b / 2.0, l / 2.0]),
    StrokeAlign::Outside => ([t, r, b, l], [0.0; 4]),
  };
  let grow = |rad: f64, ox: f64, oy: f64| if rad > 0.0 { (rad + ox, rad + oy) } else { (0.0, 0.0) };
  let outer = rrect(
    -out[3],
    -out[0],
    w + out[1],
    h + out[2],
    [
      grow(radii[0], out[3], out[0]),
      grow(radii[1], out[1], out[0]),
      grow(radii[2], out[1], out[2]),
      grow(radii[3], out[3], out[2]),
    ],
  );
  let shrink = |rad: f64, ix: f64, iy: f64| ((rad - ix).max(0.0), (rad - iy).max(0.0));
  let (ix0, iy0, ix1, iy1) = (inn[3], inn[0], w - inn[1], h - inn[2]);
  if ix1 <= ix0 || iy1 <= iy0 {
    return outer;
  }
  let inner = rrect(
    ix0,
    iy0,
    ix1,
    iy1,
    [
      shrink(radii[0], inn[3], inn[0]),
      shrink(radii[1], inn[1], inn[0]),
      shrink(radii[2], inn[1], inn[2]),
      shrink(radii[3], inn[3], inn[2]),
    ],
  );
  format!("{outer}{inner}")
}

/// How far a per-side stroke reaches past the box: left, top, right, bottom.
pub fn ring_margins(weights: [f64; 4], align: StrokeAlign) -> [f64; 4] {
  let [t, r, b, l] = weights.map(|v| v.max(0.0));
  let f = |v: f64| match align {
    StrokeAlign::Inside => 0.0,
    StrokeAlign::Center => v / 2.0,
    StrokeAlign::Outside => v,
  };
  [f(l), f(t), f(r), f(b)]
}

/// Rounded rectangle with elliptical corners (rx, ry per corner), scaled down when they overlap.
fn rrect(x0: f64, y0: f64, x1: f64, y1: f64, radii: [(f64, f64); 4]) -> String {
  let (w, h) = ((x1 - x0).max(0.0), (y1 - y0).max(0.0));
  let fit = |a: f64, b: f64, size: f64| if a + b > size && a + b > 0.0 { size / (a + b) } else { 1.0 };
  let k = fit(radii[0].0, radii[1].0, w)
    .min(fit(radii[3].0, radii[2].0, w))
    .min(fit(radii[0].1, radii[3].1, h))
    .min(fit(radii[1].1, radii[2].1, h));
  let [(tlx, tly), (trx, try_), (brx, bry), (blx, bly)] = radii.map(|(a, b)| (a * k, b * k));
  let arc = |rx: f64, ry: f64, x: f64, y: f64| {
    if rx <= 0.0 || ry <= 0.0 {
      format!("L{} {}", fmt(x), fmt(y))
    } else {
      format!("A{} {} 0 0 1 {} {}", fmt(rx), fmt(ry), fmt(x), fmt(y))
    }
  };
  format!(
    "M{} {}H{}{}V{}{}H{}{}V{}{}Z",
    fmt(x0 + tlx),
    fmt(y0),
    fmt(x1 - trx),
    arc(trx, try_, x1, y0 + try_),
    fmt(y1 - bry),
    arc(brx, bry, x1 - brx, y1),
    fmt(x0 + blx),
    arc(blx, bly, x0, y1 - bly),
    fmt(y0 + tly),
    arc(tlx, tly, x0 + tlx, y0),
  )
}

/// The two gradient axes in layer pixels: u runs start to end, v start to width.
struct Axes {
  c: [f64; 2],
  a: [f64; 2],
  b: [f64; 2],
}

impl Axes {
  fn new(hd: &GradientHandles, w: f64, h: f64) -> Axes {
    let c = [hd.start[0] * w, hd.start[1] * h];
    Axes {
      c,
      a: [hd.end[0] * w - c[0], hd.end[1] * h - c[1]],
      b: [hd.width[0] * w - c[0], hd.width[1] * h - c[1]],
    }
  }

  fn matrix(&self) -> String {
    format!(
      "matrix({} {} {} {} {} {})",
      fmt(self.a[0]),
      fmt(self.a[1]),
      fmt(self.b[0]),
      fmt(self.b[1]),
      fmt(self.c[0]),
      fmt(self.c[1])
    )
  }

  fn det(&self) -> f64 {
    self.a[0] * self.b[1] - self.a[1] * self.b[0]
  }

  fn min_len(&self) -> f64 {
    self.a[0].hypot(self.a[1]).min(self.b[0].hypot(self.b[1]))
  }

  fn to_uv(&self, p: [f64; 2]) -> [f64; 2] {
    let (dx, dy) = (p[0] - self.c[0], p[1] - self.c[1]);
    let det = self.det();
    [(dx * self.b[1] - dy * self.b[0]) / det, (dy * self.a[0] - dx * self.a[1]) / det]
  }

  fn corners(&self, w: f64, h: f64, pad: f64) -> [[f64; 2]; 4] {
    [[-pad, -pad], [w + pad, -pad], [w + pad, h + pad], [-pad, h + pad]]
  }
}

/// Colour of a gradient at any position, interpolated like SVG does between stops.
struct Sampler {
  stops: Vec<(f64, Rgba)>,
  opacity: f64,
}

impl Sampler {
  fn new(stops: &[GradientStop], opacity: f64) -> Option<Sampler> {
    let mut s: Vec<(f64, Rgba)> = stops
      .iter()
      .map(|s| (s.position, color::parse(&s.color).unwrap_or(Rgba::BLACK)))
      .collect();
    if s.is_empty() {
      return None;
    }
    s.sort_by(|a, b| a.0.total_cmp(&b.0));
    Some(Sampler { stops: s, opacity })
  }

  /// Colour and alpha (stop alpha times the paint's opacity) at `t`.
  fn at(&self, t: f64) -> (Rgba, f64) {
    let first = &self.stops[0];
    let last = &self.stops[self.stops.len() - 1];
    let (c, a) = if t <= first.0 {
      (first.1, first.1.a)
    } else if t >= last.0 {
      (last.1, last.1.a)
    } else {
      let i = self.stops.iter().position(|s| s.0 >= t).unwrap_or(1).max(1);
      let (p, q) = (&self.stops[i - 1], &self.stops[i]);
      let k = if q.0 > p.0 { (t - p.0) / (q.0 - p.0) } else { 1.0 };
      let mix = |x: u8, y: u8| (x as f64 + (y as f64 - x as f64) * k).round() as u8;
      (
        Rgba {
          r: mix(p.1.r, q.1.r),
          g: mix(p.1.g, q.1.g),
          b: mix(p.1.b, q.1.b),
          a: 1.0,
        },
        p.1.a + (q.1.a - p.1.a) * k,
      )
    };
    (c, a * self.opacity)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::model::{Document, Node, NodeType, Paint, ScaleMode, StrokeJoin};
  use crate::render::{export_svg, render_bounds, render_root};
  use crate::render::{Mode, RenderOptions};
  use crate::text::HeuristicMeasurer;

  fn stops() -> Vec<GradientStop> {
    vec![
      GradientStop {
        color: "#FF0000".into(),
        position: 0.0,
      },
      GradientStop {
        color: "#0000FF".into(),
        position: 1.0,
      },
    ]
  }

  fn doc_with(kind: NodeType, w: f64, h: f64, f: impl FnOnce(&mut Node)) -> Document {
    let mut gen = IdGen::new(5);
    let mut doc = new_document(&mut gen, "t");
    let page = doc.pages[0].id.clone();
    let mut n = crate::ops::default_node(kind, "r".into(), "R".into());
    n.width = w;
    n.height = h;
    n.x = 100.0;
    n.y = 100.0;
    n.fills.clear();
    n.strokes.clear();
    n.stroke_weight = 0.0;
    f(&mut n);
    doc.insert(n, None, &page, None);
    doc
  }

  fn svg(doc: &Document) -> String {
    export_svg(doc, "r", &HeuristicMeasurer)
  }

  fn angular(handles: Option<GradientHandles>) -> Paint {
    Paint::AngularGradient {
      stops: stops(),
      opacity: 1.0,
      visible: true,
      handles,
    }
  }

  #[test]
  fn old_paints_round_trip_unchanged() {
    for src in [
      r##"{"type":"linearGradient","stops":[{"color":"#FF0000","position":0.0}],"angle":90.0,"opacity":1.0,"visible":true}"##,
      r##"{"type":"radialGradient","stops":[{"color":"#FF0000","position":0.0}],"opacity":1.0,"visible":true}"##,
      r##"{"type":"image","src":"asset:a","scaleMode":"fill","opacity":1.0,"visible":true}"##,
    ] {
      let p: Paint = serde_json::from_str(src).unwrap();
      assert_eq!(serde_json::to_string(&p).unwrap(), src);
    }
    let v = serde_json::to_value(Node::default()).unwrap();
    assert!(v.get("strokeWeights").is_none() && v.get("strokeJoin").is_none());
  }

  #[test]
  fn new_paints_round_trip() {
    let hd = GradientHandles {
      start: [0.5, 0.5],
      end: [1.0, 0.5],
      width: [0.5, 1.0],
    };
    for p in [
      angular(Some(hd)),
      Paint::DiamondGradient {
        stops: stops(),
        opacity: 0.5,
        visible: true,
        handles: None,
      },
      Paint::Image {
        credit: None,
        scaling_factor: 1.0,
        rotation: 0.0,
        filters: None,
        src: "asset:a".into(),
        scale_mode: ScaleMode::Crop,
        opacity: 1.0,
        visible: true,
        crop: Some(ImageCrop {
          x: -0.1,
          y: 0.0,
          w: 1.5,
          h: 1.2,
        }),
      },
    ] {
      let json = serde_json::to_string(&p).unwrap();
      assert_eq!(serde_json::from_str::<Paint>(&json).unwrap(), p);
    }
    assert!(serde_json::to_string(&angular(None)).unwrap().contains("\"angularGradient\""));
  }

  #[test]
  fn angular_renders_a_wedge_pattern_the_fill_references() {
    let doc = doc_with(NodeType::Rectangle, 100.0, 100.0, |n| n.fills = vec![angular(None)]);
    let s = svg(&doc);
    let pat = s.split("<pattern").nth(1).expect("pattern");
    // The base disc plus 72 solid wedges on a small layer.
    assert_eq!(pat.matches("<path").count(), 1 + 72);
    assert!(!s.contains("<linearGradient"));
    assert!(s.contains("fill=\"url(#xr_ag1)\""));
    // Bigger layers get finer steps.
    let count = |side: f64| {
      svg(&doc_with(NodeType::Rectangle, side, 100.0, |n| n.fills = vec![angular(None)]))
        .matches("<path")
        .count()
    };
    assert_eq!((count(400.0), count(800.0), count(1200.0)), (1 + 120, 1 + 144, 1 + 180));
  }

  #[test]
  fn angular_opacity_goes_on_a_group_and_stop_alpha_on_a_mask() {
    let opaque_stops = |opacity: f64| Paint::AngularGradient {
      stops: stops(),
      opacity,
      visible: true,
      handles: None,
    };
    for size in [100.0, 400.0] {
      let half = doc_with(NodeType::Rectangle, size, size, |n| n.fills = vec![opaque_stops(0.5)]);
      let s = svg(&half);
      assert!(!s.contains("fill-opacity") && !s.contains("<mask"), "{s}");
      assert!(s.contains("<g transform=\"translate(0 0)\" opacity=\"0.5\">"), "{s}");
      let faded = Paint::AngularGradient {
        stops: vec![
          GradientStop {
            color: "#FF000000".into(),
            position: 0.0,
          },
          GradientStop {
            color: "#0000FF".into(),
            position: 1.0,
          },
        ],
        opacity: 1.0,
        visible: true,
        handles: None,
      };
      let t = svg(&doc_with(NodeType::Rectangle, size, size, |n| n.fills = vec![faded]));
      assert!(
        t.contains("<mask") && t.contains("mask=\"url(#xr_ag1m)\"") && !t.contains("fill-opacity"),
        "{t}"
      );
    }
  }

  #[test]
  fn diamond_renders_four_quadrant_gradients() {
    let doc = doc_with(NodeType::Rectangle, 100.0, 100.0, |n| {
      n.fills = vec![Paint::DiamondGradient {
        stops: stops(),
        opacity: 1.0,
        visible: true,
        handles: None,
      }]
    });
    let s = svg(&doc);
    assert_eq!(s.matches("<linearGradient").count(), 4);
    assert_eq!(s.matches("<rect x=").count(), 4);
    assert!(s.contains("fill=\"url(#xr_dg1)\""));
  }

  #[test]
  fn linear_handles_set_the_gradient_line() {
    let hd = GradientHandles {
      start: [0.0, 0.5],
      end: [1.0, 0.5],
      width: [0.0, 1.0],
    };
    let doc = doc_with(NodeType::Rectangle, 100.0, 100.0, |n| {
      n.fills = vec![Paint::LinearGradient {
        stops: stops(),
        angle: 90.0,
        opacity: 1.0,
        visible: true,
        handles: Some(hd),
      }]
    });
    let s = svg(&doc);
    assert!(s.contains("x1=\"0\" y1=\"50\" x2=\"100\" y2=\"50\""), "{s}");
  }

  #[test]
  fn radial_handles_use_a_gradient_transform() {
    let hd = GradientHandles {
      start: [0.5, 0.5],
      end: [1.0, 0.5],
      width: [0.5, 0.75],
    };
    let doc = doc_with(NodeType::Rectangle, 100.0, 100.0, |n| {
      n.fills = vec![Paint::RadialGradient {
        stops: stops(),
        opacity: 1.0,
        visible: true,
        handles: Some(hd),
      }]
    });
    assert!(svg(&doc).contains("gradientTransform=\"matrix(50 0 0 25 50 50)\""));
  }

  #[test]
  fn per_side_stroke_is_a_ring_with_one_band() {
    let doc = doc_with(NodeType::Rectangle, 100.0, 60.0, |n| {
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_weights = Some([4.0, 0.0, 0.0, 0.0]);
    });
    let s = svg(&doc);
    assert!(s.contains("fill-rule=\"evenodd\""));
    // Outer is the box; the inner is the box minus a 4 px top band.
    assert!(s.contains("M0 0H100L100 0V60L100 60H0L0 60V0L0 0Z"), "{s}");
    assert!(s.contains("M0 4H100L100 4V60L100 60H0L0 60V4L0 4Z"), "{s}");
  }

  #[test]
  fn per_side_outside_stroke_only_grows_those_sides() {
    let mut doc = doc_with(NodeType::Rectangle, 100.0, 60.0, |n| {
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_weights = Some([4.0, 0.0, 0.0, 10.0]);
      n.stroke_align = StrokeAlign::Outside;
    });
    let b = render_bounds(&doc, "r", &HeuristicMeasurer);
    assert_eq!((b.x, b.y, b.width, b.height), (90.0, 96.0, 110.0, 64.0));
    doc.get_mut("r").unwrap().stroke_align = StrokeAlign::Center;
    let b = render_bounds(&doc, "r", &HeuristicMeasurer);
    assert_eq!((b.x, b.y, b.width, b.height), (95.0, 98.0, 105.0, 62.0));
  }

  #[test]
  fn ring_radii_shrink_inside_and_grow_outside() {
    let inside = ring_path(100.0, 100.0, [10.0; 4], StrokeAlign::Inside, [16.0; 4]);
    assert!(inside.contains("A16 16") && inside.contains("A6 6"), "{inside}");
    let outside = ring_path(100.0, 100.0, [10.0; 4], StrokeAlign::Outside, [16.0; 4]);
    assert!(outside.contains("A26 26") && outside.contains("A16 16"), "{outside}");
    // A radius smaller than the weight leaves a sharp inner corner.
    assert!(!ring_path(100.0, 100.0, [10.0; 4], StrokeAlign::Inside, [4.0; 4]).contains("A0"));
  }

  #[test]
  fn stroke_join_defaults_to_round_and_can_be_set() {
    let mut doc = doc_with(NodeType::Star, 100.0, 100.0, |n| {
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_weight = 4.0;
      n.stroke_align = StrokeAlign::Center;
    });
    assert!(svg(&doc).contains("stroke-linejoin=\"round\""));
    doc.get_mut("r").unwrap().stroke_join = Some(StrokeJoin::Miter);
    let s = svg(&doc);
    assert!(s.contains("stroke-linejoin=\"miter\"") && !s.contains("stroke-linejoin=\"round\""));
    doc.get_mut("r").unwrap().stroke_join = Some(StrokeJoin::Bevel);
    doc.get_mut("r").unwrap().stroke_dash = vec![10.0, 5.0];
    let s = svg(&doc);
    assert!(s.contains("stroke-linejoin=\"bevel\"") && s.contains("stroke-dasharray=\"10 5\""));
    // The inside-aligned path and a rectangle say it once too.
    doc.get_mut("r").unwrap().stroke_align = StrokeAlign::Inside;
    assert_eq!(svg(&doc).matches("stroke-linejoin=").count(), 1);
    let rect = doc_with(NodeType::Rectangle, 50.0, 50.0, |n| {
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_weight = 4.0;
      n.stroke_join = Some(StrokeJoin::Round);
    });
    assert_eq!(svg(&rect).matches("stroke-linejoin=\"round\"").count(), 1);
  }

  #[test]
  fn crop_places_the_whole_image_in_the_box() {
    let doc = doc_with(NodeType::Rectangle, 100.0, 50.0, |n| {
      n.fills = vec![Paint::Image {
        credit: None,
        scaling_factor: 1.0,
        rotation: 0.0,
        filters: None,
        src: "asset:a".into(),
        scale_mode: ScaleMode::Crop,
        opacity: 1.0,
        visible: true,
        crop: Some(ImageCrop {
          x: -0.2,
          y: 0.1,
          w: 1.5,
          h: 2.0,
        }),
      }]
    });
    let s = svg(&doc);
    assert!(
      s.contains("x=\"-20\" y=\"5\" width=\"150\" height=\"100\" preserveAspectRatio=\"none\""),
      "{s}"
    );
  }

  #[test]
  fn canvas_defs_stay_inside_the_root_markup() {
    let doc = doc_with(NodeType::Rectangle, 100.0, 100.0, |n| n.fills = vec![angular(None)]);
    let out = render_root(
      &doc,
      "r",
      &HeuristicMeasurer,
      RenderOptions {
        mode: Mode::Canvas,
        hidden: &[],
        editing: None,
      },
    );
    assert!(out.starts_with("<defs><pattern id=\"r_ag1\""), "{}", &out[..80.min(out.len())]);
  }

  #[test]
  fn angular_colours_sweep_clockwise_from_the_end_handle() {
    let s = Sampler::new(&stops(), 1.0).unwrap();
    assert_eq!(s.at(0.0).0.hex6(), "#FF0000");
    assert_eq!(s.at(1.0).0.hex6(), "#0000FF");
    assert_eq!(s.at(0.5).0.hex6(), "#800080");
    assert_eq!(handle_angle(&default_handles(true), 100.0, 100.0), 0.0);
    assert_eq!(handle_angle(&default_handles(false), 100.0, 100.0), 90.0);
  }

  #[test]
  fn image_filter_steps_are_in_order_and_identity_steps_are_left_out() {
    let none = image_filter("f", &ImageFilters::default());
    assert_eq!(none, "<filter id=\"f\" color-interpolation-filters=\"sRGB\"></filter>");
    let all = image_filter(
      "f",
      &ImageFilters {
        exposure: 1.0,
        contrast: 0.5,
        saturation: 0.5,
        temperature: 1.0,
        tint: -1.0,
        highlights: 0.5,
        shadows: -0.5,
      },
    );
    let at = |needle: &str| all.find(needle).unwrap_or_else(|| panic!("{needle} in {all}"));
    assert!(at("slope=\"2\" intercept=\"0\"") < at("slope=\"1.5\" intercept=\"-0.25\""));
    assert!(at("slope=\"1.5\"") < at("type=\"table\""));
    assert!(at("type=\"table\"") < at("type=\"matrix\""));
    assert!(at("type=\"matrix\"") < at("type=\"saturate\" values=\"1.5\""));
    // Temperature +1 and tint -1: R 1.15, G 1.15, B 0.85.
    assert!(all.contains("values=\"1.15 0 0 0 0 0 1.15 0 0 0 0 0 0.85 0 0 0 0 0 1 0\""), "{all}");
    // Only the steps that move something.
    let sat = image_filter(
      "f",
      &ImageFilters {
        saturation: -1.0,
        ..Default::default()
      },
    );
    assert!(!sat.contains("feComponentTransfer") && sat.contains("saturate"), "{sat}");
  }

  #[test]
  fn the_shadows_and_highlights_curve_stays_monotone_and_in_range() {
    for (s, h) in [
      (1.0, 0.0),
      (-1.0, 0.0),
      (0.0, 1.0),
      (0.0, -1.0),
      (1.0, 1.0),
      (-1.0, -1.0),
      (1.0, -1.0),
      (-1.0, 1.0),
    ] {
      let t = tone_table(s, h);
      assert!(t[0] == 0.0 && (t[8] - 1.0).abs() < 1e-12, "{t:?}");
      for w in t.windows(2) {
        assert!(w[1] >= w[0], "s {s} h {h}: {t:?}");
      }
      assert!(t.iter().all(|v| (0.0..=1.0).contains(v)));
    }
    // Shadows lift the dark half; highlights pull the bright half down.
    assert!(tone_table(1.0, 0.0)[2] > 0.25);
    assert!(tone_table(0.0, -1.0)[6] < 0.75);
  }

  #[test]
  fn quarter_turns_normalise_and_cells_clamp() {
    assert_eq!(
      [0.0, 90.0, 450.0, -90.0, 180.0, 44.0, 46.0].map(quarter_turns),
      [0, 90, 90, 270, 180, 0, 90]
    );
    assert_eq!(quarter_turns(f64::NAN), 0);
    assert_eq!(tile_cell(Some((40.0, 20.0)), 2.0, 10.0, 10.0), (80.0, 40.0));
    assert_eq!(tile_cell(Some((40.0, 20.0)), 1000.0, 10.0, 10.0), (4000.0, 2000.0));
    assert_eq!(tile_cell(None, 1.0, 400.0, 30.0), (64.0, 30.0));
  }

  #[test]
  fn the_new_image_fields_are_skipped_at_their_defaults() {
    let plain = r##"{"type":"image","src":"asset:a","scaleMode":"tile","opacity":1.0,"visible":true}"##;
    let p: Paint = serde_json::from_str(plain).unwrap();
    assert_eq!(serde_json::to_string(&p).unwrap(), plain);
    // All-zero filters are not written either.
    let zero: Paint = serde_json::from_str(
      r##"{"type":"image","src":"asset:a","scaleMode":"tile","opacity":1.0,"visible":true,"filters":{"exposure":0}}"##,
    )
    .unwrap();
    assert_eq!(serde_json::to_string(&zero).unwrap(), plain);
    let set = r##"{"type":"image","src":"asset:a","scaleMode":"tile","opacity":1.0,"visible":true,"scalingFactor":0.5,"rotation":90.0,"filters":{"exposure":0.0,"contrast":0.0,"saturation":-1.0,"temperature":0.0,"tint":0.0,"highlights":0.0,"shadows":0.0}}"##;
    let p: Paint = serde_json::from_str(set).unwrap();
    assert_eq!(serde_json::to_string(&p).unwrap(), set);
  }
}
