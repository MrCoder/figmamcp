import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

const TEST_PLUGIN_VERSION = "9.9.9-phase9-test";
const previousFigma = (globalThis as any).figma;
const previousHtml = (globalThis as any).__html__;
const previousPluginVersion = (globalThis as any).__PLUGIN_VERSION__;

const pluginMessages: any[] = [];
const scopeReadyStateSnapshots: any[] = [];
let mainModule: any;

const phase9Figma = {
    showUI: () => {},
    ui: {
        onmessage: null as any,
        postMessage: (message: any) => {
            pluginMessages.push(message);
            if (message.type === "scope-ready" && mainModule) {
                scopeReadyStateSnapshots.push({ ...mainModule.getPluginState() });
            }
        },
    },
    on: () => {},
    notify: () => {},
    closePlugin: () => {},
};

(globalThis as any).figma = phase9Figma;
(globalThis as any).__html__ = "<html></html>";
(globalThis as any).__PLUGIN_VERSION__ = TEST_PLUGIN_VERSION;

mainModule = await import(
    "../../../../../figma_plugin/src/main.js?scope=phase9-scope-ready"
);
const pluginOnMessage = phase9Figma.ui.onmessage as (message: any) => Promise<void> | void;

afterAll(() => {
    (globalThis as any).figma = previousFigma;
    (globalThis as any).__html__ = previousHtml;
    (globalThis as any).__PLUGIN_VERSION__ = previousPluginVersion;
});

describe("Phase 9 Q11: plugin-main scope-ready acknowledgement", () => {
    beforeEach(() => {
        pluginMessages.length = 0;
        scopeReadyStateSnapshots.length = 0;
    });

    it("echoes the request only after committing scoped permissions", async () => {
        await pluginOnMessage({
            type: "set-scope",
            requestId: "scope-request-1",
            scopeNodeId: "scope-1",
            scopeNodeType: "PAGE",
            allowEditVariable: true,
            allowEditStyle: false,
        });

        expect(pluginMessages).toEqual([{
            type: "scope-ready",
            requestId: "scope-request-1",
            pluginVersion: TEST_PLUGIN_VERSION,
        }]);
        expect(scopeReadyStateSnapshots).toHaveLength(1);
        expect(scopeReadyStateSnapshots[0]).toMatchObject({
            scopeRootId: "scope-1",
            allowEditNode: "page",
            allowEditVariable: true,
            allowEditStyle: false,
        });
    });

    it("acknowledges read-only node scope only after committing asset permissions", async () => {
        await pluginOnMessage({
            type: "set-scope",
            requestId: "scope-request-2",
            allowEditVariable: false,
            allowEditStyle: true,
        });

        expect(pluginMessages).toEqual([{
            type: "scope-ready",
            requestId: "scope-request-2",
            pluginVersion: TEST_PLUGIN_VERSION,
        }]);
        expect(scopeReadyStateSnapshots).toHaveLength(1);
        expect(scopeReadyStateSnapshots[0]).toMatchObject({
            scopeRootId: null,
            allowEditNode: false,
            allowEditVariable: false,
            allowEditStyle: true,
        });
    });
});

class FakeClassList {
    private readonly values = new Set<string>();

    add(...names: string[]) {
        for (const name of names) this.values.add(name);
    }

    remove(...names: string[]) {
        for (const name of names) this.values.delete(name);
    }

    has(name: string) {
        return this.values.has(name);
    }
}

class FakeElement {
    readonly classList = new FakeClassList();
    readonly style: Record<string, string> = {};
    readonly listeners = new Map<string, (event: any) => void>();
    value = "";
    checked = false;
    disabled = false;
    textContent = "";
    innerHTML = "";
    className = "";
    placeholder = "";
    offsetHeight = 0;
    open = false;
    title = "";
    children: FakeElement[] = [];
    onclick: ((event?: any) => void) | null = null;

    constructor(readonly id: string) {}

    replaceChildren(...nodes: FakeElement[]) {
        this.textContent = "";
        this.children = [...nodes];
    }

    appendChild(node: FakeElement) {
        this.children.push(node);
        return node;
    }

    append(...nodes: FakeElement[]) {
        this.children.push(...nodes);
    }

    /** What the real DOM's textContent would read: own text, then the children's. */
    deepText(): string {
        return this.textContent + this.children.map((child) => child.deepText()).join("");
    }

    addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, listener);
    }

    click() {
        this.onclick?.({ target: this });
    }

    select() {}
}

