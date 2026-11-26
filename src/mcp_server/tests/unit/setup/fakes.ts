import path from 'node:path';
import type { Deps, ExecResult, Facts, NodeCandidate } from '../../../../setup/types.js';
import { ALLOWED_PORTS, buildPlist, layoutFor } from '../../../../setup/plan.js';

type Node = { t: 'file'; data: Buffer } | { t: 'dir' } | { t: 'link'; target: string };

/** In-memory filesystem implementing the `Deps['fs']` surface. */
export function memFs(seed: Record<string, string> = {}, executables: string[] = [], realpaths: Record<string, string> = {}) {
  const nodes = new Map<string, Node>();
  const writes: string[] = [];
  const modes = new Map<string, number>();
  const ensureDir = (p: string) => {
    for (let d = p; d !== path.dirname(d); d = path.dirname(d)) if (!nodes.has(d)) nodes.set(d, { t: 'dir' });
  };
  const put = (p: string, data: string | Buffer) => {
    ensureDir(path.dirname(p));
    nodes.set(p, { t: 'file', data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
  };
  for (const [p, d] of Object.entries(seed)) put(p, d);
  const under = (root: string) => [...nodes.keys()].filter((k) => k === root || k.startsWith(root + path.sep));
  const fs: Deps['fs'] = {
    async readFile(p) {
      const n = nodes.get(p);
      if (!n || n.t !== 'file') throw new Error(`ENOENT ${p}`);
      return n.data;
    },
    async writeFile(p, d, mode) {
      if (!nodes.has(path.dirname(p))) throw new Error(`ENOENT dir ${path.dirname(p)}`);
      writes.push(p);
      if (mode !== undefined) modes.set(p, mode);
      put(p, d);
    },
    async mkdir(p) {
      writes.push(p);
      ensureDir(p);
      nodes.set(p, { t: 'dir' });
    },
    async rename(a, b) {
      if (!nodes.has(a)) throw new Error(`ENOENT ${a}`);
      writes.push(b);
      ensureDir(path.dirname(b));
      for (const k of under(a)) {
        nodes.set(b + k.slice(a.length), nodes.get(k)!);
        nodes.delete(k);
      }
    },
    async symlink(target, p) {
      writes.push(p);
      nodes.set(p, { t: 'link', target });
    },
    async readlink(p) {
      const n = nodes.get(p);
      return n?.t === 'link' ? n.target : null;
    },
    async realpath(p) {
      return realpaths[p] ?? (nodes.has(p) || executables.includes(p) ? p : null);
    },
    async rm(p) {
      for (const k of under(p)) nodes.delete(k);
    },
    async exists(p) {
      return nodes.has(p) || executables.includes(p);
    },
    async isExecutable(p) {
      return executables.includes(p);
    },
    async readdir(p) {
      const kids = new Set<string>();
      for (const k of nodes.keys()) if (path.dirname(k) === p) kids.add(path.basename(k));
      return [...kids];
    },
  };
  return { fs, nodes, writes, put, modes };
}

export type ExecScript = (argv: string[], input?: string) => Partial<ExecResult> | undefined;

export function scriptedExec(script: ExecScript) {
  const calls: { argv: string[]; input?: string }[] = [];
  const exec: Deps['exec'] = async (argv, opts) => {
    calls.push({ argv, input: opts?.input });
    const r = script(argv, opts?.input);
    return { code: r?.code ?? 127, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
  };
  return { exec, calls };
}

export const HOME = '/Users/tester';
export const PKG = '/cache/npx/figmamcp';

export function makeDeps(over: Partial<Deps> & { fsApi?: Deps['fs'] }): Deps {
  const m = memFs();
  return {
    fs: over.fsApi ?? m.fs,
    exec: over.exec ?? (async () => ({ code: 127, stdout: '', stderr: '' })),
    sleep: over.sleep ?? (async () => undefined),
    env: over.env ?? { PATH: '/usr/bin:/bin' },
    home: over.home ?? HOME,
    platform: over.platform ?? 'darwin',
    uid: over.uid ?? 501,
    pid: over.pid ?? 4242,
    execPath: over.execPath ?? '/opt/node/bin/node',
    pkgRoot: over.pkgRoot ?? PKG,
    binary: over.binary ?? false,
  };
}

export const GOOD_NODE: NodeCandidate = { path: '/opt/node/bin/node', version: 'v22.1.0', shim: false };
export const NODE = GOOD_NODE.path;

/** Facts for a Mac with Figma, a usable node, and nothing of FigmaMCP installed. */
export function freshFacts(over: Partial<Facts> = {}): Facts {
  return {
    platform: 'darwin',
    home: HOME,
    uid: 501,
    version: '1.2.3',
    pkgRoot: PKG,
    binary: false,
    figmaApp: '/Applications/Figma.app',
    nodeCandidates: [GOOD_NODE],
    runtime: {
      sourceFiles: ['package.json', 'dist/server.js', 'dist/socket.js'],
      missingSource: [],
      versionDirUpToDate: false,
      currentTarget: null,
    },
    relay: freePorts(),
    plugin: {
      settingsPath: `${HOME}/Library/Application Support/Figma/settings.json`,
      settingsExists: true,
      figmaRunning: false,
      registered: false,
      malformed: false,
    },
    skillFiles: ['SKILL.md', 'references/workflows.md'],
    skills: {
      claude: { target: `${HOME}/.claude/skills/figmamcp`, state: 'absent' },
      codex: { target: `${HOME}/.codex/skills/figmamcp`, state: 'absent' },
    },
    agents: {
      claude: { bin: '/bin/claude', registered: null },
      codex: { bin: '/bin/codex', registered: null },
    },
    ...over,
  };
}

/** Relay facts with every allowed port free; `held` puts a listener on the given ports. */
export function freePorts(
  held: Record<number, { pid: number; command: string }> = {},
  configPort: number | null = null,
  plistContent: string | null = null,
): Facts['relay'] {
  return {
    plistContent,
    ports: ALLOWED_PORTS.map((port) => ({ port, holder: held[port] ?? null })),
    configPort,
    configText: configPort === null ? null : JSON.stringify({ port: configPort }) + '\n',
  };
}

/** Facts for a machine where every automatic step is already done. */
export function doneFacts(over: Partial<Facts> = {}): Facts {
  const f = freshFacts();
  const layout = layoutFor(HOME, f.version);
  return {
    ...f,
    runtime: { ...f.runtime, versionDirUpToDate: true, currentTarget: layout.versionDir },
    relay: freePorts({ 3155: { pid: 777, command: `${NODE} ${layout.relayPath} --port 3155` } }, 3155, buildPlist({ node: NODE, layout, port: 3155 })),
    plugin: { ...f.plugin, registered: true },
    skills: {
      claude: { target: `${HOME}/.claude/skills/figmamcp`, state: 'current' },
      codex: { target: `${HOME}/.codex/skills/figmamcp`, state: 'current' },
    },
    agents: {
      claude: { bin: '/bin/claude', registered: { command: NODE, args: [layout.serverPath] } },
      codex: { bin: '/bin/codex', registered: { command: NODE, args: [layout.serverPath] } },
    },
    ...over,
  };
}
