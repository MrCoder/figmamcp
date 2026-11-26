import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { executePlan, exitCodeFor, installRuntime } from '../../../../setup/execute.js';
import { gatherFacts } from '../../../../setup/probe.js';
import { layoutFor, planSetup } from '../../../../setup/plan.js';
import { manualImporter } from '../../../../setup/importer.js';
import type { Plan, Step } from '../../../../setup/types.js';
import { HOME, NODE, PKG, doneFacts, freePorts, freshFacts, makeDeps, memFs, scriptedExec } from './fakes.js';

const L = layoutFor(HOME, '1.2.3');
const stepOf = (steps: Step[], id: string) => steps.find((s) => s.id === id)!;

const pkgFiles = (marker = 'v1') => ({
  [`${PKG}/package.json`]: '{"name":"figmamcp","version":"1.2.3"}',
  [`${PKG}/dist/server.js`]: `server ${marker}`,
  [`${PKG}/dist/socket.js`]: `socket ${marker}`,
  [`${PKG}/figma_plugin/manifest.json`]: '{}',
  [`${PKG}/figma_plugin/code.js`]: 'code',
  [`${PKG}/figma_plugin/ui.html`]: 'ui',
  [`${PKG}/skills/figmamcp/SKILL.md`]: 'the skill',
  [`${PKG}/skills/figmamcp/references/workflows.md`]: 'w',
});

/** Exec that behaves like a machine where launchctl works and the relay starts listening after bootstrap. */
function machine() {
  let listening = false;
  let codexReg: { command: string; args: string[] } | null = null;
  const s = scriptedExec((argv) => {
    if (argv[0] === 'lsof') return listening ? { code: 0, stdout: 'p900\ncnode\n' } : { code: 1 };
    if (argv[0] === 'ps') return { code: 0, stdout: `${NODE} ${L.relayPath}` };
    if (argv[0] === 'launchctl' && argv[1] === 'bootstrap') {
      listening = true;
      return { code: 0 };
    }
    if (argv[0] === 'launchctl') return { code: 0 };
    if (argv[0] === '/usr/bin/env') return { code: 0, stdout: 'v22.1.0' };
    if (argv[1] === 'mcp' && argv[2] === 'get') {
      return codexReg
        ? { code: 0, stdout: JSON.stringify({ transport: { type: 'stdio', ...codexReg } }) }
        : { code: 1, stderr: "No MCP server named 'figmamcp'" };
    }
    if (argv[0] === '/bin/codex' && argv[1] === 'mcp' && argv[2] === 'add') codexReg = { command: argv[5], args: [argv[6]] };
    if (argv[1] === 'mcp') return { code: 0 };
    if (argv[0] === 'pbcopy') return { code: 0 };
    return undefined;
  });
  return s;
}

async function run(m: ReturnType<typeof memFs>, ex: ReturnType<typeof machine>) {
  const deps = makeDeps({
    fsApi: m.fs,
    exec: ex.exec,
    execPath: NODE,
    env: { PATH: '/bin' },
  });
  const facts = await gatherFacts(deps, '1.2.3');
  const plan = planSetup(facts);
  const steps = await executePlan(plan, deps, manualImporter);
  return { plan, steps, deps };
}

describe('installRuntime', () => {
  it('copies into a temp dir, renames it into versions/<v>, and points `current` at it with a relative link', async () => {
    const m = memFs(pkgFiles());
    const files = ['package.json', 'dist/server.js', 'dist/socket.js', 'figma_plugin/manifest.json'];
    await installRuntime({ kind: 'install-runtime', version: '1.2.3', pkgRoot: PKG, files, copy: true, layout: L }, makeDeps({ fsApi: m.fs }));
    expect((await m.fs.readFile(`${L.versionDir}/dist/server.js`)).toString()).toBe('server v1');
    expect(await m.fs.readlink(L.current)).toBe('versions/1.2.3');
    // No temp leftovers.
    expect([...m.nodes.keys()].filter((k) => k.includes('.tmp-') || k.includes('.old-'))).toEqual([]);
    // The new tree was never written in place: the final dir only appears via rename.
    expect(m.writes.filter((w) => w.startsWith(L.versionDir + '/'))).toEqual([]);
  });

  it('replaces an existing version directory with new content', async () => {
    const m = memFs({ ...pkgFiles('v2'), [`${L.versionDir}/dist/server.js`]: 'server v1', [`${L.versionDir}/stale.txt`]: 'x' });
    await installRuntime({ kind: 'install-runtime', version: '1.2.3', pkgRoot: PKG, files: ['dist/server.js'], copy: true, layout: L }, makeDeps({ fsApi: m.fs }));
    expect((await m.fs.readFile(`${L.versionDir}/dist/server.js`)).toString()).toBe('server v2');
    expect(await m.fs.exists(`${L.versionDir}/stale.txt`)).toBe(false);
  });

  it('copy=false only moves the link', async () => {
    const m = memFs({ [`${L.versionDir}/dist/server.js`]: 'kept' });
    await installRuntime({ kind: 'install-runtime', version: '1.2.3', pkgRoot: PKG, files: [], copy: false, layout: L }, makeDeps({ fsApi: m.fs }));
    expect((await m.fs.readFile(`${L.versionDir}/dist/server.js`)).toString()).toBe('kept');
    expect(await m.fs.readlink(L.current)).toBe('versions/1.2.3');
  });
});

