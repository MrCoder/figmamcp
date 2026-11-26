import { describe, it, expect, beforeEach } from "bun:test";

// Local patch: cross-page node_clone + additional editable scope roots.
//
// These tests drive the real plugin dispatcher (main.ts) and the real
// cloneNode handler against stubs. Per CONTRIBUTING § Tests, stubs cannot
// establish Figma's behaviour: whether appendChild into another page needs
// loadAsync() first, and where clone() lands before the move, are host facts
// and are checked by the live verification recorded in LOCAL-BUILD.md, not here.

import { registerAllTools } from "../../../tools/index.js";

const events: string[] = [];
const posted: any[] = [];
const pending = new Map<string, (val: any) => void>();
const nodes = new Map<string, any>();
let cloneCalls = 0;

function makeContainer(id: string, name: string, type: string, parent: any) {
    const node: any = {
        id, name, type, parent, children: [] as any[],
        appendChild(child: any) {
            events.push(`append:${id}`);
            if (child.parent && Array.isArray(child.parent.children)) {
                child.parent.children = child.parent.children.filter((c: any) => c !== child);
            }
            child.parent = node;
            node.children.push(child);
        },
    };
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
};

(globalThis as any).__html__ = "<html></html>";
(globalThis as any).figma = fakeFigma;

const mainMod: any = await import("../../../../../figma_plugin/src/main.js?scope=nodeCloneCrossPage");
const state = mainMod.getPluginState();
const onMessage = fakeFigma.ui.onmessage as (msg: any) => Promise<void> | void;

async function send(command: string, params: any) {
    const id = Math.random().toString();
    const result = new Promise<any>((resolve) => pending.set(id, resolve));
    await onMessage({ type: "execute-command", command, id, params });
    return await result;
}

let pageA: any, pageB: any, pageC: any, source: any, holderB: any, frameC: any;

function setup() {
    nodes.clear();
    events.length = 0;
    posted.length = 0;
    cloneCalls = 0;
    documentNode.children = [];
    nodes.set("0:0", documentNode);

    pageA = makeContainer("1:1", "20 · Approved", "PAGE", documentNode);
    pageB = makeContainer("2:1", "30 · Explore", "PAGE", documentNode);
    pageC = makeContainer("3:1", "99 · Archive", "PAGE", documentNode);
    for (const page of [pageA, pageB, pageC]) {
        page.loadAsync = async () => { events.push(`load:${page.id}`); };
    }
    holderB = makeContainer("2:5", "Holder", "FRAME", pageB);
    frameC = makeContainer("3:5", "Archived", "FRAME", pageC);

    source = makeContainer("1:10", "Design", "FRAME", pageA);
    source.x = 10;
    source.y = 20;
    source.clone = () => {
        cloneCalls++;
        events.push("clone");
        // Stub assumption: the copy first lands on the source's page; the
        // handler must move it with an explicit appendChild either way.
        const copy: any = { id: "9:99", name: "Design", type: "FRAME", parent: pageA, x: 10, y: 20, width: 100, height: 50 };
        pageA.children.push(copy);
        nodes.set(copy.id, copy);
        return copy;
    };

    // Primary scope: page A only.
    state.allowEditNode = "page";
    state.scopeRootId = pageA.id;
    state.additionalScopeRootIds = [];
}

describe("node_clone: same page (unchanged behaviour)", () => {
    beforeEach(() => { (globalThis as any).figma = fakeFigma; setup(); });

    it("without parentId the copy goes into the source's parent and no page is loaded", async () => {
        const res = await send("node_clone", { nodeId: source.id, nodeName: "Design", x: 300, y: 40 });
        expect(res.type).toBe("command-result");
        expect(res.result.parentId).toBe(pageA.id);
        expect(res.result.x).toBe(300);
        expect(res.result.y).toBe(40);
        expect(events).toEqual(["clone", `append:${pageA.id}`]);
    });
});

