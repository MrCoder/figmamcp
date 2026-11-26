import { describe, expect, it } from "bun:test";
import {
    clientAppName,
    createIdentityProvider,
    cwdLabel,
    pickIdentityEnv,
    readClaudeDesktopTitle,
    resolveClientIdentity,
    type IdentityEnv,
} from "../../clientLabel.js";
import { normalizeClientIdentity } from "../../../shared/channelProtocol.js";

const HOST = "local_5c14add4-472a-4bd9-ab7b-697edc81a433";
const CLI = "1723d2a7-2275-45e0-b221-8d54d3e51371";
const ACCOUNT = "f6b72134-56b7-484d-8230-c5b40c67629d";
const ORG = "7d4eb599-52a9-4d59-a3be-48c3ecfbe9fd";
const DIR = "/sessions";
const RECORD_PATH = `${DIR}/${ACCOUNT}/${ORG}/${HOST}.json`;

const desktopEnv = (overrides: Partial<IdentityEnv> = {}): IdentityEnv => ({
    CLAUDECODE: "1",
    CLAUDE_CODE_HOST_SESSION_ID: HOST,
    CLAUDE_CODE_SESSION_ID: CLI,
    CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT,
    CLAUDE_CODE_ORGANIZATION_UUID: ORG,
    ...overrides,
});

const files = (map: Record<string, string>) => (path: string) => {
    if (path in map) return map[path];
    const error: any = new Error(`ENOENT: ${path}`);
    error.code = "ENOENT";
    throw error;
};

const record = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe("readClaudeDesktopTitle", () => {
    it("returns the title when the record belongs to this CLI session", () => {
        const read = files({ [RECORD_PATH]: record({ cliSessionId: CLI, title: "自运营 Figma MCP 产品" }) });
        expect(readClaudeDesktopTitle(desktopEnv(), read, DIR)).toEqual({ status: "ok", title: "自运营 Figma MCP 产品" });
    });

    it("rejects a record owned by another process (a claude -p child inherits the host session id)", () => {
        // Observed 2026-11-19: `claude -p` started from a desktop session gets the
        // parent's CLAUDE_CODE_HOST_SESSION_ID but its own CLAUDE_CODE_SESSION_ID.
        const read = files({ [RECORD_PATH]: record({ cliSessionId: CLI, title: "Parent title" }) });
        const child = desktopEnv({ CLAUDE_CODE_SESSION_ID: "69d81f06-969f-4485-857a-a1570de074af" });
        expect(readClaudeDesktopTitle(child, read, DIR)).toEqual({ status: "mismatch" });
    });

    it("accepts lastAssistantCliSessionId as the owner", () => {
        const read = files({ [RECORD_PATH]: record({ cliSessionId: "00000000-0000-0000-0000-000000000000", lastAssistantCliSessionId: CLI, title: "T" }) });
        expect(readClaudeDesktopTitle(desktopEnv(), read, DIR)).toEqual({ status: "ok", title: "T" });
    });

    it("never builds a path from a malformed id", () => {
        let reads = 0;
        const read = () => { reads++; return "{}"; };
        expect(readClaudeDesktopTitle(desktopEnv({ CLAUDE_CODE_HOST_SESSION_ID: "local_../../etc" }), read, DIR)).toEqual({ status: "absent" });
        expect(readClaudeDesktopTitle(desktopEnv({ CLAUDE_CODE_ACCOUNT_UUID: "../x" }), read, DIR)).toEqual({ status: "absent" });
        expect(reads).toBe(0);
    });

    it("reports absent with no desktop session, and unreadable on a half-written file", () => {
        expect(readClaudeDesktopTitle({}, files({}), DIR)).toEqual({ status: "absent" });
        expect(readClaudeDesktopTitle(desktopEnv(), files({}), DIR)).toEqual({ status: "absent" });
        expect(readClaudeDesktopTitle(desktopEnv(), files({ [RECORD_PATH]: "{\"cliSess" }), DIR)).toEqual({ status: "unreadable" });
    });
});

