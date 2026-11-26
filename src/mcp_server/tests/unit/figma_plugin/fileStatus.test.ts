import { describe, it, expect, afterAll } from "bun:test";

// Local patch (simple model): the plugin reports file renames and activity to the UI. These tests drive
// the real main.ts against stubs, so they prove the plugin's own logic, not that Figma fires these events.

const posted: any[] = [];
const handlers = new Map<string, () => void>();
const documentNode: any = { id: "0:0", name: "Before", type: "DOCUMENT", parent: null, children: [] };
const fakeFigma: any = {
    showUI: () => {},
    ui: { postMessage: (msg: any) => posted.push(msg) },
    on: (event: string, fn: () => void) => handlers.set(event, fn),
    notify: () => {},
    closePlugin: () => {},
    clientStorage: { setAsync: async () => {} },
    root: documentNode,
    mixed: Symbol("mixed"),
};
(globalThis as any).__html__ = "<html></html>";
(globalThis as any).figma = fakeFigma;
await import("../../../../../figma_plugin/src/main.js?scope=fileStatus");
const onMessage = fakeFigma.ui.onmessage as (msg: any) => Promise<void> | void;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterAll(async () => { await onMessage({ type: "watch-file-name", on: false }); });

describe("file status reports", () => {
    it("reports a rename only while the UI has asked to watch, including one made before watching started", async () => {
        documentNode.name = "Renamed";
        await wait(2200);
        expect(posted.filter((m) => m.type === "file-name")).toEqual([]);
        await onMessage({ type: "watch-file-name", on: true });
        await wait(2200);
        expect(posted.filter((m) => m.type === "file-name")).toEqual([{ type: "file-name", fileName: "Renamed" }]);
        await onMessage({ type: "watch-file-name", on: false });
        documentNode.name = "Again";
        await wait(2200);
        expect(posted.filter((m) => m.type === "file-name").length).toBe(1);
    }, 10000);

    it("reports activity on selection and page changes", () => {
        posted.length = 0;
        handlers.get("selectionchange")!();
        handlers.get("currentpagechange")!();
        expect(posted).toEqual([{ type: "file-active" }, { type: "file-active" }]);
    });
});
