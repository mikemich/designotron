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

/// Parses `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, `rgb()/rgba()` and a few names.
pub fn parse(input: &str) -> Option<Rgba> {
  let s = input.trim();
  if let Some(hex) = s.strip_prefix('#') {
    return parse_hex(hex);
  }
  let lower = s.to_ascii_lowercase();
  if lower.starts_with("rgb") {
    let inner = lower.split_once('(')?.1.trim_end_matches(')');
    let parts: Vec<f64> = inner
      .split([',', ' ', '/'])
      .filter(|p| !p.is_empty())
      .filter_map(|p| p.trim_end_matches('%').parse::<f64>().ok())
      .collect();
    if parts.len() < 3 {
      return None;
    }
    let a = parts.get(3).copied().unwrap_or(1.0);
    return Some(Rgba {
      r: parts[0].clamp(0.0, 255.0) as u8,
      g: parts[1].clamp(0.0, 255.0) as u8,
      b: parts[2].clamp(0.0, 255.0) as u8,
      a: if a > 1.0 { a / 100.0 } else { a },
    });
  }
  let named = match lower.as_str() {
    "black" => "000000",
    "white" => "FFFFFF",
    "red" => "FF0000",
    "green" => "00FF00",
    "blue" => "0000FF",
    "transparent" => "00000000",
    "gray" | "grey" => "808080",
    _ => return None,
  };
  parse_hex(named)
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
}
