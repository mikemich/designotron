import { describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({ toast: () => {} }));

import { failureText, plainError } from "./errors";

const named = (name: string, message = "") => Object.assign(new Error(message), { name });

describe("plainError", () => {
  it.each([
    [named("QuotaExceededError", "The quota has been exceeded"), /storage is full/],
    [new Error("Quota exceeded for this origin"), /storage is full/],
    [named("SecurityError", "The operation is insecure"), /isn't allowing storage/],
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

  it("maps InvalidStateError and NotFoundError only for storage callers", () => {
    expect(plainError(named("InvalidStateError"), { storage: true })).toMatch(/isn't allowing storage/);
    expect(plainError(named("NotFoundError"), { storage: true })).toMatch(/couldn't be read/);
    expect(plainError(named("InvalidStateError"))).toBe("Something went wrong.");
    expect(plainError(named("NotFoundError"))).toBe("Something went wrong.");
  });

  it("capitalises lowercase messages written for Claude or the engine", () => {
    expect(plainError(new Error("importing a website needs the Designotron bridge running (setup steps in the Claude panel)"))).toBe(
      "Importing a website needs the Designotron bridge running (setup steps in the Claude panel)",
    );
    expect(plainError("not a Figma file: expected the JSON")).toBe("Not a Figma file: expected the JSON");
    expect(plainError(new Error("unexpected end at position 4"))).toBe("Something went wrong.");
  });

  it("names what was parsed for a SyntaxError", () => {
    expect(plainError(new SyntaxError("x"), { json: "That file isn't a Figma JSON export: it isn't valid JSON." })).toMatch(/Figma JSON export/);
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
