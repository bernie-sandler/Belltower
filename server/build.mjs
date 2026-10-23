// Bundles the server (and @tt/shared) into dist/index.js. Runtime npm dependencies stay external
// and are installed in the image with `npm ci --omit=dev`.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const rootPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: Object.keys(pkg.dependencies ?? {}),
  define: { __APP_VERSION__: JSON.stringify(rootPkg.version) },
  banner: {
    // Some CJS deps call require(); give the ESM bundle one.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
