import { describe, it, expect } from 'bun:test';
import { gatherFacts, probeNode } from '../../../../setup/probe.js';
import { layoutFor, pickNode } from '../../../../setup/plan.js';
import { HOME, PKG, makeDeps, memFs, scriptedExec } from './fakes.js';

const MIN_ENV = 'PATH=/usr/bin:/bin';

describe('probeNode', () => {
  it('flags a Volta shim (symlink to volta-shim), only asks it where real node is, real node is tested under a minimal PATH', async () => {
    const shim = `${HOME}/.volta/bin/node`;
    const real = `${HOME}/.volta/tools/image/node/22.1.0/bin/node`;
    const m = memFs({}, [shim, real], { [shim]: `${HOME}/.volta/bin/volta-shim`, [real]: real });
    const { exec, calls } = scriptedExec((argv) => (argv.includes(real) ? { code: 0, stdout: 'v22.1.0\n' } : undefined));
    const deps = makeDeps({ fsApi: m.fs, exec, execPath: real, env: { PATH: `${HOME}/.volta/bin:/usr/bin` } });
    const c = await probeNode(deps);
    expect(c.find((x) => x.path === shim)).toMatchObject({ shim: true, version: null });
    expect(c.find((x) => x.path === real)).toMatchObject({ shim: false, version: 'v22.1.0' });
    // The shim is only asked where real node is; it is never used as the answer.
    expect(calls.map((x) => x.argv)).toEqual([
      ['/usr/bin/env', '-i', MIN_ENV, real, '--version'],
      [shim, '-p', 'process.execPath'],
    ]);
  });

  it('under bun (execPath is not node) a shim on PATH is resolved to the real binary it fronts', async () => {
    const shim = `${HOME}/.volta/bin/node`;
    const real = `${HOME}/.volta/tools/image/node/22.1.0/bin/node`;
    const m = memFs({}, [shim, real], { [shim]: `${HOME}/.volta/bin/volta-shim`, [real]: real });
    const { exec } = scriptedExec((argv) => {
      if (argv[0] === shim) return { code: 0, stdout: real + '\n' };
      if (argv.includes(real)) return { code: 0, stdout: 'v22.1.0\n' };
      return undefined;
    });
    const deps = makeDeps({ fsApi: m.fs, exec, execPath: '/b/bun', env: { PATH: `${HOME}/.volta/bin` } });
    const c = await probeNode(deps);
    expect(pickNode(c)?.path).toBe(real);
  });

  it('ignores a runtime that is not called node (bun)', async () => {
    const m = memFs({}, ['/b/bun'], { '/b/bun': '/b/bun' });
    const deps = makeDeps({ fsApi: m.fs, execPath: '/b/bun', env: { PATH: '/b' } });
    expect(await probeNode(deps)).toEqual([]);
  });

  it('a node that fails under the minimal PATH gets version null', async () => {
    const m = memFs({}, ['/opt/node/bin/node'], { '/opt/node/bin/node': '/opt/node/bin/node' });
    const { exec } = scriptedExec(() => ({ code: 1 }));
    const c = await probeNode(makeDeps({ fsApi: m.fs, exec }));
    expect(c[0]).toMatchObject({ version: null, shim: false });
  });
});

