/**
 * Names this MCP session for the plugin panel, so a user with several AI
 * sessions on one file can tell which one is connected.
 *
 * Signals, best first:
 *   1. an explicit label (`channel_join({ label })`, then `FIGMAMCP_CLIENT_LABEL`);
 *   2. the Claude desktop app's session title, read from its local session
 *      store and accepted only when that record belongs to this exact process;
 *   3. the basename of the server's working directory;
 *   4. nothing (the panel then shows only the client app name).
 *
 * The label stays on this machine: it travels over the localhost relay to the
 * plugin and is never sent to analytics.
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { normalizeClientIdentity, type ClientIdentity } from "../shared/channelProtocol.js";

export type { ClientIdentity };

export type LabelSource = "explicit" | "session-title" | "cwd" | "none";

export interface ResolvedClientIdentity extends ClientIdentity {
    source: LabelSource;
}

export interface McpClientInfo {
    name?: string;
    title?: string;
}

/** Only these environment keys are read. Never iterate the environment: it holds tokens and the user's email. */
export interface IdentityEnv {
    FIGMAMCP_CLIENT_LABEL?: string;
    CLAUDECODE?: string;
    CLAUDE_CODE_HOST_SESSION_ID?: string;
    CLAUDE_CODE_SESSION_ID?: string;
    CLAUDE_CODE_ACCOUNT_UUID?: string;
    CLAUDE_CODE_ORGANIZATION_UUID?: string;
}

export function pickIdentityEnv(env: Record<string, string | undefined>): IdentityEnv {
    return {
        FIGMAMCP_CLIENT_LABEL: env.FIGMAMCP_CLIENT_LABEL,
        CLAUDECODE: env.CLAUDECODE,
        CLAUDE_CODE_HOST_SESSION_ID: env.CLAUDE_CODE_HOST_SESSION_ID,
        CLAUDE_CODE_SESSION_ID: env.CLAUDE_CODE_SESSION_ID,
        CLAUDE_CODE_ACCOUNT_UUID: env.CLAUDE_CODE_ACCOUNT_UUID,
        CLAUDE_CODE_ORGANIZATION_UUID: env.CLAUDE_CODE_ORGANIZATION_UUID,
    };
}

const KNOWN_APPS: Record<string, string> = {
    "claude-code": "Claude Code",
    "codex-mcp-client": "Codex",
    "cursor-vscode": "Cursor",
    "claude-ai": "Claude",
};

