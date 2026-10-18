//! Text measurement, mixed-style runs and line breaking. The browser build
//! measures with a real canvas; native builds (bridge, tests) use a width heuristic.

use crate::model::{TextAutoResize, TextDecoration, TextProps, TextRun};

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
  pub segments: Vec<Segment>,
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
}

/// Breaks text into lines. `max_width` of `None` disables wrapping.
pub fn layout_text(props: &TextProps, max_width: Option<f64>, m: &dyn TextMeasurer) -> TextLayout {
  let text = props.display_text();
  let chars: Vec<char> = text.chars().collect();
  let (styles, char_style) = resolve_styles(props, chars.len());
  let lh_of = |s: &SpanStyle| props.line_height.unwrap_or(s.size * 1.2);
  let base_lh = props.line_height_px();

  let mut lines: Vec<TextLine> = Vec::new();
  let mut offset = 0;
  let paragraphs: Vec<&str> = text.split('\n').collect();
  for para in &paragraphs {
    let n = para.chars().count();
    let words = split_words(&chars[offset..offset + n], &char_style[offset..offset + n]);
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
      let fits = match max_width {
        Some(mw) if mw > 0.0 => cur.is_empty() || cur_w + trimmed_width(&word) <= mw + 0.01,
        _ => true,
      };
      if fits {
        cur_w += word_w;
        for p in word {
          push_piece(&mut cur, p);
        }
        continue;
      }
      lines.push(make_line(std::mem::take(&mut cur), &styles, m, lh_of, base_lh));
      // Overlong words break by character.
      let mw = max_width.unwrap_or(f64::INFINITY);
      if word_w > mw {
        for piece in word {
          for c in piece.text.chars() {
            let p = Piece {
              text: c.to_string(),
              style: piece.style,
            };
            let w = measure(&p);
            if !cur.is_empty() && cur_w + w > mw && c != ' ' {
              lines.push(make_line(std::mem::take(&mut cur), &styles, m, lh_of, base_lh));
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
    lines.push(make_line(cur, &styles, m, lh_of, base_lh));
  }
  let width = lines.iter().map(|l| l.width).fold(0.0, f64::max);
  let height = lines.iter().map(|l| l.height).sum::<f64>() + (paragraphs.len().max(1) as f64 - 1.0) * props.paragraph_spacing;
  TextLayout {
    lines,
    width,
    height,
    line_height: base_lh,
  }
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
fn split_words(chars: &[char], styles: &[usize]) -> Vec<Vec<Piece>> {
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

fn make_line(pieces: Vec<Piece>, styles: &[SpanStyle], m: &dyn TextMeasurer, lh_of: impl Fn(&SpanStyle) -> f64, base_lh: f64) -> TextLine {
  let mut segments: Vec<Segment> = Vec::new();
  let count = pieces.len();
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
    segments,
  }
}

/// Lays out a text node for its current box, honouring auto-resize.
pub fn layout_for_node(props: &TextProps, width: f64, m: &dyn TextMeasurer) -> TextLayout {
  match props.auto_resize {
    TextAutoResize::Width => layout_text(props, None, m),
    TextAutoResize::Height | TextAutoResize::None => layout_text(props, Some(width), m),
  }
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
}
