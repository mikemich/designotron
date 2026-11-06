import { describe, expect, it } from "vitest";
import { safeImageSrc } from "./imageSrc";

describe("safeImageSrc", () => {
  it("accepts asset ids, data images and absolute http(s) URLs", () => {
    for (const ok of ["asset:abc", "data:image/png;base64,AAAA", "https://example.com/a.png", "HTTP://example.com/a.png"]) expect(safeImageSrc(ok)).toBe(true);
  });
  it("refuses protocol-relative, slashless, padded and control-character spellings", () => {
    for (const bad of ["//host/a.png", "https:host/a.png", "ht\ttps://host/a.png", " https://host/a.png", "https://host/a b.png", "https://host/\n.png", "javascript:alert(1)", "file:///etc/passwd", "a.png"]) expect(safeImageSrc(bad)).toBe(false);
  });
});
