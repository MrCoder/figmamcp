import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
    registerChannelTools,
    createAutoBinder,
    fileKeyFromLink,
    resetRememberedJoin,
    setIdentityProvider,
} from "../../../tools/channel.js";
import { SERVER_VERSION } from "../../../../shared/version.js";

// Local patch (simple model): channel_join takes a link or nothing, and an
// auto-binder joins on demand. These tests drive the real channel tool and
// binder against injected client functions; they prove the choice logic, not
// the relay or Figma (see socketSimpleModel.test.ts and LOCAL-BUILD.md).

const FILE_A = { channel: "AAAAAAAAAAAAAAAAAAAAAA", fileName: "File A", pluginVersion: SERVER_VERSION, mcpCount: 0, maxMcpPeers: 8 };
const FILE_B = { channel: "BBBBBBBBBBBBBBBBBBBBBB", fileName: "File B", pluginVersion: SERVER_VERSION, mcpCount: 0, maxMcpPeers: 8 };

function makeDeps(channels: any[]) {
    const state = { channels };
    const deps = {
        joinChannel: mock(async (_channel: string) => ({ serverVersion: SERVER_VERSION, pluginVersion: SERVER_VERSION })),
        sendCommandToFigma: mock(async (_command: string, _params?: any) => ({ editableScopeType: "document" })),
        resetChannel: mock(async () => {}),
        listChannels: mock(async () => state.channels),
    };
    return { deps, state };
}

function registerTools(deps: any) {
    const tools: Record<string, Function> = {};
    const server: any = {
        registerTool: (name: string, _options: any, handler: Function) => {
            tools[name] = async (args: any) => (await handler(args)).structuredContent;
        },
    };
    registerChannelTools(server, deps);
    return tools;
}

describe("fileKeyFromLink", () => {
    it("reads the key from design, file and board links", () => {
        expect(fileKeyFromLink("https://www.figma.com/design/Ab12Cd34Ef56Gh78Ij90Kl/Conf-App?node-id=1-2")).toBe("Ab12Cd34Ef56Gh78Ij90Kl");
        expect(fileKeyFromLink("https://www.figma.com/file/abc123/X")).toBe("abc123");
        expect(fileKeyFromLink("https://www.figma.com/board/Zz9/Y")).toBe("Zz9");
    });

    it("returns null for anything else", () => {
        expect(fileKeyFromLink("1:23")).toBeNull();
        expect(fileKeyFromLink("https://example.com/design/abc")).toBeNull();
    });
});

describe("channel_join without a channel", () => {
    beforeEach(() => resetRememberedJoin());

    it("joins the file key from a link", async () => {
        const { deps } = makeDeps([FILE_A, FILE_B]);
        const tools = registerTools(deps);
        const res = await tools.channel_join({ link: `https://www.figma.com/design/${FILE_B.channel}/File-B` });
        expect(res.status).toBe("success");
        expect(deps.joinChannel).toHaveBeenCalledWith(FILE_B.channel);
    });

    it("refuses a link without a file key and joins nothing", async () => {
        const { deps } = makeDeps([FILE_A]);
        const tools = registerTools(deps);
        const res = await tools.channel_join({ link: "not a link" });
        expect(res.status).toBe("error");
        expect(res.errorCode).toBe("MISSING_CHANNEL");
        expect(deps.joinChannel).not.toHaveBeenCalled();
    });

    it("joins the only open plugin when given nothing", async () => {
        const { deps } = makeDeps([FILE_A]);
        const tools = registerTools(deps);
        const res = await tools.channel_join({});
        expect(res.status).toBe("success");
        expect(deps.joinChannel).toHaveBeenCalledWith(FILE_A.channel);
    });

    it("names every open file and joins nothing when several are open", async () => {
        const { deps } = makeDeps([FILE_A, FILE_B]);
        const tools = registerTools(deps);
        const res = await tools.channel_join({});
        expect(res.status).toBe("error");
        expect(res.errorCode).toBe("CHANNEL_NOT_BOUND");
        expect(res.errorMessage).toContain("File A");
        expect(res.errorMessage).toContain("File B");
        expect(deps.joinChannel).not.toHaveBeenCalled();
    });

    it("says no plugin is open when the relay lists none", async () => {
        const { deps } = makeDeps([]);
        const tools = registerTools(deps);
        const res = await tools.channel_join({});
        expect(res.errorCode).toBe("CHANNEL_NOT_BOUND");
        expect(res.errorMessage).toContain("No Figma plugin is connected");
    });
});

