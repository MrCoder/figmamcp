// Where the usage counter keeps unsent counts between sessions (figma.clientStorage).
// clientStorage is shared by every open copy of the plugin for this user, so each session
// writes its own key. A session takes over only keys left by sessions that are gone, at
// start and then every USAGE_RETAKE_MS while it stays open (createStaleTakeover). A live
// session rewrites its own key on every such check, so a key not written for
// USAGE_STALE_MS belongs to a closed or crashed plugin. Fresh keys are left alone, or two
// open files would both send the same counts.
import type { UsageState } from "./usageCounter.js";

export const USAGE_KEY_PREFIX = "usagePending:";
export const USAGE_STALE_MS = 5 * 60 * 1000;
export const USAGE_RETAKE_MS = 60 * 1000;

export interface UsageStorage {
    getAsync(key: string): Promise<unknown>;
    setAsync(key: string, value: unknown): Promise<void>;
    deleteAsync(key: string): Promise<void>;
    keysAsync(): Promise<string[]>;
}

export function createUsageStore(storage: UsageStorage, opts: { sessionId: string; now?: () => number }) {
    const now = opts.now ?? (() => Date.now());
    const own = USAGE_KEY_PREFIX + opts.sessionId;
    let last: UsageState | null = null;
    function save(state: UsageState) {
        const empty = state.ok + state.err === 0 && state.out.length === 0;
        last = empty ? null : state;
        const p = empty ? storage.deleteAsync(own) : storage.setAsync(own, { ...state, savedAt: now() });
        p.catch(() => {});
    }
    // Rewrites the last saved state with a new savedAt, so an open plugin that has an
    // unconfirmed report but makes no calls is not taken for a closed one.
    function touch() {
        if (last) storage.setAsync(own, { ...last, savedAt: now() }).catch(() => {});
    }
    async function takeOverStale(): Promise<unknown[]> {
        const found: unknown[] = [];
        let keys: string[] = [];
        try { keys = await storage.keysAsync(); } catch (_) { return found; }
        for (const key of keys) {
            if (!key.startsWith(USAGE_KEY_PREFIX) || key === own) continue;
            try {
                const saved = await storage.getAsync(key) as { savedAt?: unknown } | undefined;
                const at = saved && typeof saved.savedAt === "number" ? saved.savedAt : 0;
                if (now() - at < USAGE_STALE_MS) continue; // another plugin that is still open
                await storage.deleteAsync(key);
                found.push(saved);
            } catch (_) { /* best effort */ }
        }
        return found;
    }
    return { save, touch, takeOverStale };
}

// Runs the stale-key takeover at start and then every USAGE_RETAKE_MS until stop(), and
// gives each state found to restore (which sends it). A plugin opened within 5 min of
// another one closing finds that key only once it is stale, so the start-time check alone
// would leave those counts until the next start. A check is skipped while the previous one
// is still running.
export function createStaleTakeover(opts: {
    store: { touch(): void; takeOverStale(): Promise<unknown[]> };
    restore: (state: unknown) => void;
    intervalMs?: number;
    setTimer?: (fn: () => void, ms: number) => any;
    clearTimer?: (handle: any) => void;
}) {
    const intervalMs = opts.intervalMs ?? USAGE_RETAKE_MS;
    const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = opts.clearTimer ?? ((h: any) => clearTimeout(h));
    let timer: any = null;
    let running = false;
    let stopped = false;
    async function tick() {
        if (running) return;
        running = true;
        try {
            opts.store.touch();
            for (const s of await opts.store.takeOverStale()) {
                try { opts.restore(s); } catch (_) { /* best effort */ }
            }
        } catch (_) { /* best effort */ } finally { running = false; }
    }
    function arm() {
        timer = setTimer(() => { timer = null; arm(); void tick(); }, intervalMs);
    }
    function start(): Promise<void> {
        if (stopped || timer !== null) return Promise.resolve();
        arm();
        return tick();
    }
    function stop() {
        stopped = true;
        if (timer !== null) { clearTimer(timer); timer = null; }
    }
    return { start, stop, tick };
}
