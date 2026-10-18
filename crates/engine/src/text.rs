//! Text measurement and line breaking. The browser build measures with a
//! real canvas; native builds (bridge, tests) use a width heuristic.

use crate::model::{TextAutoResize, TextProps};

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

#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
  pub text: String,
  pub width: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextLayout {
  pub lines: Vec<TextLine>,
  pub width: f64,
  pub height: f64,
  pub line_height: f64,
}

/// Breaks text into lines. `max_width` of `None` disables wrapping.
pub fn layout_text(props: &TextProps, max_width: Option<f64>, m: &dyn TextMeasurer) -> TextLayout {
  let font = FontSpec {
    family: &props.font_family,
    size: props.font_size,
    weight: props.font_weight,
    italic: props.italic,
    letter_spacing: props.letter_spacing,
  };
  let text = props.display_text();
  let mut lines = Vec::new();
  for paragraph in text.split('\n') {
    match max_width {
      Some(w) if w > 0.0 => wrap_paragraph(paragraph, w, &font, m, &mut lines),
      _ => lines.push(TextLine { text: paragraph.to_string(), width: m.measure(paragraph, &font) }),
    }
  }
  let lh = props.line_height_px();
  let paragraphs = text.split('\n').count().max(1) as f64;
  let width = lines.iter().map(|l| l.width).fold(0.0, f64::max);
  let height = lines.len().max(1) as f64 * lh + (paragraphs - 1.0) * props.paragraph_spacing;
  TextLayout { lines, width, height, line_height: lh }
}

fn wrap_paragraph(p: &str, max_w: f64, font: &FontSpec, m: &dyn TextMeasurer, out: &mut Vec<TextLine>) {
  if p.is_empty() {
    out.push(TextLine { text: String::new(), width: 0.0 });
    return;
  }
  let mut line = String::new();
  // Split keeping whitespace attached to the preceding word.
  let mut words: Vec<String> = Vec::new();
  let mut cur = String::new();
  for c in p.chars() {
    cur.push(c);
    if c == ' ' {
      words.push(std::mem::take(&mut cur));
    }
  }
  if !cur.is_empty() {
    words.push(cur);
  }
  for word in words {
    let candidate = format!("{line}{word}");
    if m.measure(candidate.trim_end(), font) <= max_w + 0.01 || line.is_empty() {
      if line.is_empty() && m.measure(word.trim_end(), font) > max_w {
        // Break an overlong word by characters.
        for c in word.chars() {
          let cand = format!("{line}{c}");
          if !line.is_empty() && m.measure(cand.trim_end(), font) > max_w {
            push_line(&line, font, m, out);
            line = c.to_string();
          } else {
            line = cand;
          }
        }
      } else {
        line = candidate;
      }
    } else {
      push_line(&line, font, m, out);
      line = word;
    }
  }
  push_line(&line, font, m, out);
}

fn push_line(line: &str, font: &FontSpec, m: &dyn TextMeasurer, out: &mut Vec<TextLine>) {
  let t = line.trim_end().to_string();
  let w = m.measure(&t, font);
  out.push(TextLine { text: t, width: w });
}

/// Lays out a text node for its current box, honouring auto-resize.
pub fn layout_for_node(props: &TextProps, width: f64, m: &dyn TextMeasurer) -> TextLayout {
  match props.auto_resize {
    TextAutoResize::Width => layout_text(props, None, m),
    TextAutoResize::Height | TextAutoResize::None => layout_text(props, Some(width), m),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn wraps_long_text() {
    let props = TextProps { characters: "hello world this is a long line".into(), ..Default::default() };
    let l = layout_text(&props, Some(80.0), &HeuristicMeasurer);
    assert!(l.lines.len() > 1);
    assert!(l.lines.iter().all(|x| x.width <= 80.0 + 0.01 || !x.text.contains(' ')));
  }

  #[test]
  fn newline_splits() {
    let props = TextProps { characters: "a\nb".into(), ..Default::default() };
    let l = layout_text(&props, None, &HeuristicMeasurer);
    assert_eq!(l.lines.len(), 2);
    assert_eq!(l.height, 2.0 * 16.0 * 1.2);
  }
}
