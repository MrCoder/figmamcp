import { describe, it, expect } from 'bun:test';
import {
  buildPlist,
  choosePort,
  configContent,
  layoutFor,
  parseLsof,
  pickNode,
  planSetup,
  FIGMA_DOWNLOAD_URL,
} from '../../../../setup/plan.js';
import type { Plan, Step, StepId } from '../../../../setup/types.js';
import { doneFacts, freePorts, freshFacts, HOME, NODE } from './fakes.js';

const step = (p: Plan, id: StepId): Step => {
  const s = p.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};
const L = layoutFor(HOME, '1.2.3');

describe('planSetup: platform and Figma gates', () => {
  it('non-darwin: one failing step, exit 1, nothing else planned', () => {
    const p = planSetup(freshFacts({ platform: 'linux' }));
    expect(p.stopCode).toBe(1);
    expect(p.steps.map((s) => s.id)).toEqual(['platform']);
    expect(p.steps[0].status).toBe('fail');
    expect(p.steps[0].detail).toContain('macOS');
  });

  it('Figma missing: exit 2, plain message, download link, says the browser version cannot run it', () => {
    const p = planSetup(freshFacts({ figmaApp: null }));
    expect(p.stopCode).toBe(2);
    const s = step(p, 'figma');
    expect(s.status).toBe('fail');
    expect(s.detail).toContain('browser');
    expect(s.fix).toContain(FIGMA_DOWNLOAD_URL);
    expect(p.steps.some((x) => x.id === 'runtime')).toBe(false);
  });

  it('no usable node: exit 3 before anything is planned', () => {
    const p = planSetup(freshFacts({ nodeCandidates: [{ path: '/old/node', version: 'v18.0.0', shim: false }] }));
    expect(p.stopCode).toBe(3);
    expect(step(p, 'node').status).toBe('fail');
    expect(p.steps.some((x) => x.id === 'relay')).toBe(false);
  });
});

describe('pickNode', () => {
  it('rejects shims, old versions and failed probes; takes the first good one in order', () => {
    const got = pickNode([
      { path: '/Users/x/.volta/bin/node', version: null, shim: true },
      { path: '/a/node', version: 'v18.19.0', shim: false },
      { path: '/b/node', version: null, shim: false },
      { path: '/c/node', version: 'v20.0.0', shim: false },
      { path: '/d/node', version: 'v24.1.0', shim: false },
    ]);
    expect(got?.path).toBe('/c/node');
  });
  it('rejects a shim even when it reports a good version', () => {
    expect(pickNode([{ path: '/Users/x/.volta/bin/node', version: 'v22.0.0', shim: true }])).toBeNull();
  });
});

describe('planSetup: fresh machine', () => {
  const p = planSetup(freshFacts());

  it('plans runtime, relay, both agents and the plugin, in that order', () => {
    expect(p.stopCode).toBeNull();
    expect(p.steps.map((s) => [s.id, s.status])).toEqual([
      ['platform', 'ok'],
      ['figma', 'ok'],
      ['node', 'ok'],
      ['runtime', 'todo'],
      ['relay', 'todo'],
      ['agent-claude', 'todo'],
      ['agent-codex', 'todo'],
      ['skill', 'todo'],
      ['plugin', 'todo'],
    ]);
  });

  it('puts the server, relay and plugin under ~/.figmamcp/current, never under the npx cache', () => {
    expect(L.serverPath).toBe(`${HOME}/.figmamcp/current/dist/server.js`);
    const everything = JSON.stringify(p.steps);
    expect(everything).not.toContain('/cache/npx/figmamcp/dist');
    expect(everything).toContain(L.manifestPath);
  });

  it('relay actions: mkdir, write config and plist, bootout (may fail), bootstrap, wait for the port', () => {
    const a = step(p, 'relay').actions;
    expect(a.map((x) => x.kind)).toEqual(['mkdir', 'write-file', 'write-file', 'exec', 'exec', 'wait-port']);
    expect(a[1]).toMatchObject({ path: `${HOME}/.figmamcp/config.json`, content: '{"port":3155}\n' });
    expect(a[3]).toMatchObject({ argv: ['launchctl', 'bootout', 'gui/501/com.figmamcp.relay'], allowFail: true });
    expect(a[4]).toMatchObject({ argv: ['launchctl', 'bootstrap', 'gui/501', L.plistPath] });
    expect(a[4]).not.toHaveProperty('allowFail');
    expect(a[5]).toMatchObject({ kind: 'wait-port', port: 3155 });
  });

  it('registers with claude (user scope) and codex using the absolute node and the stable server path', () => {
    expect(step(p, 'agent-claude').actions).toEqual([
      { kind: 'exec', argv: ['/bin/claude', 'mcp', 'add', '-s', 'user', 'figmamcp', '--', NODE, L.serverPath], label: 'connect Claude Code' },
    ]);
    expect(step(p, 'agent-codex').actions).toEqual([
      { kind: 'exec', argv: ['/bin/codex', 'mcp', 'add', 'figmamcp', '--', NODE, L.serverPath], label: 'connect Codex' },
    ]);
  });
});

