import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/mcp_server/server.ts', socket: 'src/socket.ts', figmamcp: 'src/setup/bin.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  outDir: 'dist',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "module";\nconst require = __cr(import.meta.url);' },
  sourcemap: false,
  minify: true,
  splitting: false,
  // jimp (bundled so a copied dist/ is self-contained) reads __dirname, which does not exist in ESM.
  shims: true,
  bundle: true,
  noExternal: ['@modelcontextprotocol/sdk', 'uuid', 'ws', 'zod', 'jimp'],
}); 