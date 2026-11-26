import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseCommand, resourcesArg, route, runCli } from '../../../../setup/main.js';
import { layoutFor } from '../../../../setup/plan.js';
import { HOME, NODE, PKG, makeDeps, memFs, scriptedExec } from './fakes.js';

const SETTINGS = `${HOME}/Library/Application Support/Figma/settings.json`;

const readOnly = (argv: string[]) =>
  argv[0] === 'lsof' ||
  argv[0] === 'pgrep' ||
  argv[0] === 'ps' ||
  (argv[0] === '/usr/bin/env' && argv[1] === '-i') ||
  (argv[1] === 'mcp' && argv[2] === 'get');

function setup() {
  const m = memFs(
    {
      [`${PKG}/package.json`]: '{"name":"figmamcp","version":"1.2.3"}',
      [`${PKG}/dist/server.js`]: 's',
      [`${PKG}/dist/socket.js`]: 'k',
      [`${PKG}/figma_plugin/manifest.json`]: '{}',
      [`${PKG}/figma_plugin/code.js`]: 'c',
      [`${PKG}/figma_plugin/ui.html`]: 'u',
      [`${PKG}/skills/figmamcp/SKILL.md`]: 'skill',
      [SETTINGS]: '{"theme":"dark"}',
    },
    ['/Applications/Figma.app', '/bin/claude', '/bin/codex', NODE],
    { [NODE]: NODE },
  );
  const ex = scriptedExec((argv) => {
    if (argv[0] === '/usr/bin/env') return { code: 0, stdout: 'v22.0.0' };
    if (argv[0] === 'lsof') return { code: 1 };
    if (argv[0] === 'pgrep') return { code: 1 };
    if (argv[1] === 'mcp' && argv[2] === 'get') return { code: 1, stderr: "No MCP server named 'figmamcp'" };
    return { code: 0 };
  });
  const out: string[] = [];
  const err: string[] = [];
  const deps = makeDeps({ fsApi: m.fs, exec: ex.exec, execPath: NODE, env: { PATH: '/bin' } });
  return { m, ex, out, err, deps, io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) } };
}

describe('route / parseCommand', () => {
  it('only `setup` and `doctor` leave the server path; everything else starts the MCP server as before', () => {
    expect(route([])).toBe('server');
    expect(route(['--version'])).toBe('server');
    expect(route(['--help'])).toBe('server');
    expect(route(['--port', '3999'])).toBe('server');
    expect(route(['setup'])).toBe('setup');
    expect(route(['doctor', '--x'])).toBe('doctor');
    expect(route(['status', '--json'])).toBe('status');
  });
  it('parses flags', () => {
    const flags = { dryRun: false, json: false, restartFigma: false, resources: null };
    expect(parseCommand(['setup', '--dry-run'])).toEqual({ kind: 'setup', ...flags, dryRun: true });
    expect(parseCommand(['setup'])).toEqual({ kind: 'setup', ...flags });
    expect(parseCommand(['setup', '--json', '--restart-figma', '--resources', '/r'])).toEqual({ kind: 'setup', ...flags, json: true, restartFigma: true, resources: '/r' });
    expect(parseCommand(['doctor'])).toEqual({ kind: 'doctor', ...flags });
    expect(parseCommand(['status', '--json'])).toEqual({ kind: 'doctor', ...flags, json: true });
    expect(parseCommand(['status', '--restart-figma']).kind).toBe('error');
    expect(parseCommand(['setup', '--resources']).kind).toBe('error');
    expect(resourcesArg(['setup', '--resources', '/r'])).toBe('/r');
    expect(resourcesArg(['setup'])).toBeNull();
    expect(parseCommand(['setup', '--help']).kind).toBe('help');
    expect(parseCommand(['setup', '--nope']).kind).toBe('error');
    expect(parseCommand(['doctor', '--dry-run']).kind).toBe('error');
  });
});