describe('planSetup: idempotency', () => {
  it('everything already done: every automatic step is ok with zero actions', () => {
    const p = planSetup(doneFacts());
    for (const id of ['runtime', 'relay', 'agent-claude', 'agent-codex', 'skill', 'plugin'] as const) {
      expect(step(p, id).status).toBe('ok');
      expect(step(p, id).actions).toEqual([]);
    }
  });

  it('runtime is replaced, plist unchanged: relay restarts but the plist is not rewritten', () => {
    const f = doneFacts();
    f.runtime.versionDirUpToDate = false;
    const p = planSetup(f);
    expect(step(p, 'runtime').status).toBe('todo');
    const relay = step(p, 'relay');
    expect(relay.status).toBe('todo');
    expect(relay.actions.map((x) => x.kind)).toEqual(['mkdir', 'exec', 'exec', 'wait-port']);
  });

  it('relay job installed but not running: loads it without rewriting the plist', () => {
    const f = doneFacts();
    f.relay = freePorts({}, 3155, f.relay.plistContent);
    const relay = step(planSetup(f), 'relay');
    expect(relay.status).toBe('todo');
    expect(relay.actions.some((x) => x.kind === 'write-file')).toBe(false);
  });

  it('plist points at a different node: it is rewritten and reloaded', () => {
    const f = doneFacts();
    f.relay.plistContent = buildPlist({ node: '/old/node', layout: L, port: 3155 });
    const relay = step(planSetup(f), 'relay');
    expect(relay.status).toBe('todo');
    expect(relay.actions.some((x) => x.kind === 'write-file')).toBe(true);
  });
});

const FOREIGN = (pid: number) => ({ pid, command: `/usr/bin/other-program ${pid}` });
const OURS = (port: number) => ({ pid: 777, command: `${NODE} ${L.relayPath} --port ${port}` });

describe('choosePort', () => {
  const pick = (held: Parameters<typeof freePorts>[0], cfg: number | null) => choosePort(freshFacts({ relay: freePorts(held, cfg) }));

  it('nothing running, nothing configured: the first allowed port', () => {
    expect(pick({}, null)).toBe(3155);
  });
  it('the first port is held by a foreign program: the next free one', () => {
    expect(pick({ 3155: FOREIGN(1) }, null)).toBe(3156);
    expect(pick({ 3155: FOREIGN(1), 3156: FOREIGN(2) }, null)).toBe(3157);
  });
  it('keeps the configured port when our own relay holds it, even if an earlier port is free', () => {
    expect(pick({ 3157: OURS(3157) }, 3157)).toBe(3157);
  });
  it('keeps the configured port when it is free, even if an earlier port is free too', () => {
    expect(pick({}, 3157)).toBe(3157);
  });
  it('adopts the port our relay already holds when the config is missing or points elsewhere', () => {
    expect(pick({ 3156: OURS(3156) }, null)).toBe(3156);
    expect(pick({ 3156: OURS(3156) }, 3158)).toBe(3156);
  });
  it('the configured port was taken by a foreign program since: moves to another free port', () => {
    expect(pick({ 3157: FOREIGN(9) }, 3157)).toBe(3155);
  });
  it('a configured port outside the allowed list is ignored', () => {
    expect(pick({}, 3055)).toBe(3155);
  });
  it('all four held by foreign programs: no port', () => {
    expect(pick({ 3155: FOREIGN(1), 3156: FOREIGN(2), 3157: FOREIGN(3), 3158: FOREIGN(4) }, null)).toBeNull();
  });
  it('an old agentic-local-figma relay on 3055 is never looked at, so it cannot conflict', () => {
    expect(freshFacts().relay.ports.map((p) => p.port)).toEqual([3155, 3156, 3157, 3158]);
  });
});

