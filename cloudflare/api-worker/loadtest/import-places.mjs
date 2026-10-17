// LadiesGo — gerar SQL de import para a tabela `places` (D1) a partir de um JSON.
// Replica a normalizacao do worker (fold) e monta `norm` (nome+rua+municipio+
// provincia+tipo) e `nname` (nome) usados pela pesquisa /api/places/search.
//
// Uso:
//   node loadtest/import-places.mjs --file=webapp/luanda-top.json --out=loadtest/places-import.sql --replace
//   # depois aplicar (ex.: staging):
//   npx wrangler@4.151.1 d1 execute ladiesgo-staging --remote --env staging --file=loadtest/places-import.sql
//
// Aceita { places: [...] } ou um array simples. Campos usados por item:
//   name (obrig.), lat, lng, type, municipality, province, street, number.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const arg = (k, d) => { const p = process.argv.slice(2).find((x) => x.startsWith(`--${k}=`)); return p ? p.slice(k.length + 3) : d; };
const flag = (k) => process.argv.slice(2).includes(`--${k}`);
const dir = dirname(fileURLToPath(import.meta.url));
const FILE = arg('file', 'webapp/luanda-top.json');
const OUT = arg('out', join(dir, 'places-import.sql'));
const REPLACE = flag('replace');
const BATCH = Math.max(1, parseInt(arg('batch', '200'), 10) || 200);

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
const q = (v) => (v === null || v === undefined || v === '') ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const num = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : 'NULL');

function main() {
  const raw = JSON.parse(readFileSync(FILE, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.places || []);
  const rows = [];
  let skipped = 0;
  for (const p of list) {
    const name = String(p.name || '').trim();
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) { skipped++; continue; }
    const type = String(p.type || '');
    const street = String(p.street || '');
    const number = String(p.number || '');
    const municipality = String(p.municipality || '');
    const province = String(p.province || 'Luanda');
    const nname = fold(name);
    const norm = fold([name, street, municipality, province, type].filter(Boolean).join(' '));
    rows.push({ name, nname, norm, lat, lng, type, municipality, province, street, number });
  }

  const parts = [];
  parts.push('-- Gerado por loadtest/import-places.mjs a partir de ' + FILE);
  parts.push(`-- ${rows.length} locais (ignorados: ${skipped})`);
  if (REPLACE) parts.push('DELETE FROM places;');
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map((r) => `(${q(r.name)},${q(r.nname)},${q(r.norm)},${num(r.lat)},${num(r.lng)},${q(r.type)},${q(r.municipality)},${q(r.province)},${q(r.street)},${q(r.number)})`);
    parts.push('INSERT INTO places (name, nname, norm, lat, lng, type, municipality, province, street, "number") VALUES\n  ' + values.join(',\n  ') + ';');
  }
  writeFileSync(OUT, parts.join('\n') + '\n');
  console.log(`places import: ${rows.length} locais (ignorados ${skipped}) -> ${OUT}${REPLACE ? '  [DELETE antes]' : ''}`);
}

main();