describe('--dry-run and doctor are read-only', () => {
  for (const argv of [['setup', '--dry-run'], ['doctor'], ['status', '--json'], ['setup', '--dry-run', '--json']]) {
    it(`${argv.join(' ')}: no file writes, only read-only commands, no clipboard`, async () => {
      const s = setup();
      const code = await runCli(argv, s.deps, s.io);
      expect(s.m.writes).toEqual([]);
      expect(s.ex.calls.filter((c) => !readOnly(c.argv))).toEqual([]);
      // dry-run exits 0 when the plan can proceed; doctor exits 3 because work is still needed.
      expect(code).toBe(argv[0] === 'doctor' || argv[0] === 'status' ? 3 : 0);
      if (!argv.includes('--json')) expect(s.out.join('')).toContain('nothing is changed');
      expect(await s.m.fs.readFile(SETTINGS).then((b) => b.toString())).toBe('{"theme":"dark"}');
    });
  }

  it('dry-run prints the exact commands it would run', async () => {
    const s = setup();
    await runCli(['setup', '--dry-run'], s.deps, s.io);
    const text = s.out.join('');
    const L = layoutFor(HOME, '1.2.3');
    expect(text).toContain(`launchctl bootstrap gui/501 ${L.plistPath}`);
    expect(text).toContain(`/bin/claude mcp add -s user figmamcp -- ${NODE} ${L.serverPath}`);
    expect(text).toContain('register ' + L.manifestPath + ' in Figma');
    expect(text).toContain('copy the skill');
    expect(text).toContain(`write ${HOME}/.figmamcp/config.json`);
  });

  it('doctor reports the plugin as NEEDED until it is registered (it can now be checked)', async () => {
    const s = setup();
    await runCli(['doctor'], s.deps, s.io);
    expect(s.out.join('')).toMatch(/NEEDED\s+Figma plugin/);
  });
});

describe('--json', () => {
  it('status --json: step list with id, state, message, fix, plus figma / plugin / relay / claude / codex / skill', async () => {
    const s = setup();
    await runCli(['status', '--json'], s.deps, s.io);
    const j = JSON.parse(s.out.join(''));
    expect(Object.keys(j.steps[0]).sort()).toEqual(['fix', 'id', 'message', 'state']);
    expect(j.steps.map((x: { id: string }) => x.id)).toEqual(['platform', 'figma', 'node', 'runtime', 'relay', 'agent-claude', 'agent-codex', 'skill', 'plugin']);
    expect(j.figma).toEqual({ installed: true, running: false });
    expect(j.plugin).toEqual({ registered: false });
    expect(j.relay).toEqual({ running: false, port: 3155 });
    expect(j.claude).toEqual({ installed: true, connected: false, loaded: 0 });
    expect(j.codex).toEqual({ installed: true, connected: false, loaded: 0 });
    expect(j.skill).toEqual({ claude: false, codex: false });
    expect(j.exitCode).toBe(3);
  });

  it('status --json lists the files where FigmaMCP is open, asked from the relay on the chosen port', async () => {
    const s = setup();
    const asked: number[] = [];
    const deps = { ...s.deps, openFiles: async (port: number) => { asked.push(port); return [{ fileName: 'Checkout flow', aiSessions: 1 }, { fileName: null, aiSessions: 0 }]; } };
    await runCli(['status', '--json'], deps, s.io);
    const j = JSON.parse(s.out.join(''));
    expect(asked).toEqual([3155]);
    expect(j.openFiles).toEqual([
      { fileName: 'Checkout flow', aiSessions: 1, pluginVersion: null, outdated: false },
      { fileName: null, aiSessions: 0, pluginVersion: null, outdated: false },
    ]);
    expect(j.currentFile).toBe('Checkout flow');
  });

  it('status --json marks a FigmaMCP panel from an older version as outdated and never names it as the current file', async () => {
    const s = setup();
    const deps = {
      ...s.deps,
      openFiles: async () => [
        { fileName: 'Old panel', aiSessions: 0, pluginVersion: '1.0.0' },
        { fileName: 'Unknown build', aiSessions: 0, pluginVersion: 'unknown' },
        { fileName: 'Checkout flow', aiSessions: 0, pluginVersion: '1.2.3' },
        { fileName: 'Earlier patch', aiSessions: 0, pluginVersion: '1.2.0' },
      ],
    };
    await runCli(['status', '--json'], deps, s.io);
    const j = JSON.parse(s.out.join(''));
    // Same rule as the relay's VERSION_MISMATCH refusal: only a known version from another release line is
    // outdated. A panel from an earlier patch release still works, so the user is not asked to reopen it.
    expect(j.openFiles.map((f: { outdated: boolean }) => f.outdated)).toEqual([true, false, false, false]);
    expect(j.currentFile).toBe('Unknown build');
  });

  it('status --json still answers when the relay cannot be asked', async () => {
    const s = setup();
    const deps = { ...s.deps, openFiles: async () => { throw new Error('down'); } };
    await runCli(['status', '--json'], deps, s.io);
    const j = JSON.parse(s.out.join(''));
    expect(j.openFiles).toEqual([]);
    expect(j.currentFile).toBeNull();
  });

  it('setup --json after a real run: all ok, relay running on the chosen port, skill installed, plugin registered', async () => {
    const s = setup();
    let listening = false;
    const ex = scriptedExec((argv) => {
      if (argv[0] === '/usr/bin/env') return { code: 0, stdout: 'v22.0.0' };
      if (argv[1] === 'bootstrap') listening = true;
      if (argv[0] === 'lsof') return listening ? { code: 0, stdout: 'p1\ncn\n' } : { code: 1 };
      if (argv[0] === 'ps') return { code: 0, stdout: 'x' };
      if (argv[0] === 'pgrep') return { code: 1 };
      if (argv[1] === 'mcp' && argv[2] === 'get') return { code: 1, stderr: "No MCP server named 'figmamcp'" };
      return { code: 0 };
    });
    const code = await runCli(['setup', '--json'], { ...s.deps, exec: ex.exec }, s.io);
    const j = JSON.parse(s.out.join(''));
    expect(code).toBe(0);
    expect(j.steps.every((x: { state: string }) => x.state === 'ok')).toBe(true);
    expect(j.plugin.registered).toBe(true);
    expect(j.relay).toEqual({ running: true, port: 3155 });
    expect(j.skill).toEqual({ claude: true, codex: true });
    expect(JSON.parse(await s.m.fs.readFile(SETTINGS).then((b) => b.toString())).localFileExtensions).toHaveLength(3);
  });

  it('setup --json with Figma running and no --restart-figma: plugin state needs-figma-restart, settings untouched', async () => {
    const s = setup();
    const ex = scriptedExec((argv) => {
      if (argv[0] === '/usr/bin/env') return { code: 0, stdout: 'v22.0.0' };
      if (argv[0] === 'pgrep') return { code: 0 };
      if (argv[0] === 'lsof') return { code: 0, stdout: 'p1\ncn\n' };
      if (argv[0] === 'ps') return { code: 0, stdout: 'x' };
      if (argv[1] === 'mcp' && argv[2] === 'get') return { code: 1, stderr: "No MCP server named 'figmamcp'" };
      return { code: 0 };
    });
    await runCli(['setup', '--json'], { ...s.deps, exec: ex.exec }, s.io);
    const j = JSON.parse(s.out.join(''));
    expect(j.steps.find((x: { id: string }) => x.id === 'plugin').state).toBe('needs-figma-restart');
    expect(j.figma.running).toBe(true);
    expect(await s.m.fs.readFile(SETTINGS).then((b) => b.toString())).toBe('{"theme":"dark"}');
  });
});