describe('planSetup: relay port', () => {
  const relayOf = (f: ReturnType<typeof freshFacts>) => step(planSetup(f), 'relay');

  it('uses the chosen port in the plist (--port), the config file and the wait', () => {
    const f = freshFacts({ relay: freePorts({ 3155: FOREIGN(1) }, null) });
    const plan = planSetup(f);
    const relay = step(plan, 'relay');
    expect(plan.port).toBe(3156);
    const plist = relay.actions.find((a) => a.kind === 'write-file' && a.path === L.plistPath);
    expect(plist && plist.kind === 'write-file' && plist.content).toContain('<string>--port</string>\n    <string>3156</string>');
    expect(relay.actions.find((a) => a.kind === 'write-file' && a.path.endsWith('config.json'))).toMatchObject({ content: '{"port":3156}\n' });
    expect(relay.actions.find((a) => a.kind === 'wait-port')).toMatchObject({ port: 3156 });
  });

  it('all four ports foreign: one clear failure naming each holder, nothing planned, other steps still planned', () => {
    const f = freshFacts({ relay: freePorts({ 3155: FOREIGN(1), 3156: FOREIGN(2), 3157: FOREIGN(3), 3158: FOREIGN(4) }, null) });
    const plan = planSetup(f);
    const relay = step(plan, 'relay');
    expect(relay.status).toBe('fail');
    expect(relay.actions).toEqual([]);
    for (const n of ['3155', '3156', '3157', '3158', 'pid 1', 'pid 4']) expect(relay.detail).toContain(n);
    expect(relay.detail).toContain('did not stop them');
    expect(relay.fix).toContain('Quit one of those programs');
    expect(plan.port).toBeNull();
    expect(step(plan, 'agent-claude').status).toBe('todo');
  });

  it('our relay on the configured port with an up-to-date plist and config: ok, nothing to do', () => {
    expect(relayOf(doneFacts()).status).toBe('ok');
  });

  it('config.json missing although our relay runs: only the config is written, via the same restart', () => {
    const f = doneFacts();
    f.relay = { ...f.relay, configPort: null, configText: null };
    const relay = relayOf(f);
    expect(relay.status).toBe('todo');
    expect(relay.actions.some((a) => a.kind === 'write-file' && a.path.endsWith('config.json'))).toBe(true);
    expect(relay.actions.some((a) => a.kind === 'write-file' && a.path === L.plistPath)).toBe(false);
  });

  it('configContent keeps other keys and replaces garbage', () => {
    expect(configContent('{"port":3155,"x":1}', 3156)).toBe('{"port":3156,"x":1}\n');
    expect(configContent('not json', 3158)).toBe('{"port":3158}\n');
    expect(configContent(null, 3155)).toBe('{"port":3155}\n');
  });
});

