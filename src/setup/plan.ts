import path from 'node:path';
import type {
  AgentFacts,
  Action,
  Facts,
  Layout,
  NodeCandidate,
  Plan,
  PortHolder,
  SkillFacts,
  Step,
} from './types.js';
import { EXIT } from './types.js';

export const RELAY_LABEL = 'com.figmamcp.relay';
/** The plugin tries these in order and the server reads the one setup picked from ~/.figmamcp/config.json. */
export const ALLOWED_PORTS = [3155, 3156, 3157, 3158] as const;
export const SERVER_NAME = 'figmamcp';
export const FIGMA_DOWNLOAD_URL = 'https://www.figma.com/downloads/';
export const MIN_NODE_MAJOR = 20;
export const PLUGIN_ID = 'figmamcp-local';
export const SKILL_NAME = 'figmamcp';

const PLUGIN_FILES = ['figma_plugin/manifest.json', 'figma_plugin/code.js', 'figma_plugin/ui.html'] as const;
/**
 * The CLI as a user or agent runs it. FigmaMCP is not on npm: the CLI ships inside the Mac app,
 * and setup does not put it on PATH, so printed commands use the full path.
 */
export const CLI_COMMAND = '/Applications/FigmaMCP.app/Contents/Resources/bin/figmamcp';
/** What to do when the installed files are incomplete. */
export const FRESH_DOWNLOAD = `Download FigmaMCP again from https://figmamcp.dev, then run: ${CLI_COMMAND} setup`;

export const BINARY_NAMES = ['figmamcp', 'figmamcp-server', 'figmamcp-relay'] as const;

/** Files copied from the package (or the binary folder) into the stable runtime. Paths are relative to the resources root. */
export const REQUIRED_RUNTIME_FILES = ['package.json', 'dist/server.js', 'dist/socket.js', ...PLUGIN_FILES] as const;
export const REQUIRED_BINARY_FILES = ['package.json', ...BINARY_NAMES, ...PLUGIN_FILES] as const;

export function requiredRuntimeFiles(binary: boolean): readonly string[] {
  return binary ? REQUIRED_BINARY_FILES : REQUIRED_RUNTIME_FILES;
}

/** Where a source file lands inside versions/<v>: binaries go to bin/, everything else keeps its path. */
export function destOf(rel: string, binary: boolean): string {
  return binary && (BINARY_NAMES as readonly string[]).includes(rel) ? `bin/${rel}` : rel;
}

export function isExecutableFile(rel: string, binary: boolean): boolean {
  return binary && (BINARY_NAMES as readonly string[]).includes(rel);
}

/** Directory whose *.md files are also copied (the server serves them as `figmamcp://guide/*`). */
export const GUIDE_DIR = 'skills/figmamcp/references';
export const SKILL_SRC_DIR = 'skills/figmamcp';

export function figmaAppCandidates(home: string): string[] {
  return ['/Applications/Figma.app', path.join(home, 'Applications', 'Figma.app')];
}

export function figmaSettingsPath(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'Figma', 'settings.json');
}

export function layoutFor(home: string, version: string, binary = false): Layout {
  const root = path.join(home, '.figmamcp');
  const versionsDir = path.join(root, 'versions');
  const versionDir = path.join(versionsDir, version);
  const current = path.join(root, 'current');
  return {
    root,
    versionsDir,
    versionDir,
    current,
    binary,
    serverPath: binary ? path.join(current, 'bin', 'figmamcp-server') : path.join(current, 'dist', 'server.js'),
    relayPath: binary ? path.join(current, 'bin', 'figmamcp-relay') : path.join(current, 'dist', 'socket.js'),
    manifestPath: path.join(current, 'figma_plugin', 'manifest.json'),
    logDir: path.join(root, 'logs'),
    plistPath: path.join(home, 'Library', 'LaunchAgents', `${RELAY_LABEL}.plist`),
  };
}

export function configPath(layout: Layout): string {
  return path.join(layout.root, 'config.json');
}

/** The command that starts a program: `node <file>` for the npm package, the executable itself for binaries. */
export function programCommand(node: string | null, layout: Layout, which: 'server' | 'relay'): { command: string; args: string[] } {
  const file = which === 'server' ? layout.serverPath : layout.relayPath;
  return layout.binary || node === null ? { command: file, args: [] } : { command: node, args: [file] };
}

// ------------------------------------------------------------------ port

