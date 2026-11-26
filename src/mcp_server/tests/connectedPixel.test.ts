import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import worker from "../../../site-worker/index.js";

// Distinguishes "plugin opened, no MCP client" (p.gif) and "client called a
// tool" (u.gif) from "client joined the channel, no tool call yet" (c.gif).
function aeEnv() {
  const points: any[] = [];
  return { points, env: { LOADS: { writeDataPoint: (p: any) => points.push(p) }, ASSETS: { fetch: () => new Response("asset") } } };
}
const hit = (qs: string, env: any) => worker.fetch(new Request(`https://figmamcp.dev/c.gif?${qs}`), env);

describe("GET /c.gif (worker)", () => {
  it("writes one connected row with version, country and install id", async () => {
    const { points, env } = aeEnv();
    const res = await hit("v=0.1.18&i=0123456789abcdef", env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(points).toHaveLength(1);
    const p = points[0];
    expect(p.blobs).toEqual(["connected", "0.1.18", "XX", "0123456789abcdef"]);
    expect(p.doubles).toEqual([1]);
    expect(p.indexes).toEqual(["connected"]);
  });

  it("rejects a bad install id or a bad version without writing", async () => {
    for (const qs of ["v=0.1.18&i=XYZ", "v=<script>&i=0123456789abcdef", "v=&i=0123456789abcdef"]) {
      const { points, env } = aeEnv();
      const res = await hit(qs, env);
      expect(res.status).toBe(200);
      expect(points).toHaveLength(0);
    }
  });
});

describe("wrangler asset routing", () => {
  it("runs the worker first for /c.gif, so static assets never shadow it", () => {
    const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/\/\/.*$/gm, ""));
    // "/*" sends every path to the worker; only the paths negated with "!" go straight to static assets.
    expect(config.assets.run_worker_first).toContain("/*");
    expect(config.assets.run_worker_first).not.toContain("!/c.gif");
  });
});