describe('planSetup: standalone binaries', () => {
  const BL = layoutFor(HOME, '1.2.3', true);
  const f = freshFacts({
    binary: true,
    nodeCandidates: [],
    runtime: { sourceFiles: ['package.json', 'figmamcp', 'figmamcp-server', 'figmamcp-relay'], missingSource: [], versionDirUpToDate: false, currentTarget: null },
  });
  const p = planSetup(f);

  it('needs no Node.js: there is no node step, and a machine without node still proceeds', () => {
    expect(p.stopCode).toBeNull();
    expect(p.steps.some((s) => s.id === 'node')).toBe(false);
  });
  it('installs the executables under bin/', () => {
    const a = step(p, 'runtime').actions[0];
    expect(a).toMatchObject({ kind: 'install-runtime', map: { figmamcp: 'bin/figmamcp', 'figmamcp-server': 'bin/figmamcp-server', 'figmamcp-relay': 'bin/figmamcp-relay' } });
    expect(BL.serverPath).toBe(`${HOME}/.figmamcp/current/bin/figmamcp-server`);
  });
  it('the LaunchAgent runs the installed relay binary, not node', () => {
    const w = step(p, 'relay').actions.find((x) => x.kind === 'write-file' && x.path === L.plistPath);
    const plist = w && w.kind === 'write-file' ? w.content : '';
    expect(plist).toContain(`<string>${BL.relayPath}</string>`);
    expect(plist).not.toContain('node');
  });
  it('claude and codex are registered with the installed server binary and no arguments', () => {
    expect(step(p, 'agent-claude').actions[0]).toMatchObject({ argv: ['/bin/claude', 'mcp', 'add', '-s', 'user', 'figmamcp', '--', BL.serverPath] });
    expect(step(p, 'agent-codex').actions[0]).toMatchObject({ argv: ['/bin/codex', 'mcp', 'add', 'figmamcp', '--', BL.serverPath] });
  });
  it('an agent still registered with node + server.js is updated to the binary', () => {
    const g = freshFacts({ ...f, agents: { claude: { bin: '/bin/claude', registered: { command: NODE, args: [L.serverPath] } }, codex: f.agents.codex } });
    expect(step(planSetup(g), 'agent-claude').status).toBe('todo');
  });
});

describe('planSetup: skill', () => {
  it('copies to both agents when both are present and have no skill', () => {
    const s = step(planSetup(freshFacts()), 'skill');
    expect(s.status).toBe('todo');
    expect(s.actions.map((a) => a.kind === 'copy-skill' && a.to)).toEqual([`${HOME}/.claude/skills/figmamcp`, `${HOME}/.codex/skills/figmamcp`]);
  });
  it('skips an agent that is not installed', () => {
    const f = freshFacts();
    f.skills.codex = null;
    f.agents.codex = { bin: null, registered: null };
    expect(step(planSetup(f), 'skill').actions).toHaveLength(1);
  });
  it('refreshes a stale copy but never writes through a link to something else', () => {
    const f = freshFacts();
    f.skills.claude = { target: `${HOME}/.claude/skills/figmamcp`, state: 'stale' };
    f.skills.codex = { target: `${HOME}/.codex/skills/figmamcp`, state: 'foreign-link' };
    const s = step(planSetup(f), 'skill');
    expect(s.actions).toHaveLength(1);
    expect(s.actions[0]).toMatchObject({ to: `${HOME}/.claude/skills/figmamcp` });
  });
  it('only a foreign link: skip with an explanation, no action', () => {
    const f = freshFacts();
    f.skills.claude = { target: `${HOME}/.claude/skills/figmamcp`, state: 'foreign-link' };
    f.skills.codex = null;
    const s = step(planSetup(f), 'skill');
    expect(s.status).toBe('skip');
    expect(s.actions).toEqual([]);
  });
});

