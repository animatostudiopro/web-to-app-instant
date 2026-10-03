// Web to App Instant — builds the user's web project (if needed) and copies the
// finished site into ./www, ready to be wrapped as a native app.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const cfg = JSON.parse(fs.readFileSync('wta.json', 'utf8'));
const www = path.resolve('www');
fs.mkdirSync(www, { recursive: true });

const log = (m) => console.log(`[web-to-app] ${m}`);

if (cfg.source === 'url') {
  fs.writeFileSync(
    path.join(www, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${cfg.appName}</title></head><body style="margin:0;font-family:sans-serif;display:grid;place-items:center;height:100vh;color:#555">Loading…<script>location.replace(${JSON.stringify(cfg.url)})</script></body></html>`,
  );
  log(`Website app → ${cfg.url}`);
  process.exit(0);
}

const src = path.resolve('source');

// Unpack the uploaded project (downloaded from the "wta-input" release) and
// apply the AI feature integration prepared by Web to App Instant.
if (fs.existsSync('source.zip')) {
  const { default: AdmZip } = await import('adm-zip');
  new AdmZip('source.zip').extractAllTo(src, true);
  log('Project unpacked');
}
// Protected keys (GitHub Secrets → this build step only). Values are never printed.
let secrets = null;
try {
  secrets = process.env.WTA_SECRETS ? JSON.parse(process.env.WTA_SECRETS) : null;
} catch {
  console.error('[web-to-app] WTA_SECRETS is not valid JSON — continuing without protected keys');
}
if (secrets?.envFiles) {
  for (const [rel, content] of Object.entries(secrets.envFiles)) {
    if (rel.includes('..')) continue;
    const f = path.join(src, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(content));
  }
  const n = Object.keys(secrets.envFiles).length;
  if (n) log(`Restored ${n} .env file(s) from GitHub Secrets for this build only`);
}

if (fs.existsSync('wta-edits.json')) {
  const { edits = [], newFiles = [], notes = '' } = JSON.parse(fs.readFileSync('wta-edits.json', 'utf8'));
  let applied = 0, skipped = 0;
  for (const e of edits) {
    const f = path.join(src, e.path || '');
    if (!e.path || e.path.includes('..') || !fs.existsSync(f) || typeof e.find !== 'string' || !e.find) { skipped++; continue; }
    const text = fs.readFileSync(f, 'utf8');
    const i = text.indexOf(e.find);
    if (i < 0) { skipped++; continue; }
    fs.writeFileSync(f, text.slice(0, i) + e.replace + text.slice(i + e.find.length));
    applied++;
  }
  for (const n of newFiles) {
    if (!n.path || n.path.includes('..')) continue;
    const f = path.join(src, n.path);
    if (fs.existsSync(f)) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(n.content));
    applied++;
  }
  log(`AI feature integration: ${applied} change(s) applied${skipped ? `, ${skipped} skipped` : ''}`);
  if (notes) log(notes);
}

const run = (cmd, cwd) => {
  log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'false', GENERATE_SOURCEMAP: 'false' } });
};

function findIndex(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 4) return null;
  if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || /^(node_modules|\.git|src|scripts)$/.test(e.name)) continue;
    const r = findIndex(path.join(dir, e.name), depth + 1);
    if (r) return r;
  }
  return null;
}

let out = null;
const pkgPath = path.join(src, 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.scripts && pkg.scripts.build) {
    const lock = fs.existsSync(path.join(src, 'package-lock.json'));
    const yarn = fs.existsSync(path.join(src, 'yarn.lock'));
    const pnpm = fs.existsSync(path.join(src, 'pnpm-lock.yaml'));
    if (pnpm) run('npx --yes pnpm@9 install --no-frozen-lockfile', src);
    else if (yarn) run('npx --yes yarn@1 install --non-interactive', src);
    else run(lock ? 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund' : 'npm install --no-audit --no-fund', src);
    const base = process.env.WTA_BASE; // GitHub Pages serves the site from /<repo>/
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (base) {
      process.env.PUBLIC_URL = base; // Create React App
      process.env.BASE_URL = base;
    }
    run(base && deps.vite ? `npm run build -- --base=${base}` : 'npm run build', src);
    for (const d of ['dist', 'build', 'out', 'www', 'public']) {
      const r = findIndex(path.join(src, d));
      if (r) { out = r; break; }
    }
  }
}
if (!out) out = findIndex(src);
if (!out) {
  console.error('[web-to-app] Could not find an index.html in your project. Make sure your project has an index.html (or a build script that produces one).');
  process.exit(1);
}

log(`Using web files from ${path.relative(process.cwd(), out) || '.'}`);
fs.cpSync(out, www, { recursive: true, filter: (p) => !/node_modules|\.git(\/|\\|$)|(^|[\/\\])\.env(\.[\w-]+)?$/.test(p) });

const walk = (d, fn) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name), fn) : fn(path.join(d, e.name))));

// Put protected keys back where the placeholders are (only in the compiled output).
if (secrets?.values && Object.keys(secrets.values).length) {
  let hits = 0;
  walk(www, (f) => {
    if (!/\.(html?|js|mjs|cjs|css|json|txt|webmanifest)$/i.test(f)) return;
    let t = fs.readFileSync(f, 'utf8');
    let changed = false;
    for (const [name, value] of Object.entries(secrets.values)) {
      const ph = `__WTA_SECRET_${name}__`;
      if (t.includes(ph)) {
        t = t.split(ph).join(String(value));
        changed = true;
        hits++;
      }
    }
    if (changed) fs.writeFileSync(f, t);
  });
  log(`Injected ${Object.keys(secrets.values).length} protected key(s) from GitHub Secrets into the compiled app (${hits} place(s))`);
}

// GitHub Pages: make root-absolute links work under /<repo>/, SPA fallback, no Jekyll.
if (process.env.WTA_BASE) {
  const base = process.env.WTA_BASE;
  walk(www, (f) => {
    if (!/\.html?$/i.test(f)) return;
    const t = fs.readFileSync(f, 'utf8');
    const fixed = t.replace(/(\s(?:src|href)=["'])\/(?!\/)/g, (m, p1, off) => (t.startsWith(base.slice(1), off + m.length) ? m : p1 + base));
    if (fixed !== t) fs.writeFileSync(f, fixed);
  });
  if (fs.existsSync(path.join(www, 'index.html')) && !fs.existsSync(path.join(www, '404.html'))) fs.copyFileSync(path.join(www, 'index.html'), path.join(www, '404.html'));
  fs.writeFileSync(path.join(www, '.nojekyll'), '');
  log(`Prepared for GitHub Pages at ${base}`);
}
const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
log(`Copied ${count(www)} files into the app bundle`);