/**
 * Pure port choice. Keep the configured port when our relay holds it, else any port our relay holds
 * (it is already running there), else the configured port if it is free, else the first free port.
 * Returns null when all allowed ports belong to other programs.
 */
export function choosePort(f: Facts): number | null {
  const ours = (h: PortHolder | null) => h !== null && isOurRelay(h, f.home);
  const byPort = new Map(f.relay.ports.map((p) => [p.port, p.holder]));
  const cfg = f.relay.configPort;
  if (cfg !== null && byPort.has(cfg) && ours(byPort.get(cfg)!)) return cfg;
  for (const p of f.relay.ports) if (ours(p.holder)) return p.port;
  if (cfg !== null && byPort.has(cfg) && byPort.get(cfg) === null) return cfg;
  for (const p of f.relay.ports) if (p.holder === null) return p.port;
  return null;
}

export function configContent(existing: string | null, port: number): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed = existing === null ? null : JSON.parse(existing);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
  } catch {
    // An unreadable config is ours to replace: it only ever holds the port.
  }
  return JSON.stringify({ ...base, port }) + '\n';
}

// ------------------------------------------------------------------ node

const SHIM_RE = /(\/\.volta\/bin\/|\/shims\/|\/\.nodenv\/|\/\.asdf\/|\/mise\/)/;

export function isShimPath(p: string): boolean {
  return SHIM_RE.test(p);
}

export function nodeMajor(version: string | null): number | null {
  const m = version ? /^v?(\d+)\./.exec(version.trim()) : null;
  return m ? Number(m[1]) : null;
}

/** First candidate that runs under a minimal PATH, is real node (not a shim) and is >= 20. */
export function pickNode(cands: NodeCandidate[]): NodeCandidate | null {
  for (const c of cands) {
    if (c.shim) continue;
    const major = nodeMajor(c.version);
    if (major !== null && major >= MIN_NODE_MAJOR) return c;
  }
  return null;
}

// ------------------------------------------------------------------ relay

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildPlist(opts: { node: string | null; layout: Layout; port: number }): string {
  const { node, layout, port } = opts;
  const out = path.join(layout.logDir, 'relay.out.log');
  const err = path.join(layout.logDir, 'relay.err.log');
  const cmd = programCommand(node, layout, 'relay');
  const argv = [cmd.command, ...cmd.args, '--port', String(port)];
  const args = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${RELAY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(out)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(err)}</string>
</dict>
</plist>
`;
}

/** Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpcn` output into the first listening process. */
export function parseLsof(out: string): { pid: number; name: string } | null {
  let pid: number | null = null;
  let name = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      if (pid !== null) break; // only the first process
      pid = Number(line.slice(1));
    } else if (line.startsWith('c') && pid !== null && !name) {
      name = line.slice(1);
    }
  }
  return pid !== null && Number.isInteger(pid) ? { pid, name } : null;
}

export function isOurRelay(holder: PortHolder, home: string): boolean {
  return holder.command.includes(`${path.join(home, '.figmamcp')}${path.sep}`);
}

// ------------------------------------------------------------------ agents

export function mcpJsonSnippet(cmd: { command: string; args: string[] }): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: cmd.command, args: cmd.args } } }, null, 2);
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shellLine(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}

export function agentArgv(agent: 'claude' | 'codex', bin: string, cmd: { command: string; args: string[] }) {
  const prog = [cmd.command, ...cmd.args];
  if (agent === 'claude') {
    return {
      add: [bin, 'mcp', 'add', '-s', 'user', SERVER_NAME, '--', ...prog],
      // `claude mcp add` refuses to overwrite, so an update is remove + add.
      remove: [bin, 'mcp', 'remove', SERVER_NAME, '-s', 'user'] as string[] | null,
    };
  }
  // `codex mcp add` overwrites an existing entry in place.
  return { add: [bin, 'mcp', 'add', SERVER_NAME, '--', ...prog], remove: null as string[] | null };
}

function sameCommand(reg: { command: string; args: string[] }, cmd: { command: string; args: string[] }): boolean {
  return reg.command === cmd.command && reg.args.length === cmd.args.length && reg.args.every((a, i) => a === cmd.args[i]);
}