describe("node_clone: cross-page placement", () => {
    beforeEach(() => {
        (globalThis as any).figma = fakeFigma;
        setup();
        state.additionalScopeRootIds = [pageB.id];
    });

    it("places the copy into another page, loading that page before the append", async () => {
        const res = await send("node_clone", {
            nodeId: source.id, nodeName: "Design",
            parentId: pageB.id, parentNodeName: "30 · Explore",
            x: 500, y: 60,
        });
        expect(res.type).toBe("command-result");
        expect(res.result.parentId).toBe(pageB.id);
        expect(res.result.x).toBe(500);
        expect(res.result.y).toBe(60);
        expect(events).toEqual([`load:${pageB.id}`, "clone", `append:${pageB.id}`]);
        expect(pageB.children.map((c: any) => c.id)).toContain("9:99");
        expect(pageA.children.map((c: any) => c.id)).not.toContain("9:99");
    });

    it("places the copy into a frame on another page, loading that frame's page", async () => {
        const res = await send("node_clone", {
            nodeId: source.id, nodeName: "Design",
            parentId: holderB.id, parentNodeName: "Holder",
        });
        expect(res.type).toBe("command-result");
        expect(res.result.parentId).toBe(holderB.id);
        expect(events).toEqual([`load:${pageB.id}`, "clone", `append:${holderB.id}`]);
    });

    it("rejects a target outside every editable root, before cloning", async () => {
        const res = await send("node_clone", {
            nodeId: source.id, nodeName: "Design",
            parentId: frameC.id, parentNodeName: "Archived",
        });
        expect(res.type).toBe("command-error");
        expect(String(res.error.message)).toContain("outside");
        expect(cloneCalls).toBe(0);
        expect(events).toEqual([]);
    });

    it("rejects another page when it is not linked as an additional root", async () => {
        state.additionalScopeRootIds = [];
        const res = await send("node_clone", {
            nodeId: source.id, nodeName: "Design",
            parentId: pageB.id, parentNodeName: "30 · Explore",
        });
        expect(res.type).toBe("command-error");
        expect(cloneCalls).toBe(0);
    });

    it("rejects a wrong destination name, before cloning", async () => {
        const res = await send("node_clone", {
            nodeId: source.id, nodeName: "Design",
            parentId: pageB.id, parentNodeName: "30 · Explore (old)",
        });
        expect(res.type).toBe("command-error");
        expect(cloneCalls).toBe(0);
    });

    it("rejects a missing destination name, before cloning", async () => {
        const res = await send("node_clone", { nodeId: source.id, nodeName: "Design", parentId: pageB.id });
        expect(res.type).toBe("command-error");
        expect(cloneCalls).toBe(0);
    });

    it("rejects a locked destination, before cloning", async () => {
        holderB.locked = true;
        const res = await send("node_clone", {
            nodeId: source.id, nodeName: "Design",
            parentId: holderB.id, parentNodeName: "Holder",
        });
        expect(res.type).toBe("command-error");
        expect(cloneCalls).toBe(0);
    });

    it("lets node_delete remove the copy under the additional root (cleanup path)", async () => {
        const copy: any = { id: "2:77", name: "Design B", type: "FRAME", parent: pageB, remove() { events.push("remove:2:77"); copy.removed = true; } };
        pageB.children.push(copy);
        nodes.set(copy.id, copy);
        const res = await send("node_delete", { nodes: [{ nodeId: copy.id, nodeName: "Design B" }] });
        expect(res.type).toBe("command-result");
        expect(events).toContain("remove:2:77");
    });

    it("refuses to delete an additional root itself", async () => {
        pageB.remove = () => { events.push("remove:page"); };
        const res = await send("node_delete", { nodes: [{ nodeId: pageB.id, nodeName: "30 · Explore" }] });
        expect(res.type).toBe("command-error");
        expect(events).not.toContain("remove:page");
    });
});

describe("set-scope: additional editable roots", () => {
    beforeEach(() => { (globalThis as any).figma = fakeFigma; setup(); });

    const link = (id: string) => `https://www.figma.com/design/abc/File?node-id=${id.replace(":", "-")}`;

    async function setScope(msg: any) {
        await onMessage({ type: "set-scope", requestId: "r1", ...msg });
        return posted.filter((m) => m.requestId === "r1");
    }

    it("commits valid extra roots alongside the primary root", async () => {
        const out = await setScope({ scopeNodeId: pageA.id, scopeNodeType: "PAGE", additionalScopeLinks: [link(pageB.id)] });
        expect(out.map((m) => m.type)).toEqual(["scope-ready"]);
        expect(state.scopeRootId).toBe(pageA.id);
        expect(state.additionalScopeRootIds).toEqual([pageB.id]);
    });

    it("refuses the whole connection on an unresolvable link and leaves state untouched", async () => {
        const out = await setScope({ scopeNodeId: pageA.id, scopeNodeType: "PAGE", additionalScopeLinks: [link("42:42")] });
        expect(out.map((m) => m.type)).toEqual(["scope-rejected"]);
        expect(state.additionalScopeRootIds).toEqual([]);
    });

    it("refuses the document root as an extra root", async () => {
        const out = await setScope({ scopeNodeId: pageA.id, scopeNodeType: "PAGE", additionalScopeLinks: [link("0:0")] });
        expect(out.map((m) => m.type)).toEqual(["scope-rejected"]);
    });

    it("refuses extra roots without a primary root (read-only stays read-only)", async () => {
        const out = await setScope({ scopeNodeId: null, additionalScopeLinks: [link(pageB.id)] });
        expect(out.map((m) => m.type)).toEqual(["scope-rejected"]);
    });

    it("clears extra roots on a later single-link connection", async () => {
        state.additionalScopeRootIds = [pageB.id];
        const out = await setScope({ scopeNodeId: pageA.id, scopeNodeType: "PAGE" });
        expect(out.map((m) => m.type)).toEqual(["scope-ready"]);
        expect(state.additionalScopeRootIds).toEqual([]);
    });
});

describe("node_clone input schema", () => {
    const INPUTS: Record<string, any> = {};
    registerAllTools({
        registerTool: (name: string, config: any) => { INPUTS[name] = config?.inputSchema; },
        tool: () => {}, prompt: () => {}, registerPrompt: () => {},
        registerResource: () => {}, resource: () => {},
    } as any);

    it("accepts the original shape and the parentId + parentNodeName pair", () => {
        expect(INPUTS.node_clone.safeParse({ nodeId: "1:10", nodeName: "Design" }).success).toBe(true);
        expect(INPUTS.node_clone.safeParse({ nodeId: "1:10", nodeName: "Design", parentId: "2:1", parentNodeName: "30 · Explore" }).success).toBe(true);
    });

    it("rejects parentId without parentNodeName, and the reverse", () => {
        expect(INPUTS.node_clone.safeParse({ nodeId: "1:10", nodeName: "Design", parentId: "2:1" }).success).toBe(false);
        expect(INPUTS.node_clone.safeParse({ nodeId: "1:10", nodeName: "Design", parentNodeName: "30 · Explore" }).success).toBe(false);
    });
});