describe('doctor: live checks after setup', () => {
  // A fully set-up in-memory Mac: run setup once, then ask doctor on the same machine.
  async function setUpMac(psOut = '') {
    const s = setup();
    let listening = false;
    let prog: string[] | null = null;
    const ex = scriptedExec((argv) => {
      if (argv[0] === '/usr/bin/env') return { code: 0, stdout: 'v22.0.0' };
      if (argv[1] === 'bootstrap') listening = true;
      if (argv[0] === 'lsof') return listening ? { code: 0, stdout: 'p1\ncn\n' } : { code: 1 };
      if (argv[0] === 'ps' && argv[1] === '-Axo') return { code: 0, stdout: psOut };
      if (argv[0] === 'ps') return { code: 0, stdout: `${HOME}/.figmamcp/current/bin/relay` };
      if (argv[0] === 'pgrep') return { code: 1 };
      if (argv[1] === 'mcp' && argv[2] === 'add') prog = argv.slice(argv.indexOf('--') + 1);
      if (argv[1] === 'mcp' && argv[2] === 'get') {
        return prog ? { code: 0, stdout: JSON.stringify({ transport: { type: 'stdio', command: prog[0], args: prog.slice(1) } }) } : { code: 1, stderr: "No MCP server named 'figmamcp'" };
      }
      return { code: 0 };
    });
    expect(await runCli(['setup'], { ...s.deps, exec: ex.exec }, s.io)).toBe(0);
    await s.m.fs.writeFile(`${HOME}/.claude.json`, JSON.stringify({ mcpServers: { figmamcp: { command: prog![0], args: prog!.slice(1) } } }));
    s.out.length = 0;
    // The in-memory fs does not follow the `current` link; resolve it the way the real one would.
    const real = (p: string) => p.replace(`${HOME}/.figmamcp/current/`, `${HOME}/.figmamcp/versions/1.2.3/`);
    const fs = { ...s.deps.fs, exists: (p: string) => s.m.fs.exists(real(p)) };
    return { ...s, deps: { ...s.deps, fs, exec: ex.exec } };
  }

  it('exits 4, not 0, when setup is complete but FigmaMCP is open in no Figma file, and says so', async () => {
    const s = await setUpMac();
    const code = await runCli(['doctor'], { ...s.deps, openFiles: async () => [] }, s.io);
    expect(code).toBe(4);
    expect(s.out.join('')).toContain('FigmaMCP is not open in any Figma file');
  });

  it('exits 0 once FigmaMCP is open in a file', async () => {
    const s = await setUpMac();
    const code = await runCli(['doctor'], { ...s.deps, openFiles: async () => [{ fileName: 'A', aiSessions: 0, pluginVersion: '1.2.3' }] }, s.io);
    expect(code).toBe(0);
    expect(s.out.join('')).toContain('FigmaMCP is open in 1 Figma file');
  });

  it('a panel from an older version does not count as open', async () => {
    const s = await setUpMac();
    const code = await runCli(['doctor'], { ...s.deps, openFiles: async () => [{ fileName: 'A', aiSessions: 0, pluginVersion: '1.0.0' }] }, s.io);
    expect(code).toBe(4);
  });

  it('json: pluginOpen, per-client loaded count from running servers, and finished requests', async () => {
    const ps = [
      '  100     1 /Users/tester/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude',
      '  101   100 /Users/tester/.figmamcp/current/bin/figmamcp-server',
      '  200     1 /Applications/Other.app/Contents/MacOS/codex',
      '  300     1 /usr/bin/zsh',
    ].join('\n');
    const s = await setUpMac(ps);
    const code = await runCli(['status', '--json'], { ...s.deps, openFiles: async () => [{ fileName: 'A', aiSessions: 1, pluginVersion: '1.2.3', completedCalls: 2 }] }, s.io);
    const j = JSON.parse(s.out.join(''));
    expect(code).toBe(0);
    expect(j.pluginOpen).toBe(true);
    expect(j.claude.loaded).toBe(1);
    expect(j.codex.loaded).toBe(0);
    expect(j.openFiles[0].completedCalls).toBe(2);
  });

  it('loaded: finds the client through node and sh wrappers; a server with no known client is unknown, not 0', async () => {
    const ps = [
      '  10     1 node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      '  11    10 /bin/sh -c npx figmamcp',
      '  12    11 node /Users/tester/.figmamcp/current/dist/server.js',
      '  20     1 /Applications/Codex.app/Contents/MacOS/codex',
      '  21    20 /Users/tester/.figmamcp/current/bin/figmamcp-server',
      '  30     1 /Users/tester/.figmamcp/current/bin/figmamcp doctor',
    ].join('\n');
    const s = await setUpMac(ps);
    await runCli(['status', '--json'], { ...s.deps, openFiles: async () => [] }, s.io);
    const j = JSON.parse(s.out.join(''));
    expect(j.claude.loaded).toBe(1);
    expect(j.codex.loaded).toBe(1);
    const u = await setUpMac('  5     1 /sbin/launchd\n  40     5 /Users/tester/.figmamcp/current/bin/figmamcp-server');
    await runCli(['status', '--json'], { ...u.deps, openFiles: async () => [] }, u.io);
    const k = JSON.parse(u.out.join(''));
    expect(k.claude.loaded).toBeNull();
  });

  it('text: a connected client with no running server gets the restart hint next to it', async () => {
    const s = await setUpMac('  300     1 /usr/bin/zsh');
    await runCli(['doctor'], { ...s.deps, openFiles: async () => [] }, s.io);
    expect(s.out.join('')).toContain('Claude Code has not loaded FigmaMCP yet. Restart Claude Code');
  });

  it('relay cannot be asked: no claim either way, exit stays 0', async () => {
    const s = await setUpMac();
    const code = await runCli(['doctor'], { ...s.deps, openFiles: async () => { throw new Error('down'); } }, s.io);
    expect(code).toBe(0);
    expect(s.out.join('')).toContain('Could not ask the relay');
  });
});