function planAgent(agent: 'claude' | 'codex', facts: AgentFacts, cmd: { command: string; args: string[] }): Step {
  const id = agent === 'claude' ? 'agent-claude' : 'agent-codex';
  const title = agent === 'claude' ? 'Claude Code' : 'Codex';
  if (!facts.bin) {
    return { id, title, status: 'skip', detail: `${agent} was not found on this Mac. Nothing to do for it.`, actions: [] };
  }
  const { add, remove } = agentArgv(agent, facts.bin, cmd);
  const manual = shellLine(add);
  if (facts.registered === 'unreadable') {
    return {
      id,
      title,
      status: 'fail',
      detail: facts.error
        ? `${title} did not answer when FigmaMCP checked it: ${facts.error}`
        : `${title} already has something called "${SERVER_NAME}" that FigmaMCP could not read, so it was left alone.`,
      fix: `Check it with: ${agent} mcp list. To set it by hand, run: ${manual}`,
      actions: [],
    };
  }
  const reg = facts.registered;
  if (reg && sameCommand(reg, cmd)) {
    return { id, title, status: 'ok', detail: `Already connected to ${title}.`, actions: [] };
  }
  const actions: Action[] = [];
  if (reg && remove) actions.push({ kind: 'exec', argv: remove, label: `remove the old ${title} entry` });
  actions.push({ kind: 'exec', argv: add, label: `connect ${title}` });
  return {
    id,
    title,
    status: 'todo',
    done: `Connected FigmaMCP to ${title}. Restart ${title} to load it.`,
    detail: reg
      ? `${title} points at an older location (${reg.command} ${reg.args.join(' ')}). It will be updated.`
      : `Connect FigmaMCP to ${title}.`,
    actions,
  };
}

function planSkill(f: Facts): Step {
  const title = 'AI skill';
  const targets: { agent: string; s: SkillFacts }[] = [];
  if (f.skills.claude) targets.push({ agent: 'Claude Code', s: f.skills.claude });
  if (f.skills.codex) targets.push({ agent: 'Codex', s: f.skills.codex });
  if (targets.length === 0) {
    return { id: 'skill', title, status: 'skip', detail: 'Neither Claude Code nor Codex was found, so there is nowhere to put the skill.', actions: [] };
  }
  const from = path.join(f.pkgRoot, SKILL_SRC_DIR);
  const files = f.skillFiles;
  const actions: Action[] = [];
  const left: string[] = [];
  const names: string[] = [];
  for (const { agent, s } of targets) {
    if (s.state === 'foreign-link') {
      left.push(`${s.target} is a link to something else, so it was left alone`);
    } else if (s.state !== 'current') {
      actions.push({ kind: 'copy-skill', from, to: s.target, files });
      names.push(agent);
    }
  }
  if (actions.length === 0) {
    return left.length
      ? { id: 'skill', title, status: 'skip', detail: left.join('; ') + '.', actions: [] }
      : { id: 'skill', title, status: 'ok', detail: 'The FigmaMCP skill is installed and up to date.', actions: [] };
  }
  if (files.length === 0) {
    return { id: 'skill', title, status: 'fail', detail: 'The package has no skill files to install.', fix: FRESH_DOWNLOAD, actions: [] };
  }
  return {
    id: 'skill',
    title,
    status: 'todo',
    done: `Installed the FigmaMCP skill for ${names.join(' and ')}.`,
    detail: `Install the FigmaMCP skill for ${names.join(' and ')}.`,
    actions,
  };
}

// ------------------------------------------------------------------ plan

