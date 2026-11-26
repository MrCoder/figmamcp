import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clientSlug,
  createTelemetry,
  errorCodeOf,
  telemetryEnabled,
  TELEMETRY_TOOLS,
  type TelemetryTimer,
} from "../../telemetry.ts";
import { USAGE_TOOLS } from "../../../figma_plugin/utils/usageCounter.ts";

const ID = "0000000000000001";
let dir: string;
let queueFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "figmamcp-telemetry-"));
  queueFile = join(dir, ".figmamcp", "telemetry-queue.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manualTimer() {
  const callbacks: Array<() => void> = [];
  const timer: TelemetryTimer = {
    setInterval(callback) {
      callbacks.push(callback);
      return callbacks.length - 1;
    },
    clearInterval() {},
  };
  return { timer, tick: () => callbacks.forEach((cb) => cb()) };
}

function recorder(respond: () => Response | Promise<Response> = () => new Response('{"status":1}')) {
  const calls: any[][] = [];
  const fetch = async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return respond();
  };
  return { calls, fetch };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

function make(overrides: Record<string, unknown> = {}) {
  const t = manualTimer();
  const rec = recorder((overrides.respond as any) ?? undefined);
  const telemetry = createTelemetry({
    serverVersion: "0.1.24",
    queueFile,
    fetch: rec.fetch,
    timer: t.timer,
    isEnabled: () => true,
    os: "macOS 26",
    ...overrides,
  } as any);
  return { telemetry, rec, tick: t.tick };
}

describe("relay telemetry queue", () => {
  test("the first tool_called is sent at once, with the common properties", async () => {
    const { telemetry, rec } = make();
    telemetry.track("tool_called", { tool: "node_info", ok: true, duration_ms: 12, plugin_version: "0.1.24" }, ID);
    await settle();
    expect(rec.calls).toHaveLength(1);
    const [event] = rec.calls[0];
    expect(event.event).toBe("tool_called");
    expect(event.properties).toMatchObject({
      tool: "node_info", ok: true, duration_ms: 12, plugin_version: "0.1.24",
      product: "figmamcp", server_version: "0.1.24", os: "macOS 26", distinct_id: ID,
    });
    expect(typeof event.properties.$insert_id).toBe("string");
    expect(typeof event.properties.time).toBe("number");
    telemetry.close();
  });

  test("later events wait for the interval, then go in one batch", async () => {
    const { telemetry, rec, tick } = make();
    telemetry.track("tool_called", { tool: "node_info", ok: true }, ID);
    await settle();
    telemetry.track("tool_called", { tool: "page_info", ok: true }, ID);
    telemetry.track("tool_called", { tool: "node_rename", ok: false, error_code: "NAME_MISMATCH" }, ID);
    await settle();
    expect(rec.calls).toHaveLength(1);
    tick();
    await settle();
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1].map((e: any) => e.properties.tool)).toEqual(["page_info", "node_rename"]);
    telemetry.close();
  });

  test("50 queued events flush without waiting for the interval", async () => {
    const { telemetry, rec } = make();
    telemetry.track("plugin_opened", {}, ID);
    for (let i = 0; i < 49; i++) telemetry.track("ai_connected", { client: "codex" }, ID);
    await settle();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toHaveLength(50);
    telemetry.close();
  });

  test("unsent events persist and are sent by the next start", async () => {
    const offline = make({ respond: () => { throw new Error("offline"); } });
    offline.telemetry.track("tool_called", { tool: "node_info", ok: true }, ID);
    await settle();
    offline.telemetry.track("plugin_opened", {}, ID);
    offline.telemetry.persistSync();
    offline.telemetry.close();
    const saved = readFileSync(queueFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(saved.map((e) => e.event)).toEqual(["tool_called", "plugin_opened"]);

    const next = make();
    next.tick();
    await settle();
    expect(next.rec.calls).toHaveLength(1);
    expect(next.rec.calls[0].map((e: any) => e.properties.$insert_id)).toEqual(saved.map((e) => e.properties.$insert_id));
    expect(existsSync(queueFile)).toBe(false);
    next.telemetry.close();
  });

  test("a network failure never throws and keeps the events", async () => {
    const { telemetry } = make({ respond: () => { throw new Error("ECONNREFUSED"); } });
    expect(() => telemetry.track("tool_called", { tool: "node_info", ok: true }, ID)).not.toThrow();
    await telemetry.flush();
    expect(telemetry.queued()).toHaveLength(1);
    telemetry.close();
  });

  test("a 4xx answer drops the batch so it is not resent forever", async () => {
    const { telemetry } = make({ respond: () => new Response('{"error":"bad"}', { status: 400 }) });
    telemetry.track("tool_called", { tool: "node_info", ok: true }, ID);
    await telemetry.flush();
    expect(telemetry.queued()).toHaveLength(0);
    telemetry.close();
  });

  test("opt-out sends nothing and queues nothing", async () => {
    const { telemetry, rec, tick } = make({ isEnabled: () => false });
    telemetry.track("tool_called", { tool: "node_info", ok: true }, ID);
    telemetry.track("plugin_opened", {}, ID);
    expect(telemetry.queued()).toHaveLength(0);
    tick();
    await settle();
    expect(rec.calls).toHaveLength(0);
    telemetry.close();
  });

  test("an event without a valid install ID is not queued", () => {
    const { telemetry } = make();
    telemetry.track("plugin_opened", {}, "not-an-id");
    expect(telemetry.queued()).toHaveLength(0);
    telemetry.close();
  });

  test("the queue keeps only the newest events past the cap", () => {
    const { telemetry } = make({ maxQueue: 3 });
    for (const tool of ["a", "b", "c", "d", "e"]) telemetry.track("plugin_opened", { tool }, ID);
    expect(telemetry.queued().map((e) => e.properties.tool)).toEqual(["c", "d", "e"]);
    telemetry.close();
  });

  test("events older than Mixpanel accepts are dropped on load", async () => {
    mkdirSync(join(dir, ".figmamcp"), { recursive: true });
    const old = { event: "plugin_opened", properties: { distinct_id: ID, time: Date.now() - 6 * 86400_000, $insert_id: "x" } };
    writeFileSync(queueFile, JSON.stringify(old) + "\n");
    const { telemetry } = make();
    expect(telemetry.queued()).toHaveLength(0);
    telemetry.close();
  });
});

