import { describe, it, expect } from "bun:test";
import { createServer } from "node:net";
// @ts-expect-error plain .mjs script shared with CI smoke tests, no type declarations
import { getFreePort } from "../../../scripts/free-port.mjs";

/**
 * Regression guard for `EADDRINUSE 127.0.0.1:13055` in CI: both node-smoke
 * matrix legs ran on one VM with a hard-coded port. Each concurrent caller
 * must get its own port, and that port must really be bindable.
 */
describe("getFreePort", () => {
    it("gives concurrent callers different ports", async () => {
        const ports: number[] = await Promise.all(Array.from({ length: 8 }, () => getFreePort()));
        expect(new Set(ports).size).toBe(ports.length);
    });

    it("returns a port that can be bound right away", async () => {
        const port: number = await getFreePort();
        await new Promise<void>((resolve, reject) => {
            const s = createServer();
            s.once("error", reject);
            s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
        });
    });

    it("does not hand out a port that is already in use", async () => {
        const held = createServer();
        await new Promise<void>((r) => held.listen(0, "127.0.0.1", () => r()));
        const heldPort = (held.address() as { port: number }).port;
        try {
            const ports: number[] = await Promise.all(Array.from({ length: 8 }, () => getFreePort()));
            expect(ports).not.toContain(heldPort);
        } finally {
            held.close();
        }
    });
});
