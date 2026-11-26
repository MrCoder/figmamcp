import { describe, it, expect } from 'bun:test';
import { registryImporter, inspectRegistry, withRegistration } from '../../../../setup/importer.js';
import { layoutFor } from '../../../../setup/plan.js';
import { HOME, makeDeps, memFs, scriptedExec } from './fakes.js';

const L = layoutFor(HOME, '1.2.3');
const DIR = `${L.current}/figma_plugin`;
const SETTINGS = `${HOME}/Library/Application Support/Figma/settings.json`;
const FIGMA_APP = '/Applications/Figma.app';

/** A machine whose Figma is running or not, quits when asked, and rewrites settings on quit (as the real one does). */
function machine(opts: { settings: string | null; running: boolean; quitWorks?: boolean; rewriteOnQuit?: string; stubborn?: boolean }) {
  const m = memFs(opts.settings === null ? { [`${HOME}/Library/Application Support/Figma/x`]: '' } : { [SETTINGS]: opts.settings });
  let running = opts.running;
  const ex = scriptedExec((argv) => {
    if (argv[0] === 'pgrep') return { code: running ? 0 : 1 };
    if (argv[0] === 'osascript') {
      if (opts.quitWorks === false) return { code: 1, stderr: 'not allowed' };
      if (!opts.stubborn) {
        running = false;
        if (opts.rewriteOnQuit !== undefined) m.put(SETTINGS, opts.rewriteOnQuit);
      }
      return { code: 0 };
    }
    if (argv[0] === 'open') {
      running = true;
      return { code: 0 };
    }
    return undefined;
  });
  const deps = makeDeps({ fsApi: m.fs, exec: ex.exec });
  const read = async () => (await m.fs.readFile(SETTINGS)).toString();
  return { m, ex, deps, read, isRunning: () => running };
}

const run = (mc: ReturnType<typeof machine>, restartFigma = false) =>
  registryImporter.run({ manifestPath: L.manifestPath, deps: mc.deps, restartFigma, figmaApp: FIGMA_APP });

const OTHER = { id: 7, manifestPath: '/other/manifest.json', lastKnownName: 'Other', fileMetadata: { type: 'manifest', codeFileId: 8, uiFileIds: [9] } };

describe('withRegistration / inspectRegistry (pure)', () => {
  it('writes exactly the verified shape: three linked entries with ids n, n+1, n+2 where n = max id + 1', () => {
    const text = JSON.stringify({ keep: true, localFileExtensions: [OTHER, { id: 9, manifestPath: '/other/ui.html', fileMetadata: { type: 'ui', manifestFileId: 7 } }] });
    const next = withRegistration(inspectRegistry(text, DIR), DIR) as { keep: boolean; localFileExtensions: unknown[] };
    expect(next.keep).toBe(true);
    expect(next.localFileExtensions.slice(2)).toEqual([
      { id: 10, manifestPath: `${DIR}/manifest.json`, lastKnownName: 'FigmaMCP', lastKnownPluginId: 'figmamcp-local', fileMetadata: { type: 'manifest', codeFileId: 11, uiFileIds: [12] }, cachedContainsWidget: false },
      { id: 11, manifestPath: `${DIR}/code.js`, fileMetadata: { type: 'code', manifestFileId: 10 } },
      { id: 12, manifestPath: `${DIR}/ui.html`, fileMetadata: { type: 'ui', manifestFileId: 10 } },
    ]);
    expect(next.localFileExtensions.slice(0, 2)).toEqual(JSON.parse(text).localFileExtensions);
  });
  it('starts at id 1 for an empty or missing list', () => {
    const e = withRegistration(inspectRegistry('{}', DIR), DIR) as { localFileExtensions: { id: number }[] };
    expect(e.localFileExtensions.map((x) => x.id)).toEqual([1, 2, 3]);
  });
});

