// bundle a tool for node (the pump SDK's ESM build does not load under plain node)
//   node tools/build-sim.mjs [name]   name = pump-sim (default) | relay-check  →  tools/.<name>.bundle.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
const name = process.argv[2] || 'pump-sim';
const p = (f) => fileURLToPath(new URL(f, import.meta.url));
const banner = [
  "import{createRequire as __cr}from'module';",
  "import{fileURLToPath as __fu}from'url';",
  "import{dirname as __dn}from'path';",
  'const require=__cr(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);',
].join('');
await build({ entryPoints: [p('./' + name + '.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: p('./.' + name + '.bundle.mjs'), logLevel: 'warning', nodePaths: [p('../node_modules')], banner: { js: banner } });
