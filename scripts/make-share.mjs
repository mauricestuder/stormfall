// Bundles the production build into one self-contained HTML file you can send to anyone.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let html = readFileSync('dist/index.html', 'utf8');
const js = html.match(/<script type="module" crossorigin src="\/?([^"]+)"><\/script>/);
const css = html.match(/<link rel="stylesheet" crossorigin href="\/?([^"]+)">/);
if (!js) throw new Error('No bundled script found in dist/index.html. Run "npm run build" first.');
html = html.replace(js[0], '');
if (css) html = html.replace(css[0], () => `<style>${readFileSync(join('dist', css[1]), 'utf8')}</style>`);
const code = readFileSync(join('dist', js[1]), 'utf8').replace(/<\/script/gi, '<\/script');
html = html.replace('</body>', () => `<script type="module">${code}</script>\n</body>`);
const theme = process.env.THEME;
const out = process.env.STYLE ? `Stormfall-style-${process.env.STYLE}.html` : !theme ? 'Stormfall.html' : theme === 'default' ? 'Stormfall-classic.html' : `Stormfall-${theme}.html`;
writeFileSync(out, html);
console.log(`${out} written (${Math.round(statSync(out).size / 1024)} KB)`);
