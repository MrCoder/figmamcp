import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveDefaultPort } from "../../../cli.js";

const home = () => mkdtempSync(join(tmpdir(), "figmamcp-port-"));

describe("default relay port", () => {
    it("is 3155 with no config", () => {
        expect(resolveDefaultPort(home())).toBe(3155);
    });
    it("comes from the config setup wrote", () => {
        const h = home();
        mkdirSync(join(h, ".figmamcp"));
        writeFileSync(join(h, ".figmamcp/config.json"), '{"port":3157}');
        expect(resolveDefaultPort(h)).toBe(3157);
    });
    it("ignores a broken config", () => {
        const h = home();
        mkdirSync(join(h, ".figmamcp"));
        writeFileSync(join(h, ".figmamcp/config.json"), "{oops");
        expect(resolveDefaultPort(h)).toBe(3155);
    });
});