describe('setup end to end on an in-memory machine', () => {
  it('first run does the work; second run finds every automatic step ok and does nothing', async () => {
    const m = memFs(pkgFiles(), ['/Applications/Figma.app', '/bin/claude', '/bin/codex', NODE], { [NODE]: NODE });
    const ex = machine();
    const first = await run(m, ex);
    for (const id of ['runtime', 'relay', 'agent-claude', 'agent-codex', 'skill', 'plugin']) expect(stepOf(first.steps, id).status).toBe('ok');
    expect(exitCodeFor(first.plan, first.steps)).toBe(0);
    expect(await m.fs.exists(L.plistPath)).toBe(true);
    expect(ex.calls.some((c) => c.argv.join(' ') === `launchctl bootstrap gui/501 ${L.plistPath}`)).toBe(true);
    expect(ex.calls.find((c) => c.argv[0] === 'pbcopy')?.input).toBe(L.manifestPath);
    expect((await m.fs.readFile(`${HOME}/.claude/skills/figmamcp/SKILL.md`)).toString()).toBe('the skill');
    expect((await m.fs.readFile(`${HOME}/.codex/skills/figmamcp/references/workflows.md`)).toString()).toBe('w');
    expect((await m.fs.readFile(`${L.root}/config.json`)).toString()).toBe('{"port":3155}\n');

    // Simulate agents now being registered (the fake `mcp add` does not persist).
    const claudeAdd = ex.calls.find((c) => c.argv[1] === 'mcp' && c.argv[2] === 'add' && c.argv[0] === '/bin/claude')!;
    m.put(`${HOME}/.claude.json`, JSON.stringify({ mcpServers: { figmamcp: { command: claudeAdd.argv[7], args: [claudeAdd.argv[8]] } } }));

    const writesBefore = m.writes.length;
    const callsBefore = ex.calls.length;
    const second = await run(m, ex);
    expect(stepOf(second.plan.steps, 'runtime').status).toBe('ok');
    expect(stepOf(second.plan.steps, 'relay').status).toBe('ok');
    expect(stepOf(second.plan.steps, 'agent-claude').status).toBe('ok');
    expect(m.writes.length).toBe(writesBefore);
    const mutating = ex.calls.slice(callsBefore).filter((c) => c.argv[0] === 'launchctl' || (c.argv[1] === 'mcp' && c.argv[2] !== 'get') || c.argv[0] === '/bin/claude');
    expect(mutating).toEqual([]);
  });
});

