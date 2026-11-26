import { describe, it, expect, beforeEach } from "bun:test";

// Local patch (multi-MCP, issue #4): per-session leases inside the scope the
// user set in the plugin. These tests drive the real plugin dispatcher
// (main.ts) against stubs. The relay side (peer stamping, routing) is covered
// by socketMultiPeer.test.ts; whether Figma behaves the same live is checked
// by the live verification recorded in LOCAL-BUILD.md.

const posted: any[] = [];
const pending = new Map<string, (val: any) => void>();
const nodes = new Map<string, any>();

function makeNode(id: string, name: string, type: string, parent: any) {
    const node: any = { id, name, type, parent, children: [] as any[] };
    if (parent) parent.children.push(node);
    nodes.set(id, node);
    return node;
}

const documentNode: any = { id: "0:0", name: "Doc", type: "DOCUMENT", parent: null, children: [] };

const fakeFigma: any = {
    showUI: () => {},
    ui: {
        postMessage: (msg: any) => {
            posted.push(msg);
            const resolver = pending.get(msg.id);
            if (resolver) {
                resolver(msg);
                pending.delete(msg.id);
            }
        },
    },
    on: () => {},
    notify: () => {},
    closePlugin: () => {},
    clientStorage: { setAsync: async () => {} },
    getNodeByIdAsync: async (id: string) => nodes.get(id) || null,
    root: documentNode,
    mixed: Symbol("mixed"),
    variables: {
        getLocalVariableCollectionsAsync: async () => [],
        getLocalVariablesAsync: async () => [],
    },
};

(globalThis as any).__html__ = "<html></html>";
(globalThis as any).figma = fakeFigma;

const mainMod: any = await import("../../../../../figma_plugin/src/main.js?scope=multiMcpLeases");
const state = mainMod.getPluginState();
// getConnectPayload reads the state of the un-queried main module, which other
// test files in the same process leave scoped to nodes that do not exist here.
const plainMod: any = await import("../../../../../figma_plugin/src/main.js");
const plainState = plainMod.getPluginState();
const onMessage = fakeFigma.ui.onmessage as (msg: any) => Promise<void> | void;

let seq = 0;
async function send(peerId: string | null, command: string, params: any) {
    const id = `req-${++seq}`;
    const result = new Promise<any>((resolve) => pending.set(id, resolve));
    await onMessage({ type: "execute-command", command, id, params, ...(peerId ? { peerId } : {}) });
    return await result;
}

const join = (peerId: string | null, scopeLinks?: string[]) =>
    send(peerId, "get_connect_payload", scopeLinks ? { scopeLinks } : undefined);

const rename = (peerId: string | null, node: any, name: string) =>
    send(peerId, "node_rename", { nodeId: node.id, nodeName: node.name, name });

async function peerLeft(peerId: string) {
    await onMessage({ type: "peer-left", peerId });
    await state.commandQueue;
}

const link = (id: string) => `https://www.figma.com/design/abc/File?node-id=${id.replace(":", "-")}`;
const code = (res: any) => res?.error?.code;

let pageA: any, pageB: any, pageC: any, frameA: any, frameA2: any, frameB: any, frameC: any;

function setup() {
    nodes.clear();
    posted.length = 0;
    documentNode.children = [];
    nodes.set("0:0", documentNode);
    pageA = makeNode("1:1", "20 · Approved", "PAGE", documentNode);
    pageB = makeNode("2:1", "30 · Explore", "PAGE", documentNode);
    pageC = makeNode("3:1", "99 · Archive", "PAGE", documentNode);
    for (const page of [pageA, pageB, pageC]) page.loadAsync = async () => {};
    frameA = makeNode("1:10", "Screen A", "FRAME", pageA);
    frameA2 = makeNode("1:20", "Screen A2", "FRAME", pageA);
    frameB = makeNode("2:10", "Screen B", "FRAME", pageB);
    frameC = makeNode("3:10", "Screen C", "FRAME", pageC);

    // The ceiling the user set in the plugin UI: page A + page B.
    state.allowEditNode = "page";
    state.scopeRootId = pageA.id;
    state.additionalScopeRootIds = [pageB.id];
    state.allowEditVariable = true;
    state.allowEditStyle = true;
    state.leases.clear();
    plainState.allowEditNode = false;
    plainState.scopeRootId = null;
}