describe('exit codes and messages', () => {
  it('non-darwin exits 1', async () => {
    const s = setup();
    const deps = { ...s.deps, platform: 'linux' as const };
    expect(await runCli(['setup'], deps, s.io)).toBe(1);
    expect(s.out.join('')).toContain('macOS');
    expect(s.ex.calls).toEqual([]);
  });

  it('no Figma exits 2 and installs nothing', async () => {
    const m = memFs({ [`${PKG}/package.json`]: '{"name":"figmamcp","version":"1.2.3"}' });
    const s = setup();
    const deps = makeDeps({ fsApi: m.fs, exec: s.ex.exec });
    expect(await runCli(['setup'], deps, s.io)).toBe(2);
    expect(s.out.join('')).toContain('https://www.figma.com/downloads/');
    expect(m.writes).toEqual([]);
  });

  it('a real setup run on a fresh in-memory Mac exits 0 and ends with the plugin steps and next steps', async () => {
    const s = setup();
    let listening = false;
    const ex = scriptedExec((argv) => {
      if (argv[0] === '/usr/bin/env') return { code: 0, stdout: 'v22.0.0' };
      if (argv[1] === 'bootstrap') listening = true;
      if (argv[0] === 'lsof') return listening ? { code: 0, stdout: 'p1\ncn\n' } : { code: 1 };
      if (argv[0] === 'ps') return { code: 0, stdout: 'x' };
      if (argv[0] === 'pgrep') return { code: 1 };
      if (argv[1] === 'mcp' && argv[2] === 'get') return { code: 1, stderr: "No MCP server named 'figmamcp'" };
      return { code: 0 };
    });
    const deps = { ...s.deps, exec: ex.exec };
    expect(await runCli(['setup'], deps, s.io)).toBe(0);
    const text = s.out.join('');
    expect(text).toContain('Plugins > Development > FigmaMCP');
    expect(text).toContain('restart Claude Code or Codex');
    expect(text).not.toContain('FAIL');
  });

  it('resources folder without package.json: one plain message and exit 3, no stack trace, nothing written', async () => {
    const s = setup();
    const deps = { ...s.deps, pkgRoot: '/nowhere', binary: true };
    expect(await runCli(['status'], deps, s.io)).toBe(3);
    expect(s.out.join('')).toContain('--resources');
    const j = setup();
    await runCli(['status', '--json'], { ...j.deps, pkgRoot: '/nowhere' }, j.io);
    expect(JSON.parse(j.out.join('')).exitCode).toBe(3);
    expect(s.m.writes).toEqual([]);
  });

  it('unknown option exits 64 with usage on stderr', async () => {
    const s = setup();
    expect(await runCli(['setup', '--wat'], s.deps, s.io)).toBe(64);
    expect(s.err.join('')).toContain('Unknown option');
    expect(s.out).toEqual([]);
  });
});

