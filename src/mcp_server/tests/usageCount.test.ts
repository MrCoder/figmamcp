import { describe, expect, it } from "bun:test";
import worker from "../../../site-worker/index.js";
import { createUsageCounter, USAGE_TOOLS, type UsageState } from "../../../figma_plugin/utils/usageCounter.ts";
import { createStaleTakeover, createUsageStore, USAGE_RETAKE_MS, USAGE_STALE_MS } from "../../../figma_plugin/utils/usageStore.ts";

function aeEnv() {
  const points: any[] = [];
  return { points, env: { LOADS: { writeDataPoint: (p: any) => points.push(p) }, ASSETS: { fetch: () => new Response("asset") } } };
}
const hit = (qs: string, env: any) => worker.fetch(new Request(`https://figmamcp.dev/u.gif?${qs}`), env);

describe("GET /u.gif (worker)", () => {
  it("writes one usage row with marker, counts and tool list", async () => {
    const { points, env } = aeEnv();
    const res = await hit("v=0.1.15&i=0123456789abcdef&ok=3&err=1&t=node_info:2,node_set_fill:2", env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(points).toHaveLength(1);
    const p = points[0];
    expect(p.blobs[0]).toBe("usage");
    expect(p.blobs[1]).toBe("0.1.15");
    expect(p.blobs[3]).toBe("0123456789abcdef");
    expect(p.blobs[4]).toBe("node_info:2,node_set_fill:2");
    expect(p.doubles).toEqual([3, 1]);
    expect(p.indexes).toEqual(["usage"]);
  });

  it("drops unknown tool names and bad counts, clamps big numbers", async () => {
    const { points, env } = aeEnv();
    await hit("v=0.1.15&i=0123456789abcdef&ok=99999999&err=-4&t=node_info:2,evil<x>:5,get_secret:7,page_info:abc,style_list:1", env);
    const p = points[0];
    expect(p.blobs[4]).toBe("node_info:2,style_list:1");
    expect(p.doubles).toEqual([10000, 0]);
  });

  it("rejects bad install id and bad version without writing", async () => {
    for (const qs of ["v=0.1.15&i=XYZ&ok=1&err=0&t=node_info:1", "v=<script>&i=0123456789abcdef&ok=1&err=0&t=node_info:1", "v=0.1.15&i=0123456789abcdef&ok=0&err=0&t="]) {
      const { points, env } = aeEnv();
      const res = await hit(qs, env);
      expect(res.status).toBe(200);
      expect(points).toHaveLength(0);
    }
  });
});

describe("GET /u.gif failures (blob6)", () => {
  it("writes failed tool name + error code as blob6, keeping blob order", async () => {
    const { points, env } = aeEnv();
    await hit("v=0.1.16&i=0123456789abcdef&ok=1&err=2&t=node_info:1,node_delete:2&f=node_delete:NAME_MISMATCH:1,node_delete:THROWN:1", env);
    const p = points[0];
    expect(p.blobs.slice(0, 5)).toEqual(["usage", "0.1.16", "XX", "0123456789abcdef", "node_info:1,node_delete:2"]);
    expect(p.blobs[5]).toBe("node_delete:NAME_MISMATCH:1,node_delete:THROWN:1");
  });

  it("drops failures with unknown tools or non-code text", async () => {
    const { points, env } = aeEnv();
    await hit("v=0.1.16&i=0123456789abcdef&ok=0&err=3&t=node_info:3&f=node_info:My Frame:1,get_secret:X:1,node_info:SCOPE_LOCKED:99999,node_info:bad-code:1", env);
    expect(points[0].blobs[5]).toBe("node_info:SCOPE_LOCKED:10000");
  });

  it("writes empty blob6 when no f param", async () => {
    const { points, env } = aeEnv();
    await hit("v=0.1.16&i=0123456789abcdef&ok=1&err=0&t=node_info:1", env);
    expect(points[0].blobs[5]).toBe("");
  });
});

// A manual clock: timers fire only when the test advances time. Counters run with the
// production defaults (no timing passed), so restoring old timing fails these tests.
function fakeClock() {
  let t = 0, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id: number) => { timers.delete(id); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}

// A counter on a fake clock, with a fake clientStorage slot it saves to.
function harness(opts: { batchSize?: number } = {}) {
  const clock = fakeClock();
  const sent: { at: number; q: string; id: string }[] = [];
  const store: { state?: UsageState } = {};
  const c = createUsageCounter({
    ...opts,
    send: (q, id) => sent.push({ at: clock.now(), q, id }),
    save: (s) => { store.state = JSON.parse(JSON.stringify(s)); },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  return { clock, sent, store, c, queries: () => sent.map((s) => s.q) };
}

describe("plugin usage counter", () => {
  it("reports tool:CODE:n for failures and sanitizes codes", () => {
    const h = harness();
    h.c.record("page_info", true); // first call of the session, sent at once
    h.c.record("node_delete", false, "NAME_MISMATCH");
    h.c.record("node_delete", false, "NAME_MISMATCH");
    h.c.record("node_info", false, "Node 'Secret' not found");
    h.c.record("node_info", true);
    h.c.flush();
    expect(h.queries()).toEqual(["ok=1&err=0&t=page_info:1", "ok=1&err=3&t=node_delete:2,node_info:2&f=node_delete:NAME_MISMATCH:2,node_info:UNKNOWN:1"]);
  });

  it("counts ok/err per tool and flushes at the batch size", () => {
    const h = harness({ batchSize: 3 });
    h.c.record("page_info", true);
    h.c.record("node_info", true);
    h.c.record("node_set_fill", false);
    expect(h.sent).toHaveLength(1);
    h.c.record("node_info", true);
    expect(h.queries()).toEqual(["ok=1&err=0&t=page_info:1", "ok=2&err=1&t=node_info:2,node_set_fill:1"]);
    h.c.flush();
    expect(h.sent).toHaveLength(2); // nothing pending, nothing sent
  });

  it("ignores names outside the tool list and never sends content", () => {
    const h = harness();
    h.c.record("get_connect_payload", true);
    h.c.record("My Secret Frame", true);
    expect(h.sent).toHaveLength(0);
    h.c.record("page_info", true);
    expect(h.queries()).toEqual(["ok=1&err=0&t=page_info:1"]);
    expect(JSON.stringify(h.store.state)).not.toContain("Secret");
  });

  it("worker and plugin share the same tool list", async () => {
    const src = await Bun.file(new URL("../../../site-worker/index.js", import.meta.url)).text();
    for (const t of USAGE_TOOLS) expect(src).toContain(`"${t}"`);
  });
});

describe("ui.html usage pixel guard", () => {
  it("lets a batch with failure codes through to /u.gif", async () => {
    const html = await Bun.file(new URL("../../../figma_plugin/ui.html", import.meta.url)).text();
    const m = /function sendUsagePixel\(query[^)]*\)[\s\S]*?!(\/\^\[[^\]]+\]\{1,2000\}\$\/)\.test\(query\)/.exec(html);
    expect(m).not.toBeNull();
    const guard = eval(m![1]) as RegExp;
    const h = harness();
    h.c.record("node_delete", false, "NAME_MISMATCH");
    h.c.record("node_info", false, "SCOPE_LOCKED");
    h.c.flush();
    for (const q of h.queries()) expect(guard.test(q)).toBe(true);
  });
});

describe("plugin usage counter timing (sent while the plugin is open)", () => {
  it("sends the first call of a session at once, without waiting or closing", () => {
    const h = harness();
    h.c.record("page_info", true);
    expect(h.sent).toEqual([{ at: 0, q: "ok=1&err=0&t=page_info:1", id: h.sent[0]?.id }]);
  });

  it("sends a later call within 60 s of the last report, without close", () => {
    const h = harness();
    h.c.record("page_info", true); // t=0, sent at once
    h.clock.advance(1000);
    h.c.record("node_info", true);
    h.clock.advance(58_000); // 59 s
    expect(h.sent).toHaveLength(1);
    h.clock.advance(1500);
    expect(h.sent.map((s) => [s.at, s.q])).toEqual([[0, "ok=1&err=0&t=page_info:1"], [60_000, "ok=1&err=0&t=node_info:1"]]);
    h.clock.advance(10 * 60 * 1000);
    expect(h.sent).toHaveLength(2); // nothing pending, nothing more sent
  });

  it("waits about 15 s for more calls when the last report was long ago", () => {
    const h = harness();
    h.c.record("page_info", true);
    h.clock.advance(5 * 60 * 1000);
    h.c.record("node_info", true); // t=300 s
    h.clock.advance(2000);
    h.c.record("node_info", true);
    h.clock.advance(12_000); // 314 s
    expect(h.sent).toHaveLength(1);
    h.clock.advance(1500); // 315.5 s
    expect(h.sent.map((s) => [s.at, s.q])).toEqual([[0, "ok=1&err=0&t=page_info:1"], [315_000, "ok=2&err=0&t=node_info:2"]]);
  });

  it("sends at most once a minute while calls continue, and counts every call", () => {
    const h = harness();
    let calls = 0;
    for (let i = 0; i < 36; i++) { h.c.record("node_info", true); calls++; h.clock.advance(5000); } // one call every 5 s for 3 min
    h.clock.advance(2 * 60 * 1000);
    expect(h.sent.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < h.sent.length; i++) expect(h.sent[i].at - h.sent[i - 1].at).toBeGreaterThanOrEqual(60_000);
    const total = h.sent.reduce((n, s) => n + Number(/ok=(\d+)/.exec(s.q)![1]), 0);
    expect(total).toBe(calls);
  });

  it("still sends a full batch of 20 at once", () => {
    const h = harness();
    h.c.record("page_info", true);
    for (let i = 0; i < 20; i++) h.c.record("node_info", true);
    expect(h.queries()).toEqual(["ok=1&err=0&t=page_info:1", "ok=20&err=0&t=node_info:20"]);
  });
});

describe("plugin usage counter persistence (clientStorage)", () => {
  it("saves unsent counts on every call", () => {
    const h = harness();
    h.c.record("page_info", true);
    h.c.record("node_info", true);
    h.c.record("node_delete", false, "NAME_MISMATCH");
    expect(h.store.state).toMatchObject({ ok: 1, err: 1, t: [["node_info", 1], ["node_delete", 1]], f: [["node_delete:NAME_MISMATCH", 1]] });
  });

  it("sends counts left in storage on the next start", () => {
    const a = harness();
    a.c.record("page_info", true);
    a.c.ack(a.sent[0].id); // the first report reached the site
    a.c.record("node_info", true);
    a.c.record("node_delete", false, "NAME_MISMATCH");
    // The plugin closes or crashes here: the 2 calls were never sent.
    const b = harness();
    b.c.restore(a.store.state);
    expect(b.queries()).toEqual(["ok=1&err=1&t=node_info:1,node_delete:1&f=node_delete:NAME_MISMATCH:1"]);
  });

  it("re-sends a report the UI never confirmed, and not one it confirmed", () => {
    const a = harness();
    a.c.record("page_info", true);   // confirmed below
    a.c.ack(a.sent[0].id);
    a.clock.advance(5 * 60 * 1000);
    a.c.record("node_info", true);
    a.c.flush();                      // the close-time flush: its request never left
    const lost = a.sent[1];
    const b = harness();
    b.c.restore(a.store.state);
    expect(b.sent).toEqual([{ at: 0, q: lost.q, id: lost.id }]);
    b.c.ack(lost.id);
    expect(b.store.state!.out).toEqual([]);
    const c = harness();
    c.c.restore(b.store.state);
    expect(c.sent).toHaveLength(0);
  });

  it("drops malformed stored state", () => {
    const h = harness();
    h.c.restore({ ok: 5, err: 0, t: [["get_secret", 5], ["node_info", "x"]], f: [["node_info:My Frame", 1]], out: [{ id: "1", q: "ok=1&t=<x>" }, "junk"] });
    h.c.restore("junk");
    h.c.restore(null);
    expect(h.sent).toHaveLength(0);
  });
});

// clientStorage shared by every open copy of the plugin (one user, two files open).
// This fake resolves at once; Figma's own write ordering is not covered here.
function sharedStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    getAsync: async (k: string) => data.get(k),
    setAsync: async (k: string, v: unknown) => { data.set(k, JSON.parse(JSON.stringify(v))); },
    deleteAsync: async (k: string) => { data.delete(k); },
    keysAsync: async () => [...data.keys()],
  };
}
function session(storage: ReturnType<typeof sharedStorage>, clock: ReturnType<typeof fakeClock>, sessionId: string) {
  const sent: string[] = [], ids: string[] = [];
  const store = createUsageStore(storage, { sessionId, now: clock.now });
  const c = createUsageCounter({ send: (q, id) => { sent.push(q); ids.push(id); }, save: store.save, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const start = async () => { for (const s of await store.takeOverStale()) c.restore(s); };
  return { sent, ids, c, start };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("plugin usage store (several open plugins share clientStorage)", () => {
  it("does not send counts of another plugin that is still open", async () => {
    const storage = sharedStorage(), clock = fakeClock();
    const a = session(storage, clock, "aaaa");
    a.c.record("page_info", true);
    a.c.record("node_info", true); // pending in file A
    await settle();
    clock.advance(10_000);
    const b = session(storage, clock, "bbbb");
    await b.start();
    expect(b.sent).toEqual([]);
    clock.advance(60_000); // A sends its own pending counts
    expect(a.sent).toEqual(["ok=1&err=0&t=page_info:1", "ok=1&err=0&t=node_info:1"]);
  });

  it("sends, once, the counts of a plugin that closed or crashed", async () => {
    const storage = sharedStorage(), clock = fakeClock();
    const a = session(storage, clock, "aaaa");
    a.c.record("page_info", true);
    a.c.record("node_info", true); // A crashes with this unsent: its timers never run again
    await settle();
    const later = fakeClock();
    later.advance(USAGE_STALE_MS + 1000);
    const b = session(storage, later, "bbbb");
    await b.start();
    await settle();
    // page_info was never confirmed by A's UI, so it is re-sent too.
    expect([...b.sent].sort()).toEqual(["ok=1&err=0&t=node_info:1", "ok=1&err=0&t=page_info:1"]);
    for (const id of b.ids) b.c.ack(id); // B's UI confirms both
    await settle();
    later.advance(USAGE_STALE_MS + 1000);
    const c = session(storage, later, "cccc");
    await c.start();
    expect(c.sent).toEqual([]);
    expect([...storage.data.keys()]).toEqual([]);
  });
});

// A plugin left open: the stale-key check runs at start and then every 60 s (usageStore.ts).
function liveSession(storage: ReturnType<typeof sharedStorage>, clock: ReturnType<typeof fakeClock>, sessionId: string) {
  const sent: string[] = [], ids: string[] = [];
  const store = createUsageStore(storage, { sessionId, now: clock.now });
  const c = createUsageCounter({ send: (q, id) => { sent.push(q); ids.push(id); }, save: store.save, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const takeover = createStaleTakeover({ store, restore: c.restore, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { sent, ids, c, store, takeover };
}
const settleAll = async () => { for (let i = 0; i < 10; i++) await settle(); };
async function runFor(clock: ReturnType<typeof fakeClock>, ms: number) {
  for (let done = 0; done < ms; done += 10_000) { clock.advance(Math.min(10_000, ms - done)); await settleAll(); }
}
// A store whose stale-key check the test counts and can hold open.
function countingStore() {
  let calls = 0;
  let hold: Promise<void> | null = null;
  return {
    calls: () => calls,
    holdNext() { let release!: () => void; hold = new Promise<void>((r) => { release = r; }); return release; },
    touch() {},
    async takeOverStale() { calls++; if (hold) { const h = hold; hold = null; await h; } return []; },
  };
}

describe("plugin usage store, while the plugin stays open (60 s check)", () => {
  it("sends, once, counts a plugin left less than 5 min before this one opened", async () => {
    const storage = sharedStorage();
    const closed = fakeClock(); // A's clock: A closes at t=0 and its timers never run again
    const a = session(storage, closed, "aaaa");
    a.c.record("page_info", true); // sent, never confirmed by A's UI
    a.c.record("node_info", true); // unsent
    await settle();
    const clock = fakeClock();
    clock.advance(70_000); // B opens 70 s later: A's key is not stale yet
    const b = liveSession(storage, clock, "bbbb");
    await b.takeover.start();
    await settleAll();
    expect(b.sent).toEqual([]);
    await runFor(clock, USAGE_STALE_MS - 70_000 - 1000); // up to 1 s before A's key turns stale
    expect(b.sent).toEqual([]);
    await runFor(clock, USAGE_RETAKE_MS + 1000); // the next 60 s check after it turned stale
    expect([...b.sent].sort()).toEqual(["ok=1&err=0&t=node_info:1", "ok=1&err=0&t=page_info:1"]);
    expect(storage.data.has("usagePending:aaaa")).toBe(false);
    await runFor(clock, 10 * 60 * 1000);
    expect(b.sent).toHaveLength(2);
  });

  it("never takes the key of another plugin that is open and idle with an unconfirmed report", async () => {
    const storage = sharedStorage(), clock = fakeClock();
    const a = liveSession(storage, clock, "aaaa");
    const b = liveSession(storage, clock, "bbbb");
    await a.takeover.start();
    await b.takeover.start();
    a.c.record("page_info", true); // sent at once; A's UI never confirms it, so it stays in A's key
    await settleAll();
    await runFor(clock, 15 * 60 * 1000);
    expect(a.sent).toEqual(["ok=1&err=0&t=page_info:1"]);
    expect(b.sent).toEqual([]);
    expect(storage.data.has("usagePending:aaaa")).toBe(true);
  });

  it("leaves no key behind once everything is sent and confirmed", async () => {
    const storage = sharedStorage(), clock = fakeClock();
    const a = liveSession(storage, clock, "aaaa");
    await a.takeover.start();
    a.c.record("page_info", true);
    await settle();
    a.c.ack(a.ids[0]); // A's UI confirms the report: nothing left to keep
    await settleAll();
    await runFor(clock, 3 * USAGE_RETAKE_MS);
    expect([...storage.data.keys()]).toEqual([]);
  });

  it("never takes its own key, even one not written for 5 min", async () => {
    const storage = sharedStorage(), clock = fakeClock();
    const a = liveSession(storage, clock, "aaaa");
    a.c.record("page_info", true); // unconfirmed, kept in A's own key
    await settle();
    clock.advance(USAGE_STALE_MS + 60_000);
    expect(await a.store.takeOverStale()).toEqual([]);
    expect(storage.data.has("usagePending:aaaa")).toBe(true);
  });

  it("checks at start and every 60 s, and stops when the plugin closes", async () => {
    const clock = fakeClock(), store = countingStore();
    const t = createStaleTakeover({ store, restore: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await t.start();
    expect(store.calls()).toBe(1);
    await runFor(clock, 3 * USAGE_RETAKE_MS);
    expect(store.calls()).toBe(4);
    t.stop();
    await runFor(clock, 10 * USAGE_RETAKE_MS);
    expect(store.calls()).toBe(4);
  });

  it("does not start when the plugin closed before the check was due to start", async () => {
    const clock = fakeClock(), store = countingStore();
    const t = createStaleTakeover({ store, restore: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    t.stop();
    await t.start();
    await runFor(clock, 5 * USAGE_RETAKE_MS);
    expect(store.calls()).toBe(0);
  });

  it("skips a 60 s check while the previous one is still running", async () => {
    const clock = fakeClock(), store = countingStore();
    const t = createStaleTakeover({ store, restore: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const release = store.holdNext();
    void t.start();
    await runFor(clock, 3 * USAGE_RETAKE_MS);
    expect(store.calls()).toBe(1);
    release();
    await settleAll();
    await runFor(clock, USAGE_RETAKE_MS);
    expect(store.calls()).toBe(2);
  });
});
