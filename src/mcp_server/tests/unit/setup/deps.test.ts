import { describe, it, expect } from 'bun:test';
import { childEnv } from '../../../../setup/deps.js';

describe('childEnv', () => {
  it('puts the folder of an absolute program first on PATH, so an npm-installed CLI finds its own node', () => {
    const env = childEnv(['/u/.nvm/versions/node/v24.10.0/bin/codex', 'mcp'], { PATH: '/usr/bin:/bin', HOME: '/u' });
    expect(env.PATH).toBe('/u/.nvm/versions/node/v24.10.0/bin:/usr/bin:/bin');
    expect(env.HOME).toBe('/u');
  });
  it('leaves PATH alone for a bare command name', () => {
    expect(childEnv(['pgrep', '-x', 'Figma'], { PATH: '/usr/bin' }).PATH).toBe('/usr/bin');
  });
});
