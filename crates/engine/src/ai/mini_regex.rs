//! A small regular-expression matcher for `find_nodes` (the engine takes no regex crate). It
//! covers what layer-name searches use: literals, `.`, `[a-z]` classes, `\d \w \s` (and their
//! negations), `^ $`, groups, `|` and the quantifiers `* + ? {n} {n,} {n,m}`. Matching is
//! case-insensitive, unanchored and bounded in work, so a hostile pattern can't hang the editor.

use std::cell::Cell;

/// Most atom comparisons one match may make.
const BUDGET: u64 = 2_000_000;
/// Longest pattern accepted.
const MAX_PATTERN: usize = 200;

pub struct Regex {
  alt: Alt,
}

struct Alt(Vec<Vec<Item>>);

struct Item {
  atom: Atom,
  min: usize,
  max: usize,
}

enum Atom {
  Char(char),
  Any,
  Class(Vec<Range>, bool),
  Start,
  End,
  Group(Alt),
}

enum Range {
  Span(char, char),
  Digit(bool),
  Word(bool),
  Space(bool),
}

impl Regex {
  pub fn new(pattern: &str) -> Result<Regex, String> {
    if pattern.chars().count() > MAX_PATTERN {
      return Err(format!("the pattern is longer than {MAX_PATTERN} characters"));
    }
    let chars: Vec<char> = pattern.chars().collect();
    let mut pos = 0;
    let alt = parse_alt(&chars, &mut pos, 0)?;
    if pos < chars.len() {
      return Err("unmatched ')'".into());
    }
    Ok(Regex { alt })
  }

  pub fn is_match(&self, text: &str) -> bool {
    let t: Vec<char> = text.chars().flat_map(|c| c.to_lowercase()).collect();
    let budget = Cell::new(BUDGET);
    (0..=t.len()).any(|start| match_alt(&self.alt, &t, start, &budget, &mut |_| true))
  }
}

fn parse_alt(p: &[char], pos: &mut usize, depth: usize) -> Result<Alt, String> {
  if depth > 20 {
    return Err("groups are nested too deeply".into());
  }
  let mut alts = vec![Vec::new()];
  while *pos < p.len() {
    let c = p[*pos];
    let atom = match c {
      ')' if depth > 0 => break,
      ')' => return Err("unmatched ')'".into()),
      '|' => {
        *pos += 1;
        alts.push(Vec::new());
        continue;
      }
      '(' => {
        *pos += 1;
        if p.get(*pos) == Some(&'?') && p.get(*pos + 1) == Some(&':') {
          *pos += 2;
        }
        let inner = parse_alt(p, pos, depth + 1)?;
        if p.get(*pos) != Some(&')') {
          return Err("missing ')'".into());
        }
        *pos += 1;
        Atom::Group(inner)
      }
      '[' => {
        *pos += 1;
        parse_class(p, pos)?
      }
      '.' => {
        *pos += 1;
        Atom::Any
      }
      '^' => {
        *pos += 1;
        Atom::Start
      }
      '$' => {
        *pos += 1;
        Atom::End
      }
      '\\' => {
        *pos += 1;
        let e = *p.get(*pos).ok_or("a pattern can't end with a backslash")?;
        *pos += 1;
        match escape_class(e) {
          Some(r) => Atom::Class(vec![r], false),
          None => Atom::Char(match e {
            'n' => '\n',
            't' => '\t',
            other => lower(other),
          }),
        }
      }
      '*' | '+' | '?' => return Err(format!("nothing to repeat before '{c}'")),
      other => {
        *pos += 1;
        Atom::Char(lower(other))
      }
    };
    let (min, max) = quantifier(p, pos)?;
    alts.last_mut().unwrap().push(Item { atom, min, max });
  }
  Ok(Alt(alts))
}

fn quantifier(p: &[char], pos: &mut usize) -> Result<(usize, usize), String> {
  let q = match p.get(*pos) {
    Some('*') => (0, usize::MAX),
    Some('+') => (1, usize::MAX),
    Some('?') => (0, 1),
    Some('{') => {
      let close = p[*pos..].iter().position(|c| *c == '}').ok_or("missing '}'")? + *pos;
      let body: String = p[*pos + 1..close].iter().collect();
      let num = |s: &str| s.trim().parse::<usize>().map_err(|_| format!("bad repeat '{{{body}}}'"));
      let q = match body.split_once(',') {
        None => {
          let n = num(&body)?;
          (n, n)
        }
        Some((a, "")) => (num(a)?, usize::MAX),
        Some((a, b)) => (num(a)?, num(b)?),
      };
      *pos = close;
      q
    }
    _ => return Ok((1, 1)),
  };
  *pos += 1;
  // A lazy marker changes which match wins, not whether there is one.
  if p.get(*pos) == Some(&'?') {
    *pos += 1;
  }
  Ok(q)
}