function createUiHarness(script: string) {
    const elements = new Map<string, FakeElement>();
    const getElement = (id: string) => {
        let element = elements.get(id);
        if (!element) {
            element = new FakeElement(id);
            elements.set(id, element);
        }
        return element;
    };

    getElement("ai-can-edit").checked = true;

    const documentStub = {
        getElementById: (id: string) => getElement(id),
        querySelectorAll: () => [] as FakeElement[],
        createElement: (tag: string) => new FakeElement(tag),
        execCommand: () => true,
        body: {
            appendChild: () => {},
            removeChild: () => {},
        },
    };

    const windowListeners = new Map<string, (event: any) => void>();
    const windowStub: any = {
        onmessage: null,
        addEventListener: (type: string, listener: (event: any) => void) => {
            windowListeners.set(type, listener);
        },
        open: () => {},
    };

    const parentMessages: any[] = [];
    const parentStub = {
        postMessage: (message: any) => {
            parentMessages.push(message);
        },
    };

    const sockets: MockWebSocket[] = [];
    class MockWebSocket {
        onopen: ((event?: any) => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onclose: ((event?: any) => void) | null = null;
        onerror: ((event?: any) => void) | null = null;
        readonly sent: string[] = [];
        closed = false;

        constructor(readonly url: string) {
            sockets.push(this);
        }

        send(message: string) {
            this.sent.push(message);
        }

        close() {
            if (this.closed) return;
            this.closed = true;
            this.onclose?.({ type: "close" });
        }
    }

    const quietConsole = {
        log: () => {},
        error: () => {},
        warn: () => {},
    };

    // Controllable timers: the UI's scope-ready bound (P9-F9) is only testable
    // if the harness can fire a pending timer on demand instead of waiting.
    const timers = new Map<number, { callback: () => void; delay: number }>();
    let nextTimerId = 0;
    const fakeSetTimeout = (callback: () => void, delay: number) => {
        const id = ++nextTimerId;
        timers.set(id, { callback, delay });
        return id;
    };
    const fakeClearTimeout = (id: number) => {
        timers.delete(id);
    };
    const runPendingTimers = () => {
        const scheduled = [...timers.entries()];
        for (const [id, timer] of scheduled) {
            if (!timers.has(id)) continue;
            timers.delete(id);
            timer.callback();
        }
        return scheduled.length;
    };

    const execute = new Function(
        "document",
        "window",
        "parent",
        "WebSocket",
        "console",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        `${script}\nreturn { state };`,
    );
    const runtime = execute(
        documentStub,
        windowStub,
        parentStub,
        MockWebSocket,
        quietConsole,
        fakeSetTimeout,
        fakeClearTimeout,
        fakeSetTimeout,
        fakeClearTimeout,
    ) as { state: any };

    return {
        elements,
        parentMessages,
        runtime,
        sockets,
        windowStub,
        timers,
        runPendingTimers,
    };
}

const text = (harness: any, id: string) => harness.elements.get(id).deepText();

const uiHtml = await readFile("figma_plugin/ui.html", "utf8");
const inlineScript = uiHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!inlineScript) {
    throw new Error("figma_plugin/ui.html inline script was not found");
}

// The plugin connects by itself once main reports the file: there is no Connect button.
function pluginVersionMessage(extra: any = {}) {
    return { data: { pluginMessage: { type: "plugin-version", version: "2.3.3", fileKey: "AbC123xyz", fileName: "My File", rootId: "0:0", ...extra } } };
}

function clickAndReadScopeRequest(harness: ReturnType<typeof createUiHarness>, extra: any = {}) {
    harness.windowStub.onmessage(pluginVersionMessage(extra));

    expect(harness.parentMessages).toHaveLength(1);
    const request = harness.parentMessages[0].pluginMessage;
    expect(request.type).toBe("set-scope");
    expect(typeof request.requestId).toBe("string");
    expect(request.requestId.length).toBeGreaterThan(0);
    return request;
}

function deliverScopeReady(
    harness: ReturnType<typeof createUiHarness>,
    requestId: string,
    pluginVersion = "2.3.3",
) {
    harness.windowStub.onmessage({
        data: {
            pluginMessage: {
                type: "scope-ready",
                requestId,
                pluginVersion,
            },
        },
    });
}

