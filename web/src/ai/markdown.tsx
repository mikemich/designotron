// A small, safe Markdown renderer for Claude's replies: paragraphs, **bold**, *italic*, `code`,
// fenced code, bullet and numbered lists, tables, headings (shown as bold lines) and http(s) links.
// It builds React elements, never HTML strings, so nothing in a reply can inject markup.
// Inline spans are found by a scanner that looks at most a few hundred characters ahead, so
// no input makes it slow (regular expressions with nested quantifiers could).

import { memo, type ReactNode } from "react";

export type Block =
  | { kind: "p"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "code"; text: string; lang: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "table"; head: string[]; align: ("left" | "center" | "right" | undefined)[]; rows: string[][] };

/** Lines longer than this are shown as they are (no Markdown), which bounds the work per line. */
const MAX_LINE = 10_000;
/** How far ahead a span's closing mark is looked for. */
const MAX_SPAN = 500;
const MAX_CODE = 2000;
const MAX_LINK_TEXT = 300;
/** Columns beyond this are dropped from a table. */
const MAX_COLS = 20;

const FENCE = /^\s*```(.*)$/;
const ITEM = /^\s*(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/** Splits Markdown into blocks. An unclosed code fence (a reply still streaming) runs to the end. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE) {
      para.push(line);
      continue;
    }
    const fence = line.match(FENCE);
    if (fence && /^[\w+-]*$/.test(fence[1].trim())) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ kind: "code", text: body.join("\n"), lang: fence[1].trim() });
      continue;
    }
    const heading = headingText(line);
    if (heading !== null) {
      flush();
      blocks.push({ kind: "heading", text: heading });
      continue;
    }
    const head = i + 1 < lines.length ? tableRow(line) : null;
    const sep = head ? tableSeparator(lines[i + 1], head.length) : null;
    if (head && sep) {
      flush();
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].length <= MAX_LINE; i++) {
        const row = tableRow(lines[i]);
        if (!row) break;
        rows.push(Array.from({ length: head.length }, (_, c) => row[c] ?? ""));
      }
      i--;
      blocks.push({ kind: "table", head, align: sep, rows });
      continue;
    }
    const item = line.match(ITEM);
    if (item) {
      flush();
      const ordered = !item[1];
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item[3]);
      else blocks.push({ kind: "list", ordered, start: ordered ? Number(item[2]) : 1, items: [item[3]] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // A wrapped list item continues on an indented line.
    const last = blocks[blocks.length - 1];
    if (!para.length && last?.kind === "list" && /^\s+\S/.test(line)) {
      last.items[last.items.length - 1] += " " + line.trim();
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/** The cells of a table row ("| a | b |" or "a | b"), or null when the line has no pipe. */
function tableRow(line: string): string[] | null {
  let t = line.trim();
  if (!t.includes("|")) return null;
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < t.length; k++) {
    if (t[k] === "\\" && t[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (t[k] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += t[k];
  }
  cells.push(cur.trim());
  return cells.slice(0, MAX_COLS);
}

/** The column alignments of a separator line ("|---|:--:|"), or null when it isn't one. */
function tableSeparator(line: string, cols: number): ("left" | "center" | "right" | undefined)[] | null {
  if (line.length > MAX_LINE) return null;
  const cells = tableRow(line);
  if (!cells || cells.length !== cols) return null;
  const out: ("left" | "center" | "right" | undefined)[] = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    out.push(c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined);
  }
  return out;
}

/** The text of an ATX heading line ("## Plan ##" gives "Plan"), or null for any other line. */
function headingText(line: string): string | null {
  const m = line.match(/^ {0,3}(#{1,6})[ \t]+(\S.*)$/);
  if (!m) return null;
  let t = m[2].trimEnd();
  let end = t.length;
  while (end > 0 && t[end - 1] === "#") end--;
  if (end < t.length && (end === 0 || t[end - 1] === " ")) t = t.slice(0, end).trimEnd();
  return t;
}

/** Link targets a reply may open: web pages only (never javascript: or data:). */
export function safeHref(url: string): string | null {
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

/** Inline spans of a paragraph (each line on its own). */
export function renderInline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i) out.push("\n");
    if (line.length > MAX_LINE) out.push(line);
    else out.push(...scan(line, `${key}${i}.`));
  });
  return out;
}

function scan(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = "";
  let n = 0;
  const flush = () => {
    if (plain) out.push(plain);
    plain = "";
  };
  const push = (node: ReactNode) => {
    flush();
    out.push(node);
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1 && j - i <= MAX_CODE) {
        push(<code key={key + n++}>{s.slice(i + 1, j)}</code>);
        i = j + 1;
        continue;
      }
    } else if (c === "*") {
      let run = 1;
      while (s[i + run] === "*") run++;
      const next = s[i + run];
      if (run <= 3 && next !== undefined && !isSpace(next)) {
        const j = closer(s, i + run, run);
        if (j > 0) {
          const k = key + n++;
          const inner = scan(s.slice(i + run, j), k + ".");
          const node = run === 1 ? <em key={k}>{inner}</em> : run === 2 ? <strong key={k}>{inner}</strong> : <strong key={k}><em>{inner}</em></strong>;
          push(node);
          i = j + run;
          continue;
        }
      }
      plain += s.slice(i, i + run);
      i += run;
      continue;
    } else if (c === "[") {
      const link = linkAt(s, i);
      if (link) {
        const k = key + n++;
        const href = safeHref(link.url);
        const inner = scan(link.text, k + ".");
        // Not a web link: only its text is shown.
        if (href) push(<a key={k} href={href} target="_blank" rel="noreferrer noopener">{inner}</a>);
        else {
          flush();
          out.push(...inner);
        }
        i = link.end;
        continue;
      }
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

/** Index of the mark that closes a span of `run` asterisks opened before `from`, or -1. The
 *  closing mark follows a non-space, is not part of a longer run, and a one-asterisk span
 *  skips over **bold** inside it. */
function closer(s: string, from: number, run: number): number {
  const limit = Math.min(s.length, from + MAX_SPAN);
  for (let j = s.indexOf("*", from); j >= 0 && j < limit; j = s.indexOf("*", j)) {
    let len = 1;
    while (s[j + len] === "*") len++;
    if (len === run && !isSpace(s[j - 1])) return j;
    if (run === 1 && len === 2) {
      // **bold** inside *italic*: jump over it.
      const end = s.indexOf("**", j + 2);
      if (end < 0 || end >= limit) return -1;
      j = end + 2;
    } else j += len;
  }
  return -1;
}

const isSpace = (ch: string | undefined) => ch === undefined || ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\u00a0";

/** A `[text](url)` link starting at `i`: its text, url and where it ends. */
function linkAt(s: string, i: number): { text: string; url: string; end: number } | null {
  // Both scans are bounded so a reply full of "[" or "[x](y" stays linear.
  const close = s.indexOf("]", i + 1);
  if (close < 0 || close - i - 1 < 1 || close - i - 1 > MAX_LINK_TEXT || s[close + 1] !== "(") return null;
  let depth = 1;
  let j = close + 2;
  for (; j < s.length && depth > 0 && j - close < 500; j++) {
    const c = s.charCodeAt(j);
    if (c <= 32 || c === 0xa0 || c === 0x2028 || c === 0x2029) return null;
    if (c === 40) depth++;
    else if (c === 41) depth--;
  }
  if (depth !== 0 || j - close - 3 < 1) return null;
  return { text: s.slice(i + 1, close), url: s.slice(close + 2, j - 1), end: j };
}

/** Claude's reply as formatted text. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <>
      {parseBlocks(text).map((b, i) =>
        b.kind === "code" ? (
          <pre key={i} className="md-code">
            <code>{b.text}</code>
          </pre>
        ) : b.kind === "heading" ? (
          <p key={i} className="md-heading">
            <strong>{renderInline(b.text)}</strong>
          </p>
        ) : b.kind === "table" ? (
          <div key={i} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((t, j) => (
                    <th key={j} style={{ textAlign: b.align[j] }}>
                      {renderInline(t)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((t, k) => (
                      <td key={k} style={{ textAlign: b.align[k] }}>
                        {renderInline(t)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : b.kind === "list" ? (
          b.ordered ? (
            <ol key={i} start={b.start === 1 ? undefined : b.start}>
              {b.items.map((t, j) => (
                <li key={j}>{renderInline(t)}</li>
              ))}
            </ol>
          ) : (
            <ul key={i}>
              {b.items.map((t, j) => (
                <li key={j}>{renderInline(t)}</li>
              ))}
            </ul>
          )
        ) : (
          <p key={i}>{renderInline(b.text)}</p>
        ),
      )}
    </>
  );
});