// ---- the built bin: bare `figmamcp` must still be the stdio MCP server -----------------------
const dist = resolve(import.meta.dir, '../../../../../dist/figmamcp.js');
const pkgVersion = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../../../package.json'), 'utf8')).version;

describe.skipIf(!existsSync(dist))('built dist/figmamcp.js', () => {
  it('--version prints only the version', () => {
    const r = spawnSync('node', [dist, '--version'], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe(pkgVersion);
    expect(r.status).toBe(0);
  });

  it('--help still shows the server options and now mentions setup', () => {
    const r = spawnSync('node', [dist, '--help'], { encoding: 'utf8' });
    expect(r.stdout).toContain('--port <n>');
    expect(r.stdout).toContain('setup');
  });

  it('bare invocation answers an MCP initialize on stdout and writes nothing else there', async () => {
    const child = spawn('node', [dist, '--port', '3998'], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n',
      );
      const deadline = Date.now() + 8000;
      while (!stdout.includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const lines = stdout.split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe('2.0');
      expect(JSON.parse(lines[0]).result.serverInfo.name).toBeTruthy();
    } finally {
      child.kill('SIGKILL');
    }
  }, 15000);

  it('`setup --help` through the bin prints setup usage and exits 0', () => {
    const r = spawnSync('node', [dist, 'setup', '--dry-run', '--help'], { encoding: 'utf8' });
    expect(r.stdout).toContain('/Applications/FigmaMCP.app/Contents/Resources/bin/figmamcp setup');
    expect(r.status).toBe(0);
  });
});