describe('gatherFacts', () => {
  const L = layoutFor(HOME, '1.2.3');
  const pkgFiles = {
    [`${PKG}/package.json`]: '{"name":"figmamcp","version":"1.2.3"}',
    [`${PKG}/dist/server.js`]: 'server',
    [`${PKG}/dist/socket.js`]: 'socket',
    [`${PKG}/figma_plugin/manifest.json`]: '{}',
    [`${PKG}/figma_plugin/code.js`]: 'code',
    [`${PKG}/figma_plugin/ui.html`]: 'ui',
    [`${PKG}/skills/figmamcp/references/workflows.md`]: 'w',
    [`${PKG}/skills/figmamcp/references/notes.txt`]: 'not markdown',
  };

  it('reads the machine and never writes anything', async () => {
    const m = memFs(
      {
        ...pkgFiles,
        [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: { figmamcp: { type: 'stdio', command: '/n/node', args: ['/s.js'], env: {} } } }),
      },
      ['/Applications/Figma.app', '/bin/claude', '/bin/codex'],
    );
    const { exec } = scriptedExec((argv) => {
      if (argv[0] === 'lsof') return argv.includes('-iTCP:3156') ? { code: 0, stdout: 'p91321\ncnode\nn[::1]:3156\n' } : { code: 1 };
      if (argv[0] === 'pgrep') return { code: 1 };
      if (argv[0] === 'ps') return { code: 0, stdout: '/usr/local/bin/node /thing/socket.js\n' };
      if (argv[1] === 'mcp') return { code: 1, stderr: "Error: No MCP server named 'figmamcp' found." };
      return undefined;
    });
    const deps = makeDeps({ fsApi: m.fs, exec, env: { PATH: '/bin' } });
    const before = m.writes.length;
    const f = await gatherFacts(deps, '1.2.3');
    expect(m.writes.length).toBe(before);
    expect(f.figmaApp).toBe('/Applications/Figma.app');
    expect(f.relay.ports).toEqual([
      { port: 3155, holder: null },
      { port: 3156, holder: { pid: 91321, command: '/usr/local/bin/node /thing/socket.js' } },
      { port: 3157, holder: null },
      { port: 3158, holder: null },
    ]);
    expect(f.relay.configPort).toBeNull();
    expect(f.agents.claude).toEqual({ bin: '/bin/claude', registered: { command: '/n/node', args: ['/s.js'] } });
    expect(f.agents.codex).toEqual({ bin: '/bin/codex', registered: null });
    expect(f.runtime.sourceFiles).toContain('skills/figmamcp/references/workflows.md');
    expect(f.runtime.sourceFiles).not.toContain('skills/figmamcp/references/notes.txt');
    expect(f.runtime.missingSource).toEqual([]);
    expect(f.runtime.versionDirUpToDate).toBe(false);
  });

  it('versionDirUpToDate is true only when every copied file is byte-identical', async () => {
    const copied: Record<string, string> = {};
    for (const [p, d] of Object.entries(pkgFiles)) copied[L.versionDir + p.slice(PKG.length)] = d;
    const same = memFs({ ...pkgFiles, ...copied });
    const deps = (m: ReturnType<typeof memFs>) => makeDeps({ fsApi: m.fs, env: { PATH: '' } });
    expect((await gatherFacts(deps(same), '1.2.3')).runtime.versionDirUpToDate).toBe(true);

    const drift = memFs({ ...pkgFiles, ...copied, [`${L.versionDir}/dist/server.js`]: 'DIFFERENT' });
    expect((await gatherFacts(deps(drift), '1.2.3')).runtime.versionDirUpToDate).toBe(false);
  });

  it('resolves a relative `current` link against ~/.figmamcp', async () => {
    const m = memFs(pkgFiles);
    await m.fs.mkdir(L.root);
    await m.fs.symlink('versions/1.2.3', L.current);
    const f = await gatherFacts(makeDeps({ fsApi: m.fs, env: { PATH: '' } }), '1.2.3');
    expect(f.runtime.currentTarget).toBe(L.versionDir);
  });

  it('reports a missing package file instead of pretending to install it', async () => {
    const { [`${PKG}/dist/socket.js`]: _gone, ...rest } = pkgFiles;
    const f = await gatherFacts(makeDeps({ fsApi: memFs(rest).fs, env: { PATH: '' } }), '1.2.3');
    expect(f.runtime.missingSource).toEqual(['dist/socket.js']);
  });

  it('claude config that is not JSON, or an entry we do not understand, is reported unreadable', async () => {
    const run = async (content: string) => {
      const m = memFs({ ...pkgFiles, [`${HOME}/.claude.json`]: content }, ['/bin/claude']);
      return (await gatherFacts(makeDeps({ fsApi: m.fs, env: { PATH: '/bin' } }), '1.2.3')).agents.claude.registered;
    };
    expect(await run('{not json')).toBe('unreadable');
    expect(await run(JSON.stringify({ mcpServers: { figmamcp: { type: 'http', url: 'https://x' } } }))).toBe('unreadable');
  });

  it('honours CLAUDE_CONFIG_DIR and finds agents in ~/.local/bin even when PATH is empty', async () => {
    const m = memFs(
      { ...pkgFiles, '/cfg/.claude.json': JSON.stringify({ mcpServers: { figmamcp: { command: 'n', args: ['s'] } } }) },
      [`${HOME}/.local/bin/claude`],
    );
    const f = await gatherFacts(makeDeps({ fsApi: m.fs, env: { PATH: '', CLAUDE_CONFIG_DIR: '/cfg' } }), '1.2.3');
    expect(f.agents.claude).toEqual({ bin: `${HOME}/.local/bin/claude`, registered: { command: 'n', args: ['s'] } });
  });

  it('codex failure that is not "not found" keeps the error text for the user', async () => {
    const m = memFs(pkgFiles, ['/bin/codex']);
    const { exec } = scriptedExec((argv) =>
      argv[1] === 'mcp' ? { code: 127, stdout: '', stderr: 'env: node: No such file or directory\nmore' } : undefined,
    );
    const f = await gatherFacts(makeDeps({ fsApi: m.fs, exec, env: { PATH: '/bin' } }), '1.2.3');
    expect(f.agents.codex).toEqual({ bin: '/bin/codex', registered: 'unreadable', error: 'env: node: No such file or directory' });
  });

  it('codex stdio entry from --json is compared by command and args', async () => {
    const m = memFs(pkgFiles, ['/bin/codex']);
    const { exec } = scriptedExec((argv) =>
      argv[1] === 'mcp' ? { code: 0, stdout: JSON.stringify({ transport: { type: 'stdio', command: '/n', args: ['/s'] } }) } : undefined,
    );
    const f = await gatherFacts(makeDeps({ fsApi: m.fs, exec, env: { PATH: '/bin' } }), '1.2.3');
    expect(f.agents.codex.registered).toEqual({ command: '/n', args: ['/s'] });
  });
});

