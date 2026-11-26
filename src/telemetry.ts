// Product usage events, sent by the local relay (owner decision 2026-11-22).
//
// The relay is one long-lived process per Mac that sees every plugin join and every
// tool call, so it is the single writer of the on-disk queue. Events go to the
// figmamcp.dev worker route /mp/track, which checks them, adds the country and the
// Mixpanel project token, and forwards them with ip=0. This file never sees the token.
//
// Only fixed fields are sent: event name, tool name, ok, structured error code,
// duration, versions, OS major version, the plugin's random install ID. Never file
// names, node names, file content, user names, paths or prompts.
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir, platform } from "os";
import { dirname, join } from "path";

export const TELEMETRY_ENDPOINT = "https://figmamcp.dev/mp/track";
export const INSTALL_ID_RE = /^[0-9a-f]{16}$/;
export const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,39}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Must match TOOLS in site-worker/index.js and USAGE_TOOLS in figma_plugin/utils/usageCounter.ts. */
export const TELEMETRY_TOOLS: ReadonlySet<string> = new Set(["annotation_list","annotation_set","component_delete_property","component_list","component_manage_property","create_component","create_component_set","create_frame","create_instance","create_shape","create_svg","create_text","instance_get_overrides","instance_set_overrides","instance_set_property","node_apply_style","node_bind_variable","node_clone","node_delete","node_export_visual","node_flatten","node_group","node_info","node_insert_child","node_rename","node_set_auto_layout","node_set_corner_radius","node_set_effects","node_set_fill","node_set_stroke","node_transform","node_ungroup","page_info","reaction_list","reaction_update","style_delete","style_list","style_manage","text_set_content","text_set_style","variable_delete","variable_list","variable_manage","view_navigate"]);

/** Fixed client names. The client's session label (a title or folder name) is never sent. */
export function clientSlug(app: unknown): string {
  const name = typeof app === "string" ? app.trim().toLowerCase() : "";
  if (!name) return "other";
  if (name === "claude code" || name === "claude-code") return "claude-code";
  if (name === "codex" || name.startsWith("codex")) return "codex";
  if (name.startsWith("cursor")) return "cursor";
  if (name === "claude" || name === "claude-ai") return "claude";
  return "other";
}

/** The plugin's structured error code, or UNKNOWN. A free-text message (it can hold node names) is never used. */
export function errorCodeOf(message: { result?: unknown; error?: unknown }): { ok: boolean; code?: string } {
  const error = message.error;
  const resultCode = message.result && typeof message.result === "object" ? (message.result as any).errorCode : undefined;
  if (!error && !resultCode) return { ok: true };
  const raw = error && typeof error === "object" ? (error as any).code : resultCode;
  return { ok: false, code: typeof raw === "string" && ERROR_CODE_RE.test(raw) ? raw : "UNKNOWN" };
}

export function cleanVersion(value: unknown): string | undefined {
  return typeof value === "string" && VERSION_RE.test(value) ? value : undefined;
}

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/** FIGMAMCP_TELEMETRY=0 in the environment, or "telemetry": false in ~/.figmamcp/config.json, turns events off. */
export function telemetryEnvOff(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.FIGMAMCP_TELEMETRY;
  return typeof flag === "string" && OFF_VALUES.has(flag.trim().toLowerCase());
}

export function telemetryEnabled(env: Record<string, string | undefined> = process.env, home: string = homedir()): boolean {
  if (telemetryEnvOff(env)) return false;
  try {
    const config = JSON.parse(readFileSync(join(home, ".figmamcp", "config.json"), "utf-8"));
    if (config && config.telemetry === false) return false;
  } catch {
    // No config, or an unreadable one: the default is on.
  }
  return true;
}

export function defaultQueueFile(home: string = homedir()): string {
  return join(home, ".figmamcp", "telemetry-queue.jsonl");
}

/** "macOS 26" from sw_vers. Darwin's kernel number is not the macOS number, so it is not used. */
export function detectOs(onReady: (os: string) => void): string {
  const p = platform();
  if (p === "win32") return "Windows";
  if (p === "linux") return "Linux";
  if (p !== "darwin") return "other";
  try {
    execFile("/usr/bin/sw_vers", ["-productVersion"], { timeout: 2000 }, (error, stdout) => {
      const major = !error && /^(\d{1,2})\./.exec(String(stdout).trim() + ".");
      if (major) onReady(`macOS ${major[1]}`);
    });
  } catch {
    // Keep the bare "macOS".
  }
  return "macOS";
}

export interface TelemetryEvent {
  event: string;
  properties: Record<string, unknown>;
}

export interface TelemetrySink {
  track(event: string, properties: Record<string, unknown>, distinctId: string): void;
}

