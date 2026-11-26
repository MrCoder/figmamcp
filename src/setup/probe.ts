import path from 'node:path';
import type { AgentFacts, Deps, Facts, NodeCandidate, PluginFacts, PortHolder, SkillFacts } from './types.js';
import { inspectRegistry, pluginPaths } from './importer.js';
import {
  ALLOWED_PORTS,
  GUIDE_DIR,
  SERVER_NAME,
  SKILL_NAME,
  SKILL_SRC_DIR,
  configPath,
  destOf,
  figmaAppCandidates,
  figmaSettingsPath,
  requiredRuntimeFiles,
  isShimPath,
  layoutFor,
  parseLsof,
} from './plan.js';

/** Read-only. Never writes, never calls launchctl, never starts or stops anything. */
export async function gatherFacts(deps: Deps, version: string): Promise<Facts> {
  const { home } = deps;
  const binary = deps.binary === true;
  const layout = layoutFor(home, version, binary);

  const none: AgentFacts = { bin: null, registered: null };
  if (deps.platform !== 'darwin') {
    // Nothing below applies off macOS, and we should not run anything there.
    return {
      platform: deps.platform,
      home,
      uid: deps.uid,
      version,
      pkgRoot: deps.pkgRoot,
      binary,
      figmaApp: null,
      nodeCandidates: [],
      runtime: { sourceFiles: [], missingSource: [], versionDirUpToDate: false, currentTarget: null },
      relay: { plistContent: null, ports: [], configPort: null, configText: null },
      plugin: { settingsPath: figmaSettingsPath(home), settingsExists: false, figmaRunning: false, registered: false, malformed: false },
      skillFiles: [],
      skills: { claude: null, codex: null },
      agents: { claude: none, codex: none },
    };
  }

  let figmaApp: string | null = null;
  for (const c of figmaAppCandidates(home)) {
    if (await deps.fs.exists(c)) {
      figmaApp = c;
      break;
    }
  }

  const claude = await probeClaude(deps);
  const codex = await probeCodex(deps);
  const skillFiles = await probeSkillFiles(deps);
  const configText = await readText(deps, configPath(layout));
  return {
    platform: deps.platform,
    home,
    uid: deps.uid,
    version,
    pkgRoot: deps.pkgRoot,
    binary,
    figmaApp,
    nodeCandidates: binary ? [] : await probeNode(deps),
    runtime: await probeRuntime(deps, layout.versionDir, layout.current, layout.root, binary),
    relay: {
      plistContent: await readText(deps, layout.plistPath),
      ports: await probePorts(deps),
      configPort: parseConfigPort(configText),
      configText,
    },
    plugin: await probePlugin(deps, layout.manifestPath),
    skillFiles,
    skills: {
      claude: claude.bin ? await probeSkill(deps, path.join(deps.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills', SKILL_NAME), skillFiles) : null,
      codex: codex.bin ? await probeSkill(deps, path.join(deps.env.CODEX_HOME || path.join(home, '.codex'), 'skills', SKILL_NAME), skillFiles) : null,
    },
    agents: { claude, codex },
  };
}

export function parseConfigPort(text: string | null): number | null {
  if (text === null) return null;
  try {
    const port = JSON.parse(text)?.port;
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

async function readText(deps: Deps, p: string): Promise<string | null> {
  try {
    return (await deps.fs.readFile(p)).toString('utf8');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ node

function pathDirs(deps: Deps): string[] {
  return (deps.env.PATH ?? '').split(':').filter(Boolean);
}

export async function probeNode(deps: Deps): Promise<NodeCandidate[]> {
  const raw: string[] = [deps.execPath];
  for (const d of pathDirs(deps)) raw.push(path.join(d, 'node'));
  raw.push('/opt/homebrew/bin/node', '/usr/local/bin/node');

  const seen = new Set<string>();
  const out: NodeCandidate[] = [];
  const consider = async (p: string, viaShim = false): Promise<void> => {
    if (seen.has(p) || path.basename(p) !== 'node') return;
    seen.add(p);
    if (!(await deps.fs.isExecutable(p))) return;
    const real = await deps.fs.realpath(p);
    // Volta's `node` is a link to `volta-shim`: the real file is not called node.
    const shim = isShimPath(p) || !real || path.basename(real) !== 'node';
    if (shim && !viaShim) {
      // A shim depends on shell state, so it is never used itself. Ask it where the real binary is
      // (matters when setup runs under bun, where execPath is not node).
      const r = await deps.exec([p, '-p', 'process.execPath']);
      out.push({ path: p, version: null, shim: true });
      if (r.code === 0 && r.stdout.trim()) await consider(r.stdout.trim(), true);
      return;
    }
    let version: string | null = null;
    if (!shim) {
      // launchd gives jobs almost no PATH and no shell setup; test under the same conditions.
      const r = await deps.exec(['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', p, '--version']);
      version = r.code === 0 ? r.stdout.trim() : null;
    }
    out.push({ path: p, version, shim });
  };
  for (const p of raw) await consider(p);
  return out;
}

// ------------------------------------------------------------------ runtime

async function probeRuntime(deps: Deps, versionDir: string, current: string, root: string, binary: boolean): Promise<Facts['runtime']> {
  const sourceFiles: string[] = [];
  const missingSource: string[] = [];
  // Run from the installed version itself, programs are under bin/ rather than beside package.json.
  const sourcePath = (rel: string) => path.join(deps.pkgRoot, deps.pkgRoot === versionDir ? destOf(rel, binary) : rel);
  for (const rel of requiredRuntimeFiles(binary)) {
    if (await deps.fs.exists(sourcePath(rel))) sourceFiles.push(rel);
    else missingSource.push(rel);
  }
  try {
    for (const f of (await deps.fs.readdir(path.join(deps.pkgRoot, GUIDE_DIR))).sort()) {
      if (f.endsWith('.md')) sourceFiles.push(`${GUIDE_DIR}/${f}`);
    }
  } catch {
    // Guides are optional: the server reports a missing guide itself.
  }

  let versionDirUpToDate = missingSource.length === 0;
  if (versionDirUpToDate) {
    for (const rel of sourceFiles) {
      try {
        const [a, b] = await Promise.all([
          deps.fs.readFile(sourcePath(rel)),
          deps.fs.readFile(path.join(versionDir, destOf(rel, binary))),
        ]);
        if (!a.equals(b)) {
          versionDirUpToDate = false;
          break;
        }
      } catch {
        versionDirUpToDate = false;
        break;
      }
    }
  }

  const link = await deps.fs.readlink(current);
  return {
    sourceFiles,
    missingSource,
    versionDirUpToDate,
    currentTarget: link ? path.resolve(root, link) : null,
  };
}

// ------------------------------------------------------------------ port

async function probePorts(deps: Deps): Promise<{ port: number; holder: PortHolder | null }[]> {
  const out: { port: number; holder: PortHolder | null }[] = [];
  for (const port of ALLOWED_PORTS) out.push({ port, holder: await probePort(deps, port) });
  return out;
}

async function probePort(deps: Deps, port: number): Promise<PortHolder | null> {
  const r = await deps.exec(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn']);
  if (r.code !== 0) return null;
  const hit = parseLsof(r.stdout);
  if (!hit) return null;
  const ps = await deps.exec(['ps', '-p', String(hit.pid), '-o', 'command=']);
  const command = ps.code === 0 && ps.stdout.trim() ? ps.stdout.trim() : hit.name;
  return { pid: hit.pid, command };
}

// ------------------------------------------------------------------ plugin

/** Exit 0 = running, 1 = not running; anything else (pgrep missing, odd failure) is unknown and counts as running. */
export async function figmaRunning(deps: Deps): Promise<boolean | 'unknown'> {
  const r = await deps.exec(['pgrep', '-x', 'Figma']);
  return r.code === 0 ? true : r.code === 1 ? false : 'unknown';
}

async function probePlugin(deps: Deps, manifestPath: string): Promise<PluginFacts> {
  const settingsPath = figmaSettingsPath(deps.home);
  const text = await readText(deps, settingsPath);
  const base = { settingsPath, figmaRunning: await figmaRunning(deps) };
  if (text === null) return { ...base, settingsExists: false, registered: false, malformed: false };
  const reg = inspectRegistry(text, path.dirname(manifestPath));
  // Figma silently drops an entry whose files are missing, so a registry entry alone does not mean the plugin shows up.
  let registered = reg.registered;
  if (registered) for (const f of pluginPaths(path.dirname(manifestPath))) if (!(await deps.fs.exists(f))) registered = false;
  return { ...base, settingsExists: true, registered, malformed: reg.malformed };
}

// ------------------------------------------------------------------ skill

async function probeSkillFiles(deps: Deps): Promise<string[]> {
  const root = path.join(deps.pkgRoot, SKILL_SRC_DIR);
  const files: string[] = [];
  if (await deps.fs.exists(path.join(root, 'SKILL.md'))) files.push('SKILL.md');
  try {
    for (const f of (await deps.fs.readdir(path.join(root, 'references'))).sort()) if (f.endsWith('.md')) files.push(`references/${f}`);
  } catch {
    // No references folder.
  }
  return files;
}

async function probeSkill(deps: Deps, target: string, files: string[]): Promise<SkillFacts> {
  const link = await deps.fs.readlink(target);
  if (link === null && !(await deps.fs.exists(target))) return { target, state: 'absent' };
  let same = files.length > 0;
  for (const rel of files) {
    try {
      const [a, b] = await Promise.all([
        deps.fs.readFile(path.join(deps.pkgRoot, SKILL_SRC_DIR, rel)),
        deps.fs.readFile(path.join(target, rel)),
      ]);
      if (!a.equals(b)) same = false;
    } catch {
      same = false;
    }
  }
  if (same) return { target, state: 'current' };
  // A link is the user's own arrangement (one copy shared by several agents): never write through it.
  return { target, state: link !== null ? 'foreign-link' : 'stale' };
}

// ------------------------------------------------------------------ agents

/** Compare `v24.10.0`-style folder names, newest first. */
function byVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** bin folders of node versions installed with nvm. The app runs with launchd's bare PATH, which never has them. */
async function nvmBinDirs(deps: Deps): Promise<string[]> {
  const root = path.join(deps.env.NVM_DIR || path.join(deps.home, '.nvm'), 'versions', 'node');
  try {
    const versions = (await deps.fs.readdir(root)).filter((v) => /^v\d/.test(v)).sort(byVersionDesc);
    return versions.map((v) => path.join(root, v, 'bin'));
  } catch {
    return [];
  }
}

async function findBin(deps: Deps, name: string): Promise<string | null> {
  const dirs = [
    ...pathDirs(deps),
    path.join(deps.home, '.local', 'bin'),
    path.join(deps.home, '.volta', 'bin'),
    path.join(deps.home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(await nvmBinDirs(deps)),
  ];
  for (const d of dirs) {
    const p = path.join(d, name);
    if (await deps.fs.isExecutable(p)) return p;
  }
  return null;
}

function asRegistered(command: unknown, args: unknown): AgentFacts['registered'] {
  if (typeof command !== 'string' || !Array.isArray(args) || !args.every((a) => typeof a === 'string')) return 'unreadable';
  return { command, args: args as string[] };
}

async function probeClaude(deps: Deps): Promise<AgentFacts> {
  const bin = await findBin(deps, 'claude');
  if (!bin) return { bin: null, registered: null };
  // Reading the user-scope file is cheaper and safer than `claude mcp get`, which starts the server as a health check.
  const dir = deps.env.CLAUDE_CONFIG_DIR || deps.home;
  const text = await readText(deps, path.join(dir, '.claude.json'));
  if (text === null) return { bin, registered: null };
  try {
    const entry = JSON.parse(text)?.mcpServers?.[SERVER_NAME];
    if (entry === undefined) return { bin, registered: null };
    return { bin, registered: asRegistered(entry?.command, entry?.args ?? []) };
  } catch {
    return { bin, registered: 'unreadable' };
  }
}

async function probeCodex(deps: Deps): Promise<AgentFacts> {
  const bin = await findBin(deps, 'codex');
  if (!bin) return { bin: null, registered: null };
  const r = await deps.exec([bin, 'mcp', 'get', SERVER_NAME, '--json']);
  if (r.code !== 0) {
    const out = `${r.stderr ?? ''}\n${r.stdout ?? ''}`;
    if (/No MCP server named/i.test(out)) return { bin, registered: null };
    const error = out.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? `exit code ${r.code}`;
    return { bin, registered: 'unreadable', error: error.slice(0, 200) };
  }
  try {
    const t = JSON.parse(r.stdout)?.transport;
    return { bin, registered: t?.type === 'stdio' ? asRegistered(t.command, t.args ?? []) : 'unreadable' };
  } catch {
    return { bin, registered: 'unreadable' };
  }
}
