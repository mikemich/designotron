//! Colour parsing and formatting. Colours are stored as hex strings
//! (`#RRGGBB` or `#RRGGBBAA`) so they stay readable for humans and AI.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
  pub r: u8,
  pub g: u8,
  pub b: u8,
  /// 0..1
  pub a: f64,
}

impl Rgba {
  pub const BLACK: Rgba = Rgba { r: 0, g: 0, b: 0, a: 1.0 };

  pub fn hex6(&self) -> String {
    format!("#{:02X}{:02X}{:02X}", self.r, self.g, self.b)
  }

  pub fn hex(&self) -> String {
    if self.a >= 0.999 {
      self.hex6()
    } else {
      format!("{}{:02X}", self.hex6(), (self.a * 255.0).round() as u8)
    }
  }

  pub fn css(&self) -> String {
    if self.a >= 0.999 {
      self.hex6()
    } else {
      format!("rgba({}, {}, {}, {})", self.r, self.g, self.b, crate::geom::fmt(self.a))
    }
  }

  pub fn with_alpha(mut self, factor: f64) -> Rgba {
    self.a = (self.a * factor).clamp(0.0, 1.0);
    self
  }
}

/// Parses `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, `rgb()/rgba()`, `hsl()/hsla()` and the CSS
/// named colours.
pub fn parse(input: &str) -> Option<Rgba> {
  let s = input.trim();
  if let Some(hex) = s.strip_prefix('#') {
    return parse_hex(hex);
  }
  let lower = s.to_ascii_lowercase();
  if lower.starts_with("rgb") || lower.starts_with("hsl") {
    let inner = lower.split_once('(')?.1.trim_end_matches(')');
    let parts: Vec<&str> = inner.split([',', ' ', '/']).filter(|p| !p.is_empty()).collect();
    if parts.len() < 3 {
      return None;
    }
    let num = |p: &str| p.trim_end_matches(['%', 'd', 'e', 'g']).parse::<f64>().ok();
    let alpha = match parts.get(3) {
      None => 1.0,
      Some(p) => {
        let v = num(p)?;
        if p.ends_with('%') || v > 1.0 {
          v / 100.0
        } else {
          v
        }
      }
    }
    .clamp(0.0, 1.0);
    if lower.starts_with("hsl") {
      let h = num(parts[0])?;
      let s = num(parts[1])?.clamp(0.0, 100.0) / 100.0;
      let l = num(parts[2])?.clamp(0.0, 100.0) / 100.0;
      let (r, g, b) = hsl_to_rgb(h, s, l);
      return Some(Rgba { r, g, b, a: alpha });
    }
    let chan = |p: &str| -> Option<u8> {
      let v = num(p)?;
      let v = if p.ends_with('%') { v * 255.0 / 100.0 } else { v };
      Some(v.round().clamp(0.0, 255.0) as u8)
    };
    return Some(Rgba {
      r: chan(parts[0])?,
      g: chan(parts[1])?,
      b: chan(parts[2])?,
      a: alpha,
    });
  }
  if lower == "transparent" {
    return Some(Rgba { r: 0, g: 0, b: 0, a: 0.0 });
  }
  let i = NAMED.binary_search_by(|(n, _)| (*n).cmp(lower.as_str())).ok()?;
  let v = NAMED[i].1;
  Some(Rgba {
    r: (v >> 16) as u8,
    g: (v >> 8) as u8,
    b: v as u8,
    a: 1.0,
  })
}

