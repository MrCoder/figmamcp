import { afterEach, describe, expect, it } from "bun:test";
import { getPagesInfo } from "../../../../../figma_plugin/handlers/nodeReaders.js";

const original = (globalThis as any).figma;
afterEach(() => { (globalThis as any).figma = original; });

describe("page_info reports where the user is looking", () => {
    it("names the current page and the selected layers", async () => {
        const pageA = { id: "1:1", name: "A" };
        const pageB = { id: "2:1", name: "B" };
        (globalThis as any).figma = {
            root: { id: "0:0", name: "Doc", children: [pageA, pageB] },
            currentPage: { ...pageB, selection: [{ id: "2:5", name: "Card", type: "FRAME" }] },
        };
        const result: any = await getPagesInfo({});
        expect(result.currentPage).toEqual({ pageId: "2:1", pageName: "B" });
        expect(result.selection).toEqual([{ id: "2:5", name: "Card", type: "FRAME" }]);
    });
});