export function planSetup(f: Facts): Plan {
  const steps: Step[] = [];
  const stop = (code: number): Plan => ({ steps, stopCode: code, layout: null, nodePath: null, next: [], port: null });

  if (f.platform !== 'darwin') {
    steps.push({
      id: 'platform',
      title: 'Operating system',
      status: 'fail',
      detail: `This setup only supports macOS for now (this computer reports "${f.platform}").`,
      fix: 'Use a Mac, or set FigmaMCP up by hand: see the README.',
      actions: [],
    });
    return stop(EXIT.WRONG_PLATFORM);
  }
  steps.push({ id: 'platform', title: 'Operating system', status: 'ok', detail: 'macOS detected.', actions: [] });

  if (!f.figmaApp) {
    steps.push({
      id: 'figma',
      title: 'Figma desktop app',
      status: 'fail',
      detail:
        'The Figma desktop app was not found in /Applications or ~/Applications. ' +
        'The Figma website (browser version) cannot run this plugin; the desktop app is required.',
      fix: `Download and install it from ${FIGMA_DOWNLOAD_URL}, then run this command again.`,
      actions: [],
    });
    return stop(EXIT.NO_FIGMA);
  }
  steps.push({ id: 'figma', title: 'Figma desktop app', status: 'ok', detail: `Found ${f.figmaApp}.`, actions: [] });

  // The npm package runs on Node; the compiled binaries need nothing.
  let nodePath: string | null = null;
  if (!f.binary) {
    const node = pickNode(f.nodeCandidates);
    if (!node) {
      steps.push({
        id: 'node',
        title: 'Node.js',
        status: 'fail',
        detail: `Could not find a Node.js ${MIN_NODE_MAJOR} or newer that works outside a terminal (background jobs do not see your shell setup).`,
        fix: 'Install Node.js from https://nodejs.org (the macOS installer puts it in /usr/local/bin), then run this command again.',
        actions: [],
      });
      return stop(EXIT.FAILED);
    }
    nodePath = node.path;
    steps.push({ id: 'node', title: 'Node.js', status: 'ok', detail: `Using ${node.path} (${node.version?.trim()}).`, actions: [] });
  }

  const layout = layoutFor(f.home, f.version, f.binary);

  // ---- runtime
  let runtime: Step;
  if (f.runtime.missingSource.length > 0) {
    runtime = {
      id: 'runtime',
      title: 'FigmaMCP files',
      status: 'fail',
      detail: `The downloaded package is incomplete (missing ${f.runtime.missingSource.join(', ')}).`,
      fix: f.binary
        ? 'Download FigmaMCP again, or point --resources at the folder that holds the programs, figma_plugin and skills.'
        : FRESH_DOWNLOAD,
      actions: [],
    };
  } else if (f.runtime.versionDirUpToDate && f.runtime.currentTarget === layout.versionDir) {
    runtime = { id: 'runtime', title: 'FigmaMCP files', status: 'ok', detail: `Version ${f.version} is installed in ${layout.root}.`, actions: [] };
  } else {
    const map: Record<string, string> = {};
    for (const rel of f.runtime.sourceFiles) if (destOf(rel, f.binary) !== rel) map[rel] = destOf(rel, f.binary);
    runtime = {
      id: 'runtime',
      title: 'FigmaMCP files',
      status: 'todo',
      done: `Installed FigmaMCP ${f.version} in ${layout.root}.`,
      detail: `Copy FigmaMCP ${f.version} to ${layout.versionDir} and point ${layout.current} at it (the download cache is temporary, so a permanent copy is needed).`,
      actions: [
        {
          kind: 'install-runtime',
          version: f.version,
          pkgRoot: f.pkgRoot,
          files: f.runtime.sourceFiles,
          copy: !f.runtime.versionDirUpToDate,
          layout,
          ...(f.binary ? { map } : {}),
        },
      ],
    };
  }
  steps.push(runtime);

  // ---- relay
  const port = choosePort(f);
  steps.push(planRelay(f, nodePath, layout, runtime.status === 'todo', port));

  // ---- agents
  const serverCmd = programCommand(nodePath, layout, 'server');
  const claude = planAgent('claude', f.agents.claude, serverCmd);
  const codex = planAgent('codex', f.agents.codex, serverCmd);
  steps.push(claude, codex);
  if (!f.agents.claude.bin && !f.agents.codex.bin) {
    steps.push({
      id: 'agent-manual',
      title: 'Other agents',
      status: 'skip',
      detail: 'Neither claude nor codex was found. Add this to your agent’s MCP settings by hand:',
      notes: mcpJsonSnippet(serverCmd).split('\n'),
      actions: [],
    });
  }

  // ---- skill
  steps.push(planSkill(f));

  // ---- plugin
  steps.push(planPlugin(f, layout));

  return {
    steps,
    stopCode: null,
    layout,
    nodePath,
    port,
    next: [
      'Next: restart Claude Code or Codex so it loads the new tool.',
      'Then open a Figma file, run Plugins > Development > FigmaMCP, and ask your agent to describe the page.',
    ],
  };
}