describe('executePlan failures', () => {
  it('a failing agent command marks only that step FAIL, with the command to try by hand', async () => {
    const plan = planSetup(freshFacts());
    const ex = scriptedExec((argv) => (argv[0] === '/bin/claude' ? { code: 1, stderr: 'boom\nmore' } : { code: 0, stdout: 'p1\ncn\n' }));
    const m = memFs(pkgFiles());
    const steps = await executePlan(plan, makeDeps({ fsApi: m.fs, exec: ex.exec }), manualImporter);
    const claude = stepOf(steps, 'agent-claude');
    expect(claude.status).toBe('fail');
    expect(claude.detail).toContain('boom');
    expect(claude.fix).toContain('claude mcp add');
    expect(stepOf(steps, 'agent-codex').status).toBe('ok');
    expect(exitCodeFor(plan, steps)).toBe(3);
  });

  it('if the runtime cannot be installed, relay/agents/plugin are skipped, not run against missing files', async () => {
    const plan = planSetup(freshFacts());
    const ex = scriptedExec(() => ({ code: 0 }));
    const m = memFs({}); // package files absent: copying throws
    const steps = await executePlan(plan, makeDeps({ fsApi: m.fs, exec: ex.exec }), manualImporter);
    expect(stepOf(steps, 'runtime').status).toBe('fail');
    for (const id of ['relay', 'agent-claude', 'agent-codex', 'skill', 'plugin']) expect(stepOf(steps, id).status).toBe('skip');
    expect(ex.calls).toEqual([]);
  });

  it('a relay that never listens fails with the log path', async () => {
    const plan = planSetup(freshFacts());
    const ex = scriptedExec((argv) => (argv[0] === 'lsof' ? { code: 1 } : { code: 0 }));
    const m = memFs(pkgFiles());
    let slept = 0;
    const steps = await executePlan(plan, makeDeps({ fsApi: m.fs, exec: ex.exec, sleep: async (ms) => void (slept += ms) }), manualImporter);
    const relay = stepOf(steps, 'relay');
    expect(relay.status).toBe('fail');
    expect(relay.detail).toContain('relay.err.log');
    expect(slept).toBeGreaterThanOrEqual(8000);
  });

  it('a bootout that fails (nothing loaded yet) is ignored', async () => {
    const plan = planSetup(doneFacts({ relay: freePorts({}, 3155, null) }));
    const ex = scriptedExec((argv) => {
      if (argv[1] === 'bootout') return { code: 3, stderr: 'Boot-out failed: 5' };
      if (argv[0] === 'lsof') return { code: 0, stdout: 'p1\ncn\n' };
      return { code: 0 };
    });
    const m = memFs({});
    const steps = await executePlan(plan, makeDeps({ fsApi: m.fs, exec: ex.exec }), manualImporter);
    expect(stepOf(steps, 'relay').status).toBe('ok');
  });

  it('keeps trying to start the relay while launchd is still removing the old one', async () => {
    const plan = planSetup(doneFacts({ relay: freePorts({}, 3155, null) }));
    let tries = 0;
    const ex = scriptedExec((argv) => {
      if (argv[1] === 'bootstrap') return ++tries < 3 ? { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : { code: 0 };
      if (argv[0] === 'lsof') return { code: 0, stdout: 'p1\ncn\n' };
      return { code: 0 };
    });
    const steps = await executePlan(plan, makeDeps({ fsApi: memFs({}).fs, exec: ex.exec }), manualImporter);
    expect(stepOf(steps, 'relay').status).toBe('ok');
    expect(tries).toBe(3);
  });

  it('reports the failure when the relay never starts, after a bounded number of tries', async () => {
    const plan = planSetup(doneFacts({ relay: freePorts({}, 3155, null) }));
    let tries = 0;
    const ex = scriptedExec((argv) => {
      if (argv[1] === 'bootstrap') {
        tries++;
        return { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
      }
      return { code: 0 };
    });
    const steps = await executePlan(plan, makeDeps({ fsApi: memFs({}).fs, exec: ex.exec }), manualImporter);
    expect(stepOf(steps, 'relay').status).toBe('fail');
    expect(tries).toBe(10);
  });
});

describe('manual plugin importer', () => {
  it('copies the manifest path to the clipboard and prints the Figma menu path and the file', async () => {
    const ex = scriptedExec(() => ({ code: 0 }));
    const r = await manualImporter.run({ manifestPath: L.manifestPath, deps: makeDeps({ exec: ex.exec }) });
    expect(ex.calls).toEqual([{ argv: ['pbcopy'], input: L.manifestPath }]);
    const text = r.lines.join('\n');
    expect(text).toContain('Plugins > Development > Import plugin from manifest');
    expect(text).toContain(L.manifestPath);
    expect(path.basename(L.manifestPath)).toBe('manifest.json');
  });

  it('if the clipboard is unavailable, still shows the path to type', async () => {
    const ex = scriptedExec(() => ({ code: 1 }));
    const r = await manualImporter.run({ manifestPath: L.manifestPath, deps: makeDeps({ exec: ex.exec }) });
    expect(r.lines.join('\n')).toContain('type this path');
    expect(r.lines.join('\n')).toContain(L.manifestPath);
  });
});

describe('end to end: port choice and binaries', () => {
  it('3155 held by a foreign program: relay runs on 3156, config.json says 3156, plist passes --port 3156, wait is on 3156', async () => {
    const m = memFs(pkgFiles(), ['/Applications/Figma.app', '/bin/claude', '/bin/codex', NODE], { [NODE]: NODE });
    let listening = false;
    const ex = scriptedExec((argv) => {
      if (argv[0] === 'lsof') {
        if (argv.includes('-iTCP:3155')) return { code: 0, stdout: 'p55\ncother\n' };
        return listening && argv.includes('-iTCP:3156') ? { code: 0, stdout: 'p900\ncnode\n' } : { code: 1 };
      }
      if (argv[0] === 'ps') return { code: 0, stdout: '/usr/bin/other' };
      if (argv[1] === 'bootstrap') listening = true;
      if (argv[0] === '/usr/bin/env') return { code: 0, stdout: 'v22.1.0' };
      if (argv[1] === 'mcp' && argv[2] === 'get') return { code: 1, stderr: "No MCP server named 'figmamcp'" };
      if (argv[0] === 'pgrep') return { code: 1 };
      return { code: 0 };
    });
    const deps = makeDeps({ fsApi: m.fs, exec: ex.exec, execPath: NODE, env: { PATH: '/bin' } });
    const plan = planSetup(await gatherFacts(deps, '1.2.3'));
    const steps = await executePlan(plan, deps, manualImporter);
    expect(stepOf(steps, 'relay').status).toBe('ok');
    expect((await m.fs.readFile(`${L.root}/config.json`)).toString()).toBe('{"port":3156}\n');
    expect((await m.fs.readFile(L.plistPath)).toString()).toMatch(/<string>--port<\/string>\s*<string>3156<\/string>/);
  });

  it('binary install: executables land in bin/ with the executable bit; plugin files keep their paths', async () => {
    const BL = layoutFor(HOME, '1.2.3', true);
    const m = memFs({
      [`${PKG}/package.json`]: '{"name":"figmamcp","version":"1.2.3"}',
      [`${PKG}/figmamcp`]: 'cli',
      [`${PKG}/figmamcp-server`]: 'srv',
      [`${PKG}/figmamcp-relay`]: 'rel',
      [`${PKG}/figma_plugin/manifest.json`]: '{}',
      [`${PKG}/figma_plugin/code.js`]: 'c',
      [`${PKG}/figma_plugin/ui.html`]: 'u',
    });
    const files = ['package.json', 'figmamcp', 'figmamcp-server', 'figmamcp-relay', 'figma_plugin/manifest.json'];
    const map = { figmamcp: 'bin/figmamcp', 'figmamcp-server': 'bin/figmamcp-server', 'figmamcp-relay': 'bin/figmamcp-relay' };
    await installRuntime({ kind: 'install-runtime', version: '1.2.3', pkgRoot: PKG, files, copy: true, map, layout: BL }, makeDeps({ fsApi: m.fs }));
    expect((await m.fs.readFile(`${BL.versionDir}/bin/figmamcp-server`)).toString()).toBe('srv');
    expect((await m.fs.readFile(`${BL.versionDir}/figma_plugin/manifest.json`)).toString()).toBe('{}')
    expect(await m.fs.readlink(BL.current)).toBe('versions/1.2.3');
    // Modes were recorded on the temp copy (the final dir appears via rename); all three are 0o755, nothing else sets a mode.
    expect([...m.modes.entries()].map(([p, md]) => [p.split('/').pop(), md]).sort()).toEqual([
      ['figmamcp', 0o755],
      ['figmamcp-relay', 0o755],
      ['figmamcp-server', 0o755],
    ]);
  });

  it('skill: idempotent (second run writes nothing), and a link to somewhere else is never written through', async () => {
    const m = memFs(pkgFiles(), ['/Applications/Figma.app', '/bin/claude', '/bin/codex', NODE], { [NODE]: NODE });
    await m.fs.mkdir(`${HOME}/.codex/skills`);
    await m.fs.mkdir('/shared/figmamcp');
    m.put('/shared/figmamcp/SKILL.md', 'someone else’s');
    await m.fs.symlink('/shared/figmamcp', `${HOME}/.codex/skills/figmamcp`);
    const ex = machine();
    const first = await run(m, ex);
    expect(stepOf(first.steps, 'skill').status).toBe('ok');
    expect((await m.fs.readFile(`${HOME}/.claude/skills/figmamcp/SKILL.md`)).toString()).toBe('the skill');
    expect((await m.fs.readFile('/shared/figmamcp/SKILL.md')).toString()).toBe('someone else’s');
    expect(await m.fs.readlink(`${HOME}/.codex/skills/figmamcp`)).toBe('/shared/figmamcp');
    const before = m.writes.filter((w) => w.includes('skills')).length;
    const second = await run(m, ex);
    expect(stepOf(second.plan.steps, 'skill').actions).toEqual([]);
    expect(m.writes.filter((w) => w.includes('skills')).length).toBe(before);
  });
});

// keep the Plan import used for typing clarity
export type _P = Plan;