describe("Phase 9 Q11: executable plugin UI handshake", () => {
    it("opens no socket before the matching one-shot acknowledgement", () => {
        const harness = createUiHarness(inlineScript);
        const request = clickAndReadScopeRequest(harness, { fileName: null });

        expect(harness.sockets).toHaveLength(0);
        expect(harness.runtime.state.pendingScopeRequest).toMatchObject({
            requestId: request.requestId,
            port: 3155,
        });

        deliverScopeReady(harness, "stray-request");
        expect(harness.sockets).toHaveLength(0);

        deliverScopeReady(harness, request.requestId);
        expect(harness.sockets).toHaveLength(1);
        expect(harness.runtime.state.pendingScopeRequest).toBeNull();

        deliverScopeReady(harness, request.requestId);
        expect(harness.sockets).toHaveLength(1);

        const socket = harness.sockets[0];
        expect(socket.url).toBe("ws://localhost:3155");
        socket.onopen?.();
        expect(socket.sent).toHaveLength(1);
        expect(JSON.parse(socket.sent[0])).toEqual({
            type: "join",
            channel: expect.any(String),
            clientType: "plugin",
            pluginVersion: "2.3.3",
            // Local patch (simple model): several sessions are on by default.
            maxMcpPeers: 4,
            // Random per plugin window, so the relay counts a reconnect as the same open.
            pluginSession: expect.stringMatching(/^[0-9a-z]{12}$/),
        });
    });

    it("keeps a coded join refusal visible after the socket closes", () => {
        const harness = createUiHarness(inlineScript);
        const request = clickAndReadScopeRequest(harness);
        deliverScopeReady(harness, request.requestId);

        const socket = harness.sockets[0];
        socket.onopen?.();
        socket.onmessage?.({
            data: JSON.stringify({
                type: "join_error",
                code: "PLUGIN_PEER_AMBIGUOUS",
                message: "Two plugin peers are waiting in this channel.",
            }),
        });

        expect(socket.closed).toBe(true);
        expect(harness.runtime.state.socket).toBeNull();
        expect(text(harness, "status-title")).toBe("Can't connect");
        expect(text(harness, "status-detail")).toContain("Two plugin peers are waiting");
    });

    it("P9-F9: abandons an unacknowledged scope request and states the retry", () => {
        // Without a bound, a lost `scope-ready` left the UI at "Connecting..."
        // forever with no recovery text and no socket.
        const harness = createUiHarness(inlineScript);
        const request = clickAndReadScopeRequest(harness);
        expect(harness.runtime.state.pendingScopeRequest).not.toBeNull();

        expect(harness.runPendingTimers()).toBeGreaterThan(0);

        expect(harness.sockets).toHaveLength(0);
        expect(harness.runtime.state.pendingScopeRequest).toBeNull();
        expect(text(harness, "status-title")).toBe("Can't connect");
        expect(text(harness, "status-detail")).toContain("did not respond");
        expect(text(harness, "status-detail")).toContain("Trying again");

        // A late acknowledgement for the abandoned request stays inert.
        deliverScopeReady(harness, request.requestId);
        expect(harness.sockets).toHaveLength(0);
    });

    it("P9-F9: a served acknowledgement cancels the bound so it cannot fire later", () => {
        const harness = createUiHarness(inlineScript);
        const request = clickAndReadScopeRequest(harness);
        deliverScopeReady(harness, request.requestId);
        expect(harness.sockets).toHaveLength(1);

        // The scope-ready timer must have been cleared on consumption; firing
        // whatever remains must not tear down the established connection.
        harness.runPendingTimers();
        expect(text(harness, "status-detail")).not.toContain("did not respond");
        expect(harness.sockets).toHaveLength(1);
    });

    it("P9-F9: a newer scope request supersedes the first request's bound", () => {
        const harness = createUiHarness(inlineScript);
        clickAndReadScopeRequest(harness);
        const firstId = harness.runtime.state.pendingScopeRequest.requestId;

        const box = harness.elements.get("ai-can-edit")!;
        box.listeners.get("change")!({ target: box });
        const secondId = harness.runtime.state.pendingScopeRequest.requestId;
        expect(secondId).not.toBe(firstId);

        // The superseded request's timer was cleared, so firing the remaining
        // timer abandons only the current request — and the stale ID is inert.
        harness.runPendingTimers();
        deliverScopeReady(harness, firstId);
        expect(harness.sockets).toHaveLength(0);
    });
});