/** The client app's display name, from MCP `initialize` clientInfo. */
export function clientAppName(info: McpClientInfo | undefined, env: IdentityEnv): string {
    const title = typeof info?.title === "string" ? info.title.trim() : "";
    if (title) return title;
    const name = typeof info?.name === "string" ? info.name.trim() : "";
    if (name) return KNOWN_APPS[name] ?? name;
    if (env.CLAUDECODE === "1") return "Claude Code";
    return "AI session";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST_SESSION = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DesktopTitle =
    | { status: "ok"; title: string }
    /** No desktop session in the environment, or the record has no title yet. */
    | { status: "absent" }
    /** The record belongs to another process (for example a `claude -p` child that inherited the variable). */
    | { status: "mismatch" }
    /** The file could not be read or parsed; the desktop app may be writing it. */
    | { status: "unreadable" };

export function claudeSessionsDir(home: string = homedir()): string {
    return join(home, "Library", "Application Support", "Claude", "claude-code-sessions");
}

/**
 * The Claude desktop app's title for this session. The host session id is
 * inherited by child processes, so the record is trusted only when its CLI
 * session id is the one this server was started with.
 */
export function readClaudeDesktopTitle(
    env: IdentityEnv,
    readFile: (path: string) => string,
    sessionsDir: string = claudeSessionsDir(),
): DesktopTitle {
    const host = env.CLAUDE_CODE_HOST_SESSION_ID;
    const cliSession = env.CLAUDE_CODE_SESSION_ID;
    const account = env.CLAUDE_CODE_ACCOUNT_UUID;
    const org = env.CLAUDE_CODE_ORGANIZATION_UUID;
    if (
        typeof host !== "string" || !HOST_SESSION.test(host)
        || typeof cliSession !== "string" || !UUID.test(cliSession)
        || typeof account !== "string" || !UUID.test(account)
        || typeof org !== "string" || !UUID.test(org)
    ) {
        return { status: "absent" };
    }
    let record: any;
    try {
        record = JSON.parse(readFile(join(sessionsDir, account, org, `${host}.json`)));
    } catch (error: any) {
        return error?.code === "ENOENT" ? { status: "absent" } : { status: "unreadable" };
    }
    if (record === null || typeof record !== "object") return { status: "unreadable" };
    if (record.cliSessionId !== cliSession && record.lastAssistantCliSessionId !== cliSession) {
        return { status: "mismatch" };
    }
    const title = typeof record.title === "string" ? record.title.trim() : "";
    return title ? { status: "ok", title } : { status: "absent" };
}

/** A working directory that names nothing (home, filesystem root) is not a label. */
export function cwdLabel(cwd: string, home: string = homedir()): string {
    if (!cwd || cwd === "/" || cwd === home) return "";
    return basename(cwd);
}

export interface ResolveInput {
    explicitLabel?: string | null;
    clientInfo?: McpClientInfo;
    env: IdentityEnv;
    cwd: string;
    home?: string;
    desktopTitle: DesktopTitle;
}

export function resolveClientIdentity(input: ResolveInput): ResolvedClientIdentity {
    const app = clientAppName(input.clientInfo, input.env);
    const pick = (label: string, source: LabelSource): ResolvedClientIdentity => {
        const normalized = normalizeClientIdentity({ app, label });
        return { app: normalized?.app ?? app, label: normalized?.label ?? "", source };
    };
    const explicit = [input.explicitLabel, input.env.FIGMAMCP_CLIENT_LABEL]
        .map((value) => normalizeClientIdentity({ app, label: value })?.label ?? "")
        .find((value) => value.length > 0);
    if (explicit) return pick(explicit, "explicit");
    if (input.desktopTitle.status === "ok") return pick(input.desktopTitle.title, "session-title");
    const fromCwd = cwdLabel(input.cwd, input.home);
    if (fromCwd) return pick(fromCwd, "cwd");
    return pick("", "none");
}

export interface IdentityProviderOptions {
    getClientInfo: () => McpClientInfo | undefined;
    env?: IdentityEnv;
    cwd?: () => string;
    home?: string;
    readFile?: (path: string) => string;
    sessionsDir?: string;
}

/**
 * Stateful wrapper: remembers the explicit label across rejoins, and keeps the
 * last good desktop title when the store is briefly unreadable mid-write.
 */
export function createIdentityProvider(options: IdentityProviderOptions) {
    const env = options.env ?? pickIdentityEnv(process.env);
    const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    const cwd = options.cwd ?? (() => process.cwd());
    let explicitLabel: string | null = null;
    let lastGoodTitle: string | null = null;

    return {
        setExplicitLabel(label: string | null | undefined) {
            explicitLabel = typeof label === "string" && label.trim() ? label : null;
        },
        current(): ResolvedClientIdentity {
            let desktopTitle = readClaudeDesktopTitle(env, readFile, options.sessionsDir);
            if (desktopTitle.status === "ok") lastGoodTitle = desktopTitle.title;
            else if (desktopTitle.status === "unreadable" && lastGoodTitle) {
                desktopTitle = { status: "ok", title: lastGoodTitle };
            }
            return resolveClientIdentity({
                explicitLabel,
                clientInfo: options.getClientInfo(),
                env,
                cwd: cwd(),
                home: options.home,
                desktopTitle,
            });
        },
    };
}

export type IdentityProvider = ReturnType<typeof createIdentityProvider>;
