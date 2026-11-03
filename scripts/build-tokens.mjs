// Gera apps/web/src/styles/tokens.css a partir de packages/design-system/tokens.json (ADR-0009).
// tokens.json é a fonte da verdade; não edite o CSS gerado.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(fs.readFileSync(path.join(root, 'packages/design-system/tokens.json'), 'utf8'));
const themes = t.color.themes.map((th) => th.id);
const ref = (v) => (typeof v === 'string' && /^\{.+\}$/.test(v) ? `var(--${v.slice(1, -1)})` : v);
const colorFor = (tok, theme) => (typeof tok.value === 'string' ? tok.value : (tok.value[theme] ?? tok.value[themes[0]]));
const shadowFor = colorFor;

const block = (sel, lines) => `${sel} {\n${lines.map((l) => `  ${l}`).join('\n')}\n}\n`;
const themeLines = (theme) => [
  ...t.color.tokens.map((tok) => `--${tok.name}: ${ref(colorFor(tok, theme))};`),
  ...(t.shadow?.tokens ?? []).map((tok) => `--${tok.name}: ${shadowFor(tok, theme)};`),
  `color-scheme: ${theme === 'dark' ? 'dark' : 'light'};`,
];
const scalar = ['spacing', 'radius', 'size'].flatMap((k) => (t[k]?.tokens ?? []).map((tok) => `--${tok.name}: ${tok.value};`));
const fams = Object.entries(t.type.families).map(([k, v]) => `--font-${k}: ${v};`);

let css = `/* Finanças da Família — generated from tokens.json. Não edite: rode \`npm run tokens\`. */\n`;
css += block(`:root, [data-theme="${themes[0]}"]`, themeLines(themes[0]));
for (const th of themes.slice(1)) css += block(`[data-theme="${th}"]`, themeLines(th));
// Sem escolha explícita, segue o sistema operacional.
for (const th of themes.slice(1)) css += `@media (prefers-color-scheme: ${th}) {\n${block(`  :root:not([data-theme])`, themeLines(th)).replace(/^/gm, '  ')}}\n`;
css += block(':root', [...scalar, ...fams]);
for (const g of t.type.groups) {
  for (const s of g.styles) {
    css += block(`.${s.name}`, [`font-family: var(--font-${s.family ?? g.family});`, `font-size: ${s.fontSize};`, `line-height: ${s.lineHeight};`, `font-weight: ${s.fontWeight};`]);
  }
}
const out = path.join(root, 'apps/web/src/styles/tokens.css');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, css);
console.log(`tokens.css gerado (${t.color.tokens.length} cores, ${themes.length} temas)`);