describe("Phase 9 P9-F10: plugin UI socket response handling", () => {
    it("resolves a pending UI request by its own id", () => {
        // `state.pendingRequests.delete(id)` referenced an undeclared binding
        // where `data.id` was meant. Reachable only through the unused
        // sendCommand helper, so latent — but it sits in the response path.
        const harness = createUiHarness(inlineScript);
        const request = clickAndReadScopeRequest(harness);
        deliverScopeReady(harness, request.requestId);
        const socket = harness.sockets[0];
        socket.onopen?.();

        const state = harness.runtime.state;
        state.connected = true;
        let resolved: unknown;
        state.pendingRequests.set("req-1", {
            resolve: (value: unknown) => { resolved = value; },
            reject: () => { throw new Error("must not reject"); },
        });

        expect(() => socket.onmessage?.({
            data: JSON.stringify({
                type: "broadcast",
                message: { id: "req-1", result: { ok: true } },
            }),
        })).not.toThrow();

        expect(resolved).toEqual({ ok: true });
        expect(state.pendingRequests.has("req-1")).toBe(false);
    });
});

// Local patch (multi-MCP, issue #4): the UI is the only path that carries the
// relay's peer stamp into the plugin. If it dropped mcpPeerId, every command
// would arrive unstamped and every lease check would pass silently.
describe("multi-MCP: plugin UI wiring", () => {
    function connect(harness: ReturnType<typeof createUiHarness>) {
        const request = clickAndReadScopeRequest(harness);
        deliverScopeReady(harness, request.requestId);
        const socket = harness.sockets[0];
        socket.onopen?.();
        socket.onmessage?.({ data: JSON.stringify({ type: "system", channel: "ab12", message: { id: "j", result: "Connected" } }) });
        return socket;
    }

    it("always offers 4 AI sessions", () => {
        const socket = connect(createUiHarness(inlineScript));
        expect(JSON.parse(socket.sent[0]).maxMcpPeers).toBe(4);
    });

    it("passes the relay's mcpPeerId to the plugin as peerId on execute-command", () => {
        const harness = createUiHarness(inlineScript);
        const socket = connect(harness);
        harness.parentMessages.length = 0;
        socket.onmessage?.({ data: JSON.stringify({
            type: "broadcast", channel: "ab12", sender: "peer", mcpPeerId: "peer-a",
            message: { id: "req-1", command: "node_info", params: {} },
        }) });
        const exec = harness.parentMessages.map((m) => m.pluginMessage).find((m) => m.type === "execute-command");
        expect(exec).toMatchObject({ id: "req-1", command: "node_info", peerId: "peer-a" });
    });

    it("tells the plugin which session left, so its lease is freed", () => {
        const harness = createUiHarness(inlineScript);
        const socket = connect(harness);
        harness.parentMessages.length = 0;
        socket.onmessage?.({ data: JSON.stringify({ type: "system", channel: "ab12", message: "A user has left the channel", peerId: "peer-b" }) });
        expect(harness.parentMessages.map((m) => m.pluginMessage)).toContainEqual({ type: "peer-left", peerId: "peer-b" });
    });
});

// Local patch (simple model): the plugin names its channel after the file key,
// so an agent holding the file's link needs no channel code.
describe("simple model: file key as channel name", () => {
    function connectWith(pluginVersionMessage: any) {
        const harness = createUiHarness(inlineScript);
        if (pluginVersionMessage) harness.windowStub.onmessage({ data: { pluginMessage: pluginVersionMessage } });
        // With a file key the plugin connects by itself; without one, click.
        expect(harness.parentMessages).toHaveLength(1);
        const request = harness.parentMessages[0].pluginMessage;
        deliverScopeReady(harness, request.requestId);
        const socket = harness.sockets[0];
        socket.onopen?.();
        return JSON.parse(socket.sent[0]);
    }

    it("joins the channel named after the file key and sends the file name", () => {
        const join = connectWith({ type: "plugin-version", version: "2.3.3", fileKey: "AbC123xyz", fileName: "My File" });
        expect(join.channel).toBe("AbC123xyz");
        expect(join.fileName).toBe("My File");
    });

    it("falls back to a random 4-character code when the file key is unavailable", () => {
        const join = connectWith({ type: "plugin-version", version: "2.3.3", fileKey: null, fileName: "My File" });
        expect(join.channel).toMatch(/^[a-z0-9]{4}$/);
    });
});

