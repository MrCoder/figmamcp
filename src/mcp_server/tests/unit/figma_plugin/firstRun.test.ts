import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { createFirstRun, FIRST_CALL_KEY } from "../../../../../figma_plugin/utils/firstRun";

const ui = readFileSync("figma_plugin/ui.html", "utf8");

function memoryStorage(initial: Record<string, unknown> = {}) {
    const data = { ...initial };
    return {
        data,
        getAsync: async (k: string) => data[k],
        setAsync: async (k: string, v: unknown) => { data[k] = v; },
    };
}

type Hint = { lead: string; prompt: string; restart: boolean } | null;

function loadBlock() {
    const start = ui.indexOf("// FIRST-RUN-START");
    const end = ui.indexOf("// FIRST-RUN-END");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function(`${ui.slice(start, end)}\nreturn { firstRunHint, nextAiPresence };`)() as {
        firstRunHint: (s: any) => Hint;
        nextAiPresence: (p: any, event: string) => { aiPresent: boolean; aiWaitOver: boolean };
    };
}

function loadHint() {
    return loadBlock().firstRunHint;
}

describe("first-run hint: storage flag", () => {
    it("is pending on a fresh install, and clears and persists after the first successful call", async () => {
        const s = memoryStorage();
        const posts: boolean[] = [];
        const fr = createFirstRun(s, (p) => posts.push(p));
        await fr.load();
        expect(posts).toEqual([true]);
        fr.noteSuccess();
        fr.noteSuccess();
        expect(posts).toEqual([true, false]);
        expect(s.data[FIRST_CALL_KEY]).toBe(true);
    });

    it("stays hidden on a later load once the flag is stored", async () => {
        const posts: boolean[] = [];
        await createFirstRun(memoryStorage({ [FIRST_CALL_KEY]: true }), (p) => posts.push(p)).load();
        expect(posts).toEqual([false]);
    });

    it("stays hidden when storage fails", async () => {
        const broken = { getAsync: async () => { throw new Error("no storage"); }, setAsync: async () => {} };
        const posts: boolean[] = [];
        await createFirstRun(broken, (p) => posts.push(p)).load();
        expect(posts).toEqual([false]);
    });

    it("does nothing for a success that arrives before storage was read", () => {
        const s = memoryStorage();
        const posts: boolean[] = [];
        createFirstRun(s, (p) => posts.push(p)).noteSuccess();
        expect(posts).toEqual([]);
        expect(s.data[FIRST_CALL_KEY]).toBeUndefined();
    });
});

describe("first-run hint: panel text", () => {
    const hint = loadHint();

    it("shows one example prompt only when connected and pending", () => {
        expect(hint({ connected: true, firstRunPending: true, aiPresent: true })?.prompt).toContain("FigmaMCP");
        expect(hint({ connected: false, firstRunPending: true, aiPresent: true })).toBeNull();
        expect(hint({ connected: true, firstRunPending: false, aiPresent: true })).toBeNull();
        expect(hint({ connected: true, aiPresent: true })).toBeNull();
    });

    // Netherlands, 2026-11-21 (Melbourne): 29 minutes from the first plugin load to the
    // first AI hello, while the old hint said "Try asking your agent" whenever it was shown.
    it("tells the user to restart Claude Code or Codex when no AI app has loaded FigmaMCP", () => {
        const h = hint({ connected: true, firstRunPending: true, aiPresent: false, aiWaitOver: true })!;
        expect(h.restart).toBe(true);
        expect(h.lead).toContain("Claude Code");
        expect(h.lead).toContain("Codex");
        expect(h.lead).toMatch(/quit/i);
    });

    it("does not tell the user to restart once an AI app has FigmaMCP loaded", () => {
        const h = hint({ connected: true, firstRunPending: true, aiPresent: true, aiWaitOver: true })!;
        expect(h.restart).toBe(false);
        expect(h.lead).not.toMatch(/quit|restart/i);
    });

    it("waits for the relay's catch-up notice before saying no AI app is there", () => {
        const h = hint({ connected: true, firstRunPending: true, aiPresent: false, aiWaitOver: false })!;
        expect(h.restart).toBe(false);
        expect(h.prompt).toContain("FigmaMCP");
    });

    it("uses plain words and no banned terms", () => {
        for (const s of [
            { connected: true, firstRunPending: true, aiPresent: true },
            { connected: true, firstRunPending: true, aiPresent: false, aiWaitOver: true },
        ]) {
            const h = hint(s)!;
            expect(h.prompt.length).toBeLessThan(100);
            expect(h.lead.length).toBeLessThan(110);
            expect(h.lead + h.prompt).not.toMatch(/MIT|open source|unlimited|bypass|workaround|npx|npm/i);
        }
    });
});

describe("first-run hint: AI presence", () => {
    const { nextAiPresence, firstRunHint } = loadBlock();
    const start = { aiPresent: false, aiWaitOver: false };

    it("a hello from an AI app marks it present", () => {
        expect(nextAiPresence(start, "ai-present")).toEqual({ aiPresent: true, aiWaitOver: false });
    });

    it("the wait ends without a hello: no AI app", () => {
        expect(nextAiPresence(start, "wait-over")).toEqual({ aiPresent: false, aiWaitOver: true });
    });

    it("losing the relay forgets both, so a reconnect waits for a fresh notice", () => {
        expect(nextAiPresence({ aiPresent: true, aiWaitOver: true }, "disconnected")).toEqual(start);
    });

    it("an AI app that starts after the wait replaces the restart line with the prompt", () => {
        let p = nextAiPresence(start, "wait-over");
        expect(firstRunHint({ connected: true, firstRunPending: true, ...p })!.restart).toBe(true);
        p = nextAiPresence(p, "ai-present");
        expect(firstRunHint({ connected: true, firstRunPending: true, ...p })!.restart).toBe(false);
    });
});

describe("first-run hint: wiring", () => {
    it("main.ts marks success only for calls without an error code", () => {
        const main = readFileSync("figma_plugin/src/main.ts", "utf8");
        expect(main).toContain("if (!errorCode) firstRun.noteSuccess();");
        expect(main).toContain("firstRun.load();");
    });

    it("the panel handles the first-run message and has a hidden slot for the line", () => {
        expect(ui).toContain('case "first-run":');
        expect(ui).toContain('id="first-run" class="note hidden"');
    });
});
