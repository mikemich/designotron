import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, parseBlocks, safeHref } from "./markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("parseBlocks", () => {
  it("splits paragraphs, lists, headings and fenced code", () => {
    const blocks = parseBlocks("# Title\n\nHello\nworld\n\n- a\n- b\n\n1. x\n2. y\n\n```js\nlet a = 1;\n```\nend");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "p", "list", "list", "code", "p"]);
    expect(blocks[1]).toEqual({ kind: "p", text: "Hello\nworld" });
    expect(blocks[2]).toEqual({ kind: "list", ordered: false, start: 1, items: ["a", "b"] });
    expect(blocks[3]).toEqual({ kind: "list", ordered: true, start: 1, items: ["x", "y"] });
    expect(blocks[4]).toEqual({ kind: "code", text: "let a = 1;", lang: "js" });
  });

  it("treats an unclosed fence (a reply still streaming) as code to the end", () => {
    expect(parseBlocks("```\nlet a")).toEqual([{ kind: "code", text: "let a", lang: "" }]);
  });
});

describe("Markdown", () => {
  it("renders bold, italic and code, nested", () => {
    expect(html("**Hi `x`** and *there*")).toBe("<p><strong>Hi <code>x</code></strong> and <em>there</em></p>");
  });

  it("leaves stray asterisks and snake_case alone", () => {
    expect(html("2 * 3 * 4 and my_var_name")).toBe("<p>2 * 3 * 4 and my_var_name</p>");
  });

  it("escapes HTML instead of injecting it", () => {
    const out = html("<img src=x onerror=alert(1)> and `<b>`");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("<code>&lt;b&gt;</code>");
  });

  it("links only http and https", () => {
    expect(html("[a](https://x.dev/p?q=1)")).toContain('<a href="https://x.dev/p?q=1" target="_blank" rel="noreferrer noopener">a</a>');
    const bad = html("[a](javascript:alert(1))");
    expect(bad).not.toContain("href");
    expect(bad).toBe("<p>a</p>");
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("mailto:a@b.c")).toBeNull();
  });

  it("shows headings as bold lines, never as raw hashes", () => {
    expect(html("## Plan")).toBe('<p class="md-heading"><strong>Plan</strong></p>');
    expect(html("## Plan ##")).toBe('<p class="md-heading"><strong>Plan</strong></p>');
  });

  it("starts a numbered list at its first number", () => {
    expect(html("3. c\n4. d")).toBe('<ol start="3"><li>c</li><li>d</li></ol>');
    expect(html("1) a\n2) b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("nests emphasis and handles ***", () => {
    expect(html("**a *b* c**")).toBe("<p><strong>a <em>b</em> c</strong></p>");
    expect(html("*a **b** c*")).toBe("<p><em>a <strong>b</strong> c</em></p>");
    expect(html("***both***")).toBe("<p><strong><em>both</em></strong></p>");
    expect(html("***")).toBe("<p>***</p>");
  });

  it("is fast on hostile input", () => {
    const inputs = ["**a ".repeat(5000), "*a" + " b".repeat(20000), "*".repeat(50000), "[".repeat(50000), "[a](" + "(".repeat(50000), "[x](y".repeat(10000), "[x](y".repeat(1999), "#" + " ".repeat(50000) + "x", " ".repeat(50000) + "x", "```" + " ".repeat(50000) + "a b", "`a".repeat(2500), "**x" + "y".repeat(5000)];
    for (const input of inputs) {
      const start = performance.now();
      html(input);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });
});

describe("tables and replies from the field", () => {
  it("renders a pipe table with a header and rows", () => {
    const b = parseBlocks("Done.\n\n| Card | Name | Price |\n|---|---|--:|\n| 1 | Aero Runner 3 | $134 |\n| 2 | Cloud Court Low | $112 |\n\nAfter.");
    expect(b.map((x) => x.kind)).toEqual(["p", "table", "p"]);
    const t = b[1] as Extract<ReturnType<typeof parseBlocks>[number], { kind: "table" }>;
    expect(t.head).toEqual(["Card", "Name", "Price"]);
    expect(t.align).toEqual([undefined, undefined, "right"]);
    expect(t.rows).toEqual([["1", "Aero Runner 3", "$134"], ["2", "Cloud Court Low", "$112"]]);
  });
  it("keeps a lone pipe line as text", () => {
    expect(parseBlocks("a | b\nnot a separator").map((x) => x.kind)).toEqual(["p"]);
  });
  it("renders a list that follows a paragraph line directly", () => {
    const b = parseBlocks("What I can do instead:\n- **Draw vector illustrations.** I can build\n- **Import images you supply.** If you give");
    expect(b.map((x) => x.kind)).toEqual(["p", "list"]);
  });
});
