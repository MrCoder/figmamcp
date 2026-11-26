import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "./index.js";

const realFetch = globalThis.fetch;
let upstream;
beforeEach(() => {
  upstream = [];
  globalThis.fetch = async (url, init) => {
    upstream.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response('{"status":1,"error":null}', { status: 200, headers: { "content-type": "application/json" } });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const env = () => ({ ASSETS: { fetch: () => new Response("asset") }, LOADS: { writeDataPoint() {} } });

function event(overrides = {}, props = {}) {
  return {
    event: "tool_called",
    properties: {
      distinct_id: "a1b2c3d4e5f60718",
      time: Date.now(),
      $insert_id: "6f1c2a1e-1b2c-4d5e-8f90-0123456789ab",
      product: "figmamcp",
      server_version: "0.1.24",
      plugin_version: "0.1.24",
      os: "macOS 26",
      tool: "node_info",
      ok: false,
      error_code: "READ_ONLY_MODE",
      duration_ms: 42,
      ...props,
    },
    ...overrides,
  };
}

function post(body, { country = "AU", method = "POST" } = {}) {
  const request = new Request("https://figmamcp.dev/mp/track", {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  Object.defineProperty(request, "cf", { value: { country } });
  return request;
}

describe("POST /mp/track", () => {
  test("forwards a valid batch to Mixpanel with the token, ip=0, the country and is_internal", async () => {
    const res = await worker.fetch(post([event(), event({ event: "plugin_opened" }, { tool: undefined, ok: undefined, error_code: undefined, duration_ms: undefined })]), env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 1, error: null });
    expect(upstream).toHaveLength(1);
    const url = new URL(upstream[0].url);
    expect(url.origin + url.pathname).toBe("https://api.mixpanel.com/track");
    expect(url.searchParams.get("ip")).toBe("0");
    expect(url.searchParams.get("verbose")).toBe("1");
    expect(upstream[0].init.method).toBe("POST");
    expect(upstream[0].init.headers["content-type"]).toBe("application/json");
    const [first, second] = upstream[0].body;
    expect(first.properties).toMatchObject({
      token: "62d0ff230c6799db2a4d30a04fe5e1e2",
      mp_country_code: "AU",
      is_internal: false,
      product: "figmamcp",
      tool: "node_info",
      error_code: "READ_ONLY_MODE",
    });
    expect(second.event).toBe("plugin_opened");
    // The caller's IP is never passed on.
    expect(JSON.stringify(upstream[0])).not.toContain("203.0.113.7");
  });

  test("marks the owner's and test install IDs as internal", async () => {
    await worker.fetch(post([event({}, { distinct_id: "0000000000000001" }), event({}, { distinct_id: "a531dc8409abd710" }), event({ event: "app_launched" }, { tool: undefined, ok: undefined, error_code: undefined, duration_ms: undefined, server_version: undefined, plugin_version: undefined, app_version: "0.1.24", distinct_id: "3ca9259ba36013aa" })]), env());
    expect(upstream[0].body.map((e) => e.properties.is_internal)).toEqual([true, true, true]);
  });

  test("the server sets token, ip, product and is_internal; the client cannot", async () => {
    const res = await worker.fetch(post([event({}, { token: "other-project", ip: "198.51.100.1", is_internal: false, distinct_id: "0000000000000001" })]), env());
    expect(res.status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  test("rejects an unknown event name", async () => {
    const res = await worker.fetch(post([event({ event: "file_opened" })]), env());
    expect(res.status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  test("rejects an unknown property, such as a file name", async () => {
    const res = await worker.fetch(post([event({}, { file_name: "Secret.fig" })]), env());
    expect(res.status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  test("rejects a property that belongs to another event", async () => {
    const res = await worker.fetch(post([event({ event: "plugin_opened" }, { tool: "node_info" })]), env());
    expect(res.status).toBe(400);
  });

  test("rejects a bad install ID", async () => {
    for (const id of ["someone@example.com", "A1B2C3D4E5F60718", "123", ""]) {
      const res = await worker.fetch(post([event({}, { distinct_id: id })]), env());
      expect(res.status).toBe(400);
    }
    expect(upstream).toHaveLength(0);
  });

  test("rejects an unknown tool and a free-text error code", async () => {
    expect((await worker.fetch(post([event({}, { tool: "secret_tool" })]), env())).status).toBe(400);
    expect((await worker.fetch(post([event({}, { error_code: "Node 'Secret' not found" })]), env())).status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  test("accepts every tool the relay counts", async () => {
    const { TELEMETRY_TOOLS } = await import("../src/telemetry.ts");
    const batch = [...TELEMETRY_TOOLS].slice(0, 50).map((tool) => event({}, { tool }));
    const res = await worker.fetch(post(batch), env());
    expect(res.status).toBe(200);
    expect(upstream[0].body).toHaveLength(batch.length);
  });

  test("rejects an empty batch, more than 50 events and an oversized body", async () => {
    expect((await worker.fetch(post([]), env())).status).toBe(400);
    expect((await worker.fetch(post(Array.from({ length: 51 }, () => event())), env())).status).toBe(400);
    expect((await worker.fetch(post("x".repeat(70_000)), env())).status).toBe(413);
    expect((await worker.fetch(post("{not json"), env())).status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  test("accepts only POST", async () => {
    const res = await worker.fetch(post(null, { method: "GET" }), env());
    expect(res.status).toBe(405);
  });

  test("sends no country when Cloudflare has none", async () => {
    await worker.fetch(post([event()], { country: "XX" }), env());
    expect(upstream[0].body[0].properties.mp_country_code).toBeUndefined();
  });

  test("passes a Mixpanel failure back as 502", async () => {
    globalThis.fetch = async () => { throw new Error("down"); };
    const res = await worker.fetch(post([event()]), env());
    expect(res.status).toBe(502);
  });
});