describe('gatherFacts: config, plugin registry, skills, binary mode', () => {
  const L = layoutFor(HOME, '1.2.3');
  const SETTINGS = `${HOME}/Library/Application Support/Figma/settings.json`;
  const base = {
    [`${PKG}/package.json`]: '{"name":"figmamcp","version":"1.2.3"}',
    [`${PKG}/dist/server.js`]: 's',
    [`${PKG}/dist/socket.js`]: 'k',
    [`${PKG}/figma_plugin/manifest.json`]: '{}',
    [`${PKG}/figma_plugin/code.js`]: 'c',
    [`${PKG}/figma_plugin/ui.html`]: 'u',
    [`${PKG}/skills/figmamcp/SKILL.md`]: 'skill',
    [`${PKG}/skills/figmamcp/references/workflows.md`]: 'w',
  };
  const facts = (files: Record<string, string>, exec = scriptedExec(() => undefined), execs: string[] = ['/Applications/Figma.app', '/bin/claude', '/bin/codex'], over = {}) =>
    gatherFacts(makeDeps({ fsApi: memFs({ ...base, ...files }, execs).fs, exec: exec.exec, env: { PATH: '/bin' }, ...over }), '1.2.3');

  it('reads the configured port; garbage or a missing file gives null', async () => {
    expect((await facts({ [`${L.root}/config.json`]: '{"port":3157}' })).relay.configPort).toBe(3157);
    expect((await facts({ [`${L.root}/config.json`]: 'nope' })).relay.configPort).toBeNull();
    expect((await facts({})).relay.configPort).toBeNull();
  });

  it('plugin: registered / not registered / malformed / no settings file; pgrep exit 0, 1 and anything else', async () => {
    const entry = (extra: object = {}) => ({
      localFileExtensions: [
        { id: 4, manifestPath: L.manifestPath, lastKnownName: 'FigmaMCP', lastKnownPluginId: 'figmamcp-local', fileMetadata: { type: 'manifest', codeFileId: 5, uiFileIds: [6] }, cachedContainsWidget: false },
        { id: 5, manifestPath: `${L.current}/figma_plugin/code.js`, fileMetadata: { type: 'code', manifestFileId: 4 } },
        { id: 6, manifestPath: `${L.current}/figma_plugin/ui.html`, fileMetadata: { type: 'ui', manifestFileId: 4 } },
      ],
      ...extra,
    });
    const run = async (text: string | null, pgrep: number) =>
      (await facts(text === null ? {} : { [SETTINGS]: text, [L.manifestPath]: '{}', [`${L.current}/figma_plugin/code.js`]: 'c', [`${L.current}/figma_plugin/ui.html`]: 'u' }, scriptedExec((a) => (a[0] === 'pgrep' ? { code: pgrep } : undefined)))).plugin;
    expect(await run(JSON.stringify(entry()), 1)).toMatchObject({ settingsExists: true, registered: true, malformed: false, figmaRunning: false });
    expect(await run('{"x":1}', 0)).toMatchObject({ registered: false, malformed: false, figmaRunning: true });
    expect(await run('{nope', 1)).toMatchObject({ malformed: true, registered: false });
    expect(await run('{"localFileExtensions":{"a":1}}', 1)).toMatchObject({ malformed: true });
    expect(await run(null, 1)).toMatchObject({ settingsExists: false, registered: false });
    expect((await run('{}', 127)).figmaRunning).toBe('unknown');
  });

  it('registration whose plugin files are gone from disk is not registered (Figma hides it from Plugins > Development)', async () => {
    const reg = {
      localFileExtensions: [
        { id: 4, manifestPath: L.manifestPath, fileMetadata: { type: 'manifest', codeFileId: 5, uiFileIds: [6] } },
        { id: 5, manifestPath: `${L.current}/figma_plugin/code.js`, fileMetadata: { type: 'code', manifestFileId: 4 } },
        { id: 6, manifestPath: `${L.current}/figma_plugin/ui.html`, fileMetadata: { type: 'ui', manifestFileId: 4 } },
      ],
    };
    const onDisk = {
      [L.manifestPath]: '{}',
      [`${L.current}/figma_plugin/code.js`]: 'c',
      [`${L.current}/figma_plugin/ui.html`]: 'u',
    };
    expect((await facts({ [SETTINGS]: JSON.stringify(reg), ...onDisk })).plugin.registered).toBe(true);
    const { [L.manifestPath]: _gone, ...noManifest } = onDisk;
    expect((await facts({ [SETTINGS]: JSON.stringify(reg), ...noManifest })).plugin.registered).toBe(false);
    const { [`${L.current}/figma_plugin/code.js`]: _c, ...noCode } = onDisk;
    expect((await facts({ [SETTINGS]: JSON.stringify(reg), ...noCode })).plugin.registered).toBe(false);
  });

  it('registration with a broken link (code entry missing) is not registered', async () => {
    const half = { localFileExtensions: [{ id: 4, manifestPath: L.manifestPath, fileMetadata: { type: 'manifest', codeFileId: 5, uiFileIds: [6] } }] };
    expect((await facts({ [SETTINGS]: JSON.stringify(half) })).plugin.registered).toBe(false);
  });

  it('skills: absent / current / stale / foreign link, and null when the agent is not installed', async () => {
    const t = `${HOME}/.claude/skills/figmamcp`;
    const same = { [`${t}/SKILL.md`]: 'skill', [`${t}/references/workflows.md`]: 'w' };
    expect((await facts({})).skills.claude).toEqual({ target: t, state: 'absent' });
    expect((await facts(same)).skills.claude?.state).toBe('current');
    expect((await facts({ ...same, [`${t}/SKILL.md`]: 'old' })).skills.claude?.state).toBe('stale');
    expect((await facts({}, scriptedExec(() => undefined), ['/Applications/Figma.app'])).skills).toEqual({ claude: null, codex: null });
    const m = memFs({ ...base });
    await m.fs.mkdir(`${HOME}/.claude/skills`);
    await m.fs.symlink('/elsewhere/figmamcp', t);
    const f = await gatherFacts(makeDeps({ fsApi: m.fs, env: { PATH: '/bin' } }), '1.2.3');
    expect(f.skills.claude).toBeNull(); // claude binary not present in this fake
    const m2 = memFs({ ...base }, ['/bin/claude']);
    await m2.fs.mkdir(`${HOME}/.claude/skills`);
    await m2.fs.symlink('/elsewhere/figmamcp', t);
    const f2 = await gatherFacts(makeDeps({ fsApi: m2.fs, env: { PATH: '/bin' } }), '1.2.3');
    expect(f2.skills.claude?.state).toBe('foreign-link');
  });

  it('binary mode: needs the three executables, never probes node, compares installed files under bin/', async () => {
    const bin = {
      [`${PKG}/package.json`]: '{"name":"figmamcp","version":"1.2.3"}',
      [`${PKG}/figmamcp`]: 'a',
      [`${PKG}/figmamcp-server`]: 'b',
      [`${PKG}/figmamcp-relay`]: 'c',
      [`${PKG}/figma_plugin/manifest.json`]: '{}',
      [`${PKG}/figma_plugin/code.js`]: 'c',
      [`${PKG}/figma_plugin/ui.html`]: 'u',
    };
    const BL = layoutFor(HOME, '1.2.3', true);
    const installed = { [`${BL.versionDir}/package.json`]: bin[`${PKG}/package.json`], [`${BL.versionDir}/bin/figmamcp`]: 'a', [`${BL.versionDir}/bin/figmamcp-server`]: 'b', [`${BL.versionDir}/bin/figmamcp-relay`]: 'c', [`${BL.versionDir}/figma_plugin/manifest.json`]: '{}', [`${BL.versionDir}/figma_plugin/code.js`]: 'c', [`${BL.versionDir}/figma_plugin/ui.html`]: 'u' };
    const ex = scriptedExec(() => undefined);
    const f = await gatherFacts(makeDeps({ fsApi: memFs({ ...bin, ...installed }, ['/Applications/Figma.app']).fs, exec: ex.exec, binary: true, env: { PATH: '/bin' } }), '1.2.3');
    expect(f.binary).toBe(true);
    expect(f.nodeCandidates).toEqual([]);
    expect(f.runtime.missingSource).toEqual([]);
    expect(f.runtime.versionDirUpToDate).toBe(true);
    expect(ex.calls.some((c) => c.argv.includes('--version'))).toBe(false);

    const { [`${PKG}/figmamcp-relay`]: _x, ...missing } = bin;
    const g = await gatherFacts(makeDeps({ fsApi: memFs(missing, ['/Applications/Figma.app']).fs, binary: true, env: { PATH: '/bin' } }), '1.2.3');
    expect(g.runtime.missingSource).toEqual(['figmamcp-relay']);
  });

  it('binary mode: running from the installed version finds its own programs under bin/', async () => {
    const BL = layoutFor(HOME, '1.2.3', true);
    const d = BL.versionDir;
    const installed = {
      [`${d}/package.json`]: '{"name":"figmamcp","version":"1.2.3"}',
      [`${d}/bin/figmamcp`]: 'a',
      [`${d}/bin/figmamcp-server`]: 'b',
      [`${d}/bin/figmamcp-relay`]: 'c',
      [`${d}/figma_plugin/manifest.json`]: '{}',
      [`${d}/figma_plugin/code.js`]: 'c',
      [`${d}/figma_plugin/ui.html`]: 'u',
    };
    const ex = scriptedExec(() => undefined);
    const f = await gatherFacts(makeDeps({ fsApi: memFs(installed, ['/Applications/Figma.app']).fs, exec: ex.exec, binary: true, pkgRoot: d, env: { PATH: '/bin' } }), '1.2.3');
    expect(f.runtime.missingSource).toEqual([]);
    expect(f.runtime.versionDirUpToDate).toBe(true);
  });
});

describe('agents installed with nvm', () => {
  const nvmCodex = `${HOME}/.nvm/versions/node/v24.10.0/bin/codex`;
  it('finds codex under ~/.nvm even when PATH is the bare GUI PATH, newest node version first', async () => {
    const old = `${HOME}/.nvm/versions/node/v9.0.0/bin/codex`;
    const m = memFs({ [`${PKG}/package.json`]: '{"name":"figmamcp","version":"1.2.3"}', [old]: '#!', [nvmCodex]: '#!' }, [old, nvmCodex]);
    const { exec } = scriptedExec((argv) => (argv[1] === 'mcp' ? { code: 1, stderr: 'No MCP server named figmamcp' } : undefined));
    const f = await gatherFacts(makeDeps({ fsApi: m.fs, exec, env: { PATH: '/usr/bin:/bin' } }), '1.2.3');
    expect(f.agents.codex).toEqual({ bin: nvmCodex, registered: null });
  });
});