describe("resolveClientIdentity", () => {
    const claude = { name: "claude-code", title: "Claude Code" };
    const base = { clientInfo: claude, env: desktopEnv(), cwd: "/Users/u/workspaces/agentic-local-figma", home: "/Users/u" };

    it("orders explicit label > env label > session title > cwd > none", () => {
        const title = { status: "ok" as const, title: "自运营 Figma MCP 产品" };
        expect(resolveClientIdentity({ ...base, explicitLabel: "Reviewer", env: desktopEnv({ FIGMAMCP_CLIENT_LABEL: "Env" }), desktopTitle: title }))
            .toEqual({ app: "Claude Code", label: "Reviewer", source: "explicit" });
        expect(resolveClientIdentity({ ...base, env: desktopEnv({ FIGMAMCP_CLIENT_LABEL: "Env" }), desktopTitle: title }))
            .toEqual({ app: "Claude Code", label: "Env", source: "explicit" });
        expect(resolveClientIdentity({ ...base, desktopTitle: title }))
            .toEqual({ app: "Claude Code", label: "自运营 Figma MCP 产品", source: "session-title" });
        expect(resolveClientIdentity({ ...base, desktopTitle: { status: "mismatch" } }))
            .toEqual({ app: "Claude Code", label: "agentic-local-figma", source: "cwd" });
        expect(resolveClientIdentity({ ...base, cwd: "/Users/u", desktopTitle: { status: "absent" } }))
            .toEqual({ app: "Claude Code", label: "", source: "none" });
    });

    it("ignores a blank explicit label", () => {
        expect(resolveClientIdentity({ ...base, explicitLabel: "   ", desktopTitle: { status: "absent" } }).source).toBe("cwd");
    });

    it("names Codex from its clientInfo", () => {
        expect(resolveClientIdentity({ clientInfo: { name: "codex-mcp-client", title: "Codex" }, env: {}, cwd: "/w/web-sequence", home: "/h", desktopTitle: { status: "absent" } }))
            .toEqual({ app: "Codex", label: "web-sequence", source: "cwd" });
    });
});

describe("clientAppName and cwdLabel", () => {
    it("prefers the clientInfo title, maps known names, and falls back", () => {
        expect(clientAppName({ name: "x", title: "Custom" }, {})).toBe("Custom");
        expect(clientAppName({ name: "codex-mcp-client" }, {})).toBe("Codex");
        expect(clientAppName(undefined, { CLAUDECODE: "1" })).toBe("Claude Code");
        expect(clientAppName(undefined, {})).toBe("AI session");
    });

    it("does not treat the home directory or root as a label", () => {
        expect(cwdLabel("/Users/u", "/Users/u")).toBe("");
        expect(cwdLabel("/", "/Users/u")).toBe("");
        expect(cwdLabel("/Users/u/conf-app", "/Users/u")).toBe("conf-app");
    });
});

describe("normalizeClientIdentity", () => {
    it("strips control and bidi characters and clamps length", () => {
        expect(normalizeClientIdentity({ app: "Claude\u0000 Code", label: "a‮b\nc" })).toEqual({ app: "Claude Code", label: "a b c" });
        const long = normalizeClientIdentity({ app: "A", label: "x".repeat(200) })!;
        expect([...long.label].length).toBe(80);
        expect(long.label.endsWith("…")).toBe(true);
        expect(normalizeClientIdentity({ app: 3, label: null })).toBeUndefined();
        expect(normalizeClientIdentity("str")).toBeUndefined();
    });
});

describe("createIdentityProvider", () => {
    it("keeps the last good title while the store is mid-write, and keeps the explicit label", () => {
        let content = record({ cliSessionId: CLI, title: "First" });
        const provider = createIdentityProvider({
            getClientInfo: () => ({ name: "claude-code", title: "Claude Code" }),
            env: desktopEnv(),
            cwd: () => "/w/repo",
            home: "/h",
            readFile: (path) => { if (path !== RECORD_PATH) throw new Error("bad path"); return content; },
            sessionsDir: DIR,
        });
        expect(provider.current().label).toBe("First");
        content = "{\"half";
        expect(provider.current()).toEqual({ app: "Claude Code", label: "First", source: "session-title" });
        content = record({ cliSessionId: CLI, title: "Renamed" });
        expect(provider.current().label).toBe("Renamed");
        provider.setExplicitLabel("Mine");
        expect(provider.current()).toEqual({ app: "Claude Code", label: "Mine", source: "explicit" });
        provider.setExplicitLabel(null);
        expect(provider.current().label).toBe("Renamed");
    });

    it("pickIdentityEnv copies only the whitelisted keys", () => {
        const picked = pickIdentityEnv({ CLAUDE_CODE_USER_EMAIL: "x@y", SOME_TOKEN: "t", CLAUDECODE: "1" } as any);
        expect(Object.values(picked)).not.toContain("x@y");
        expect(Object.values(picked)).not.toContain("t");
        expect(picked.CLAUDECODE).toBe("1");
    });
});