/// The CSS named colours, sorted for binary search.
const NAMED: &[(&str, u32)] = &[
  ("aliceblue", 0xf0f8ff),
  ("antiquewhite", 0xfaebd7),
  ("aqua", 0x00ffff),
  ("aquamarine", 0x7fffd4),
  ("azure", 0xf0ffff),
  ("beige", 0xf5f5dc),
  ("bisque", 0xffe4c4),
  ("black", 0x000000),
  ("blanchedalmond", 0xffebcd),
  ("blue", 0x0000ff),
  ("blueviolet", 0x8a2be2),
  ("brown", 0xa52a2a),
  ("burlywood", 0xdeb887),
  ("cadetblue", 0x5f9ea0),
  ("chartreuse", 0x7fff00),
  ("chocolate", 0xd2691e),
  ("coral", 0xff7f50),
  ("cornflowerblue", 0x6495ed),
  ("cornsilk", 0xfff8dc),
  ("crimson", 0xdc143c),
  ("cyan", 0x00ffff),
  ("darkblue", 0x00008b),
  ("darkcyan", 0x008b8b),
  ("darkgoldenrod", 0xb8860b),
  ("darkgray", 0xa9a9a9),
  ("darkgreen", 0x006400),
  ("darkgrey", 0xa9a9a9),
  ("darkkhaki", 0xbdb76b),
  ("darkmagenta", 0x8b008b),
  ("darkolivegreen", 0x556b2f),
  ("darkorange", 0xff8c00),
  ("darkorchid", 0x9932cc),
  ("darkred", 0x8b0000),
  ("darksalmon", 0xe9967a),
  ("darkseagreen", 0x8fbc8f),
  ("darkslateblue", 0x483d8b),
  ("darkslategray", 0x2f4f4f),
  ("darkslategrey", 0x2f4f4f),
  ("darkturquoise", 0x00ced1),
  ("darkviolet", 0x9400d3),
  ("deeppink", 0xff1493),
  ("deepskyblue", 0x00bfff),
  ("dimgray", 0x696969),
  ("dimgrey", 0x696969),
  ("dodgerblue", 0x1e90ff),
  ("firebrick", 0xb22222),
  ("floralwhite", 0xfffaf0),
  ("forestgreen", 0x228b22),
  ("fuchsia", 0xff00ff),
  ("gainsboro", 0xdcdcdc),
  ("ghostwhite", 0xf8f8ff),
  ("gold", 0xffd700),
  ("goldenrod", 0xdaa520),
  ("gray", 0x808080),
  ("green", 0x008000),
  ("greenyellow", 0xadff2f),
  ("grey", 0x808080),
  ("honeydew", 0xf0fff0),
  ("hotpink", 0xff69b4),
  ("indianred", 0xcd5c5c),
  ("indigo", 0x4b0082),
  ("ivory", 0xfffff0),
  ("khaki", 0xf0e68c),
  ("lavender", 0xe6e6fa),
  ("lavenderblush", 0xfff0f5),
  ("lawngreen", 0x7cfc00),
  ("lemonchiffon", 0xfffacd),
  ("lightblue", 0xadd8e6),
  ("lightcoral", 0xf08080),
  ("lightcyan", 0xe0ffff),
  ("lightgoldenrodyellow", 0xfafad2),
  ("lightgray", 0xd3d3d3),
  ("lightgreen", 0x90ee90),
  ("lightgrey", 0xd3d3d3),
  ("lightpink", 0xffb6c1),
  ("lightsalmon", 0xffa07a),
  ("lightseagreen", 0x20b2aa),
  ("lightskyblue", 0x87cefa),
  ("lightslategray", 0x778899),
  ("lightslategrey", 0x778899),
  ("lightsteelblue", 0xb0c4de),
  ("lightyellow", 0xffffe0),
  ("lime", 0x00ff00),
  ("limegreen", 0x32cd32),
  ("linen", 0xfaf0e6),
  ("magenta", 0xff00ff),
  ("maroon", 0x800000),
  ("mediumaquamarine", 0x66cdaa),
  ("mediumblue", 0x0000cd),
  ("mediumorchid", 0xba55d3),
  ("mediumpurple", 0x9370db),
  ("mediumseagreen", 0x3cb371),
  ("mediumslateblue", 0x7b68ee),
  ("mediumspringgreen", 0x00fa9a),
  ("mediumturquoise", 0x48d1cc),
  ("mediumvioletred", 0xc71585),
  ("midnightblue", 0x191970),
  ("mintcream", 0xf5fffa),
  ("mistyrose", 0xffe4e1),
  ("moccasin", 0xffe4b5),
  ("navajowhite", 0xffdead),
  ("navy", 0x000080),
  ("oldlace", 0xfdf5e6),
  ("olive", 0x808000),
  ("olivedrab", 0x6b8e23),
  ("orange", 0xffa500),
  ("orangered", 0xff4500),
  ("orchid", 0xda70d6),
  ("palegoldenrod", 0xeee8aa),
  ("palegreen", 0x98fb98),
  ("paleturquoise", 0xafeeee),
  ("palevioletred", 0xdb7093),
  ("papayawhip", 0xffefd5),
  ("peachpuff", 0xffdab9),
  ("peru", 0xcd853f),
  ("pink", 0xffc0cb),
  ("plum", 0xdda0dd),
  ("powderblue", 0xb0e0e6),
  ("purple", 0x800080),
  ("rebeccapurple", 0x663399),
  ("red", 0xff0000),
  ("rosybrown", 0xbc8f8f),
  ("royalblue", 0x4169e1),
  ("saddlebrown", 0x8b4513),
  ("salmon", 0xfa8072),
  ("sandybrown", 0xf4a460),
  ("seagreen", 0x2e8b57),
  ("seashell", 0xfff5ee),
  ("sienna", 0xa0522d),
  ("silver", 0xc0c0c0),
  ("skyblue", 0x87ceeb),
  ("slateblue", 0x6a5acd),
  ("slategray", 0x708090),
  ("slategrey", 0x708090),
  ("snow", 0xfffafa),
  ("springgreen", 0x00ff7f),
  ("steelblue", 0x4682b4),
  ("tan", 0xd2b48c),
  ("teal", 0x008080),
  ("thistle", 0xd8bfd8),
  ("tomato", 0xff6347),
  ("turquoise", 0x40e0d0),
  ("violet", 0xee82ee),
  ("wheat", 0xf5deb3),
  ("white", 0xffffff),
  ("whitesmoke", 0xf5f5f5),
  ("yellow", 0xffff00),
  ("yellowgreen", 0x9acd32),
];

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
  let h = h.rem_euclid(360.0) / 360.0;
  let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
  let p = 2.0 * l - q;
  let ch = |mut t: f64| -> u8 {
    t = t.rem_euclid(1.0);
    let v = if t < 1.0 / 6.0 {
      p + (q - p) * 6.0 * t
    } else if t < 0.5 {
      q
    } else if t < 2.0 / 3.0 {
      p + (q - p) * (2.0 / 3.0 - t) * 6.0
    } else {
      p
    };
    (v * 255.0).round().clamp(0.0, 255.0) as u8
  };
  (ch(h + 1.0 / 3.0), ch(h), ch(h - 1.0 / 3.0))
}

