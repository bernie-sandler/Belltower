// Fails the build if the built web bundle references any external http(s) asset.
// The app must work with no internet, so no CDN fonts, scripts, stylesheets or images.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../web/dist/', import.meta.url);
const offenders = [];

// Only flag URLs used as resources (src/href attributes, CSS url(), import()/fetch of absolute URLs).
const patterns = [
  /\b(?:src|href)\s*=\s*["']https?:\/\//gi,
  /url\(\s*["']?https?:\/\//gi,
  /@import\s+["']https?:\/\//gi,
  /\bimport\(\s*["']https?:\/\//gi,
];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(html|css|js|mjs|webmanifest|json)$/.test(name)) {
      const text = readFileSync(p, 'utf8');
      for (const re of patterns) {
        re.lastIndex = 0;
        const m = re.exec(text);
        if (m) offenders.push(`${p}: ...${text.slice(Math.max(0, m.index - 40), m.index + 80)}...`);
      }
    }
  }
}

walk(fileURLToPath(root));
if (offenders.length) {
  console.error('External resource URLs found in web/dist (no-CDN rule):\n' + offenders.join('\n'));
  process.exit(1);
}
console.log('check-dist: no external resource URLs in web/dist');