describe('planSetup: plugin registration', () => {
  it('registered: ok', () => {
    expect(step(planSetup(doneFacts()), 'plugin').status).toBe('ok');
  });
  it('Figma closed: plain todo', () => {
    const s = step(planSetup(freshFacts()), 'plugin');
    expect([s.status, s.state]).toEqual(['todo', 'todo']);
  });
  it('Figma running, or running state unknown: needs-figma-restart (fails safe)', () => {
    for (const running of [true, 'unknown'] as const) {
      const f = freshFacts();
      f.plugin.figmaRunning = running;
      expect(step(planSetup(f), 'plugin').state).toBe('needs-figma-restart');
    }
  });
  it('Figma never opened: needs-figma-launch', () => {
    const f = freshFacts();
    f.plugin.settingsExists = false;
    expect(step(planSetup(f), 'plugin').state).toBe('needs-figma-launch');
  });
  it('malformed settings: fail, nothing planned', () => {
    const f = freshFacts();
    f.plugin.malformed = true;
    const s = step(planSetup(f), 'plugin');
    expect(s.status).toBe('fail');
    expect(s.actions).toEqual([]);
  });
});

describe('planSetup: agents', () => {
  it('registered at an old path: claude is removed then added, codex is just added (it overwrites)', () => {
    const f = doneFacts();
    f.agents.claude.registered = { command: NODE, args: ['/old/server.js'] };
    f.agents.codex.registered = { command: '/old/node', args: [L.serverPath] };
    const p = planSetup(f);
    expect(step(p, 'agent-claude').actions.map((a) => (a.kind === 'exec' ? a.argv.slice(1, 3).join(' ') : a.kind))).toEqual(['mcp remove', 'mcp add']);
    expect(step(p, 'agent-codex').actions).toHaveLength(1);
  });

  it('one agent missing: that step is skipped, the other still runs, no manual snippet', () => {
    const f = freshFacts();
    f.agents.codex = { bin: null, registered: null };
    const p = planSetup(f);
    expect(step(p, 'agent-codex').status).toBe('skip');
    expect(step(p, 'agent-claude').status).toBe('todo');
    expect(p.steps.some((s) => s.id === 'agent-manual')).toBe(false);
  });

  it('neither agent found: prints a JSON snippet with the absolute node and server path', () => {
    const f = freshFacts();
    f.agents.claude = { bin: null, registered: null };
    f.agents.codex = { bin: null, registered: null };
    const manual = step(planSetup(f), 'agent-manual');
    const json = JSON.parse((manual.notes ?? []).join('\n'));
    expect(json).toEqual({ mcpServers: { figmamcp: { command: NODE, args: [L.serverPath] } } });
  });

  it('an entry we cannot read is left alone and reported', () => {
    const f = doneFacts();
    f.agents.claude.registered = 'unreadable';
    const s = step(planSetup(f), 'agent-claude');
    expect(s.status).toBe('fail');
    expect(s.actions).toEqual([]);
  });

  it('an agent that answered with an error shows that error, not "something called figmamcp"', () => {
    const f = doneFacts();
    f.agents.codex = { bin: '/bin/codex', registered: 'unreadable', error: 'env: node: No such file or directory' };
    const s = step(planSetup(f), 'agent-codex');
    expect(s.status).toBe('fail');
    expect(s.detail).toBe('Codex did not answer when FigmaMCP checked it: env: node: No such file or directory');
  });
});

describe('buildPlist', () => {
  const plist = buildPlist({ node: NODE, layout: L, port: 3157 });
  it('uses the absolute node, the stable relay path, --port, RunAtLoad and KeepAlive', () => {
    expect(plist).toContain('<string>com.figmamcp.relay</string>');
    expect(plist).toContain(`<string>${NODE}</string>`);
    expect(plist).toContain(`<string>${L.relayPath}</string>`);
    expect(plist).toMatch(/<string>--port<\/string>\s*<string>3157<\/string>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });
  it('escapes XML in paths', () => {
    expect(buildPlist({ node: '/a&b/<node>', layout: L, port: 3155 })).toContain('/a&amp;b/&lt;node&gt;');
  });
});

describe('parseLsof', () => {
  it('returns the first listening process', () => {
    expect(parseLsof('p91321\ncnode\nf14\nn[::1]:3055\np5\ncother\n')).toEqual({ pid: 91321, name: 'node' });
  });
  it('returns null for empty output', () => {
    expect(parseLsof('')).toBeNull();
  });
});
