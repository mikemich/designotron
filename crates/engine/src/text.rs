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
  /// The pixel size of an image source (`asset:<id>` or a URL), when the host knows it.
  /// Tiled image fills use it; without it they fall back to a 64 px cell.
  fn image_size(&self, _src: &str) -> Option<(f64, f64)> {
    None
  }
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
  // Index of each line that follows a soft line break (U+2028): no paragraph spacing, but not a
  // wrapped line either.
  let mut soft_starts: Vec<usize> = Vec::new();
  let mut offset = 0;
  for para_text in text.split('\n') {
    para_starts.push(lines.len());
    let cjk = para_text.chars().any(is_ideographic);
    for (si, para) in para_text.split(SOFT_BREAK).enumerate() {
      if si > 0 {
        soft_starts.push(lines.len());
      }
      let n = para.chars().count();
      let para_start = offset;
      let words = split_words(&chars[offset..offset + n], &char_style[offset..offset + n], offset, cjk);
      // The break itself takes one index, like the `\n` after a paragraph.
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
              if !cur.is_empty()
                && cur_w + w > mw
                && c != ' '
                && !(cjk && glued(cur.last().and_then(|p| p.text.chars().last()), c, trailing_regional(&cur)))
              {
                // Kinsoku: a line never starts with a closing mark or ends with an opening one;
                // the previous characters move down with it (oidashi), unless that empties the line.
                // When even the whole line would move, nothing is carried: the line breaks here and the
                // next starts with the character (as the browser does).
                let carry = if cjk {
                  take_carry(&mut cur, c).unwrap_or_default()
                } else {
                  Vec::new()
                };
                lines.push(make_line(std::mem::take(&mut cur), para_start, &styles, m, lh_of, base_lh));
                cur_w = 0.0;
                for q in carry {
                  cur_w += measure(&q);
                  push_piece(&mut cur, q);
                }
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
    line.soft_wrap = i + 1 < count && para_starts.get(next_para) != Some(&(i + 1)) && soft_starts.binary_search(&(i + 1)).is_err();
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

/// A soft line break (Shift+Enter, Figma's U+2028): a new line inside the paragraph.
pub const SOFT_BREAK: char = '\u{2028}';

// ---------- CJK line breaking (kinsoku) ----------
//
// The tables follow CSS `line-break: strict` for Japanese and Chinese, which is what the HTML
// and React exports write on text that contains CJK: the canvas, PNG and SVG then break where
// the browser does.

/// Characters laid out as ideographs, between which a line may break: CJK ideographs (with
/// extensions and compatibility forms), kana, Hangul, Bopomofo, CJK symbols and punctuation, and
/// the fullwidth forms.
pub fn is_ideographic(c: char) -> bool {
  matches!(c as u32,
    0x1100..=0x11FF // Hangul Jamo
    | 0x2E80..=0x2FDF // CJK and Kangxi radicals
    | 0x3000..=0x303F // CJK symbols and punctuation
    | 0x3040..=0x30FF // Hiragana, Katakana
    | 0x3100..=0x312F | 0x31A0..=0x31BF // Bopomofo
    | 0x3130..=0x318F // Hangul compatibility Jamo
    | 0x31C0..=0x31EF // CJK strokes
    | 0x31F0..=0x31FF // Katakana phonetic extensions
    | 0x3200..=0x4DBF // enclosed CJK, CJK compatibility, Extension A
    | 0x4E00..=0x9FFF // CJK unified ideographs
    | 0xA960..=0xA97F | 0xAC00..=0xD7FF // Hangul syllables and Jamo extensions
    | 0xF900..=0xFAFF // compatibility ideographs
    | 0xFE30..=0xFE4F // CJK compatibility forms
    | 0xFF00..=0xFFEF // fullwidth and halfwidth forms
    | 0x20000..=0x3134F // Extensions B and later
  )
}

pub fn has_ideographic(s: &str) -> bool {
  s.chars().any(is_ideographic)
}

/// Marks that attach to the character before them: combining marks, variation selectors, the
/// voiced sound marks, Hangul vowel and final Jamo and the halfwidth sound marks. A line never
/// starts with one.
fn is_attached(c: char) -> bool {
  matches!(c as u32,
    0x0300..=0x036F | 0x0483..=0x0489 | 0x0591..=0x05BD | 0x064B..=0x065F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF
    | 0x1160..=0x11FF | 0x200D | 0x20D0..=0x20FF | 0x3099..=0x309A | 0xFE00..=0xFE0F | 0xFE20..=0xFE2F
    | 0xFF9E..=0xFF9F | 0x1F3FB..=0x1F3FF | 0xE0020..=0xE007F | 0xE0100..=0xE01EF)
}

fn is_regional(c: char) -> bool {
  matches!(c as u32, 0x1F1E6..=0x1F1FF)
}

/// Number of regional indicators that end the pieces (a flag is a pair of them).
fn trailing_regional(cur: &[Piece]) -> usize {
  cur
    .iter()
    .rev()
    .flat_map(|p| p.text.chars().rev())
    .take_while(|c| is_regional(*c))
    .count()
}

/// Whether `c` can't be split from what comes before it even in a box too narrow for both: an
/// attached mark, anything after a zero-width joiner, the second half of a flag.
fn glued(prev: Option<char>, c: char, regional_run: usize) -> bool {
  is_attached(c) || prev == Some('\u{200D}') || (is_regional(c) && regional_run % 2 == 1)
}

/// May not start a line.
fn no_line_start(c: char) -> bool {
  is_attached(c)
    || matches!(
      c,
      '）' | '〕' | '］' | '｝' | '〉' | '》' | '」' | '』' | '】' | '〙' | '〗' | '〟' | '’' | '”' | '｠' | '»' | ')' | ']' | '}'
      | '、' | '。' | '，' | '．' | '：' | '；' | '？' | '！' | '‼' | '⁇' | '⁈' | '⁉' | '・' | '゠' | '–' | '‐' | '〜' | '～'
      | ',' | '.' | ':' | ';' | '?' | '!'
      // Inseparable leaders, and a percent sign after an ideograph.
      | '…' | '‥' | '․' | '%' | '％'
      | 'ー' | '々' | '〻' | 'ゝ' | 'ゞ' | 'ヽ' | 'ヾ'
      | 'ぁ' | 'ぃ' | 'ぅ' | 'ぇ' | 'ぉ' | 'っ' | 'ゃ' | 'ゅ' | 'ょ' | 'ゎ' | 'ゕ' | 'ゖ'
      | 'ァ' | 'ィ' | 'ゥ' | 'ェ' | 'ォ' | 'ッ' | 'ャ' | 'ュ' | 'ョ' | 'ヮ' | 'ヵ' | 'ヶ'
      | '\u{3000}' | '\u{31F0}'..='\u{31FF}'
      // Halfwidth: ｡ ｣ ､ ･ ｰ and the small kana ｧ-ｯ.
      | '\u{FF61}' | '\u{FF63}' | '\u{FF64}' | '\u{FF65}' | '\u{FF67}'..='\u{FF70}'
    )
}

/// May not end a line.
fn no_line_end(c: char) -> bool {
  matches!(
    c,
    '（'
      | '〔'
      | '［'
      | '｛'
      | '〈'
      | '《'
      | '「'
      | '『'
      | '【'
      | '〘'
      | '〖'
      | '〝'
      | '‘'
      | '“'
      | '｟'
      | '«'
      | '('
      | '['
      | '{'
      | '\u{FF62}'
      | '\u{200D}'
  )
}

/// Whether a line may break between `a` and `b` (neither a space) in text that has ideographs.
fn cjk_break_between(a: char, b: char) -> bool {
  (is_ideographic(a) || is_ideographic(b)) && !no_line_start(b) && !no_line_end(a)
}

/// Kinsoku for a break by character before `next`: the characters of `cur` that move down to the
/// new line with it, so it doesn't start with a closing mark or the previous line end with an
/// opening one. When even the whole line would move: `None`.
fn take_carry(cur: &mut Vec<Piece>, next: char) -> Option<Vec<Piece>> {
  let all: Vec<(usize, char)> = cur
    .iter()
    .enumerate()
    .flat_map(|(pi, p)| p.text.chars().map(move |c| (pi, c)))
    .collect();
  let mut k = 0;
  let mut first = next;
  while k < all.len() && (no_line_start(first) || no_line_end(all[all.len() - 1 - k].1)) {
    k += 1;
    first = all[all.len() - k].1;
  }
  if k == 0 {
    return Some(Vec::new());
  }
  if k >= all.len() {
    return None;
  }
  let mut carry: Vec<Piece> = Vec::new();
  for _ in 0..k {
    let last = cur.last_mut().unwrap();
    let c = last.text.pop().unwrap();
    let start = last.start + last.text.chars().count();
    let style = last.style;
    if last.text.is_empty() {
      cur.pop();
    }
    carry.insert(
      0,
      Piece {
        text: c.to_string(),
        style,
        start,
      },
    );
  }
  Some(carry)
}

/// Words (with trailing spaces) as style pieces. In text with ideographs (`cjk`) a word also ends
/// wherever a line may break between two characters.
fn split_words(chars: &[char], styles: &[usize], base: usize, cjk: bool) -> Vec<Vec<Piece>> {
  let mut words: Vec<Vec<Piece>> = Vec::new();
  let mut cur: Vec<Piece> = Vec::new();
  let mut prev_space = false;
  for (i, c) in chars.iter().enumerate() {
    if (prev_space && *c != ' ')
      || (cjk
        && i > 0
        && *c != ' '
        && !prev_space
        && cjk_break_between(chars[i - 1], *c)
        && !(is_regional(*c) && chars[..i].iter().rev().take_while(|x| is_regional(**x)).count() % 2 == 1))
    {
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

/// Longest run of chars measured as one prefix when placing the caret.
const CARET_CHUNK: usize = 32;

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
      // Measure growing prefixes so kerning and letter spacing are kept, but restart the prefix
      // at every word and every `CHUNK` chars: the cost stays linear and the cache keys short.
      let font = sg.style.font();
      let chars: Vec<char> = sg.text.chars().collect();
      let base_x = x;
      let mut chunk_x = 0.0;
      let mut gaps = 0.0;
      let mut chunk = String::new();
      let mut chunk_len = 0;
      for (i, &c) in chars.iter().enumerate() {
        chunk.push(c);
        chunk_len += 1;
        let w = m.measure(&chunk, &font);
        if matches!(c, ' ' | '\u{a0}') {
          gaps += gap;
        }
        xs.push(base_x + chunk_x + w + gaps);
        let word_end = c == ' ' && chars.get(i + 1).is_some_and(|n| *n != ' ');
        if word_end || chunk_len >= CARET_CHUNK {
          chunk_x += w;
          chunk.clear();
          chunk_len = 0;
        }
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

  struct Counting {
    calls: std::cell::Cell<usize>,
    chars: std::cell::Cell<usize>,
  }
  impl TextMeasurer for Counting {
    fn measure(&self, text: &str, font: &FontSpec) -> f64 {
      self.calls.set(self.calls.get() + 1);
      self.chars.set(self.chars.get() + text.chars().count());
      HeuristicMeasurer.measure(text, font)
    }
  }

  #[test]
  fn caret_geometry_of_a_long_single_line_is_linear() {
    let words = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(60);
    let text: String = words.chars().take(3000).collect();
    let (n, t) = text_node(&text, 100.0, 20.0, |_, _| {});
    let m = Counting {
      calls: Default::default(),
      chars: Default::default(),
    };
    let g = caret_geometry(&n, &t, &m, true, None);
    assert_eq!(g.lines.len(), 1);
    assert_eq!(g.lines[0].xs.len(), 3001);
    // About one measure per char, over short strings: the old prefix walk measured ~4.5M chars.
    assert!(m.calls.get() < 4 * 3000, "{} calls", m.calls.get());
    assert!(m.chars.get() < 3000 * 40, "{} chars measured", m.chars.get());
    // Positions agree with the whole-prefix measure to within half a pixel.
    let font = SpanStyle::base(&t);
    let all: Vec<char> = text.chars().collect();
    for i in [1usize, 40, 500, 1500, 2999, 3000] {
      let prefix: String = all[..i].iter().collect();
      let exact = HeuristicMeasurer.measure(&prefix, &font.font());
      assert!((g.lines[0].xs[i] - exact).abs() < 0.5, "char {i}: {} vs {exact}", g.lines[0].xs[i]);
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

  /// Every ideograph is one em wide, everything else half an em: box widths count characters.
  struct Em;

  impl TextMeasurer for Em {
    fn measure(&self, text: &str, font: &FontSpec) -> f64 {
      text
        .chars()
        .map(|c| if is_ideographic(c) { font.size } else { font.size / 2.0 })
        .sum()
    }
  }

  const JA: &str = "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。「何でも薄暗いじめじめした所で、ニャーニャー泣いていた事だけは記憶している。」（ぁっ）";
  const ZH: &str = "春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少？（这是一首唐诗。）“好”，他说！";

  fn cjk_lines(text: &str, chars_wide: f64) -> Vec<String> {
    let props = TextProps {
      characters: text.into(),
      font_size: 10.0,
      auto_resize: TextAutoResize::Height,
      ..Default::default()
    };
    layout_text(&props, Some(chars_wide * 10.0), &Em)
      .lines
      .into_iter()
      .map(|l| l.text)
      .collect()
  }

  #[test]
  fn cjk_lines_never_start_or_end_against_kinsoku() {
    for text in [JA, ZH] {
      for width in 1..=30 {
        let lines = cjk_lines(text, width as f64);
        assert_eq!(lines.concat(), text, "width {width}: no character is lost");
        for l in &lines {
          let first = l.chars().next().unwrap();
          let last = l.chars().last().unwrap();
          // A line can only break the rules when nothing else fits in the box (a word wider
          // than the box that has no allowed break).
          let tiny = l.chars().count() == 1 || width <= 2;
          assert!(!no_line_start(first) || tiny, "width {width}: {l:?} starts with {first}");
          assert!(!no_line_end(last) || tiny, "width {width}: {l:?} ends with {last}");
        }
      }
    }
  }

  #[test]
  fn cjk_breaks_match_the_table() {
    assert_eq!(
      cjk_lines("今日は晴れです。明日は雨でしょう。", 8.0),
      vec!["今日は晴れです。", "明日は雨でしょ", "う。"]
    );
    assert_eq!(
      cjk_lines("「こんにちは」と彼は言った。", 5.0),
      vec!["「こんにち", "は」と彼は", "言った。"]
    );
    assert_eq!(cjk_lines("春眠不觉晓，处处闻啼鸟。", 5.0), vec!["春眠不觉", "晓，处处闻", "啼鸟。"]);
  }

  #[test]
  fn a_closing_mark_pulls_the_character_before_it_down() {
    assert_eq!(cjk_lines("今日は晴れ。", 5.0), vec!["今日は晴", "れ。"]);
    // An opening bracket never ends a line.
    assert_eq!(cjk_lines("今日は「晴れ」", 4.0), vec!["今日は", "「晴れ」"]);
  }

  #[test]
  fn cjk_edge_cases_keep_their_characters() {
    // A run of prolonged sound marks has nothing to carry: it breaks wherever the box is full, as
    // the browser does.
    let run = "ー".repeat(10);
    assert_eq!(cjk_lines(&run, 3.0), vec!["ーーー", "ーーー", "ーーー", "ー"]);
    // A box narrower than a character: one character per line.
    assert_eq!(cjk_lines("今日。", 0.5), vec!["今", "日", "。"]);
    // Inseparable leaders, percent after an ideograph, halfwidth marks, combining marks.
    assert_eq!(cjk_lines("前年比……増加", 5.0).concat(), "前年比……増加");
    for (text, width) in [
      ("前年比百二十%増加", 6.0),
      ("前年比百二十％増加", 6.0),
      ("前年比百二……", 6.0),
      ("日本語ｱｲｳ｡日本語", 3.0),
    ] {
      for l in cjk_lines(text, width) {
        let first = l.chars().next().unwrap();
        assert!(!no_line_start(first) || l.chars().count() == 1, "{text}: {l:?}");
      }
    }
    assert_eq!(cjk_lines("前年比百二十%増加", 6.0)[0], "前年比百二");
    assert!(no_line_start('…') && no_line_start('‥') && no_line_start('%') && no_line_start('％'));
    assert!(
      no_line_start('｡')
        && no_line_start('､')
        && no_line_start('｣')
        && no_line_start('･')
        && no_line_start('ｰ')
        && no_line_start('ｧ')
        && no_line_start('ｯ')
    );
    assert!(no_line_end('｢') && no_line_end('\u{200D}'));
    for c in [
      '\u{0301}',
      '\u{3099}',
      '\u{309A}',
      '\u{FE0F}',
      '\u{E0100}',
      '\u{200D}',
      '\u{1161}',
      '\u{11A8}',
      '\u{FF9E}',
      '\u{FF9F}',
      '\u{20DD}',
    ] {
      assert!(no_line_start(c), "{:X}", c as u32);
    }
    // A voiced sound mark stays with its kana.
    for l in cjk_lines("か\u{3099}か\u{3099}か\u{3099}か\u{3099}", 1.0) {
      assert!(!l.starts_with('\u{3099}'), "{l:?}");
    }
    // Latin words stay whole between CJK.
    let l = cjk_lines("私はRustが好き", 5.0);
    assert_eq!(l.concat(), "私はRustが好き");
    assert!(l.iter().any(|x| x.contains("Rust")), "{l:?}");
    // Full-width space.
    let l = cjk_lines("あ\u{3000}い\u{3000}う", 2.0);
    assert!(l.iter().all(|x| !x.starts_with('\u{3000}')), "{l:?}");
    // Right-aligned and justified text takes the same lines.
    for align in [crate::model::TextAlignH::Right, crate::model::TextAlignH::Justify] {
      let props = TextProps {
        characters: JA.into(),
        font_size: 10.0,
        align_h: align,
        auto_resize: TextAutoResize::Height,
        ..Default::default()
      };
      let l = layout_text(&props, Some(100.0), &Em);
      assert_eq!(l.lines.iter().map(|x| x.text.as_str()).collect::<String>(), JA);
    }
  }

  #[test]
  fn emoji_clusters_stay_whole_in_a_box_narrower_than_a_glyph() {
    let lay = |text: &str| -> Vec<String> {
      let props = TextProps {
        characters: text.into(),
        auto_resize: TextAutoResize::Height,
        ..Default::default()
      };
      layout_text(&props, Some(12.0), &HeuristicMeasurer)
        .lines
        .into_iter()
        .map(|l| l.text)
        .collect()
    };
    let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    let tone = "\u{1F44D}\u{1F3FD}";
    let flag = "\u{1F1EF}\u{1F1F5}";
    for cluster in [family, tone, flag] {
      let lines = lay(&format!("日{cluster}日"));
      assert_eq!(lines.concat(), format!("日{cluster}日"));
      assert!(lines.iter().any(|l| l == cluster), "{cluster:?} split: {lines:?}");
    }
    // Two flags in a row break between them, not inside one.
    let lines = lay(&format!("日{flag}{flag}日"));
    assert!(lines.iter().filter(|l| *l == flag).count() == 2, "{lines:?}");
    // A tag sequence (subdivision flag) stays with its base.
    let tags = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    assert!(lay(&format!("日{tags}日")).iter().any(|l| l == tags));
  }

  #[test]
  fn latin_text_keeps_its_old_breaks() {
    // Without ideographs the table is not consulted: a long word still breaks at any character.
    let long = TextProps {
      characters: "abc,def.ghi".into(),
      auto_resize: TextAutoResize::Height,
      ..Default::default()
    };
    let l = layout_text(&long, Some(30.0), &Em);
    assert!(
      l.lines.iter().any(|x| x.text.starts_with(',') || x.text.starts_with('.')),
      "{:?}",
      l.lines
    );
  }

  #[test]
  fn a_soft_break_starts_a_line_without_paragraph_spacing() {
    let props = TextProps {
      characters: "a\u{2028}b\nc".into(),
      paragraph_spacing: 20.0,
      ..Default::default()
    };
    let l = layout_text(&props, None, &HeuristicMeasurer);
    let lh = 16.0 * 1.2;
    let texts: Vec<&str> = l.lines.iter().map(|x| x.text.as_str()).collect();
    assert_eq!(texts, vec!["a", "b", "c"]);
    let tops: Vec<f64> = l.lines.iter().map(|x| x.top).collect();
    assert_eq!(tops, vec![0.0, lh, 2.0 * lh + 20.0]);
    // The break takes one index, like a newline, and the line before it is a hard line.
    assert_eq!((l.lines[0].start, l.lines[0].end), (0, 1));
    assert_eq!((l.lines[1].start, l.lines[1].end), (2, 3));
    assert_eq!((l.lines[2].start, l.lines[2].end), (4, 5));
    assert!(!l.lines[0].soft_wrap && !l.lines[1].soft_wrap);
    // Nothing of the break is measured or drawn.
    assert!(l.lines.iter().all(|x| !x.text.contains('\u{2028}')));
  }

  #[test]
  fn soft_breaks_at_the_edges_and_twice_in_a_row() {
    let lay = |s: &str| {
      let props = TextProps {
        characters: s.into(),
        ..Default::default()
      };
      layout_text(&props, None, &HeuristicMeasurer)
    };
    assert_eq!(lay("\u{2028}a").lines.len(), 2);
    assert_eq!(lay("a\u{2028}").lines.len(), 2);
    let l = lay("a\u{2028}\u{2028}b");
    assert_eq!(l.lines.iter().map(|x| x.text.as_str()).collect::<Vec<_>>(), vec!["a", "", "b"]);
    assert_eq!(l.lines[2].start, 3);
    // Next to a newline.
    let l = lay("a\u{2028}\nb");
    assert_eq!(l.lines.iter().map(|x| x.text.as_str()).collect::<Vec<_>>(), vec!["a", "", "b"]);
    // Auto width grows to the longest line.
    let l = lay("ab\u{2028}abcdef");
    assert_eq!(l.width, l.lines[1].width);
    // Wrapping inside a line after a soft break still counts as soft wrap.
    let props = TextProps {
      characters: "x\u{2028}one two three four five six".into(),
      ..Default::default()
    };
    let l = layout_text(&props, Some(60.0), &HeuristicMeasurer);
    assert!(!l.lines[0].soft_wrap && l.lines[1].soft_wrap);
  }

  #[test]
  fn the_caret_after_a_soft_break_is_on_the_next_line() {
    let (n, t) = text_node("ab\u{2028}cd", 200.0, 100.0, |_, _| {});
    let g = caret_geometry(&n, &t, &HeuristicMeasurer, true, None);
    assert_eq!(g.lines.len(), 2);
    assert_eq!((g.lines[0].start, g.lines[0].end), (0, 2));
    assert_eq!((g.lines[1].start, g.lines[1].end), (3, 5));
    assert!(g.lines[1].top > g.lines[0].top);
  }

  #[test]
  fn soft_breaks_survive_a_run_remap() {
    let runs = vec![bold(0, 3)];
    let r = remap_runs("ab\u{2028}cd", "ab\u{2028}cXd", &runs);
    assert_eq!((r[0].start, r[0].end), (0, 3));
  }
}
