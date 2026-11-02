import assert from "node:assert/strict";
import { test } from "node:test";
import { injectBridge, upstreamUrl } from "../src/proxy/upstream.ts";

const base = "https://my-mac.tailnet.ts.net";

test("protocol-relative paths stay on the server's origin", () => {
  const url = upstreamUrl(base, new URL("//evil.example/steal?x=1", "http://proxy.invalid"));
  assert.equal(url.origin, base);
  assert.equal(url.pathname, "/steal");
});

test("paths and queries pass through unchanged", () => {
  const url = upstreamUrl("http://127.0.0.1:3773", new URL("/ws?orchestrationProtocol=2&wsTicket=t", "http://proxy.invalid"));
  assert.equal(url.toString(), "http://127.0.0.1:3773/ws?orchestrationProtocol=2&wsTicket=t");
});

test("the bridge loads first in <head> and only once", () => {
  const html = injectBridge('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  assert.match(html, /<head><script src="\/__threadside\/bridge.js"><\/script><meta/);
  assert.equal(injectBridge(html), html);
});
