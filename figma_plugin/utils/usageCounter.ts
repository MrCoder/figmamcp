// Anonymous usage counts (owner decision 2026-11-18): tool name and ok/error counts only.
// No file content, node names, IDs or text. Must match TOOLS in site-worker/index.js.
export const USAGE_TOOLS: string[] = ["annotation_list","annotation_set","component_delete_property","component_list","component_manage_property","create_component","create_component_set","create_frame","create_instance","create_shape","create_svg","create_text","instance_get_overrides","instance_set_overrides","instance_set_property","node_apply_style","node_bind_variable","node_clone","node_delete","node_export_visual","node_flatten","node_group","node_info","node_insert_child","node_rename","node_set_auto_layout","node_set_corner_radius","node_set_effects","node_set_fill","node_set_stroke","node_transform","node_ungroup","page_info","reaction_list","reaction_update","style_delete","style_list","style_manage","text_set_content","text_set_style","variable_delete","variable_list","variable_manage","view_navigate"];
const KNOWN = new Set(USAGE_TOOLS);
// Structured error codes only (e.g. NAME_MISMATCH). Free text (may hold node names) becomes UNKNOWN.
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;


// Production timing. Closing the plugin tears down the UI iframe before a u.gif request
// started on close can leave, so reports go out while the plugin is open:
// - the first counted call of a plugin session is sent at once (it is what makes an install a user);
// - later calls are sent 15 s after the first unsent one, at most once every 60 s,
//   or at once when a batch of 20 fills.
export const USAGE_BATCH_SIZE = 20;
export const USAGE_FIRST_FLUSH_MS = 15 * 1000;
export const USAGE_MIN_INTERVAL_MS = 60 * 1000;
// Reports not yet confirmed by the UI, kept so a close or crash loses nothing. Oldest dropped first.
export const USAGE_OUTBOX_MAX = 20;
const QUERY = /^[A-Za-z0-9_=&:,]{1,2000}$/;
const COUNT_MAX = 10000;

// What is kept in figma.clientStorage between sessions: the unsent counts and the
// reports sent but not confirmed. The same data the query carries, nothing more.
export interface UsageState {
  ok: number;
  err: number;
  t: [string, number][];
  f: [string, number][];
  out: { id: string; q: string }[];
}

const count = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 ? Math.min(n, COUNT_MAX) : 0);

export function createUsageCounter(opts: {
  send: (query: string, id: string) => void;
  save?: (state: UsageState) => void;
  batchSize?: number;
  firstFlushMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (handle: any) => void;
}) {
  const batchSize = opts.batchSize ?? USAGE_BATCH_SIZE;
  const firstFlushMs = opts.firstFlushMs ?? USAGE_FIRST_FLUSH_MS;
  const minIntervalMs = opts.minIntervalMs ?? USAGE_MIN_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: any) => clearTimeout(h));
  let ok = 0, err = 0;
  let tools = new Map<string, number>();
  let fails = new Map<string, number>();
  let outbox: { id: string; q: string }[] = [];
  let timer: any = null;
  let lastSentAt = -Infinity;
  let firstCallSent = false;
  let seq = 0;

  function save() {
    if (!opts.save) return;
    try { opts.save({ ok, err, t: [...tools], f: [...fails], out: outbox.slice() }); } catch (_) { /* best effort */ }
  }
  function transmit(entry: { id: string; q: string }) {
    try { opts.send(entry.q, entry.id); } catch (_) { /* best effort; stays in the outbox */ }
  }
  function flush() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (ok + err === 0) return;
    const t = [...tools].map(([k, n]) => `${k}:${n}`).join(",");
    const f = [...fails].map(([k, n]) => `${k}:${n}`).join(",");
    const q = `ok=${ok}&err=${err}&t=${t}` + (f ? `&f=${f}` : "");
    ok = 0; err = 0; tools = new Map(); fails = new Map();
    const entry = { id: `${now().toString(36)}-${++seq}`, q };
    outbox.push(entry);
    if (outbox.length > USAGE_OUTBOX_MAX) outbox = outbox.slice(-USAGE_OUTBOX_MAX);
    lastSentAt = now();
    save();
    transmit(entry);
  }
  function record(tool: string, success: boolean, code?: unknown) {
    if (!KNOWN.has(tool)) return;
    if (success) ok++; else err++;
    tools.set(tool, (tools.get(tool) || 0) + 1);
    if (!success && code !== undefined) {
      const key = `${tool}:${typeof code === "string" && CODE.test(code) ? code : "UNKNOWN"}`;
      fails.set(key, (fails.get(key) || 0) + 1);
    }
    if (!firstCallSent || ok + err >= batchSize) { firstCallSent = true; flush(); return; }
    save();
    if (timer === null) {
      // Later calls join the pending report; they do not push it back.
      const delay = Math.max(firstFlushMs, lastSentAt + minIntervalMs - now());
      timer = setTimer(() => { timer = null; flush(); }, delay);
    }
  }
  // The UI confirms a report once its u.gif request has loaded.
  function ack(id: unknown) {
    const before = outbox.length;
    outbox = outbox.filter((e) => e.id !== id);
    if (outbox.length !== before) save();
  }
  // On plugin start: take what the last session left, re-send its unconfirmed reports
  // and send its unsent counts at once. Anything malformed is dropped.
  function restore(saved: unknown) {
    if (!saved || typeof saved !== "object") return;
    const s = saved as Partial<UsageState>;
    const old = Array.isArray(s.out) ? s.out.filter((e) => e && typeof e.id === "string" && e.id.length <= 40 && typeof e.q === "string" && QUERY.test(e.q)) : [];
    const known = new Set(outbox.map((e) => e.id));
    const resend = old.filter((e) => !known.has(e.id)).slice(-USAGE_OUTBOX_MAX).map((e) => ({ id: e.id, q: e.q }));
    outbox = [...resend, ...outbox].slice(-USAGE_OUTBOX_MAX);
    let added = 0;
    for (const [k, n] of Array.isArray(s.t) ? s.t : []) if (KNOWN.has(k) && count(n)) { tools.set(k, (tools.get(k) || 0) + count(n)); added++; }
    for (const [k, n] of Array.isArray(s.f) ? s.f : []) {
      const [tool, c] = typeof k === "string" ? k.split(":") : [];
      if (KNOWN.has(tool) && typeof c === "string" && CODE.test(c) && count(n)) fails.set(k, (fails.get(k) || 0) + count(n));
    }
    if (added) { ok += count(s.ok); err += count(s.err); }
    for (const e of resend) transmit(e);
    if (ok + err > 0) flush(); else save();
  }
  return { record, flush, ack, restore };
}
