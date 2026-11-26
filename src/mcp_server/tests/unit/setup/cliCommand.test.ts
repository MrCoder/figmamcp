import { describe, it, expect } from 'bun:test';
import { HELP, render } from '../../../../setup/render.js';
import { runCli } from '../../../../setup/main.js';
import { planSetup } from '../../../../setup/plan.js';
import type { Step } from '../../../../setup/types.js';
import { freshFacts, makeDeps, memFs } from './fakes.js';

// FigmaMCP is not on npm. The CLI ships inside the Mac app and setup does not put it on PATH, so every
// command the CLI prints must be the bundled path. An agent that reads `--help` runs what it says.
const CLI = '/Applications/FigmaMCP.app/Contents/Resources/bin/figmamcp';
const NPM_ROUTE = /\bnpx\b|\bnpm\b|\bbunx\b|figmamcp@/i;

describe('CLI text names the bundled command, never an npm route', () => {
  it('--help', () => {
    expect(HELP).not.toMatch(NPM_ROUTE);
    expect(HELP).toContain(`${CLI} setup`);
    expect(HELP).toContain(`${CLI} doctor`);
  });

  it('doctor closing line when a step needs attention', () => {
    const plan = planSetup(freshFacts());
    const steps: Step[] = [{ id: 'relay', title: 'Relay', status: 'todo', detail: 'x', actions: [] }];
    const text = render(plan, steps, 'doctor');
    expect(text).not.toMatch(NPM_ROUTE);
    expect(text).toContain(`Run: ${CLI} setup`);
  });

  for (const binary of [false, true]) {
    it(`missing package.json message (binary=${binary})`, async () => {
      const out: string[] = [];
      const code = await runCli(['setup'], makeDeps({ fsApi: memFs().fs, binary, pkgRoot: '/opt/figmamcp' }), { out: (s) => out.push(s), err: (s) => out.push(s) });
      expect(code).toBe(3);
      expect(out.join('')).not.toMatch(NPM_ROUTE);
      if (!binary) expect(out.join('')).toContain('https://figmamcp.dev');
    });
  }

  it('skill step fix when the package has no skill files', () => {
    const s = planSetup(freshFacts({ skillFiles: [] })).steps.find((x) => x.id === 'skill');
    expect(s?.status).toBe('fail');
    expect(s?.fix).not.toMatch(NPM_ROUTE);
    expect(s?.fix).toContain('https://figmamcp.dev');
  });

  it('runtime step fix when the package is incomplete', () => {
    const f = freshFacts();
    const s = planSetup(freshFacts({ runtime: { ...f.runtime, missingSource: ['dist/socket.js'] } })).steps.find((x) => x.id === 'runtime');
    expect(s?.status).toBe('fail');
    expect(s?.fix).not.toMatch(NPM_ROUTE);
    expect(s?.fix).toContain('https://figmamcp.dev');
  });
});