describe('registryImporter: Figma closed', () => {
  it('registers, keeps every other key and entry, keeps a backup, leaves no temp file, and does not touch Figma', async () => {
    const original = JSON.stringify({ theme: 'dark', recent: [1, 2], localFileExtensions: [OTHER] }, null, 2) + '\n';
    const mc = machine({ settings: original, running: false });
    const r = await run(mc);
    expect(r.status).toBe('ok');
    expect(r.state).toBe('registered');
    const after = JSON.parse(await mc.read());
    expect(after.theme).toBe('dark');
    expect(after.recent).toEqual([1, 2]);
    expect(after.localFileExtensions[0]).toEqual(OTHER);
    expect(after.localFileExtensions).toHaveLength(4);
    expect(await mc.read()).toStartWith('{\n  "theme"'); // original indentation kept
    expect((await mc.m.fs.readFile(`${SETTINGS}.figmamcp-backup`)).toString()).toBe(original);
    expect([...mc.m.nodes.keys()].filter((k) => k.includes('figmamcp-tmp'))).toEqual([]);
    expect(mc.ex.calls.map((c) => c.argv[0]).filter((a) => a === 'osascript' || a === 'open')).toEqual([]);
  });

  it('is idempotent: a second run writes nothing', async () => {
    const mc = machine({ settings: '{}', running: false });
    await run(mc);
    const writes = mc.m.writes.length;
    const again = await run(mc);
    expect(again).toMatchObject({ status: 'ok', state: 'registered' });
    expect(mc.m.writes.length).toBe(writes);
  });

  it('repairs a half registration of ours instead of duplicating it, and keeps others', async () => {
    const half = { localFileExtensions: [OTHER, { id: 20, manifestPath: `${DIR}/manifest.json`, fileMetadata: { type: 'manifest', codeFileId: 21, uiFileIds: [22] } }] };
    const mc = machine({ settings: JSON.stringify(half), running: false });
    expect((await run(mc)).status).toBe('ok');
    const list = JSON.parse(await mc.read()).localFileExtensions;
    expect(list.filter((e: { manifestPath: string }) => e.manifestPath === `${DIR}/manifest.json`)).toHaveLength(1);
    expect(list).toHaveLength(4);
    expect(list[0]).toEqual(OTHER);
  });

  it('malformed JSON, or a localFileExtensions that is not a list: fail and write nothing', async () => {
    for (const bad of ['{nope', '{"localFileExtensions":"x"}', '[]']) {
      const mc = machine({ settings: bad, running: false });
      const w = mc.m.writes.length;
      const r = await run(mc);
      expect(r.status).toBe('fail');
      expect(mc.m.writes.length).toBe(w);
      expect(await mc.read()).toBe(bad);
    }
  });

  it('Figma never opened (no settings file): pending needs-figma-launch, nothing written', async () => {
    const mc = machine({ settings: null, running: false });
    const w = mc.m.writes.length;
    expect(await run(mc)).toMatchObject({ status: 'pending', state: 'needs-figma-launch' });
    expect(mc.m.writes.length).toBe(w);
  });
});

describe('registryImporter: Figma running', () => {
  it('without --restart-figma: needs-figma-restart, nothing written, Figma not touched', async () => {
    const mc = machine({ settings: '{"a":1}', running: true });
    const w = mc.m.writes.length;
    const r = await run(mc);
    expect(r).toMatchObject({ status: 'pending', state: 'needs-figma-restart' });
    expect(mc.m.writes.length).toBe(w);
    expect(await mc.read()).toBe('{"a":1}');
    expect(mc.ex.calls.some((c) => c.argv[0] === 'osascript' || c.argv[0] === 'open')).toBe(false);
  });

  it('pgrep that cannot answer counts as running (fails safe): nothing written', async () => {
    const m = memFs({ [SETTINGS]: '{}' });
    const ex = scriptedExec((a) => (a[0] === 'pgrep' ? { code: 127 } : undefined));
    const r = await registryImporter.run({ manifestPath: L.manifestPath, deps: makeDeps({ fsApi: m.fs, exec: ex.exec }) });
    expect(r.state).toBe('needs-figma-restart');
    expect((await m.fs.readFile(SETTINGS)).toString()).toBe('{}');
  });

  it('--restart-figma: quits gracefully, writes AFTER the quit on top of what Figma wrote while quitting, then reopens Figma', async () => {
    const mc = machine({ settings: '{"stale":true}', running: true, rewriteOnQuit: '{"fresh":true,"localFileExtensions":[]}' });
    const r = await run(mc, true);
    expect(r).toMatchObject({ status: 'ok', state: 'registered' });
    const after = JSON.parse(await mc.read());
    expect(after.fresh).toBe(true);
    expect(after.stale).toBeUndefined(); // Figma's last write is the base, not the copy read before the quit
    expect(after.localFileExtensions).toHaveLength(3);
    const order = mc.ex.calls.map((c) => c.argv[0]).filter((a) => a === 'osascript' || a === 'open');
    expect(order).toEqual(['osascript', 'open']);
    expect(mc.ex.calls.find((c) => c.argv[0] === 'osascript')!.argv).toEqual(['osascript', '-e', 'tell application "Figma" to quit']);
    expect(mc.ex.calls.find((c) => c.argv[0] === 'open')!.argv).toEqual(['open', FIGMA_APP]);
    expect(mc.isRunning()).toBe(true);
  });

  it('--restart-figma but Figma will not quit (save dialog): fail, nothing written, Figma not relaunched', async () => {
    const mc = machine({ settings: '{}', running: true, stubborn: true });
    mc.deps.sleep = async () => undefined;
    const w = mc.m.writes.length;
    const r = await run(mc, true);
    expect(r.status).toBe('fail');
    expect(mc.m.writes.length).toBe(w);
    expect(mc.ex.calls.some((c) => c.argv[0] === 'open')).toBe(false);
  });

  it('--restart-figma but osascript is refused: fail with how to quit by hand, nothing written', async () => {
    const mc = machine({ settings: '{}', running: true, quitWorks: false });
    const w = mc.m.writes.length;
    const r = await run(mc, true);
    expect(r.status).toBe('fail');
    expect(r.lines.join(' ')).toContain('Cmd+Q');
    expect(mc.m.writes.length).toBe(w);
  });

  it('if the file turns out malformed after the quit, Figma is still reopened and nothing is written', async () => {
    const mc = machine({ settings: '{}', running: true, rewriteOnQuit: '{broken' });
    const w = mc.m.writes.length;
    const r = await run(mc, true);
    expect(r.status).toBe('fail');
    expect(mc.m.writes.length).toBe(w);
    expect(mc.ex.calls.some((c) => c.argv[0] === 'open')).toBe(true);
  });
});