export interface TelemetryTimer {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TelemetryOptions {
  serverVersion: string;
  queueFile?: string;
  endpoint?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  isEnabled?: () => boolean;
  os?: string;
  insertId?: () => string;
  timer?: TelemetryTimer;
  flushIntervalMs?: number;
  batchSize?: number;
  maxQueue?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface Telemetry extends TelemetrySink {
  flush(): Promise<void>;
  /** Writes unsent events to the queue file now (used on exit; a network send would not finish). */
  persistSync(): void;
  setOs(os: string): void;
  queued(): TelemetryEvent[];
  close(): void;
}

// Mixpanel's /track accepts events up to 5 days old; older ones would only be rejected.
const MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const queueFile = options.queueFile ?? defaultQueueFile();
  const endpoint = options.endpoint ?? TELEMETRY_ENDPOINT;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const isEnabled = options.isEnabled ?? (() => telemetryEnabled());
  const insertId = options.insertId ?? randomUUID;
  const batchSize = options.batchSize ?? 50;
  const maxQueue = options.maxQueue ?? 1000;
  const maxBytes = options.maxBytes ?? 1_000_000;
  const timeoutMs = options.timeoutMs ?? 5000;
  const timer = options.timer ?? {
    setInterval(callback: () => void, ms: number) {
      const handle = setInterval(callback, ms);
      (handle as any).unref?.();
      return handle;
    },
    clearInterval(handle: unknown) {
      clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
  let os = options.os ?? "macOS";
  let queue: TelemetryEvent[] = [];
  let firstToolSent = false;
  let inFlight: Promise<void> | null = null;
  let closed = false;

  const sizeOf = (e: TelemetryEvent) => JSON.stringify(e).length + 1;

  const trim = () => {
    if (queue.length > maxQueue) queue = queue.slice(queue.length - maxQueue);
    let bytes = queue.reduce((sum, e) => sum + sizeOf(e), 0);
    while (bytes > maxBytes && queue.length > 0) bytes -= sizeOf(queue.shift()!);
  };

  const fresh = (e: TelemetryEvent) => {
    const time = Number(e?.properties?.time);
    return Number.isFinite(time) && now() - time < MAX_AGE_MS;
  };

  const persistSync = () => {
    try {
      if (queue.length === 0) {
        if (existsSync(queueFile)) unlinkSync(queueFile);
        return;
      }
      mkdirSync(dirname(queueFile), { recursive: true });
      const tmp = `${queueFile}.tmp`;
      writeFileSync(tmp, queue.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
      renameSync(tmp, queueFile);
    } catch {
      // A full or read-only disk only loses events.
    }
  };

  const load = () => {
    try {
      if (!existsSync(queueFile)) return;
      const lines = readFileSync(queueFile, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && typeof e.event === "string" && e.properties && typeof e.properties === "object" && fresh(e)) queue.push(e);
        } catch {
          // Skip a damaged line.
        }
      }
      trim();
    } catch {
      // Unreadable queue: start empty.
    }
  };

  const sendBatch = async (batch: TelemetryEvent[]): Promise<"sent" | "drop" | "retry"> => {
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return "sent";
      // A 4xx will be refused again on every retry, so the batch is dropped.
      return res.status >= 400 && res.status < 500 ? "drop" : "retry";
    } catch {
      return "retry";
    }
  };

  const runFlush = async () => {
    if (!isEnabled()) {
      queue = [];
      persistSync();
      return;
    }
    queue = queue.filter(fresh);
    while (queue.length > 0) {
      const batch = queue.slice(0, batchSize);
      const outcome = await sendBatch(batch);
      if (outcome === "retry") break;
      const sent = new Set(batch);
      queue = queue.filter((e) => !sent.has(e));
    }
    persistSync();
  };

  const flush = (): Promise<void> => {
    if (inFlight) return inFlight.then(() => (queue.length > 0 ? flush() : undefined));
    inFlight = runFlush()
      .catch(() => {})
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const track = (event: string, properties: Record<string, unknown>, distinctId: string) => {
    if (closed || !INSTALL_ID_RE.test(distinctId)) return;
    try {
      if (!isEnabled()) return;
    } catch {
      return;
    }
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) if (value !== undefined) props[key] = value;
    queue.push({
      event,
      properties: {
        ...props,
        product: "figmamcp",
        server_version: options.serverVersion,
        os,
        distinct_id: distinctId,
        time: now(),
        $insert_id: insertId(),
      },
    });
    trim();
    if (event === "tool_called" && !firstToolSent) {
      firstToolSent = true;
      void flush();
    } else if (queue.length >= batchSize) {
      void flush();
    }
  };

  load();
  const interval = timer.setInterval(() => {
    if (queue.length > 0) void flush();
  }, options.flushIntervalMs ?? 10_000);

  return {
    track,
    flush,
    persistSync,
    setOs(value: string) {
      os = value;
    },
    queued: () => [...queue],
    close() {
      closed = true;
      timer.clearInterval(interval);
    },
  };
}
