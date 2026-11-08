import { describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({ toast: () => {} }));

import { failureText, plainError } from "./errors";

const named = (name: string, message = "") => Object.assign(new Error(message), { name });

describe("plainError", () => {
  it.each([
    [named("QuotaExceededError", "The quota has been exceeded"), /storage is full/],
    [new Error("Quota exceeded for this origin"), /storage is full/],
    [named("SecurityError", "The operation is insecure"), /isn't allowing storage/],
    [named("InvalidStateError"), /isn't allowing storage/],
    [named("NotFoundError"), /couldn't be read/],
    [named("VersionError"), /couldn't be read/],
    [named("UnknownError"), /couldn't be read/],
    [named("DataError"), /couldn't be read/],
    [new SyntaxError("Unexpected token < in JSON at position 0"), /isn't valid JSON/],
    [new TypeError("Failed to fetch"), /Couldn't connect/],
    [new TypeError("NetworkError when attempting to fetch resource."), /Couldn't connect/],
    [new TypeError("Load failed"), /Couldn't connect/],
    [named("AbortError", "The user aborted a request."), /^Cancelled\.$/],
  ])("maps %s", (err, want) => {
    expect(plainError(err)).toMatch(want);
  });

  it("names what was parsed for a SyntaxError", () => {
    expect(plainError(new SyntaxError("x"), "That file isn't a Figma JSON export: it isn't valid JSON.")).toMatch(/Figma JSON export/);
  });

  it("passes our own sentences through", () => {
    expect(plainError(new Error("This file was made with a newer version of Designotron. Update the app to open it."))).toMatch(/^This file was made/);
    expect(plainError("Figma refused the token. Create one.")).toBe("Figma refused the token. Create one.");
  });

  it("never returns an empty string or a raw exception", () => {
    for (const e of [undefined, null, "", new Error(""), {}, 42, new Error("TypeError: x is not a function"), new Error("boom"), new Error("Unexpected end at position 4")]) {
      const t = plainError(e);
      expect(t).not.toBe("");
      expect(t).toBe("Something went wrong.");
    }
  });
});

describe("failureText", () => {
  it("joins the action and the plain reason", () => {
    expect(failureText("duplicate the file", named("QuotaExceededError", "Quota"))).toBe(
      "Couldn't duplicate the file: The browser's storage is full. Delete old files or versions, or save a .dtron copy (File menu).",
    );
    expect(failureText("rename the file", new Error("boom"))).toBe("Couldn't rename the file.");
  });
});