describe("multi-MCP leases: connect", () => {
    beforeEach(() => { (globalThis as any).figma = fakeFigma; setup(); });

    it("an unstamped join (old relay) takes no lease and reports none", async () => {
        const res = await join(null);
        expect(res.type).toBe("command-result");
        expect(res.result.lease).toBeUndefined();
        expect(state.leases.size).toBe(0);
    });

    it("gives two sessions disjoint explicit leases and reports each lease", async () => {
        const a = await join("peer-a", [link(pageA.id)]);
        const b = await join("peer-b", [frameB.id]);
        expect(a.result.lease).toEqual({ kind: "explicit", roots: [{ nodeId: pageA.id, nodeName: "20 · Approved", type: "PAGE" }] });
        expect(b.result.lease).toEqual({ kind: "explicit", roots: [{ nodeId: frameB.id, nodeName: "Screen B", type: "FRAME" }] });
    });

    it("refuses a lease that overlaps another session's lease, in both directions", async () => {
        await join("peer-a", [link(pageA.id)]);
        const inside = await join("peer-b", [frameA.id]);
        expect(inside.result.errorCode).toBe("LEASED_BY_OTHER_SESSION");
        expect(state.leases.has("peer-b")).toBe(false);

        await join("peer-c", [frameB.id]);
        const around = await join("peer-d", [pageB.id]);
        expect(around.result.errorCode).toBe("LEASED_BY_OTHER_SESSION");
    });

    it("refuses a lease outside the ceiling, an unparsable link, and the document root", async () => {
        expect((await join("peer-a", [frameC.id])).result.errorCode).toBe("SCOPE_LEASE_REFUSED");
        expect((await join("peer-a", ["not a link"])).result.errorCode).toBe("SCOPE_LEASE_REFUSED");
        expect((await join("peer-a", ["0:0"])).result.errorCode).toBe("SCOPE_LEASE_REFUSED");
        expect(state.leases.size).toBe(0);
    });

    // Intentional contract change (simple model): sessions without scopeLinks
    // share write access; the second one no longer gets readOnly.
    it("gives every session without scopeLinks the shared implicit lease", async () => {
        expect((await join("peer-a")).result.lease.kind).toBe("implicit");
        expect((await join("peer-b")).result.lease.kind).toBe("implicit");
    });

    it("refuses scopeLinks when the plugin is connected read-only", async () => {
        state.allowEditNode = false;
        state.scopeRootId = null;
        state.additionalScopeRootIds = [];
        expect((await join("peer-a", [frameA.id])).result.errorCode).toBe("SCOPE_LEASE_REFUSED");
    });
});

