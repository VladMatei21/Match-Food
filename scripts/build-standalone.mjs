import { build } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await mkdtemp(path.join(tmpdir(), 'matchfood-export-'));
let instance;

try {
  // Export preconfigured organisation data only; never read the live database.
  instance = createApp({ dataDir, enableRoleAccess: true, serveStatic: false });
  const users = instance.db.prepare('SELECT id, role, name, email, organization, businessType, phone, address, city, latitude, longitude, googleMapsUrl FROM users').all();
  const listings = instance.db.prepare('SELECT * FROM listings').all().map(row => ({ ...row, allergens: JSON.parse(row.allergens) }));
  const seed = { users, listings, requests: [], currentUserId: null };
  const artwork = Object.fromEntries(await Promise.all(['hero', 'bakery', 'vegetables', 'fruit', 'prepared', 'dairy', 'pantry'].map(async name => [name, `data:image/svg+xml;base64,${(await readFile(path.join(root, 'public/images', `${name}.svg`))).toString('base64')}`])));
  const favicon = `data:image/svg+xml;base64,${(await readFile(path.join(root, 'public/favicon.svg'))).toString('base64')}`;
  const result = await build({
    root,
    mode: 'standalone',
    publicDir: false,
    build: { write: false, cssCodeSplit: false, modulePreload: false, assetsInlineLimit: Infinity }
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const scripts = outputs.filter(item => item.type === 'chunk');
  if (scripts.length !== 1) throw new Error('The standalone site must contain exactly one self-contained script.');
  const styles = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  const htmlAsset = outputs.find(item => item.type === 'asset' && item.fileName === 'index.html');
  if (!htmlAsset) throw new Error('Vite did not produce the standalone HTML.');
  const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
  let html = String(htmlAsset.source);
  html = html.replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/g, () => `<script>globalThis.__MATCHFOOD_DATA__=${safeJson(seed)};globalThis.__MATCHFOOD_ARTWORK__=${safeJson(artwork)};</script>\n<script type="module">${scripts[0].code.replace(/<\/script/gi, '<\\/script')}</script>`);
  html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, () => `<style>${styles.map(item => String(item.source)).join('\n').replace(/<\/style/gi, '<\\/style')}</style>`);
  html = html.replace('href="/favicon.svg"', `href="${favicon}"`);
  if (/<script\b[^>]*\bsrc=|<link\b[^>]*rel="stylesheet"/i.test(html)) throw new Error('An external build dependency remains.');
  const destination = path.join(root, 'standalone/MatchFood.html');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, html);
  // A static host can serve this folder at its root without any API routes.
  await writeFile(path.join(root, 'standalone/index.html'), html);
  console.log(`Browser-ready website: ${destination}`);
  console.log('Open this file directly in a browser. No running server or Internet connection is required.');
} finally {
  instance?.close();
  await rm(dataDir, { recursive: true, force: true });
}
