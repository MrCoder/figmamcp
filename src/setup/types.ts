/**
 * Shared types for `figmamcp setup` / `figmamcp doctor`.
 *
 * Three layers, kept apart on purpose:
 *   probe.ts    reads the machine and returns `Facts` (read-only IO, injected)
 *   plan.ts     turns `Facts` into a `Plan` (pure: no fs, no exec, no clock)
 *   execute.ts  performs a `Plan`'s actions (IO, injected)
 */

export type Status = 'ok' | 'skip' | 'fail' | 'todo';

export type StepId =
  | 'platform'
  | 'figma'
  | 'node'
  | 'runtime'
  | 'relay'
  | 'agent-claude'
  | 'agent-codex'
  | 'agent-manual'
  | 'skill'
  | 'plugin';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  input?: string;
}

/** Everything the probe and executor need from the machine. */
export interface Deps {
  fs: {
    readFile(path: string): Promise<Buffer>;
    /** `mode` is the Unix permission bits; pass 0o755 for executables. */
    writeFile(path: string, data: Buffer | string, mode?: number): Promise<void>;
    mkdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string | null>;
    realpath(path: string): Promise<string | null>;
    rm(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    isExecutable(path: string): Promise<boolean>;
    readdir(path: string): Promise<string[]>;
  };
  /** Never throws for a non-zero exit; resolves with the exit code. A missing binary resolves with code 127. */
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  sleep(ms: number): Promise<void>;
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
  uid: number;
  pid: number;
  /** process.execPath of the running node. */
  execPath: string;
  /**
   * Root of the resources: the installed `figmamcp` npm package (dist/, figma_plugin/, skills/, package.json),
   * or, for the compiled binaries, the folder holding the binaries next to figma_plugin/, skills/, package.json.
   */
  pkgRoot: string;
  /** True when running as a compiled standalone binary (no Node.js on the machine is needed). */
  binary?: boolean;
  /** Files where the FigmaMCP plugin is open, asked from the local relay. Read-only; may throw when the relay is down. */
  openFiles?(port: number): Promise<OpenFile[]>;
}

export interface OpenFile {
  fileName: string | null;
  /** AI sessions bound to this file right now. */
  aiSessions: number;
  /** Version the open plugin panel reports ("unknown" when it did not say). Missing when the relay did not send one. */
  pluginVersion?: string | null;
  /** AI requests this file answered without an error since the relay started. Missing (null) from an older relay. */
  completedCalls?: number | null;
}

/** What is running right now, checked by `doctor` only. null = could not be checked. */
export interface Live {
  /** Files with FigmaMCP open, from the relay; null when the relay could not be asked. */
  openFiles: OpenFile[] | null;
  /** Running FigmaMCP servers per AI client (each is one loaded client session); null when `ps` failed. */
  loaded: { claude: number | null; codex: number | null } | null;
}

// ---------------------------------------------------------------- facts

export interface NodeCandidate {
  path: string;
  /** `v22.1.0`-style output under a minimal launchd-like PATH, or null when it failed to run. */
  version: string | null;
  /** True for version-manager shims (Volta, asdf, mise, nodenv...): they depend on shell state. */
  shim: boolean;
}

export interface PortHolder {
  pid: number;
  /** Full command line (`ps -o command=`), or the short name when ps failed. */
  command: string;
}

export interface RegisteredServer {
  command: string;
  args: string[];
}

export interface AgentFacts {
  /** Absolute path of the agent CLI, or null when not found. */
  bin: string | null;
  /** null = not registered. 'unreadable' = something is there but we could not read it safely. */
  registered: RegisteredServer | null | 'unreadable';
  /** First line of the agent CLI's error, when asking it failed for a reason other than "not registered". */
  error?: string;
}

export type SkillState = 'absent' | 'current' | 'stale' | 'foreign-link';

export interface SkillFacts {
  /** Absolute target directory, e.g. ~/.claude/skills/figmamcp. */
  target: string;
  state: SkillState;
}

export interface PluginFacts {
  settingsPath: string;
  /** False when Figma's settings.json does not exist yet (Figma was never opened). */
  settingsExists: boolean;
  /** 'unknown' when pgrep gave an answer we do not understand; treated as running. */
  figmaRunning: boolean | 'unknown';
  registered: boolean;
  /** settings.json exists but is not valid JSON, or has a localFileExtensions that is not a list. */
  malformed: boolean;
}

export interface Facts {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  version: string;
  pkgRoot: string;
  /** Running as a compiled binary: the relay and server are executables, no Node.js is used. */
  binary: boolean;
  figmaApp: string | null;
  nodeCandidates: NodeCandidate[];
  runtime: {
    /** Package files (relative to pkgRoot) that setup copies and that exist. */
    sourceFiles: string[];
    /** Required files that are missing from the package (broken install). */
    missingSource: string[];
    /** versions/<version> exists and every file is byte-identical to the package. */
    versionDirUpToDate: boolean;
    /** Absolute resolved target of the `current` link, or null. */
    currentTarget: string | null;
  };
  relay: {
    plistContent: string | null;
    /** The listener on each allowed port (null = free), in ALLOWED_PORTS order. */
    ports: { port: number; holder: PortHolder | null }[];
    /** Port recorded in ~/.figmamcp/config.json, or null. */
    configPort: number | null;
    /** Raw config.json, or null when absent. */
    configText: string | null;
  };
  plugin: PluginFacts;
  /** Skill files (relative to pkgRoot/skills/figmamcp) that exist in the package. */
  skillFiles: string[];
  skills: { claude: SkillFacts | null; codex: SkillFacts | null };
  agents: { claude: AgentFacts; codex: AgentFacts };
}

// ---------------------------------------------------------------- layout

export interface Layout {
  root: string;
  versionsDir: string;
  versionDir: string;
  current: string;
  /** Absolute path of the server program: dist/server.js (Node) or bin/figmamcp-server (binary). */
  serverPath: string;
  relayPath: string;
  binary: boolean;
  manifestPath: string;
  logDir: string;
  plistPath: string;
}

// ---------------------------------------------------------------- plan

export type Action =
  | {
      kind: 'install-runtime';
      version: string;
      pkgRoot: string;
      files: string[];
      /** false when versions/<v> is already correct and only the `current` link must move. */
      copy: boolean;
      /** Source path (relative to pkgRoot) -> destination path (relative to versions/<v>), when they differ. */
      map?: Record<string, string>;
      layout: Layout;
    }
  | { kind: 'mkdir'; paths: string[] }
  | { kind: 'copy-skill'; from: string; to: string; files: string[] }
  | { kind: 'write-file'; path: string; content: string }
  | { kind: 'exec'; argv: string[]; allowFail?: boolean; label: string; retry?: { attempts: number; delayMs: number } }
  | { kind: 'wait-port'; port: number; timeoutMs: number; failHint: string }
  | { kind: 'plugin-import'; manifestPath: string };

export interface Step {
  id: StepId;
  title: string;
  status: Status;
  detail: string;
  /** Shown instead of `detail` once the actions have run successfully. */
  done?: string;
  /** What the user can do about a `fail` (or what to run to get a `todo` done). */
  fix?: string;
  /** Machine-readable state for --json when it is more specific than `status` (e.g. needs-figma-restart). */
  state?: string;
  /** Extra lines printed under the step (snippets, manual instructions). */
  notes?: string[];
  actions: Action[];
}

export interface Plan {
  steps: Step[];
  /** Set when the plan cannot continue (wrong OS, no Figma, no usable node). Equals the process exit code. */
  stopCode: number | null;
  layout: Layout | null;
  nodePath: string | null;
  /** Closing lines: what the user does next. */
  next: string[];
  /** The relay port that was chosen (null when none could be). */
  port: number | null;
}

export type Mode = 'dry-run' | 'doctor' | 'setup';

/** 4 is `doctor` only: every setup step is fine, but FigmaMCP is not open in any Figma file right now. */
export const EXIT = { OK: 0, WRONG_PLATFORM: 1, NO_FIGMA: 2, FAILED: 3, NOT_OPEN: 4 } as const;
