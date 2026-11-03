// A small, safe Markdown renderer for Claude's replies: paragraphs, **bold**, *italic*, `code`,
// fenced code, bullet and numbered lists, headings (shown as bold lines) and http(s) links.
// It builds React elements, never HTML strings, so nothing in a reply can inject markup.

import type { ReactNode } from "react";

export type Block =
  | { kind: "p"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "code"; text: string; lang: string }
  | { kind: "list"; ordered: boolean; items: string[] };

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
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ kind: "code", text: body.join("\n"), lang: fence[1] });
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }
    const item = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      flush();
      const ordered = !item[1];
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item[3]);
      else blocks.push({ kind: "list", ordered, items: [item[3]] });
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

/** Link targets a reply may open: web pages only (never javascript: or data:). */
export function safeHref(url: string): string | null {
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

const INLINE = /`([^`\n]+)`|\*\*(?=\S)([^\n]*?\S)\*\*|\*(?=\S)([^*\n]*?\S)\*(?!\*)|\[([^\]\n]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g;

/** Inline spans of one line or paragraph. */
export function renderInline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}${n++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{renderInline(m[2], k + ".")}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k}>{renderInline(m[3], k + ".")}</em>);
    else {
      const href = safeHref(m[5]);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noreferrer noopener">
            {renderInline(m[4], k + ".")}
          </a>
        ) : (
          m[4]
        ),
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Claude's reply as formatted text. */
export function Markdown({ text }: { text: string }) {
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
        ) : b.kind === "list" ? (
          b.ordered ? (
            <ol key={i}>{b.items.map((t, j) => <li key={j}>{renderInline(t)}</li>)}</ol>
          ) : (
            <ul key={i}>{b.items.map((t, j) => <li key={j}>{renderInline(t)}</li>)}</ul>
          )
        ) : (
          <p key={i}>{renderInline(b.text)}</p>
        ),
      )}
    </>
  );
}