fn parse_hex(hex: &str) -> Option<Rgba> {
  let expand = |c: char| -> Option<u8> { u8::from_str_radix(&format!("{c}{c}"), 16).ok() };
  let pair = |i: usize| -> Option<u8> { u8::from_str_radix(hex.get(i..i + 2)?, 16).ok() };
  let chars: Vec<char> = hex.chars().collect();
  match chars.len() {
    3 | 4 => Some(Rgba {
      r: expand(chars[0])?,
      g: expand(chars[1])?,
      b: expand(chars[2])?,
      a: if chars.len() == 4 { expand(chars[3])? as f64 / 255.0 } else { 1.0 },
    }),
    6 | 8 => Some(Rgba {
      r: pair(0)?,
      g: pair(2)?,
      b: pair(4)?,
      a: if chars.len() == 8 { pair(6)? as f64 / 255.0 } else { 1.0 },
    }),
    _ => None,
  }
}

/// Normalises any accepted colour string to canonical hex, falling back to black.
pub fn normalize(input: &str) -> String {
  parse(input).unwrap_or(Rgba::BLACK).hex()
}

/// Canonical hex for a colour the parser understands; None for anything else (unlike `normalize`,
/// which turns it into black).
pub fn parse_strict(input: &str) -> Option<String> {
  parse(input).map(|c| c.hex())
}

/// CSS colour for a stored colour multiplied by an extra opacity.
pub fn css_with_opacity(color: &str, opacity: f64) -> String {
  parse(color).unwrap_or(Rgba::BLACK).with_alpha(opacity).css()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_forms() {
    assert_eq!(parse("#fff").unwrap().hex(), "#FFFFFF");
    assert_eq!(parse("#11223380").unwrap().a, 128.0 / 255.0);
    assert_eq!(parse("rgb(255, 0, 0)").unwrap().hex(), "#FF0000");
    assert_eq!(parse("rgba(0,0,0,0.5)").unwrap().css(), "rgba(0, 0, 0, 0.5)");
    assert!(parse("nope").is_none());
  }

  #[test]
  fn css_named_colours_match_the_spec() {
    assert_eq!(parse("green").unwrap().hex(), "#008000");
    assert_eq!(parse("Lime").unwrap().hex(), "#00FF00");
    assert_eq!(parse("rebeccapurple").unwrap().hex(), "#663399");
    assert_eq!(parse("grey").unwrap().hex(), "#808080");
    assert_eq!(parse("transparent").unwrap().a, 0.0);
    assert!(NAMED.windows(2).all(|w| w[0].0 < w[1].0), "table must stay sorted");
    assert_eq!(NAMED.len(), 148);
  }

  #[test]
  fn percent_and_hsl_forms() {
    assert_eq!(parse("rgb(100%, 0%, 50%)").unwrap().hex(), "#FF0080");
    assert_eq!(parse("rgb(255 0 0 / 50%)").unwrap().a, 0.5);
    assert_eq!(parse("hsl(120, 100%, 25%)").unwrap().hex(), "#008000");
    assert_eq!(parse("hsla(0, 100%, 50%, 0.5)").unwrap().hex(), "#FF000080");
  }

  #[test]
  fn strict_parsing_never_falls_back_to_black() {
    assert_eq!(parse_strict("rgb(255, 0, 0)").as_deref(), Some("#FF0000"));
    assert_eq!(parse_strict("not-a-colour"), None);
    assert_eq!(normalize("not-a-colour"), "#000000");
  }
}
