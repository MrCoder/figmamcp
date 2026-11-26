import { describe, it, expect } from "bun:test";
import { findResourceRoot } from "../../../../setup/resourceRoot.js";

describe("findResourceRoot", () => {
    it("uses the program's folder inside the app, where resources sit beside it", () => {
        const bin = "/Applications/FigmaMCP.app/Contents/Resources/bin";
        expect(findResourceRoot(bin, (f) => f === `${bin}/package.json`)).toBe(bin);
    });

    it("uses the parent folder in ~/.figmamcp, where programs live in bin/", () => {
        const root = "/home/.figmamcp/versions/0.1.0";
        expect(findResourceRoot(`${root}/bin`, (f) => f === `${root}/package.json`)).toBe(root);
    });

    it("keeps the program's folder when neither has resources, so the error names it", () => {
        expect(findResourceRoot("/tmp/x/bin", () => false)).toBe("/tmp/x/bin");
    });
});
