import path from 'node:path';
import { EXIT } from './types.js';
import type { Deps, Mode, OpenFile, Plan, Step } from './types.js';
import { gatherFacts } from './probe.js';
import { FRESH_DOWNLOAD, planSetup } from './plan.js';
import { executePlan, exitCodeFor } from './execute.js';
import { chooseImporter } from './importer.js';
import type { PluginImporter } from './importer.js';
import { HELP, render, renderJson } from './render.js';
import { gatherLive, usableFiles } from './live.js';
import type { Live } from './types.js';

export interface SetupFlags {
  dryRun: boolean;
  json: boolean;
  restartFigma: boolean;
  resources: string | null;
}

export type Command =
  | ({ kind: 'setup' } & SetupFlags)
  | ({ kind: 'doctor' } & SetupFlags)
  | { kind: 'help' }
  | { kind: 'error'; message: string };

/** Which entry the bin should run. Anything that is not `setup`, `doctor` or `status` starts the MCP server, exactly as before. */
export function route(argv: string[]): 'setup' | 'doctor' | 'status' | 'server' {
  const first = argv[0];
  return first === 'setup' || first === 'doctor' || first === 'status' ? first : 'server';
}

/** The value of `--resources <dir>`, if given (the bin needs it before it can build its deps). */
export function resourcesArg(argv: string[]): string | null {
  const i = argv.indexOf('--resources');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

export function parseCommand(argv: string[]): Command {
  const [cmd, ...flags] = argv;
  if (flags.includes('--help') || flags.includes('-h')) return { kind: 'help' };
  const known = cmd === 'setup' ? ['--dry-run', '--json', '--restart-figma', '--resources'] : ['--json', '--resources'];
  let resources: string | null = null;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (!known.includes(f)) return { kind: 'error', message: `Unknown option "${f}" for "${cmd}".` };
    if (f === '--resources') {
      const v = flags[++i];
      if (!v || v.startsWith('--')) return { kind: 'error', message: '--resources needs a folder.' };
      resources = v;
    }
  }
  const base: SetupFlags = { dryRun: flags.includes('--dry-run'), json: flags.includes('--json'), restartFigma: flags.includes('--restart-figma'), resources };
  if (cmd === 'setup') return { kind: 'setup', ...base };
  if (cmd === 'doctor' || cmd === 'status') return { kind: 'doctor', ...base };
  return { kind: 'error', message: `Unknown command "${cmd}".` };
}

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

export async function runCli(argv: string[], deps: Deps, io: Io, importer: PluginImporter = chooseImporter()): Promise<number> {
  const cmd = parseCommand(argv);
  if (cmd.kind === 'help') {
    io.out(HELP);
    return EXIT.OK;
  }
  if (cmd.kind === 'error') {
    io.err(`${cmd.message}\n\n${HELP}`);
    return 64;
  }

  let version: string;
  try {
    version = JSON.parse((await deps.fs.readFile(path.join(deps.pkgRoot, 'package.json'))).toString('utf8')).version as string;
  } catch {
    const message = `FigmaMCP's own files were not found in ${deps.pkgRoot} (no package.json there).${deps.binary ? ' Keep the programs together with the figma_plugin and skills folders, or pass --resources <folder>.' : ` ${FRESH_DOWNLOAD}`}`;
    io.out(cmd.json ? JSON.stringify({ exitCode: EXIT.FAILED, error: message, steps: [] }, null, 2) + '\n' : `${message}\n`);
    return EXIT.FAILED;
  }
  const facts = await gatherFacts(deps, version);
  const plan: Plan = planSetup(facts);
  const mode: Mode = cmd.kind === 'doctor' ? 'doctor' : cmd.dryRun ? 'dry-run' : 'setup';

  const finish = async (steps: Step[], code: number, live: Live | null = null): Promise<number> => {
    if (!cmd.json) {
      io.out(render(plan, steps, mode, live, facts.version));
      return code;
    }
    if (live) {
      io.out(renderJson(facts, plan, steps, code, live.openFiles ?? [], live));
      return code;
    }
    let open: OpenFile[] = [];
    if (plan.port !== null && deps.openFiles) {
      try {
        open = await deps.openFiles(plan.port);
      } catch {
        // Relay down or busy: report no open files rather than failing the status call.
      }
    }
    io.out(renderJson(facts, plan, steps, code, open));
    return code;
  };

  if (mode === 'doctor') {
    const live = plan.stopCode === null ? await gatherLive(deps, plan.port) : null;
    let code = plan.stopCode ?? (plan.steps.some((s) => s.status === 'fail' || s.status === 'todo') ? EXIT.FAILED : EXIT.OK);
    // Setup is complete but nothing can be edited yet. Unknown (relay not asked) is not a failure.
    if (code === EXIT.OK && live?.openFiles && usableFiles(facts.version, live.openFiles).length === 0) code = EXIT.NOT_OPEN;
    return finish(plan.steps, code, live);
  }
  if (mode === 'dry-run' || plan.stopCode !== null) {
    return finish(plan.steps, plan.stopCode ?? (plan.steps.some((s) => s.status === 'fail') ? EXIT.FAILED : EXIT.OK));
  }
  const steps = await executePlan(plan, deps, importer, { restartFigma: cmd.restartFigma, figmaApp: facts.figmaApp });
  return finish(steps, exitCodeFor(plan, steps));
}