describe("telemetry switches", () => {
  test("FIGMAMCP_TELEMETRY=0 turns it off", () => {
    expect(telemetryEnabled({ FIGMAMCP_TELEMETRY: "0" }, dir)).toBe(false);
    expect(telemetryEnabled({}, dir)).toBe(true);
  });

  test('"telemetry": false in ~/.figmamcp/config.json turns it off', () => {
    mkdirSync(join(dir, ".figmamcp"), { recursive: true });
    writeFileSync(join(dir, ".figmamcp", "config.json"), JSON.stringify({ port: 3155, telemetry: false }));
    expect(telemetryEnabled({}, dir)).toBe(false);
  });
});

describe("telemetry field rules", () => {
  test("client names map to a fixed set; anything else is other", () => {
    expect(clientSlug("Claude Code")).toBe("claude-code");
    expect(clientSlug("Codex")).toBe("codex");
    expect(clientSlug("Cursor")).toBe("cursor");
    expect(clientSlug("Claude")).toBe("claude");
    expect(clientSlug("My secret project")).toBe("other");
  });

  test("only a structured error code is used; free text becomes UNKNOWN", () => {
    expect(errorCodeOf({ result: { ok: 1 } })).toEqual({ ok: true });
    expect(errorCodeOf({ error: { code: "READ_ONLY_MODE", message: "Frame 'Secret' is read-only" } })).toEqual({ ok: false, code: "READ_ONLY_MODE" });
    expect(errorCodeOf({ error: "Node 'Secret' not found" })).toEqual({ ok: false, code: "UNKNOWN" });
    expect(errorCodeOf({ result: { errorCode: "NAME_MISMATCH" } })).toEqual({ ok: false, code: "NAME_MISMATCH" });
  });

  test("the relay's tool list matches the plugin's usage list", () => {
    expect([...TELEMETRY_TOOLS].sort()).toEqual([...USAGE_TOOLS].sort());
  });
});
