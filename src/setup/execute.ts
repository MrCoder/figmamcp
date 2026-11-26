import path from 'node:path';
import type { Action, Deps, Layout, Plan, Step } from './types.js';
import { EXIT } from './types.js';
import { isExecutableFile, parseLsof, shellLine } from './plan.js';
import type { PluginImporter } from './importer.js';

class ActionError extends Error {
  constructor(message: string, public fix?: string) {
    super(message);
  }
}

/** Runs every `todo` step's actions in order. Steps never throw: a failure becomes that step's status. */
export interface ExecuteOptions {
  restartFigma?: boolean;
  figmaApp?: string | null;
}

export async function executePlan(plan: Plan, deps: Deps, importer: PluginImporter, opts: ExecuteOptions = {}): Promise<Step[]> {
  const out: Step[] = [];
  let runtimeFailed = false;
  for (const step of plan.steps) {
    if (step.status === 'fail') {
      if (step.id === 'runtime') runtimeFailed = true;
      out.push(step);
      continue;
    }
    if (step.status !== 'todo') {
      out.push(step);
      continue;
    }
    if (runtimeFailed) {
      out.push({ ...step, status: 'skip', detail: 'Skipped because the FigmaMCP files could not be installed.', actions: [] });
      continue;
    }
    try {
      let notes = step.notes;
      let detail = step.done ?? step.detail;
      let pending: { state?: string } | null = null;
      for (const a of step.actions) {
        if (a.kind === 'plugin-import') {
          const r = await importer.run({ manifestPath: a.manifestPath, deps, restartFigma: opts.restartFigma, figmaApp: opts.figmaApp });
          if (r.status === 'fail') throw new ActionError(r.lines[0] ?? 'The plugin import step failed.', r.lines[1]);
          if (r.status === 'pending') {
            pending = { state: r.state };
            notes = [...(notes ?? []), ...r.lines];
          } else {
            detail = r.lines.join(' ');
          }
        } else {
          await runAction(a, deps);
        }
      }
      if (pending) out.push({ ...step, status: 'todo', state: pending.state, notes });
      else out.push({ ...step, status: 'ok', state: undefined, detail, notes });
    } catch (e) {
      if (step.id === 'runtime') runtimeFailed = true;
      out.push({
        ...step,
        status: 'fail',
        detail: e instanceof Error ? e.message : String(e),
        fix: e instanceof ActionError && e.fix ? e.fix : 'Fix the problem above and run this command again; finished steps are skipped.',
      });
    }
  }
  return out;
}

export function exitCodeFor(plan: Plan, steps: Step[]): number {
  if (plan.stopCode !== null) return plan.stopCode;
  return steps.some((s) => s.status === 'fail') ? EXIT.FAILED : EXIT.OK;
}

async function runAction(a: Action, deps: Deps): Promise<void> {
  switch (a.kind) {
    case 'install-runtime':
      return installRuntime(a, deps);
    case 'mkdir':
      for (const p of a.paths) await deps.fs.mkdir(p);
      return;
    case 'write-file':
      await deps.fs.writeFile(a.path, a.content);
      return;
    case 'exec': {
      let r = await deps.exec(a.argv);
      for (let tries = 1; r.code !== 0 && a.retry && tries < a.retry.attempts; tries++) {
        await deps.sleep(a.retry.delayMs);
        r = await deps.exec(a.argv);
      }
      if (r.code !== 0 && !a.allowFail) {
        const why = (r.stderr || r.stdout).trim().split('\n')[0] || `exit code ${r.code}`;
        throw new ActionError(`Could not ${a.label}: ${why}`, `Try it yourself: ${shellLine(a.argv)}`);
      }
      return;
    }
    case 'wait-port': {
      const until = a.timeoutMs;
      for (let waited = 0; waited <= until; waited += 500) {
        const r = await deps.exec(['lsof', '-nP', `-iTCP:${a.port}`, '-sTCP:LISTEN', '-Fpcn']);
        if (r.code === 0 && parseLsof(r.stdout)) return;
        await deps.sleep(500);
      }
      throw new ActionError(a.failHint);
    }
    case 'copy-skill':
      return copySkill(a, deps);
    case 'plugin-import':
      return; // handled by the importer in executePlan
  }
}

/**
 * Copies the package files into versions/<v> (built in a temp dir, then renamed into place), and
 * then moves the `current` link with a rename, which is atomic. A running relay or agent never sees
 * a half-written tree.
 */
export async function installRuntime(a: Extract<Action, { kind: 'install-runtime' }>, deps: Deps): Promise<void> {
  const { layout, pkgRoot, files, version } = a;
  const { fs } = deps;
  await fs.mkdir(layout.versionsDir);

  if (a.copy) {
    const tmp = path.join(layout.versionsDir, `.${version}.tmp-${deps.pid}`);
    await fs.rm(tmp);
    await fs.mkdir(tmp);
    for (const rel of files) {
      const dest = path.join(tmp, a.map?.[rel] ?? rel);
      await fs.mkdir(path.dirname(dest));
      await fs.writeFile(dest, await fs.readFile(path.join(pkgRoot, rel)), isExecutableFile(rel, layout.binary) ? 0o755 : undefined);
    }
    if (await fs.exists(layout.versionDir)) {
      const old = path.join(layout.versionsDir, `.${version}.old-${deps.pid}`);
      await fs.rm(old);
      await fs.rename(layout.versionDir, old);
      await fs.rename(tmp, layout.versionDir);
      await fs.rm(old);
    } else {
      await fs.rename(tmp, layout.versionDir);
    }
  }
  await swapCurrent(layout, version, deps);
}

async function swapCurrent(layout: Layout, version: string, deps: Deps): Promise<void> {
  const tmpLink = path.join(layout.root, `.current.tmp-${deps.pid}`);
  await deps.fs.rm(tmpLink);
  await deps.fs.symlink(path.join('versions', version), tmpLink);
  await deps.fs.rename(tmpLink, layout.current);
}

/** Copies the skill files into a temp folder and swaps it in, so an agent never reads a half-written skill. */
async function copySkill(a: Extract<Action, { kind: 'copy-skill' }>, deps: Deps): Promise<void> {
  const { fs } = deps;
  const parent = path.dirname(a.to);
  const tmp = `${a.to}.tmp-${deps.pid}`;
  await fs.mkdir(parent);
  await fs.rm(tmp);
  await fs.mkdir(tmp);
  for (const rel of a.files) {
    const dest = path.join(tmp, rel);
    await fs.mkdir(path.dirname(dest));
    await fs.writeFile(dest, await fs.readFile(path.join(a.from, rel)));
  }
  if (await fs.exists(a.to)) {
    const old = `${a.to}.old-${deps.pid}`;
    await fs.rm(old);
    await fs.rename(a.to, old);
    await fs.rename(tmp, a.to);
    await fs.rm(old);
  } else {
    await fs.rename(tmp, a.to);
  }
}
