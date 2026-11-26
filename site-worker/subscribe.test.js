import { describe, expect, test } from "bun:test";
import worker from "./index.js";

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k).value : null; },
    async put(k, value, opts = {}) { store.set(k, { value, opts }); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

function post(body, { ip = "203.0.113.7", type = "application/json" } = {}) {
  const payload = type === "application/json" ? JSON.stringify(body) : new URLSearchParams(body).toString();
  return new Request("https://figmamcp.dev/subscribe", {
    method: "POST",
    headers: { "content-type": type, "cf-connecting-ip": ip, origin: "https://figmamcp.dev" },
    body: payload,
  });
}

const env = () => ({ SUBSCRIBERS: fakeKV(), ASSETS: { fetch: () => new Response("asset") } });
const emails = (e) => [...e.SUBSCRIBERS.store.keys()].filter((k) => k.startsWith("email:"));

describe("POST /subscribe", () => {
  test("stores email, source and timestamp, lowercased", async () => {
    const e = env();
    const res = await worker.fetch(post({ email: " Ada@Example.COM ", source: "download" }), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rec = JSON.parse(e.SUBSCRIBERS.store.get("email:ada@example.com").value);
    expect(rec.email).toBe("ada@example.com");
    expect(rec.source).toBe("download");
    expect(Date.parse(rec.ts)).toBeGreaterThan(0);
  });

  test("rejects invalid email without storing", async () => {
    const e = env();
    for (const bad of ["", "no-at", "a@b", "a b@c.com", "x".repeat(250) + "@a.com"]) {
      const res = await worker.fetch(post({ email: bad, source: "footer" }), e);
      expect(res.status).toBe(400);
    }
    expect(emails(e)).toHaveLength(0);
  });

  test("honeypot filled: pretends success, stores nothing", async () => {
    const e = env();
    const res = await worker.fetch(post({ email: "bot@spam.com", source: "footer", website: "http://x" }), e);
    expect(res.status).toBe(200);
    expect(emails(e)).toHaveLength(0);
  });

  test("unknown source becomes 'other'", async () => {
    const e = env();
    await worker.fetch(post({ email: "a@b.co", source: "<script>" }), e);
    expect(JSON.parse(e.SUBSCRIBERS.store.get("email:a@b.co").value).source).toBe("other");
  });

  test("rate limits one IP after 5 attempts per hour", async () => {
    const e = env();
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await worker.fetch(post({ email: `u${i}@b.co`, source: "footer" }), e)).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
    expect(emails(e)).toHaveLength(5);
    // The rate-limit key must not hold the raw IP.
    expect([...e.SUBSCRIBERS.store.keys()].some((k) => k.includes("203.0.113.7"))).toBe(false);
  });

  test("duplicate signup keeps the first timestamp", async () => {
    const e = env();
    await worker.fetch(post({ email: "a@b.co", source: "footer" }), e);
    const first = e.SUBSCRIBERS.store.get("email:a@b.co").value;
    await worker.fetch(post({ email: "a@b.co", source: "download" }, { ip: "198.51.100.1" }), e);
    expect(e.SUBSCRIBERS.store.get("email:a@b.co").value).toBe(first);
  });

  test("form post without JS redirects to thank-you without email in URL", async () => {
    const e = env();
    const res = await worker.fetch(post({ email: "a@b.co", source: "footer" }, { type: "application/x-www-form-urlencoded" }), e);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/subscribed");
    expect(emails(e)).toHaveLength(1);
  });

  test("cross-origin post is refused", async () => {
    const e = env();
    const req = new Request("https://figmamcp.dev/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ email: "a@b.co" }),
    });
    expect((await worker.fetch(req, e)).status).toBe(403);
    expect(emails(e)).toHaveLength(0);
  });

  test("GET /subscribe is not an endpoint for data", async () => {
    const e = env();
    const res = await worker.fetch(new Request("https://figmamcp.dev/subscribe?email=a@b.co"), e);
    expect(res.status).toBe(405);
    expect(emails(e)).toHaveLength(0);
  });
});

describe("site CSP allows the signup form", () => {
  const csp = require("node:fs").readFileSync(new URL("../site/_headers", import.meta.url), "utf8").match(/Content-Security-Policy: (.*)/)[1];
  const directive = (name) => (csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) || "").split(/\s+/).slice(1);
  test("fetch to /subscribe is allowed (connect-src 'self')", () => expect(directive("connect-src")).toContain("'self'"));
  test("no-JS form post is allowed (form-action 'self')", () => expect(directive("form-action")).toEqual(["'self'"]));
});
