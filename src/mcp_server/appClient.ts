import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

export interface OpenPluginReply {
    ok: boolean;
    outcome: string;
    message: string;
}

export function defaultAppSocketPath(): string {
    return path.join(homedir(), ".figmamcp", "app.sock");
}

/** Asks the FigmaMCP menu bar app to open the plugin. Returns null when the app does not answer. */
export function askAppToOpenPlugin(at = defaultAppSocketPath(), timeoutMs = 15_000): Promise<OpenPluginReply | null> {
    return new Promise((resolve) => {
        let reply = "";
        const socket = createConnection(at);
        const finish = (value: OpenPluginReply | null) => {
            clearTimeout(timer);
            socket.destroy();
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        socket.on("connect", () => socket.write('{"cmd":"open-plugin"}\n'));
        socket.on("error", () => finish(null));
        socket.on("data", (chunk) => {
            reply += chunk.toString();
            const end = reply.indexOf("\n");
            if (end < 0) return;
            try {
                const parsed = JSON.parse(reply.slice(0, end));
                finish({ ok: parsed.ok === true, outcome: String(parsed.outcome ?? ""), message: String(parsed.message ?? "") });
            } catch {
                finish(null);
            }
        });
        socket.on("close", () => finish(null));
    });
}