// Local patch (simple model): open the plugin and AI can edit the whole file.
describe("simple model: UI defaults", () => {
    const versionMessage = (extra: any = {}) => ({
        data: { pluginMessage: { type: "plugin-version", version: "2.3.3", fileKey: "AbC123xyz", fileName: "F", rootId: "0:0", ...extra } },
    });
    const scopeRequests = (harness: ReturnType<typeof createUiHarness>) =>
        harness.parentMessages.map((m) => m.pluginMessage).filter((m) => m.type === "set-scope");

    it("connects by itself once the plugin reports a file key, asking for the whole file", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage());
        const requests = scopeRequests(harness);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ scopeNodeId: "0:0", scopeNodeType: "DOCUMENT", allowEditVariable: true, allowEditStyle: true });
    });

    it("auto-connects only once", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage());
        harness.runPendingTimers(); // scope-ready never came: the request is abandoned
        harness.windowStub.onmessage(versionMessage());
        expect(scopeRequests(harness)).toHaveLength(1);
    });

    it("connects without a file key too, so nobody has to click anything", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage({ fileKey: null }));
        expect(scopeRequests(harness)).toHaveLength(1);
    });

    it("with AI editing unticked, sends no scope root and no variable or style rights", () => {
        const harness = createUiHarness(inlineScript);
        harness.elements.get("ai-can-edit")!.checked = false;
        harness.windowStub.onmessage(versionMessage());
        expect(scopeRequests(harness)[0]).toMatchObject({ scopeNodeId: null, scopeNodeType: null, allowEditVariable: false, allowEditStyle: false });
    });

    it("stays read-only for an empty link when the plugin did not report the document root", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage({ fileKey: null, rootId: null }));
        expect(scopeRequests(harness)[0]).toMatchObject({ scopeNodeId: null, scopeNodeType: null });
    });
});

