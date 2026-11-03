//! A small regular-expression matcher for `find_nodes` (the engine takes no regex crate). It
//! covers what layer-name searches use: literals, `.`, `[a-z]` classes, `\d \w \s` (and their
//! negations), `^ $`, groups, `|` and the quantifiers `* + ? {n} {n,} {n,m}`. Matching is
//! case-insensitive and unanchored. A pattern compiles to a program that a Pike VM runs: time is
//! linear in the text and the program, nothing recurses per character, and every step is counted
//! against a budget the caller shares across many matches, so no pattern can hang or overflow
//! the stack (the engine runs in the editor's tab).

/// Longest pattern accepted.
const MAX_PATTERN: usize = 200;
/// Biggest repeat count (`{n}`).
const MAX_REPEAT: usize = 1000;
/// Most instructions a compiled pattern may have.
const MAX_PROGRAM: usize = 20_000;
/// Deepest group nesting.
const MAX_DEPTH: usize = 20;

pub struct Regex {
  prog: Vec<Inst>,
}

/// The shared work budget ran out.
#[derive(Debug, PartialEq)]
pub struct TooComplex;

enum Inst {
  Char(char),
  Any,
  Class(Vec<Range>, bool),
  Start,
  End,
  /// Try the first target, then the second.
  Split(usize, usize),
  Jmp(usize),
  Match,
}

// ---------- Parsing ----------

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
    let mut prog = Vec::new();
    compile_alt(&alt, &mut prog)?;
    prog.push(Inst::Match);
    Ok(Regex { prog })
  }

  /// Whether the pattern matches anywhere in `text`, spending at most `budget` steps (the
  /// budget is shared: pass the same counter for every text of one search).
  pub fn is_match(&self, text: &str, budget: &mut u64) -> Result<bool, TooComplex> {
    let t: Vec<char> = text.chars().flat_map(|c| c.to_lowercase()).collect();
    let n = self.prog.len();
    // `mark[pc]` is the position whose thread list already holds `pc`.
    let mut mark = vec![usize::MAX; n];
    let (mut now, mut next): (Vec<usize>, Vec<usize>) = (Vec::new(), Vec::new());
    let mut stack = Vec::new();
    for pos in 0..=t.len() {
      // A new thread starts at every position (the search is unanchored).
      if self.add(&mut now, 0, pos, t.len(), &mut mark, &mut stack, budget)? {
        return Ok(true);
      }
      if pos == t.len() {
        break;
      }
      for &pc in &now {
        if *budget == 0 {
          return Err(TooComplex);
        }
        *budget -= 1;
        let ok = match &self.prog[pc] {
          Inst::Char(c) => t[pos] == *c,
          Inst::Any => true,
          Inst::Class(r, negate) => in_class(r, *negate, t[pos]),
          _ => false,
        };
        if ok && self.add(&mut next, pc + 1, pos + 1, t.len(), &mut mark, &mut stack, budget)? {
          return Ok(true);
        }
      }
      now.clear();
      std::mem::swap(&mut now, &mut next);
    }
    Ok(false)
  }

  /// Adds the threads reachable from `pc` (following jumps and assertions) to `list`. True
  /// when one of them is the match.
  #[allow(clippy::too_many_arguments)]
  fn add(
    &self,
    list: &mut Vec<usize>,
    pc: usize,
    pos: usize,
    len: usize,
    mark: &mut [usize],
    stack: &mut Vec<usize>,
    budget: &mut u64,
  ) -> Result<bool, TooComplex> {
    stack.push(pc);
    while let Some(pc) = stack.pop() {
      if mark[pc] == pos {
        continue;
      }
      mark[pc] = pos;
      if *budget == 0 {
        stack.clear();
        return Err(TooComplex);
      }
      *budget -= 1;
      match &self.prog[pc] {
        Inst::Jmp(x) => stack.push(*x),
        Inst::Split(a, b) => {
          stack.push(*b);
          stack.push(*a);
        }
        Inst::Start => {
          if pos == 0 {
            stack.push(pc + 1);
          }
        }
        Inst::End => {
          if pos == len {
            stack.push(pc + 1);
          }
        }
        Inst::Match => {
          stack.clear();
          return Ok(true);
        }
        _ => list.push(pc),
      }
    }
    Ok(false)
  }
}

fn parse_alt(p: &[char], pos: &mut usize, depth: usize) -> Result<Alt, String> {
  if depth > MAX_DEPTH {
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
          None => Atom::Char(escaped_char(e)?),
        }
      }
      '*' | '+' | '?' => return Err(format!("nothing to repeat before '{c}'")),
      other => {
        *pos += 1;
        Atom::Char(lower(other))
      }
    };
    let (min, max) = quantifier(p, pos)?;
    if matches!(atom, Atom::Start | Atom::End) && (min != 1 || max != 1) {
      return Err("^ and $ can't be repeated".into());
    }
    alts.last_mut().unwrap().push(Item { atom, min, max });
  }
  Ok(Alt(alts))
}