function planPlugin(f: Facts, layout: Layout): Step {
  const title = 'Figma plugin';
  const p = f.plugin;
  if (p.registered) {
    return { id: 'plugin', title, status: 'ok', detail: 'The FigmaMCP plugin is registered in Figma.', actions: [] };
  }
  if (p.malformed) {
    return {
      id: 'plugin',
      title,
      status: 'fail',
      detail: `Figma’s settings file (${p.settingsPath}) is not in the expected shape, so FigmaMCP left it alone.`,
      fix: 'Open Figma once so it rewrites its settings, then run this command again.',
      actions: [],
    };
  }
  const state = !p.settingsExists ? 'needs-figma-launch' : p.figmaRunning === false ? 'todo' : 'needs-figma-restart';
  const detail = !p.settingsExists
    ? 'Figma has never been opened on this Mac. Open it once, then run this command again.'
    : p.figmaRunning === false
      ? 'Register the FigmaMCP plugin in Figma (Figma is closed, so this is safe).'
      : 'Register the FigmaMCP plugin in Figma. Figma is open, so this needs a restart of Figma: quit it yourself, or run with --restart-figma.';
  return { id: 'plugin', title, status: 'todo', state, detail, actions: [{ kind: 'plugin-import', manifestPath: layout.manifestPath }] };
}

function planRelay(f: Facts, node: string | null, layout: Layout, runtimeChanges: boolean, port: number | null): Step {
  const title = 'Background relay';
  if (port === null) {
    const who = f.relay.ports.map((p) => `${p.port}: ${p.holder ? `pid ${p.holder.pid} "${p.holder.command}"` : 'free'}`).join('; ');
    return {
      id: 'relay',
      title,
      status: 'fail',
      detail: `Every port FigmaMCP can use (${ALLOWED_PORTS.join(', ')}) is taken by other programs (${who}). FigmaMCP did not stop them.`,
      fix: 'Quit one of those programs (or stop its login item), then run this command again.',
      actions: [],
    };
  }
  const holder = f.relay.ports.find((p) => p.port === port)?.holder ?? null;
  const wanted = buildPlist({ node, layout, port });
  const plistMatches = f.relay.plistContent === wanted;
  const wantedConfig = configContent(f.relay.configText, port);
  const configMatches = f.relay.configPort === port;
  if (holder && plistMatches && configMatches && !runtimeChanges) {
    return { id: 'relay', title, status: 'ok', detail: `Running on port ${port} (pid ${holder.pid}) and starts at login.`, actions: [] };
  }
  const actions: Action[] = [{ kind: 'mkdir', paths: [path.dirname(layout.plistPath), layout.logDir, layout.root] }];
  if (!configMatches) actions.push({ kind: 'write-file', path: configPath(layout), content: wantedConfig });
  if (!plistMatches) actions.push({ kind: 'write-file', path: layout.plistPath, content: wanted });
  const domain = `gui/${f.uid}`;
  actions.push(
    { kind: 'exec', argv: ['launchctl', 'bootout', `${domain}/${RELAY_LABEL}`], allowFail: true, label: 'stop the old FigmaMCP relay if loaded' },
    // bootout returns before launchd has finished removing the old service; until then bootstrap fails with error 5.
    { kind: 'exec', argv: ['launchctl', 'bootstrap', domain, layout.plistPath], label: 'start the relay now and at every login', retry: { attempts: 10, delayMs: 500 } },
    {
      kind: 'wait-port',
      port,
      timeoutMs: 8000,
      failHint: `The relay did not start. See ${path.join(layout.logDir, 'relay.err.log')}.`,
    },
  );
  return {
    id: 'relay',
    title,
    status: 'todo',
    done: `Relay is running on port ${port} and will start at every login.`,
    detail: plistMatches && configMatches
      ? `Restart the FigmaMCP relay (${RELAY_LABEL}) on port ${port} so it runs the new files.`
      : `Install the login job ${RELAY_LABEL} (${layout.plistPath}) so the relay runs on port ${port} at every login.`,
    actions,
  };
}

// ------------------------------------------------------------------ describe

export function describeAction(a: Action): string {
  switch (a.kind) {
    case 'install-runtime':
      return a.copy
        ? `copy ${a.files.length} files to ${a.layout.versionDir}, then point ${a.layout.current} at it`
        : `point ${a.layout.current} at ${a.layout.versionDir}`;
    case 'mkdir':
      return `create ${a.paths.join(', ')}`;
    case 'write-file':
      return `write ${a.path}`;
    case 'exec':
      return shellLine(a.argv);
    case 'wait-port':
      return `wait up to ${a.timeoutMs / 1000}s for something to listen on port ${a.port}`;
    case 'copy-skill':
      return `copy the skill (${a.files.length} files) to ${a.to}`;
    case 'plugin-import':
      return `register ${a.manifestPath} in Figma’s plugin list (Figma must be closed)`;
  }
}
