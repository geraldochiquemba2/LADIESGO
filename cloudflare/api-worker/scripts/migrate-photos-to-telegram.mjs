// Migra as fotos de perfil em base64 que ainda estejam na D1 para o Telegram.
//
// Fluxo: lê users."profilePhoto" LIKE 'data:%' → envia cada uma ao canal
// Telegram (sendPhoto) → guarda na D1 apenas o file_id devolvido.
// A imagem em si deixa de viver na D1; é servida por GET /api/v1/users/photo/:fileId.
//
// Uso (a partir de cloudflare/api-worker):
//   node scripts/migrate-photos-to-telegram.mjs           # migra
//   node scripts/migrate-photos-to-telegram.mjs --dry-run # só lista
//
// Segredos: lê TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (ou TG_*) de
// .dev.vars.telegram, ou do ambiente. Nunca imprime o token.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dryRun = process.argv.includes('--dry-run');
const DB = 'ladiesgo';
const WRANGLER = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function loadDotVars() {
  const f = join(root, '.dev.vars.telegram');
  const out = {};
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const vars = loadDotVars();
const TOKEN = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || vars.TG_BOT_TOKEN || vars.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || vars.TG_CHAT_ID || vars.TELEGRAM_CHAT_ID || '';

if (!TOKEN || !CHAT) {
  console.error('Falta TELEGRAM_BOT_TOKEN e/ou TELEGRAM_CHAT_ID (.dev.vars.telegram ou ambiente).');
  process.exit(1);
}
if (!existsSync(WRANGLER)) {
  console.error('wrangler não encontrado em ' + WRANGLER + ' — corre `npm install` em cloudflare/api-worker.');
  process.exit(1);
}

function d1(sql) {
  let out;
  try {
    out = execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', DB, '--remote', '--command', sql, '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const txt = String(e?.stdout || e?.message || e);
    let msg = txt.trim();
    try {
      const s = txt.indexOf('{');
      const en = txt.lastIndexOf('}');
      const j = JSON.parse(txt.slice(s, en + 1));
      msg = j?.error?.notes?.[0]?.text || j?.error?.text || msg;
    } catch {}
    throw new Error('D1 recusou: ' + msg.replace(/^A request[^.]*failed\.\s*/, '').slice(0, 300));
  }
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('Resposta inesperada do wrangler: ' + out.slice(0, 300));
  const parsed = JSON.parse(out.slice(start, end + 1));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first && first.results) || [];
}

function sqlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

async function sendPhoto(dataUrl, caption) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  const fd = new FormData();
  fd.append('chat_id', CHAT);
  fd.append('caption', caption.slice(0, 1000));
  fd.append('photo', new Blob([Buffer.from(m[2], 'base64')], { type: mime }), 'foto.jpg');
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) {
    console.error('Telegram recusou:', (j && (j.description || j.error_code)) || r.status);
    return null;
  }
  const photos = Array.isArray(j.result?.photo) ? j.result.photo : [];
  if (!photos.length) return null;
  const best = photos.reduce((a, b) => (Number(b.width || 0) * Number(b.height || 0) > Number(a.width || 0) * Number(a.height || 0) ? b : a));
  return best?.file_id ? String(best.file_id) : null;
}

const rows = d1(`SELECT id, name, phone, "profilePhoto" AS photo FROM users WHERE "profilePhoto" LIKE 'data:%'`);
console.log(`Fotos base64 na D1: ${rows.length}${dryRun ? ' (dry-run)' : ''}`);

let ok = 0, fail = 0;
for (const row of rows) {
  const who = row.name || row.phone || row.id;
  if (dryRun) {
    console.log(`- ${who}: ${String(row.photo).length} bytes base64 — seria enviada ao Telegram`);
    continue;
  }
  const fileId = await sendPhoto(row.photo, `LadiesGo · migração de foto · ${who}`);
  if (!fileId) {
    console.error(`- ${who}: FALHOU (mantida a foto antiga)`);
    fail++;
    continue;
  }
  try {
    d1(`UPDATE users SET "profilePhoto" = ${sqlStr(fileId)}, "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ${sqlStr(row.id)}`);
    console.log(`- ${who}: ok (file_id ${fileId.slice(0, 12)}…)`);
    ok++;
  } catch (e) {
    console.error(`- ${who}: enviada ao Telegram, mas a D1 recusou: ${e.message}`);
    fail++;
  }
}

console.log(`\nMigradas: ${ok} · falhadas: ${fail} · total: ${rows.length}`);
if (fail) process.exitCode = 1;