/// A backslash before a punctuation mark is that mark; before a letter only `n` and `t` mean
/// anything (besides the classes), so `\b` and friends are errors rather than silent literals.
fn escaped_char(e: char) -> Result<char, String> {
  match e {
    'n' => Ok('\n'),
    't' => Ok('\t'),
    e if e.is_alphanumeric() => Err(format!("\\{e} isn't supported; use \\d \\D \\w \\W \\s \\S \\n \\t")),
    e => Ok(e),
  }
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
      if q.0 > MAX_REPEAT || (q.1 != usize::MAX && q.1 > MAX_REPEAT) {
        return Err(format!("a repeat count can be at most {MAX_REPEAT}"));
      }
      if q.1 < q.0 {
        return Err(format!("bad repeat '{{{body}}}'"));
      }
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
      lower(escaped_char(e)?)
    } else {
      lower(c)
    };
    if p.get(*pos) == Some(&'-') && p.get(*pos + 1).is_some_and(|c| *c != ']') {
      let hi = lower(p[*pos + 1]);
      *pos += 2;
      if hi < lo {
        return Err(format!("bad range '{lo}-{hi}' in []"));
      }
      ranges.push(Range::Span(lo, hi));
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

// ---------- Compiling ----------

fn push(prog: &mut Vec<Inst>, inst: Inst) -> Result<usize, String> {
  if prog.len() >= MAX_PROGRAM {
    return Err("the pattern is too complex".into());
  }
  prog.push(inst);
  Ok(prog.len() - 1)
}

fn compile_alt(alt: &Alt, prog: &mut Vec<Inst>) -> Result<(), String> {
  // split L1, next; L1: alt1; jmp end; next: split L2, next2 ...
  let mut jumps = Vec::new();
  for (i, seq) in alt.0.iter().enumerate() {
    let split = if i + 1 < alt.0.len() {
      Some(push(prog, Inst::Split(0, 0))?)
    } else {
      None
    };
    for item in seq {
      compile_item(item, prog)?;
    }
    if let Some(split) = split {
      jumps.push(push(prog, Inst::Jmp(0))?);
      prog[split] = Inst::Split(split + 1, prog.len());
    }
  }
  let end = prog.len();
  for j in jumps {
    prog[j] = Inst::Jmp(end);
  }
  Ok(())
}

fn compile_atom(atom: &Atom, prog: &mut Vec<Inst>) -> Result<(), String> {
  match atom {
    Atom::Char(c) => push(prog, Inst::Char(*c)).map(drop),
    Atom::Any => push(prog, Inst::Any).map(drop),
    Atom::Class(r, n) => push(prog, Inst::Class(r.iter().map(copy_range).collect(), *n)).map(drop),
    Atom::Start => push(prog, Inst::Start).map(drop),
    Atom::End => push(prog, Inst::End).map(drop),
    Atom::Group(a) => compile_alt(a, prog),
  }
}

fn copy_range(r: &Range) -> Range {
  match r {
    Range::Span(a, b) => Range::Span(*a, *b),
    Range::Digit(y) => Range::Digit(*y),
    Range::Word(y) => Range::Word(*y),
    Range::Space(y) => Range::Space(*y),
  }
}

fn compile_item(item: &Item, prog: &mut Vec<Inst>) -> Result<(), String> {
  for _ in 0..item.min {
    compile_atom(&item.atom, prog)?;
  }
  if item.max == usize::MAX {
    // L: split body, end; body; jmp L
    let split = push(prog, Inst::Split(0, 0))?;
    compile_atom(&item.atom, prog)?;
    push(prog, Inst::Jmp(split))?;
    prog[split] = Inst::Split(split + 1, prog.len());
  } else {
    // Each optional copy may stop the whole run: split body, end.
    let mut splits = Vec::new();
    for _ in item.min..item.max {
      splits.push(push(prog, Inst::Split(0, 0))?);
      compile_atom(&item.atom, prog)?;
    }
    let end = prog.len();
    for s in splits {
      prog[s] = Inst::Split(s + 1, end);
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  const PLENTY: u64 = 10_000_000;

  fn m(p: &str, t: &str) -> bool {
    Regex::new(p).unwrap().is_match(t, &mut PLENTY.clone()).unwrap()
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
    assert!(m("^a{2,3}$", "aaa"));
    assert!(!m("^a{2,3}$", "aaaa"));
    assert!(m("(ab)*c", "ababc"));
    assert!(m("^$", ""));
    assert!(m("x\\.y", "x.y") && !m("x\\.y", "xzy"));
  }

  #[test]
  fn rejects_bad_patterns() {
    for bad in [
      "(a",
      "*a",
      "a)",
      "\\b",
      "a\\bc",
      "[\\b]",
      "^{8}",
      "a{1001}",
      "a{3,2}",
      "(a{1000}){1000}",
    ] {
      assert!(Regex::new(bad).is_err(), "{bad}");
    }
    for bad in ["^{100000}", "(a?){100000}", "a{100000}"] {
      assert!(Regex::new(bad).is_err(), "{bad}");
    }
  }

  #[test]
  fn long_text_and_hostile_patterns_neither_crash_nor_hang() {
    // No recursion per character: a 100k-character name is fine.
    let long = "a".repeat(100_000);
    assert!(m(".*z|a", &long));
    assert!(!m(".*z", &long));
    // Exponential backtracking is linear here.
    let r = Regex::new("(a+)+$").unwrap();
    assert_eq!(r.is_match(&format!("{}!", "a".repeat(40)), &mut PLENTY.clone()), Ok(false));
    // A budget that runs out is an error, never a wrong answer.
    let r = Regex::new("(a?){300}a{300}").unwrap();
    assert_eq!(r.is_match(&"a".repeat(300), &mut 1000), Err(TooComplex));
  }
}
