import type { Facts, Live, Mode, OpenFile, Plan, Status, Step } from './types.js';
import { isOutdated, usableFiles } from './live.js';
import { CLI_COMMAND, describeAction } from './plan.js';

function label(status: Status, mode: Mode): string {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'skip':
      return 'skip';
    case 'fail':
      return 'FAIL';
    case 'todo':
      return mode === 'doctor' ? 'NEEDED' : mode === 'setup' ? 'TO DO' : 'will do';
  }
}

const TITLES: Record<Mode, string> = {
  setup: 'FigmaMCP setup',
  'dry-run': 'FigmaMCP setup (dry run: nothing is changed)',
  doctor: 'FigmaMCP doctor (read-only: nothing is changed)',
};

export function renderSteps(steps: Step[], mode: Mode): string[] {
  const lines: string[] = [];
  const titleWidth = Math.max(0, ...steps.map((s) => s.title.length));
  for (const s of steps) {
    lines.push(`  ${label(s.status, mode).padEnd(8)}${s.title.padEnd(titleWidth)}  ${s.detail}`);
    const pad = ' '.repeat(10);
    if (mode === 'dry-run' && s.status === 'todo') {
      for (const a of s.actions) lines.push(`${pad}- ${describeAction(a)}`);
    }
    if (s.fix && s.status === 'fail') lines.push(`${pad}Fix: ${s.fix}`);
    for (const n of s.notes ?? []) lines.push(`${pad}${n}`);
  }
  return lines;
}

const CLIENTS = [
  { id: 'agent-claude', key: 'claude', name: 'Claude Code' },
  { id: 'agent-codex', key: 'codex', name: 'Codex' },
] as const;

/** The "right now" block of `doctor`: what is running, apart from what is set up. */
export function renderLive(version: string, steps: Step[], live: Live): string[] {
  const lines = ['Right now:'];
  if (live.openFiles === null) {
    lines.push('  Could not ask the relay which Figma files have FigmaMCP open.');
  } else {
    const usable = usableFiles(version, live.openFiles);
    const old = live.openFiles.length - usable.length;
    if (usable.length === 0) {
      lines.push('  FigmaMCP is not open in any Figma file. In Figma, choose Plugins > Development > FigmaMCP.');
    } else {
      const names = usable.map((f) => (f.fileName ? `"${f.fileName}"` : 'an unnamed file')).join(', ');
      lines.push(`  FigmaMCP is open in ${usable.length} Figma file${usable.length === 1 ? '' : 's'}: ${names}.`);
    }
    if (old > 0) lines.push(`  ${old} FigmaMCP panel${old === 1 ? ' is' : 's are'} from an older version. Close and reopen ${old === 1 ? 'it' : 'them'}.`);
    const counts = usable.map((f) => f.completedCalls).filter((n): n is number => typeof n === 'number');
    if (counts.length > 0) {
      const total = counts.reduce((a, b) => a + b, 0);
      lines.push(total > 0 ? `  AI requests answered since the relay started: ${total}.` : '  No AI request has been answered yet. Ask your AI to use FigmaMCP.');
    }
  }
  for (const c of CLIENTS) {
    if (steps.find((s) => s.id === c.id)?.status !== 'ok') continue;
    if (live.loaded === null) continue;
    const n = live.loaded[c.key];
    if (n === null) continue;
    lines.push(
      n > 0
        ? `  ${c.name} has loaded FigmaMCP (${n} running session${n === 1 ? '' : 's'}).`
        : `  ${c.name} has not loaded FigmaMCP yet. Restart ${c.name} (quit it and open it again) so it reads the new setting.`,
    );
  }
  return lines;
}