fn parse_class(p: &[char], pos: &mut usize) -> Result<Atom, String> {
  let negate = p.get(*pos) == Some(&'^');
  if negate {
    *pos += 1;
  }
  let mut ranges = Vec::new();
  let mut first = true;
  loop {
    let c = *p.get(*pos).ok_or("missing ']'")?;
    *pos += 1;
    if c == ']' && !first {
      break;
    }
    first = false;
    let lo = if c == '\\' {
      let e = *p.get(*pos).ok_or("missing ']'")?;
      *pos += 1;
      if let Some(r) = escape_class(e) {
        ranges.push(r);
        continue;
      }
      lower(if e == 'n' { '\n' } else { e })
    } else {
      lower(c)
    };
    if p.get(*pos) == Some(&'-') && p.get(*pos + 1).is_some_and(|c| *c != ']') {
      let hi = lower(p[*pos + 1]);
      *pos += 2;
      ranges.push(Range::Span(lo.min(hi), lo.max(hi)));
    } else {
      ranges.push(Range::Span(lo, lo));
    }
  }
  Ok(Atom::Class(ranges, negate))
}

fn escape_class(e: char) -> Option<Range> {
  Some(match e {
    'd' => Range::Digit(true),
    'D' => Range::Digit(false),
    'w' => Range::Word(true),
    'W' => Range::Word(false),
    's' => Range::Space(true),
    'S' => Range::Space(false),
    _ => return None,
  })
}

fn lower(c: char) -> char {
  c.to_lowercase().next().unwrap_or(c)
}

fn in_class(r: &[Range], negate: bool, c: char) -> bool {
  let hit = r.iter().any(|r| match r {
    Range::Span(a, b) => (*a..=*b).contains(&c),
    Range::Digit(yes) => c.is_ascii_digit() == *yes,
    Range::Word(yes) => (c.is_alphanumeric() || c == '_') == *yes,
    Range::Space(yes) => c.is_whitespace() == *yes,
  });
  hit != negate
}

type Cont<'a> = &'a mut dyn FnMut(usize) -> bool;

fn match_alt(alt: &Alt, t: &[char], pos: usize, budget: &Cell<u64>, k: Cont) -> bool {
  for seq in &alt.0 {
    if match_seq(seq, t, pos, budget, k) {
      return true;
    }
  }
  false
}

fn match_seq(seq: &[Item], t: &[char], pos: usize, budget: &Cell<u64>, k: Cont) -> bool {
  match seq.split_first() {
    None => k(pos),
    Some((item, rest)) => match_rep(item, rest, t, pos, 0, budget, k),
  }
}

/// Greedy repeat of `item` (`count` done so far), then `rest`.
fn match_rep(item: &Item, rest: &[Item], t: &[char], pos: usize, count: usize, budget: &Cell<u64>, k: Cont) -> bool {
  if count < item.max {
    let more = match_atom(&item.atom, t, pos, budget, &mut |p| {
      // An empty repeat can't make progress.
      if p == pos && count >= item.min {
        return false;
      }
      match_rep(item, rest, t, p, count + 1, budget, k)
    });
    if more {
      return true;
    }
  }
  count >= item.min && match_seq(rest, t, pos, budget, k)
}

fn match_atom(atom: &Atom, t: &[char], pos: usize, budget: &Cell<u64>, k: Cont) -> bool {
  let left = budget.get();
  if left == 0 {
    return false;
  }
  budget.set(left - 1);
  match atom {
    Atom::Char(c) => t.get(pos) == Some(c) && k(pos + 1),
    Atom::Any => pos < t.len() && k(pos + 1),
    Atom::Class(r, negate) => t.get(pos).is_some_and(|c| in_class(r, *negate, *c)) && k(pos + 1),
    Atom::Start => pos == 0 && k(pos),
    Atom::End => pos == t.len() && k(pos),
    Atom::Group(alt) => match_alt(alt, t, pos, budget, k),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn m(p: &str, t: &str) -> bool {
    Regex::new(p).unwrap().is_match(t)
  }

  #[test]
  fn matches_what_name_searches_need() {
    assert!(m("^button", "Button / Primary"));
    assert!(!m("^button", "Icon button"));
    assert!(m("card (\\d+)$", "Card 12"));
    assert!(!m("card (\\d+)$", "Card x"));
    assert!(m("a|b", "xxb"));
    assert!(m("^(nav|header)", "Header bar"));
    assert!(m("[a-c]{2}x", "zabx"));
    assert!(m("colou?r", "Color"));
    assert!(m("^[^0-9]+$", "Title"));
    assert!(!m("^[^0-9]+$", "Title 2"));
  }

  #[test]
  fn rejects_bad_patterns_and_bounds_work() {
    assert!(Regex::new("(a").is_err());
    assert!(Regex::new("*a").is_err());
    assert!(Regex::new("a)").is_err());
    // Exponential backtracking gives up instead of hanging.
    let r = Regex::new("(a+)+$").unwrap();
    assert!(!r.is_match(&format!("{}!", "a".repeat(40))));
  }
}
