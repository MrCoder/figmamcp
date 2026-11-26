import { expect, test } from "bun:test";
import worker from "./index.js";

// Tests call the worker's pixel routes, and the worker copies each count to Mixpanel.
// The test preload (bunfig.toml) refuses every request to Mixpanel, so a test run never
// adds events to the production project. This test uses the preloaded fetch, not a stub.
test("a test run cannot reach Mixpanel", async () => {
  await expect(fetch("https://api.mixpanel.com/track?ip=0", { method: "POST", body: "[]" })).rejects.toThrow("blocked in tests");
});

test("a pixel hit in a test sends nothing to Mixpanel", async () => {
  const pending = [];
  const res = await worker.fetch(new Request("https://figmamcp.dev/p.gif?v=0.1.20&i=a1b2c3d4e5f60718"), { ASSETS: { fetch: () => new Response("asset") }, LOADS: { writeDataPoint() {} } }, { waitUntil: (p) => pending.push(p) });
  expect(res.status).toBe(200);
  expect(pending).toHaveLength(1);
  await Promise.all(pending);
  expect(globalThis.__mixpanelBlocked).toBeGreaterThan(0);
});
