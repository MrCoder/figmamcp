import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Deps, OpenFile } from './types.js';

/**
 * Environment for a child process. An absolute program gets its own folder first on PATH:
 * an npm-installed CLI (`#!/usr/bin/env node`, e.g. codex under ~/.nvm) needs the node that sits
 * next to it, and the app runs with launchd's bare PATH, which has no node.
 */
export function childEnv(argv: string[], env: Record<string, string | undefined>): Record<string, string | undefined> {
  const prog = argv[0];
  if (!prog || !path.isAbsolute(prog)) return { ...env };
  const dir = path.dirname(prog);
  const rest = (env.PATH ?? '').split(':').filter((d) => d !== '' && d !== dir);
  return { ...env, PATH: [dir, ...rest].join(':') };
}

/** Walk up from `start` to the directory whose package.json is named `figmamcp` (works from dist/ and from src/). */
export function findPkgRoot(start: string): string {
  let dir = start;
  for (;;) {
    const pj = path.join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        if (JSON.parse(readFileSync(pj, 'utf8')).name === 'figmamcp') return dir;
      } catch {
        // keep walking
      }
    }
    const up = path.dirname(dir);
    if (up === dir) throw new Error('Could not find the figmamcp package root.');
    dir = up;
  }
}

async function ignoreMissing<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export function realDeps(pkgRoot: string, binary = false): Deps {
  return {
    fs: {
      readFile: (p) => fsp.readFile(p),
      writeFile: (p, d, mode) => fsp.writeFile(p, d, mode === undefined ? undefined : { mode }),
      mkdir: async (p) => void (await fsp.mkdir(p, { recursive: true })),
      rename: (a, b) => fsp.rename(a, b),
      symlink: (t, p) => fsp.symlink(t, p),
      readlink: (p) => ignoreMissing(fsp.readlink(p), null),
      realpath: (p) => ignoreMissing(fsp.realpath(p), null),
      rm: (p) => fsp.rm(p, { recursive: true, force: true }),
      exists: (p) => ignoreMissing(fsp.access(p).then(() => true), false),
      isExecutable: (p) => ignoreMissing(fsp.access(p, constants.X_OK).then(() => true), false),
      readdir: (p) => fsp.readdir(p),
    },
    exec: (argv, opts) =>
      new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(argv, process.env) });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr || String(e.message) }));
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.stdin.on('error', () => undefined);
        child.stdin.end(opts?.input ?? '');
      }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    env: process.env,
    home: process.env.HOME || os.homedir(),
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    pid: process.pid,
    execPath: process.execPath,
    pkgRoot,
    binary,
    openFiles: (port) => askRelayForOpenFiles(port),
  };
}

/** Ask the local relay which files have the plugin open. Read-only: list_channels never joins or binds. */
export function askRelayForOpenFiles(port: number, timeoutMs = 800): Promise<OpenFile[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const done = (fn: () => void) => { clearTimeout(timer); try { ws.close(); } catch { /* already closed */ } fn(); };
    const timer = setTimeout(() => done(() => reject(new Error('relay did not answer'))), timeoutMs);
    ws.onerror = () => done(() => reject(new Error('relay not reachable')));
    ws.onopen = () => ws.send(JSON.stringify({ type: 'list_channels', id: 'figmamcp-status' }));
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data));
        if (data?.type !== 'channel_list' || !Array.isArray(data.channels)) return;
        const files = data.channels.map((c: { fileName?: unknown; mcpCount?: unknown; pluginVersion?: unknown; completedCalls?: unknown }) => ({
          fileName: typeof c.fileName === 'string' && c.fileName !== '' ? c.fileName : null,
          aiSessions: typeof c.mcpCount === 'number' ? c.mcpCount : 0,
          pluginVersion: typeof c.pluginVersion === 'string' ? c.pluginVersion : null,
          completedCalls: typeof c.completedCalls === 'number' ? c.completedCalls : null,
        }));
        done(() => resolve(files));
      } catch {
        // ignore unrelated frames
      }
    };
  });
}