describe("multi-MCP leases: node writes", () => {
    beforeEach(async () => {
        (globalThis as any).figma = fakeFigma;
        setup();
        await join("peer-a", [pageA.id]);
        await join("peer-b", [frameB.id]);
    });

    it("lets each session write inside its own lease", async () => {
        expect((await rename("peer-a", frameA, "A renamed")).type).toBe("command-result");
        expect((await rename("peer-b", frameB, "B renamed")).type).toBe("command-result");
        expect(frameA.name).toBe("A renamed");
        expect(frameB.name).toBe("B renamed");
    });

    it("refuses a write into another session's lease with LEASED_BY_OTHER_SESSION and changes nothing", async () => {
        const res = await rename("peer-b", frameA, "hijack");
        expect(res.type).toBe("command-error");
        expect(code(res)).toBe("LEASED_BY_OTHER_SESSION");
        expect(res.error.details).toEqual({ nodeId: frameA.id, leaseRootId: pageA.id });
        expect(frameA.name).toBe("Screen A");
    });

    it("refuses an explicit holder's write outside its lease but inside the ceiling", async () => {
        const free = makeNode("2:20", "Free B", "FRAME", pageB);
        const res = await rename("peer-b", free, "x");
        expect(res.type).toBe("command-error");
        expect(free.name).toBe("Free B");
    });

    it("lets the implicit holder write unleased areas but not leased ones", async () => {
        await join("peer-c");
        const free = makeNode("2:20", "Free B", "FRAME", pageB);
        expect((await rename("peer-c", free, "C wrote")).type).toBe("command-result");
        const res = await rename("peer-c", frameB, "x");
        expect(code(res)).toBe("LEASED_BY_OTHER_SESSION");
        expect(frameB.name).toBe("Screen B");
    });

    it("lets two sessions without scopeLinks both write unleased areas, and refuses a stamped session with no lease", async () => {
        await join("peer-c");
        await join("peer-d");
        const free = makeNode("2:20", "Free B", "FRAME", pageB);
        expect((await rename("peer-c", free, "C wrote")).type).toBe("command-result");
        expect((await rename("peer-d", free, "D wrote")).type).toBe("command-result");
        expect(free.name).toBe("D wrote");
        expect(code(await rename("peer-d", frameB, "x"))).toBe("LEASED_BY_OTHER_SESSION");
        expect((await rename("peer-unknown", free, "x")).type).toBe("command-error");
        expect(free.name).toBe("D wrote");
    });

    it("keeps unstamped commands on the single-session rules", async () => {
        expect((await rename(null, frameB, "old relay")).type).toBe("command-result");
    });

    it("frees a lease when its session leaves, so another session can take that area", async () => {
        expect((await join("peer-c", [frameA2.id])).result.errorCode).toBe("LEASED_BY_OTHER_SESSION");
        await peerLeft("peer-a");
        expect(state.leases.has("peer-a")).toBe(false);
        expect((await join("peer-c", [frameA2.id])).result.lease.kind).toBe("explicit");
        expect((await rename("peer-c", frameA2, "C owns it")).type).toBe("command-result");
    });

    it("drops every lease when the user reconnects the plugin with a new scope", async () => {
        await onMessage({ type: "set-scope", requestId: "r1", scopeNodeId: pageA.id, scopeNodeType: "PAGE" });
        expect(state.leases.size).toBe(0);
    });

    it("refuses deleting a lease root, even by the session that holds it", async () => {
        let removed = false;
        frameB.remove = () => { removed = true; };
        const res = await send("peer-b", "node_delete", { nodes: [{ nodeId: frameB.id, nodeName: "Screen B" }] });
        expect(res.type).toBe("command-error");
        expect(removed).toBe(false);
    });
});

describe("multi-MCP leases: variables and styles are document-wide", () => {
    beforeEach(async () => {
        (globalThis as any).figma = fakeFigma;
        setup();
        await join("peer-a", [pageA.id]);
        await join("peer-b");
    });

    it("refuses variable and style writes from an explicit holder while others are connected", async () => {
        for (const command of ["variable_manage", "variable_delete", "style_manage", "style_delete"]) {
            const res = await send("peer-a", command, {});
            expect(code(res)).toBe("DOCUMENT_WIDE_WRITE_LOCKED");
        }
    });

    it("lets the implicit holder past the gate", async () => {
        const res = await send("peer-b", "variable_manage", {});
        expect(code(res)).not.toBe("DOCUMENT_WIDE_WRITE_LOCKED");
    });

    it("lets a lone explicit holder past the gate once the others leave", async () => {
        await peerLeft("peer-b");
        const res = await send("peer-a", "variable_manage", {});
        expect(code(res)).not.toBe("DOCUMENT_WIDE_WRITE_LOCKED");
    });
});
