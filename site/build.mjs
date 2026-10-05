// Bundle the browser app: src/app.js → public/app.js (single IIFE, Buffer polyfilled).
//   node build.mjs   (from site/)
import { build } from 'esbuild';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, 'src/app.js')],
  bundle: true, format: 'iife', platform: 'browser', target: ['es2022'],
  outfile: join(here, 'public/app.js'), minify: true, sourcemap: false, logLevel: 'warning',
  inject: [join(here, 'src/shim.js')],
  define: { 'process.env.NODE_ENV': '"production"', 'global': 'window' },
});
console.log('✔ site/public/app.js');
