import { describe, it, expect, beforeEach } from "bun:test";

// Local patch (simple model): a whole-document editable scope. Every page is
// then "in scope", so pages and the document root need their own guards. These
// tests drive the real plugin dispatcher (main.ts) against stubs; they prove
// the dispatcher's decisions, not Figma's behaviour (see LOCAL-BUILD.md for
// the live check).

const posted: any[] = [];
const pending = new Map<string, (val: any) => void>();
const nodes = new Map<string, any>();

function makeNode(id: string, name: string, type: string, parent: any) {
    const node: any = { id, name, type, parent, children: [] as any[] };
    if (parent) parent.children.push(node);
    nodes.set(id, node);
    return node;
}

const documentNode: any = { id: "0:0", name: "Doc", type: "DOCUMENT", parent: null, children: [], appendChild: () => {} };

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

const mainMod: any = await import("../../../../../figma_plugin/src/main.js?scope=documentScope");
const state = mainMod.getPluginState();
// Captured before any test clears `posted`: the plugin announces itself on load.
const versionMessage = posted.find((m) => m.type === "plugin-version");
const onMessage = fakeFigma.ui.onmessage as (msg: any) => Promise<void> | void;

let seq = 0;
async function send(command: string, params: any) {
    const id = `req-${++seq}`;
    const result = new Promise<any>((resolve) => pending.set(id, resolve));
    await onMessage({ type: "execute-command", command, id, params });
    return await result;
}

const errorText = (res: any) => String(res?.error?.message ?? res?.error ?? "");

let pageA: any, pageB: any, frameA: any, frameB: any;

function setup() {
    nodes.clear();
    posted.length = 0;
    documentNode.children = [];
    nodes.set("0:0", documentNode);
    pageA = makeNode("1:1", "20 · Approved", "PAGE", documentNode);
    pageB = makeNode("2:1", "30 · Explore", "PAGE", documentNode);
    for (const page of [pageA, pageB]) {
        page.loadAsync = async () => {};
        page.appendChild = (child: any) => { child.parent = page; page.children.push(child); };
    }
    frameA = makeNode("1:10", "Screen A", "FRAME", pageA);
    frameB = makeNode("2:10", "Screen B", "FRAME", pageB);

    // Whole-document scope, as set-scope commits it.
    state.allowEditNode = "document";
    state.scopeRootId = documentNode.id;
    state.additionalScopeRootIds = [];
    state.allowEditVariable = true;
    state.allowEditStyle = true;
    state.leases.clear();
}

describe("document scope: pages and the document root are guarded", () => {
    beforeEach(() => { (globalThis as any).figma = fakeFigma; setup(); });

    it("refuses node_delete on a page and leaves it in place", async () => {
        let removed = false;
        pageB.remove = () => { removed = true; };
        const res = await send("node_delete", { nodes: [{ nodeId: pageB.id, nodeName: pageB.name }] });
        expect(res.type).toBe("command-error");
        expect(errorText(res)).toContain("is a page");
        expect(removed).toBe(false);
    });

    it("still deletes a frame on any page", async () => {
        let removed = false;
        frameB.remove = () => { removed = true; };
        const res = await send("node_delete", { nodes: [{ nodeId: frameB.id, nodeName: frameB.name }] });
        expect(res.type).toBe("command-result");
        expect(removed).toBe(true);
    });

    it("refuses node_flatten and node_ungroup on a page", async () => {
        for (const command of ["node_flatten", "node_ungroup"]) {
            const res = await send(command, { nodeId: pageA.id, nodeName: pageA.name });
            expect(res.type).toBe("command-error");
            expect(errorText(res)).toContain("is a page");
        }
    });

    it("refuses node_clone into the document root", async () => {
        let cloned = false;
        frameA.clone = () => { cloned = true; return { ...frameA, id: "9:9" }; };
        const res = await send("node_clone", {
            nodeId: frameA.id, nodeName: frameA.name, parentId: documentNode.id, parentNodeName: documentNode.name,
        });
        expect(res.type).toBe("command-error");
        expect(errorText(res)).toContain("document root cannot be a destination parent");
        expect(cloned).toBe(false);
    });

    it("refuses node_clone of a page (its default parent is the document root)", async () => {
        let cloned = false;
        pageA.clone = () => { cloned = true; return { ...pageA, id: "9:8" }; };
        const res = await send("node_clone", { nodeId: pageA.id, nodeName: pageA.name });
        expect(res.type).toBe("command-error");
        expect(cloned).toBe(false);
    });

    it("refuses create_frame with the document root as parent", async () => {
        const res = await send("create_frame", {
            parentId: documentNode.id, parentNodeName: documentNode.name, x: 0, y: 0, width: 10, height: 10, name: "F",
        });
        expect(res.type).toBe("command-error");
        expect(errorText(res)).toContain("document root cannot be a destination parent");
    });

    it("refuses node_insert_child that would move a page", async () => {
        const res = await send("node_insert_child", {
            parentId: frameA.id, parentNodeName: frameA.name, childId: pageB.id, childNodeName: pageB.name,
        });
        expect(res.type).toBe("command-error");
        expect(errorText(res)).toContain("is a page");
    });
});