export function render(plan: Plan, steps: Step[], mode: Mode, live: Live | null = null, version = ''): string {
  const lines = [TITLES[mode], '', ...renderSteps(steps, mode), ''];
  if (live) lines.push(...renderLive(version, steps, live), '');
  const failed = steps.some((s) => s.status === 'fail');
  const todo = steps.some((s) => s.status === 'todo');
  if (mode === 'doctor') {
    const notOpen = !!live?.openFiles && usableFiles(version, live.openFiles).length === 0;
    lines.push(
      failed || todo
        ? `Some steps need attention. Run: ${CLI_COMMAND} setup`
        : notOpen
          ? 'Setup is complete. Open FigmaMCP in a Figma file before asking your AI to use it.'
          : 'Everything that can be checked looks good.',
    );
  } else if (plan.stopCode !== null || failed) {
    lines.push('Setup did not finish. Fix the steps marked FAIL, then run this command again; finished steps are skipped.');
  } else if (mode === 'dry-run') {
    lines.push('That is the plan. Run without --dry-run to do it.');
    lines.push(...plan.next);
  } else {
    const restart = steps.some((s) => s.state === 'needs-figma-restart');
    lines.push(restart ? 'Almost done: Figma still has to be restarted (see the plugin step).' : 'Done.', ...plan.next);
  }
  return lines.join('\n') + '\n';
}

export const HELP = `FigmaMCP: connect AI agents to the Figma desktop app.

The command is inside the FigmaMCP Mac app (download it from https://figmamcp.dev).
It is not on PATH, so run it by its full path:

Usage:
  ${CLI_COMMAND} setup [--dry-run]
        Set everything up (macOS). --dry-run only prints the plan.
        --restart-figma            Quit Figma, register the plugin, and open Figma again.
        --json                     Print the steps as JSON instead of text.
        --resources <folder>       Where the plugin and skill files are (compiled programs only).
  ${CLI_COMMAND} doctor
        Check each setup step without changing anything (alias: status).
        --json                     Print the steps as JSON.

Setup connects Claude Code and Codex to the MCP server, a separate program they start themselves.

Exit codes: 0 ok, 1 not macOS, 2 Figma desktop app missing, 3 a step failed or is still needed,
            4 (doctor only) setup is complete but FigmaMCP is not open in any Figma file.
`;

/** Machine-readable report for the macOS app: the step list plus a flat summary of what is installed and running. */
export function renderJson(facts: Facts, plan: Plan, steps: Step[], exitCode: number, openFiles: OpenFile[] = [], live: Live | null = null): string {
  const files = openFiles.map((f) => ({ ...f, pluginVersion: f.pluginVersion ?? null, outdated: isOutdated(facts.version, f) }));
  const step = (id: string) => steps.find((s) => s.id === id);
  const ok = (id: string) => step(id)?.status === 'ok';
  const holder = plan.port === null ? null : (facts.relay.ports.find((p) => p.port === plan.port)?.holder ?? null);
  const summary = {
    figma: { installed: facts.figmaApp !== null, running: facts.plugin.figmaRunning === 'unknown' ? true : facts.plugin.figmaRunning },
    plugin: { registered: ok('plugin') },
    relay: { running: ok('relay') || holder !== null, port: plan.port },
    claude: { installed: facts.agents.claude.bin !== null, connected: ok('agent-claude'), ...(live ? { loaded: live.loaded?.claude ?? null } : {}) },
    codex: { installed: facts.agents.codex.bin !== null, connected: ok('agent-codex'), ...(live ? { loaded: live.loaded?.codex ?? null } : {}) },
    skill: {
      claude: facts.skills.claude === null ? null : facts.skills.claude.state === 'current' || (ok('skill') && facts.skills.claude.state !== 'foreign-link'),
      codex: facts.skills.codex === null ? null : facts.skills.codex.state === 'current' || (ok('skill') && facts.skills.codex.state !== 'foreign-link'),
    },
  };
  return (
    JSON.stringify(
      {
        version: facts.version,
        exitCode,
        ...summary,
        openFiles: files,
        ...(live ? { pluginOpen: live.openFiles === null ? null : files.some((f) => !f.outdated) } : {}),
        currentFile: files.find((f) => f.fileName !== null && !f.outdated)?.fileName ?? null,
        steps: steps.map((s) => ({ id: s.id, state: s.state ?? s.status, message: s.detail, fix: s.fix ?? null })),
      },
      null,
      2,
    ) + '\n'
  );
}
