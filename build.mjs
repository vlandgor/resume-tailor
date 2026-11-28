// Bundles src/ into dist/ (what GitHub Pages serves).
// npm run build   -> production build
// npm run dev     -> local server at http://localhost:5173 with rebuild on JS changes
import * as esbuild from 'esbuild';
import fs from 'fs';
import { createHash } from 'crypto';

const serve = process.argv.includes('--serve');

// Supabase project URL + publishable key (both public; RLS protects the data).
// Locally: put them in a .env file (see .env.example). In GitHub Actions: repository variables.
try { process.loadEnvFile('.env'); } catch { /* no .env file */ }
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) console.warn('\n  ! SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not set: the app will show a setup message.\n');

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist');
// index.html links app.js/styles.css with ?v=<content hash>, so browsers load the new files right after a deploy
// instead of serving cached ones (GitHub Pages lets browsers cache for ~10 minutes).
const hash = f => (fs.existsSync(f) ? createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 10) : 'dev');
const copyStatic = () => {
  fs.copyFileSync('src/styles.css', 'dist/styles.css');
  const html = fs.readFileSync('src/index.html', 'utf8')
    .replace('./styles.css', `./styles.css?v=${hash('dist/styles.css')}`)
    .replace('./app.js', `./app.js?v=${hash('dist/app.js')}`);
  fs.writeFileSync('dist/index.html', html);
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
  define: { __SUPABASE_URL__: JSON.stringify(SUPABASE_URL), __SUPABASE_KEY__: JSON.stringify(SUPABASE_KEY) },
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