// Local patch (simple panel): status, session count and one edit switch up
// front; everything else under Advanced.
describe("simple panel", () => {
    const versionMessage = (extra: any = {}) => ({
        data: { pluginMessage: { type: "plugin-version", version: "2.3.3", fileKey: "AbC123xyz", fileName: "My File", rootId: "0:0", ...extra } },
    });
    const scopeRequests = (harness: ReturnType<typeof createUiHarness>) =>
        harness.parentMessages.map((m) => m.pluginMessage).filter((m) => m.type === "set-scope");
    const joined = (peerId: string) => JSON.stringify({ type: "system", channel: "AbC123xyz", message: "A new user has joined the channel", peerId });
    const left = (peerId: string) => JSON.stringify({ type: "system", channel: "AbC123xyz", message: "A user has left the channel", peerId });
    const ackJoin = JSON.stringify({ type: "system", channel: "AbC123xyz", message: { id: "j", result: "Connected" } });

    function open(extra: any = {}) {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage(extra));
        const request = scopeRequests(harness).at(-1);
        deliverScopeReady(harness, request.requestId);
        const socket = harness.sockets.at(-1)!;
        socket.onopen?.();
        socket.onmessage?.({ data: ackJoin });
        return { harness, socket };
    }
    const hidden = (harness: any, id: string) => harness.elements.get(id).classList.has("hidden");

    // Activation 2026-11-21: the first-run line must follow whether an AI app has
    // FigmaMCP loaded, not only whether the plugin reached the relay.
    describe("first-run line follows AI presence", () => {
        const firstRun = (harness: any) => harness.windowStub.onmessage({ data: { pluginMessage: { type: "first-run", pending: true } } });
        const fireAiWait = (harness: any) => {
            const entry = [...harness.timers.entries()].find(([, t]: any) => t.delay === 4000);
            expect(entry).toBeDefined();
            harness.timers.delete(entry![0]);
            entry![1].callback();
        };
        const presence = JSON.stringify({ type: "system", message: "An MCP client is connected" });

        it("says to restart Claude Code or Codex when no AI app said hello before the wait ended", () => {
            const { harness } = open();
            firstRun(harness);
            expect(text(harness, "first-run")).not.toMatch(/Quit/);
            fireAiWait(harness);
            expect(hidden(harness, "first-run")).toBe(false);
            expect(text(harness, "first-run")).toMatch(/Quit Claude Code or Codex/);
            expect(text(harness, "first-run")).toContain("Use FigmaMCP");
        });

        it("shows the prompt, not the restart line, once the relay reports an AI app", () => {
            const { harness, socket } = open();
            firstRun(harness);
            socket.onmessage?.({ data: presence });
            fireAiWait(harness);
            expect(text(harness, "first-run")).toContain("Your AI app is connected");
            expect(text(harness, "first-run")).not.toMatch(/Quit/);
        });

        it("replaces the restart line when an AI app starts later", () => {
            const { harness, socket } = open();
            firstRun(harness);
            fireAiWait(harness);
            expect(text(harness, "first-run")).toMatch(/Quit/);
            socket.onmessage?.({ data: presence });
            expect(text(harness, "first-run")).not.toMatch(/Quit/);
            expect(text(harness, "first-run")).toContain("Your AI app is connected");
        });
    });

    it("says Connected with the file name under it", () => {
        const { harness } = open();
        expect(text(harness, "status-title")).toBe("Connected");
        expect(text(harness, "status-detail")).toBe("My File");
        expect(hidden(harness, "rights-note")).toBe(true);
    });

    it("writes the file name as text, never as markup", () => {
        const { harness } = open({ fileName: "<img src=x>" });
        expect(text(harness, "status-detail")).toBe("<img src=x>");
        expect(harness.elements.get("status-detail").innerHTML).toBe("");
    });

    it("says read-only when AI editing is off", () => {
        const harness = createUiHarness(inlineScript);
        harness.elements.get("ai-can-edit")!.checked = false;
        harness.windowStub.onmessage(versionMessage());
        deliverScopeReady(harness, scopeRequests(harness)[0].requestId);
        const socket = harness.sockets[0];
        socket.onopen?.();
        socket.onmessage?.({ data: ackJoin });
        expect(text(harness, "status-title")).toBe("Connected");
        expect(hidden(harness, "rights-note")).toBe(false);
    });

    it("still shows the channel code when the plugin has no file key", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage({ fileKey: null }));
        deliverScopeReady(harness, scopeRequests(harness)[0].requestId);
        const socket = harness.sockets[0];
        socket.onopen?.();
        socket.onmessage?.({ data: JSON.stringify({ type: "system", channel: "ab12", message: { id: "j", result: "Connected" } }) });
        expect(text(harness, "status-detail")).toBe("Tell the AI this code: " + harness.runtime.state.channel);
        expect(harness.runtime.state.channel).toMatch(/^[a-z0-9]{4}$/);
    });

    const sessionCount = (harness: any) => harness.elements.get("ai-sessions").children[0]?.textContent ?? "";
    const sessionRows = (harness: any) =>
        harness.elements.get("ai-sessions").children.slice(1).map((row: any) => row.children.map((c: any) => c.textContent));

    it("counts AI sessions as they join and leave", () => {
        const { harness, socket } = open();
        expect(text(harness, "ai-sessions")).toBe("");
        expect(hidden(harness, "ai-sessions")).toBe(true);
        socket.onmessage?.({ data: joined("a") });
        expect(sessionCount(harness)).toBe("1 AI session connected");
        socket.onmessage?.({ data: joined("b") });
        socket.onmessage?.({ data: joined("a") });
        expect(sessionCount(harness)).toBe("2 AI sessions connected");
        socket.onmessage?.({ data: left("a") });
        socket.onmessage?.({ data: left("unknown") });
        expect(sessionCount(harness)).toBe("1 AI session connected");
    });

    it("shows one row per session: client app and session name, as text", () => {
        const { harness, socket } = open();
        const at = new Date(2020, 0, 1, 14, 2).getTime();
        const joinedAs = (peerId: string, client: any, connectedAt: number) =>
            JSON.stringify({ type: "system", channel: "AbC123xyz", message: "A new user has joined the channel", peerId, client, connectedAt });
        socket.onmessage?.({ data: joinedAs("a", { app: "Claude Code", label: "自运营 Figma MCP 产品" }, at) });
        socket.onmessage?.({ data: joinedAs("b", { app: "Codex", label: "<b>web-sequence</b>" }, at + 60_000) });
        socket.onmessage?.({ data: joined("c") });
        const rows = sessionRows(harness);
        expect(rows[0]).toEqual(["Claude Code · 自运营 Figma MCP 产品", "Connected 14:02"]);
        expect(rows[1]).toEqual(["Codex · <b>web-sequence</b>", "Connected 14:03"]);
        // An old relay sends no client: the session still gets a row.
        expect(rows[2][0]).toBe("AI session");
        expect(harness.elements.get("ai-sessions").innerHTML).toBe("");
    });

    it("renames a row on Client updated and stamps activity from the commands it sends", () => {
        const { harness, socket } = open();
        socket.onmessage?.({ data: JSON.stringify({ type: "system", channel: "AbC123xyz", message: "A new user has joined the channel", peerId: "a", client: { app: "Claude Code", label: "Untitled" } }) });
        socket.onmessage?.({ data: JSON.stringify({ type: "system", channel: "AbC123xyz", message: "Client updated", peerId: "a", client: { app: "Claude Code", label: "Renamed" } }) });
        // A rename for a session that is not in this channel adds nothing.
        socket.onmessage?.({ data: JSON.stringify({ type: "system", channel: "AbC123xyz", message: "Client updated", peerId: "zz", client: { app: "X", label: "Y" } }) });
        expect(sessionRows(harness).map((r: any) => r[0])).toEqual(["Claude Code · Renamed"]);
        socket.onmessage?.({ data: JSON.stringify({ type: "broadcast", channel: "AbC123xyz", mcpPeerId: "a", message: { id: "c1", command: "page_info", params: {} } }) });
        expect(sessionRows(harness)[0][1]).toContain("active just now");
    });

    it("clears the session count when disconnected", () => {
        const { harness, socket } = open();
        socket.onmessage?.({ data: joined("a") });
        socket.close();
        expect(text(harness, "ai-sessions")).toBe("");
    });

    it("reconnects with the new rights when AI editing is switched while connected", () => {
        const { harness, socket } = open();
        const box = harness.elements.get("ai-can-edit")!;
        box.checked = false;
        box.listeners.get("change")!({ target: box });
        expect(socket.closed).toBe(true);
        const requests = scopeRequests(harness);
        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({ scopeNodeId: null, allowEditVariable: false });
        deliverScopeReady(harness, requests[1].requestId);
        expect(harness.sockets).toHaveLength(2);
    });

    it("does not connect when AI editing is switched while disconnected", () => {
        const harness = createUiHarness(inlineScript);
        const box = harness.elements.get("ai-can-edit")!;
        box.checked = false;
        box.listeners.get("change")!({ target: box });
        expect(scopeRequests(harness)).toHaveLength(0);
        expect(harness.runtime.state.reconnectAfterClose).toBe(false);
    });

    it("keeps the edit switch usable while connected", () => {
        const { harness } = open();
        expect(harness.elements.get("ai-can-edit")!.disabled).toBe(false);
    });

    it("always asks for the whole-file defaults and never for extra scope links", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage());
        expect(scopeRequests(harness)[0]).toEqual({
            type: "set-scope",
            requestId: expect.any(String),
            scopeNodeId: "0:0",
            scopeNodeType: "DOCUMENT",
            additionalScopeLinks: [],
            allowEditVariable: true,
            allowEditStyle: true,
        });
    });

    it("has no Advanced section, Connect button, port or scope fields in the markup", () => {
        for (const gone of ["advanced", "btn-connect", 'id="port"', "scope-link", "additional-scope-links", "allow-edit-variable", "allow-edit-style", "btn-copy-link"]) {
            expect(uiHtml).not.toContain(gone);
        }
    });

    it("uses Figma theme variables and no hard-coded colours", () => {
        expect(uiHtml).toContain("var(--figma-color-bg)");
        expect(uiHtml).toContain("var(--figma-color-text)");
        const style = uiHtml.match(/<style>([\s\S]*?)<\/style>/)![1];
        expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    });
});

