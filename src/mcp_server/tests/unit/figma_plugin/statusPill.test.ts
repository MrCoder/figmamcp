import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { bottomRightPosition } from "../../../../../figma_plugin/utils/panelPlacement";

const ui = readFileSync("figma_plugin/ui.html", "utf8");

// The reducer lives in ui.html between markers so the panel stays one file;
// load just that block and run it.
function loadReducer(): (mode: string, event: string, userOpened: boolean) => string {
    const start = ui.indexOf("// PANEL-MODE-START");
    const end = ui.indexOf("// PANEL-MODE-END");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function(ui.slice(start, end) + "\nreturn nextPanelMode;")();
}

describe("status pill: when the panel collapses and expands", () => {
    const next = loadReducer();

    it.each([
        // mode,   event,             userOpened, expected
        ["full", "connected-settled", false, "pill"], // auto-collapse after connecting
        ["full", "connected-settled", true, "full"], // user opened it: stay open
        ["pill", "problem", false, "full"], // unreachable or error: expand by itself
        ["pill", "progress-error", false, "full"], // a failed command: expand by itself
        ["pill", "pill-click", false, "full"],
        ["full", "collapse-click", true, "pill"],
        ["pill", "progress", false, "pill"], // work in progress stays in the pill
    ])("%s + %s (userOpened=%s) -> %s", (mode, event, userOpened, expected) => {
        expect(next(mode as string, event as string, userOpened as boolean)).toBe(expected);
    });
});

describe("status pill: it still shows the status", () => {
    it("has a pill with its own status dot and text", () => {
        expect(ui).toContain('id="pill"');
        expect(ui).toContain('id="pill-dot"');
        expect(ui).toContain('id="pill-text"');
    });

    it("has a collapse control on the full panel", () => {
        expect(ui).toContain('id="btn-collapse"');
    });
});

describe("status pill: placement in the bottom-right corner of the viewport", () => {
    it("converts the window size from screen pixels to canvas units", () => {
        // Viewport 1000x500 canvas units at zoom 2: a 150x32 px window with a 16 px margin.
        const p = bottomRightPosition({ x: 100, y: 200, width: 1000, height: 500 }, 2, 150, 32);
        expect(p).toEqual({ x: 100 + 1000 - (150 + 16) / 2, y: 200 + 500 - (32 + 16) / 2 });
    });

    it("never places the window left of or above the viewport", () => {
        const p = bottomRightPosition({ x: 0, y: 0, width: 50, height: 20 }, 1, 280, 200);
        expect(p).toEqual({ x: 0, y: 0 });
    });
});