describe("auto-binder", () => {
    beforeEach(() => resetRememberedJoin());

    it("joins the only open plugin", async () => {
        const { deps } = makeDeps([FILE_A]);
        await createAutoBinder(deps)();
        expect(deps.joinChannel).toHaveBeenCalledWith(FILE_A.channel);
    });

    it("throws a coded CHANNEL_NOT_BOUND when several plugins are open", async () => {
        const { deps } = makeDeps([FILE_A, FILE_B]);
        let thrown: any;
        try { await createAutoBinder(deps)(); } catch (error) { thrown = error; }
        expect(thrown?.code).toBe("CHANNEL_NOT_BOUND");
        expect(deps.joinChannel).not.toHaveBeenCalled();
    });

    it("rejoins the remembered file with its scopeLinks, even when other files are open", async () => {
        const { deps, state } = makeDeps([FILE_A, FILE_B]);
        const tools = registerTools(deps);
        await tools.channel_join({ channel: FILE_B.channel, scopeLinks: ["1:2"] });
        deps.joinChannel.mockClear();
        deps.sendCommandToFigma.mockClear();

        state.channels = [FILE_A, FILE_B];
        await createAutoBinder(deps)();
        expect(deps.joinChannel).toHaveBeenCalledWith(FILE_B.channel);
        expect(deps.sendCommandToFigma).toHaveBeenCalledWith("get_connect_payload", { scopeLinks: ["1:2"] });
    });

    it("never moves a session to another file when its file is gone", async () => {
        const { deps, state } = makeDeps([FILE_B]);
        const tools = registerTools(deps);
        await tools.channel_join({ channel: FILE_B.channel });
        deps.joinChannel.mockClear();

        state.channels = [FILE_A];
        let thrown: any;
        try { await createAutoBinder(deps)(); } catch (error) { thrown = error; }
        expect(thrown?.code).toBe("CHANNEL_NOT_BOUND");
        expect(thrown?.message).toContain(FILE_B.channel);
        expect(deps.joinChannel).not.toHaveBeenCalled();
    });

    it("forgets the remembered file after channel_leave", async () => {
        const { deps, state } = makeDeps([FILE_B]);
        const tools = registerTools(deps);
        await tools.channel_join({ channel: FILE_B.channel });
        await tools.channel_leave({});
        deps.joinChannel.mockClear();

        state.channels = [FILE_A];
        await createAutoBinder(deps)();
        expect(deps.joinChannel).toHaveBeenCalledWith(FILE_A.channel);
    });
});

describe("auto-binder asks the menu bar app when no plugin is open", () => {
    beforeEach(() => resetRememberedJoin());
    const noWait = { sleep: async () => {} };

    it("joins the file once the app has opened the plugin", async () => {
        const { deps, state } = makeDeps([]);
        const openPlugin = mock(async () => {
            state.channels = [FILE_A];
            return { ok: true, outcome: "opened", message: "" };
        });
        await createAutoBinder({ ...deps, openPlugin, ...noWait } as any)();
        expect(openPlugin).toHaveBeenCalledTimes(1);
        expect(deps.joinChannel).toHaveBeenCalledWith(FILE_A.channel);
    });

    it("reports what the app said when it could not open the plugin", async () => {
        const { deps } = makeDeps([]);
        const openPlugin = mock(async () => ({ ok: false, outcome: "no-file", message: "Open a design file in Figma first." }));
        let thrown: any;
        try { await createAutoBinder({ ...deps, openPlugin, ...noWait } as any)(); } catch (error) { thrown = error; }
        expect(thrown?.code).toBe("CHANNEL_NOT_BOUND");
        expect(thrown?.message).toContain("Open a design file in Figma first.");
    });

    it("keeps the plain error when the app is not running", async () => {
        const { deps } = makeDeps([]);
        const openPlugin = mock(async () => null);
        let thrown: any;
        try { await createAutoBinder({ ...deps, openPlugin, ...noWait } as any)(); } catch (error) { thrown = error; }
        expect(thrown?.message).toContain("Ask the user to open the FigmaMCP plugin");
    });

    it("does not open anything when a plugin is already connected", async () => {
        const { deps } = makeDeps([FILE_A]);
        const openPlugin = mock(async () => null);
        await createAutoBinder({ ...deps, openPlugin, ...noWait } as any)();
        expect(openPlugin).not.toHaveBeenCalled();
    });

    it("does not open anything for a session that lost its file", async () => {
        const { deps, state } = makeDeps([FILE_A]);
        const openPlugin = mock(async () => null);
        const binder = createAutoBinder({ ...deps, openPlugin, ...noWait } as any);
        await binder();
        state.channels = [];
        await expect(binder()).rejects.toMatchObject({ code: "CHANNEL_NOT_BOUND" });
        expect(openPlugin).not.toHaveBeenCalled();
    });
});

describe("channel_join label", () => {
    beforeEach(() => resetRememberedJoin());

    it("hands the label to the identity provider before joining, and leaves it alone when omitted", async () => {
        const order: string[] = [];
        const labels: Array<string | null | undefined> = [];
        setIdentityProvider({ setExplicitLabel: (label) => { order.push("label"); labels.push(label); } });
        const { deps } = makeDeps([FILE_A]);
        deps.joinChannel.mockImplementation(async () => { order.push("join"); return { serverVersion: SERVER_VERSION, pluginVersion: SERVER_VERSION }; });
        const tools = registerTools(deps);
        await tools.channel_join({ label: "Reviewer" });
        await tools.channel_join({});
        setIdentityProvider(null);
        expect(labels).toEqual(["Reviewer"]);
        expect(order.slice(0, 2)).toEqual(["label", "join"]);
    });
});