describe("relay missing: automatic retry", () => {
    const versionMessage = pluginVersionMessage;
    const scopeRequests = (harness: ReturnType<typeof createUiHarness>) =>
        harness.parentMessages.map((m) => m.pluginMessage).filter((m) => m.type === "set-scope");

    it("says the app is not running when the socket cannot open, then asks the plugin again by itself", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage());
        deliverScopeReady(harness, scopeRequests(harness)[0].requestId);
        harness.sockets[0].close(); // the relay refuses: onclose without ever opening

        expect(text(harness, "status-title")).toBe("FigmaMCP isn't running");
        expect(text(harness, "status-detail")).toBe("Open the FigmaMCP app, then this reconnects by itself.");
        expect(scopeRequests(harness)).toHaveLength(1);

        harness.runPendingTimers(); // the retry timer fires
        expect(scopeRequests(harness)).toHaveLength(2);
        // The retry does not flicker back to "Connecting…".
        expect(text(harness, "status-title")).toBe("FigmaMCP isn't running");

        deliverScopeReady(harness, scopeRequests(harness)[1].requestId);
        expect(harness.sockets).toHaveLength(2);
    });

    it("moves to the next port when a port refuses, and wraps", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage());
        for (const port of [3155, 3156, 3157, 3158, 3155]) {
            deliverScopeReady(harness, scopeRequests(harness).at(-1).requestId);
            const socket = harness.sockets.at(-1)!;
            expect(socket.url).toBe(`ws://localhost:${port}`);
            socket.close();
            harness.runPendingTimers();
        }
    });

    it("retries every few seconds, not once", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage());
        for (let i = 0; i < 3; i++) {
            deliverScopeReady(harness, scopeRequests(harness).at(-1).requestId);
            harness.sockets.at(-1)!.close();
            expect([...harness.timers.values()].map((t) => t.delay)).toEqual([3000]);
            harness.runPendingTimers();
        }
        expect(scopeRequests(harness)).toHaveLength(4);
    });

    it("shows Connected again when the relay comes back", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage());
        deliverScopeReady(harness, scopeRequests(harness)[0].requestId);
        harness.sockets[0].close();
        harness.runPendingTimers();
        deliverScopeReady(harness, scopeRequests(harness)[1].requestId);
        const socket = harness.sockets[1];
        socket.onopen?.();
        socket.onmessage?.({ data: JSON.stringify({ type: "system", channel: "AbC123xyz", message: { id: "j", result: "Connected" } }) });
        expect(text(harness, "status-title")).toBe("Connected");
    });

    it("also notices a relay that stops after it was connected", () => {
        const harness = createUiHarness(inlineScript);
        harness.windowStub.onmessage(versionMessage());
        deliverScopeReady(harness, scopeRequests(harness)[0].requestId);
        const socket = harness.sockets[0];
        socket.onopen?.();
        socket.onmessage?.({ data: JSON.stringify({ type: "system", channel: "AbC123xyz", message: { id: "j", result: "Connected" } }) });
        socket.close();
        expect(text(harness, "status-title")).toBe("FigmaMCP isn't running");
        harness.runPendingTimers();
        expect(scopeRequests(harness)).toHaveLength(2);
    });
});

