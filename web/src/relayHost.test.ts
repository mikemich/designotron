import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { isLocalHost, isLoopbackHost } from "./relayHost";
import { PHONE_QUERY } from "./panelState";

describe("local relay hosts", () => {
  it("counts this computer and the local network as local", () => {
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.20", "macbook.local", "MacBook.LOCAL", "app.localhost", "localhost."]) {
      expect(isLocalHost(h), h).toBe(true);
    }
  });
  it("does not count public hosts or neighbouring ranges", () => {
    for (const h of ["designotron-relay.fly.dev", "example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "11.0.0.1", "localhost.example.com", "notlocal", "1.2.3"]) {
      expect(isLocalHost(h), h).toBe(false);
    }
  });
  it("tells a link only this computer can open from one on the network", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
    expect(isLoopbackHost("macbook.local")).toBe(false);
  });
});

describe("the phone-layout rule", () => {
  it("is under 640 px, or up to 820 px with a touch screen", () => {
    expect(PHONE_QUERY).toBe("(max-width: 639px), (max-width: 820px) and (pointer: coarse)");
  });
  it("is the query every phone block in the stylesheet uses, and no block still says 820 px alone", () => {
    const css = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const queries = [...css.matchAll(/@media \(max-width: 639px\), \(max-width: 820px\) and \(pointer: coarse\) \{/g)];
    expect(queries.length).toBe(4);
    expect(css).not.toMatch(/@media \(max-width: 820px\) \{/);
  });
});