describe("simple panel: window size", () => {
    it("resizes the window to a bounded height on request", async () => {
        const sizes: any[] = [];
        fakeFigma.ui.resize = (w: number, h: number) => sizes.push([w, h]);
        await onMessage({ type: "resize-ui", height: 130.2 });
        await onMessage({ type: "resize-ui", height: 99999 });
        await onMessage({ type: "resize-ui", height: 1 });
        await onMessage({ type: "resize-ui", height: "tall" });
        expect(sizes).toEqual([[280, 131], [280, 600], [280, 24]]);
    });

    it("shrinks to the pill width and moves to the bottom-right corner when anchored", async () => {
        const sizes: any[] = [];
        const moves: any[] = [];
        fakeFigma.ui.resize = (w: number, h: number) => sizes.push([w, h]);
        fakeFigma.ui.reposition = (x: number, y: number) => moves.push([x, y]);
        fakeFigma.viewport = { bounds: { x: 0, y: 0, width: 1000, height: 800 }, zoom: 1 };
        await onMessage({ type: "resize-ui", width: 140, height: 28, anchor: "bottom-right" });
        await onMessage({ type: "resize-ui", width: 280, height: 120 });
        expect(sizes).toEqual([[140, 28], [280, 120]]);
        expect(moves).toEqual([[1000 - 156, 800 - 44]]);
    });
});

describe("document scope: set-scope, join payload, node_info default", () => {
    beforeEach(() => { (globalThis as any).figma = fakeFigma; setup(); });

    it("tells the UI the document root id, so an empty link can mean the whole file", () => {
        expect(versionMessage?.rootId).toBe(documentNode.id);
    });

    it("commits a whole-document scope when the UI sends the document root", async () => {
        state.allowEditNode = false;
        state.scopeRootId = null;
        await onMessage({
            type: "set-scope", requestId: "r1", scopeNodeId: documentNode.id, scopeNodeType: "DOCUMENT",
            additionalScopeLinks: ["https://www.figma.com/design/abc/File?node-id=2-1"],
            allowEditVariable: true, allowEditStyle: true,
        });
        expect(state.allowEditNode).toBe("document");
        expect(state.scopeRootId).toBe(documentNode.id);
        expect(state.additionalScopeRootIds).toEqual([]);
        expect(posted.some((m) => m.type === "scope-ready" && m.requestId === "r1")).toBe(true);
    });

    it("does not treat a non-root DOCUMENT claim as a document scope", async () => {
        state.allowEditNode = false;
        state.scopeRootId = null;
        await onMessage({ type: "set-scope", requestId: "r2", scopeNodeId: frameA.id, scopeNodeType: "DOCUMENT" });
        expect(state.allowEditNode).toBe("node");
    });

    it("reports editableScopeType document and lists pages without children", async () => {
        // getConnectPayload reads the state of the un-suffixed main.js module
        // instance (connectHandlers imports it directly), so set that one.
        const plain: any = await import("../../../../../figma_plugin/src/main.js");
        const { getConnectPayload } = await import("../../../../../figma_plugin/handlers/connectHandlers.js");
        const plainState = plain.getPluginState();
        const saved = { allowEditNode: plainState.allowEditNode, scopeRootId: plainState.scopeRootId };
        try {
            plainState.allowEditNode = "document";
            plainState.scopeRootId = documentNode.id;
            const payload: any = await getConnectPayload();
            expect(payload.editableScopeType).toBe("document");
            expect(payload.pages).toEqual([
                { pageId: pageA.id, pageName: pageA.name },
                { pageId: pageB.id, pageName: pageB.name },
            ]);
        } finally {
            Object.assign(plainState, saved);
        }
    });

    it("node_info with no ids lists each page and its top-level layers, not the whole document", async () => {
        const deep = makeNode("1:11", "Deep child", "FRAME", frameA);
        const res = await send("node_info", { properties: ["name"] });
        expect(res.type).toBe("command-result");
        const ids = JSON.stringify(res.result);
        expect(ids).toContain(pageA.id);
        expect(ids).toContain(pageB.id);
        expect(ids).toContain(frameA.id);
        expect(ids).not.toContain(deep.id);
    });

    it("lets a session write on every page", async () => {
        for (const frame of [frameA, frameB]) {
            const res = await send("node_rename", { nodeId: frame.id, nodeName: frame.name, name: frame.name + " ✓" });
            expect(res.type).toBe("command-result");
        }
        expect(frameA.name).toBe("Screen A ✓");
        expect(frameB.name).toBe("Screen B ✓");
    });
});