describe("no scrolling: the panel reports its height", () => {
    const resizeMessages = (harness: ReturnType<typeof createUiHarness>) =>
        harness.parentMessages.map((m) => m.pluginMessage).filter((m) => m.type === "resize-ui");

    it("posts the measured height and width 280 when the content changes", () => {
        const harness = createUiHarness(inlineScript);
        harness.elements.get("panel")!.offsetHeight = 88.4;
        harness.windowStub.onmessage(pluginVersionMessage());
        expect(resizeMessages(harness).at(-1)).toEqual({ type: "resize-ui", width: 280, height: 89 });
    });

    it("re-measures when progress appears and when it goes away", () => {
        const harness = createUiHarness(inlineScript);
        const panel = harness.elements.get("panel")!;
        panel.offsetHeight = 90;
        harness.windowStub.onmessage(pluginVersionMessage());
        panel.offsetHeight = 130; // progress block is taller
        harness.windowStub.onmessage({ data: { pluginMessage: { type: "command_progress", status: "in_progress", progress: 40, message: "Creating frames" } } });
        expect(resizeMessages(harness).at(-1)!.height).toBe(130);
        expect(text(harness, "progress-message")).toBe("Creating frames");

        harness.windowStub.onmessage({ data: { pluginMessage: { type: "command_progress", status: "completed", progress: 100, message: "Done" } } });
        panel.offsetHeight = 90; // the block is removed after a moment
        const hideTimer = [...harness.timers.values()].find((t) => t.delay === 1000)!;
        hideTimer.callback(); // fire only the hide timer: nothing else may re-measure for us // the progress block hides after a moment
        expect(harness.elements.get("progress")!.classList.has("hidden")).toBe(true);
        expect(resizeMessages(harness).at(-1)!.height).toBe(90);
    });

    it("re-measures when the read-only note appears", () => {
        const harness = createUiHarness(inlineScript);
        const panel = harness.elements.get("panel")!;
        panel.offsetHeight = 90;
        harness.windowStub.onmessage(pluginVersionMessage());
        const box = harness.elements.get("ai-can-edit")!;
        box.checked = false;
        panel.offsetHeight = 108;
        box.listeners.get("change")!({ target: box });
        expect(resizeMessages(harness).at(-1)!.height).toBe(108);
    });
});
