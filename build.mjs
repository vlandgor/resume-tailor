// Bundles src/ into dist/ (what GitHub Pages serves).
// npm run build   -> production build
// npm run dev     -> local server at http://localhost:5173 with rebuild on JS changes
import * as esbuild from 'esbuild';
import fs from 'fs';

const serve = process.argv.includes('--serve');

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist');
const copyStatic = () => {
  for (const f of ['index.html', 'styles.css']) fs.copyFileSync(`src/${f}`, `dist/${f}`);
};
copyStatic();
fs.copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');

const options = {
  entryPoints: ['src/app.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/app.js',
  minify: !serve,
  sourcemap: serve,
  logLevel: 'info',
  plugins: [{ name: 'copy-static', setup: b => b.onEnd(copyStatic) }],
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: 'dist', port: 5173 });
  console.log(`\n  Resume Tailor dev server: http://localhost:${port}\n`);
} else {
  await esbuild.build(options);
}
