// Diagnostico: que campos obrigatorios faltam para submeter 1.0.1 ao App Review.
import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY_ID = process.env.ASC_KEY_ID || '6CQX832WVJ';
const ISSUER_ID = process.env.ASC_ISSUER_ID || '92705617-9a5f-4c92-8656-d810930fc323';
const KEY_PATH = process.env.ASC_KEY_PATH || 'C:/Users/Geraldo/Downloads/AuthKey_6CQX832WVJ.p8';
const APP_ID = process.env.ASC_APP_ID || '6820322547';
const BASE = 'https://api.appstoreconnect.apple.com';
const VERSION_ID = process.argv[2] || '8327ad1b-8450-4d92-8ad6-90c60a5eb5e4';

function makeToken() {
  const key = fs.readFileSync(KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' };
  const payload = { iss: ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = b64(header) + '.' + b64(payload);
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return data + '.' + sig.toString('base64url');
}

async function api(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + makeToken() } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) { console.log('  ! HTTP', res.status, path, JSON.stringify(json)); return null; }
  return json;
}

function v(label, value) {
  const empty = value === undefined || value === null || value === '';
  console.log(`  [${empty ? 'VAZIO' : 'ok  '}] ${label}${empty || value === true || value === false ? '' : ': ' + JSON.stringify(String(value).slice(0, 80))}${value === true || value === false ? ': ' + value : ''}`);
  return !empty;
}

async function main() {
  console.log('=== VERSAO', VERSION_ID, '===');
  const ver = await api(`/v1/appStoreVersions/${VERSION_ID}`);
  if (ver) console.log('  state:', ver.data.attributes.appStoreState, '| copyright:', ver.data.attributes.copyright, '| releaseType:', ver.data.attributes.releaseType);

  const buildRel = ver?.data?.relationships?.build?.data;
  console.log(buildRel ? `  [ok  ] build associado: ${buildRel.id}` : '  [VAZIO] build associado');

  const locs = await api(`/v1/appStoreVersions/${VERSION_ID}/appStoreVersionLocalizations`);
  console.log('\n=== LOCALIZACOES ===');
  if (!locs || !locs.data.length) { console.log  ? console.log('  [VAZIO] nenhuma localizacao') : null; }
  for (const l of locs?.data || []) {
    const a = l.attributes;
    console.log(`-- ${a.locale} (id ${l.id}) --`);
    v('description', a.description);
    v('whatsNew', a.whatsNew);
    v('keywords', a.keywords);
    v('promotionalText', a.promotionalText);
    v('supportUrl', a.supportUrl);
    v('marketingUrl', a.marketingUrl);
    v('privacyPolicyUrl', a.privacyPolicyUrl);
  }

  const detail = await api(`/v1/appStoreVersions/${VERSION_ID}/appStoreVersionReviewDetail?include=appStoreVersionSubtasks`);
  console.log('\n=== DETALHE DE REVISAO (nota/credenciais) ===');
  if (detail && detail.data) {
    const a = detail.data.attributes;
    v('note (instrucoes para revisor)', a.note);
    v('demoAccountName', a.demoAccountName);
    v('demoAccountPassword', a.demoAccountPassword);
    for (const t of detail.included || []) {
      if (t.type === 'appStoreVersionSubtasks') {
        const s = t.attributes;
        const con = s.resolveForCustomerService === true || s.resolved === true;
        console.log(`  [${con ? 'ok  ' : 'VAZIO'}] subtask: ${s.name}`);
      }
    }
  }

  const infos = await api(`/v1/apps/${APP_ID}/appInfos?include=appInfoLocalizations`);
  console.log('\n=== APP INFO (nome/subtitulo/privacidade) ===');
  for (const i of infos?.data || []) {
    const loc = (infos.included || []).find((x) => x.type === 'appInfoLocalizations' && x.relationships?.appInfo?.data?.id === i.id);
    console.log(`-- appInfo ${i.id} state=${i.attributes.appStoreState} --`);
    if (loc) {
      v('name', loc.attributes.name);
      v('subtitle', loc.attributes.subtitle);
      v('privacyPolicyUrl', loc.attributes.privacyPolicyUrl);
      v('privacyPolicyText', loc.attributes.privacyPolicyText);
      v('supportUrl', loc.attributes.supportUrl);
      v('marketingUrl', loc.attributes.marketingUrl);
    } else {
      console.log  ? console.log('  [VAZIO] sem appInfoLocalization') : null;
    }
  }

  const age = await api(`/v1/appStoreVersions/${VERSION_ID}/ageRatingDeclaration`);
  console.log('\n=== CLASSIFICACAO DE IDADE ===');
  if (age && age.data) {
    const a = age.data.attributes;
    console.log(' ', JSON.stringify(a, null, 2).slice(0, 1500));
  }

  const subs = await api(`/v1/reviewSubmissions?filter[app]=${APP_ID}&limit=10`);
  console.log('\n=== REVIEW SUBMISSIONS ===');
  for (const s of subs?.data || []) console.log(`  ${s.id}  state=${s.attributes.state}`);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
