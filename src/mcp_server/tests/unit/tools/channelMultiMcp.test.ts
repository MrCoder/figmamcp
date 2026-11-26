import { describe, it, expect } from "bun:test";
import { registerChannelTools } from "../../../tools/channel.js";

// Local patch (multi-MCP, issue #4): channel_join forwards scopeLinks to the
// plugin's get_connect_payload, and channel_leave releases the binding.

function register(overrides: Partial<Record<string, any>> = {}) {
    const handlers: Record<string, (args: any) => Promise<any>> = {};
    const schemas: Record<string, any> = {};
    const calls: { sent: any[]; resets: number } = { sent: [], resets: 0 };
    registerChannelTools({
        registerTool(name: string, options: any, handler: (args: any) => Promise<any>) {
            handlers[name] = handler;
            schemas[name] = options.inputSchema;
        },
    } as any, {
        joinChannel: (async () => ({ serverVersion: "v", pluginVersion: "v" })) as any,
        sendCommandToFigma: (async (command: string, params: any) => {
            calls.sent.push({ command, params });
            return { allowEditNode: "page", lease: { kind: "explicit", roots: [] } };
        }) as any,
        resetChannel: (async () => { calls.resets++; }) as any,
        ...overrides,
    });
    return { handlers, schemas, calls };
}

const parse = (res: any) => res.structuredContent ?? JSON.parse(res.content[0].text);

describe("channel_join scopeLinks", () => {
    it("forwards scopeLinks to get_connect_payload and returns the lease", async () => {
        const { handlers, calls } = register();
        const res = parse(await handlers.channel_join({ channel: "ab12", scopeLinks: ["1:2"] }));
        expect(calls.sent).toEqual([{ command: "get_connect_payload", params: { scopeLinks: ["1:2"] } }]);
        expect(res.status).toBe("success");
        expect(res.lease).toEqual({ kind: "explicit", roots: [] });
    });

    it("sends no params without scopeLinks (unchanged single-session call)", async () => {
        const { handlers, calls } = register();
        await handlers.channel_join({ channel: "ab12" });
        expect(calls.sent).toEqual([{ command: "get_connect_payload", params: undefined }]);
    });

    it("rejects an empty link in the schema", () => {
        const { schemas } = register();
        expect(schemas.channel_join.safeParse({ channel: "ab12", scopeLinks: [""] }).success).toBe(false);
        expect(schemas.channel_join.safeParse({ channel: "ab12", scopeLinks: ["1:2"] }).success).toBe(true);
    });
});

describe("channel_leave", () => {
    it("resets the channel binding", async () => {
        const { handlers, calls } = register();
        const res = parse(await handlers.channel_leave({}));
        expect(res.status).toBe("success");
        expect(calls.resets).toBe(1);
    });

    it("reports a failed leave as an error, not a success", async () => {
        const { handlers } = register({ resetChannel: async () => { throw new Error("socket gone"); } });
        const res = parse(await handlers.channel_leave({}));
        expect(res.status).toBe("error");
    });
});
