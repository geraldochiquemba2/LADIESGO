// Diagnostico v2: endpoints corretos (include no /v1/apps e /v1/appStoreVersions).
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
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }) + '.' + b64({ iss: ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' });
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return data + '.' + sig.toString('base64url');
}

async function api(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + makeToken() } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) { console.log('  ! HTTP', res.status, path.split('?')[0]); return null; }
  return json;
}

function chk(label, value) {
  const empty = value === undefined || value === null || value === '';
  console.log(`  [${empty ? 'VAZIO' : 'ok'}] ${label}${!empty && typeof value === 'string' && value.length > 1 ? ' = ' + JSON.stringify(value.slice(0, 70)) : ''}`);
}

async function main() {
  const ver = await api(`/v1/appStoreVersions/${VERSION_ID}?include=appStoreVersionAppStoreReviewDetail,ageRatingDeclaration`);
  console.log('=== VERSAO 1.0.1 (iOS) ===');
  console.log('  state:', ver.data.attributes.appStoreState, '| releaseType:', ver.data.attributes.releaseType, '| copyright:', ver.data.attributes.copyright);
  chk('build associado', ver.data.relationships.build?.data?.id);

  const inc = ver.included || [];
  const review = inc.find((i) => i.type === 'appStoreVersionAppStoreReviewDetails');
  const age = inc.find((i) => i.type === 'ageRatingDeclarations');

  console.log('\n=== NOTA DO REVISOR / CONTAS DE TESTE ===');
  if (review) {
    chk('note (instrucoes)', review.attributes.note);
    chk('demoAccountName', review.attributes.demoAccountName);
    chk('demoAccountPassword', review.attributes.demoAccountPassword);
  } else { console.log('  [VAZIO] sem appStoreVersionReviewDetail (nota e credenciais de teste)'); }

  console.log('\n=== CLASSIFICACAO DE IDADE ===');
  if (age) {
    console.log(' ', JSON.stringify(age.attributes));
  } else { console.log('  [VAZIO] sem ageRatingDeclaration'); }

  const locs = await api(`/v1/appStoreVersions/${VERSION_ID}/appStoreVersionLocalizations`);
  console.log('\n=== LOCALIZACAO (pt-PT) ===');
  for (const l of locs.data) {
    const a = l.attributes;
    chk('description', a.description);
    chk('whatsNew ("O que há de novo")', a.whatsNew);
    chk('keywords', a.keywords);
    chk('promotionalText', a.promotionalText);
    chk('supportUrl', a.supportUrl);
    chk('marketingUrl', a.marketingUrl);
    chk('privacyPolicyUrl', a.privacyPolicyUrl);
  }

  const infos = await api(`/v1/apps/${APP_ID}/appInfos?include=appInfoLocalizations,ageRatingDeclaration`);
  console.log('\n=== APP INFO LOCALIZATIONS ===');
  for (const i of infos.data) {
    const locsIds = (i.relationships.appInfoLocalizations?.data || []).map((x) => x.id);
    const locsInc = inc.filter((x) => x.type === 'appInfoLocalizations' && locsIds.includes(x.id));
    console.log(`-- appInfo ${i.id} (${i.attributes.appStoreState}) --`);
    if (!locsInc.length) console.log('  [VAZIO] sem localizacao (nome/subtitulo da loja)');
    for (const loc of locsInc) {
      chk('name', loc.attributes.name);
      chk('subtitle', loc.attributes.subtitle);
      chk('privacyPolicyUrl', loc.attributes.privacyPolicyUrl);
      chk('supportUrl', loc.attributes.supportUrl);
      chk('marketingUrl', loc.attributes.marketingUrl);
    }
  }

  const subs = await api(`/v1/reviewSubmissions?filter[app]=${APP_ID}&limit=10&include=items`);
  console.log('\n=== SUBMISSOES ABERTAS ===');
  for (const s of subs.data) {
    const itemIds = (s.relationships.items?.data || []).map((x) => x.id);
    console.log(`  ${s.id} state=${s.attributes.state} items=${itemIds.length}`);
  }
  for (const it of subs.included || []) {
    if (it.type === 'reviewSubmissionItems') {
      const rel = it.relationships || {};
      console.log(`    item ${it.id}: version=${rel.appStoreVersion?.data?.id || '-'} build=${rel.build?.data?.id || '-'}`);
    }
  }
}
main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
