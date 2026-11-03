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
    expect(blocks[2]).toEqual({ kind: "list", ordered: false, items: ["a", "b"] });
    expect(blocks[3]).toEqual({ kind: "list", ordered: true, items: ["x", "y"] });
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
  });
});
