import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY_ID = '6CQX832WVJ';
const ISSUER_ID = '92705617-9a5f-4c92-8656-d810930fc323';
const KEY_PATH = 'C:/Users/Geraldo/Downloads/AuthKey_6CQX832WVJ.p8';
const APP_ID = '6820322547';
const BASE = 'https://api.appstoreconnect.apple.com';
const VERSION_ID = '8327ad1b-8450-4d92-8ad6-90c60a5eb5e4';

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
  try { return { status: res.status, json: text ? JSON.parse(text) : null }; } catch { return { status: res.status, json: text }; }
}

async function main() {
  const ver = await api(`/v1/appStoreVersions/${VERSION_ID}`);
  console.log('relationships:', JSON.stringify(Object.keys(ver.json.data.relationships)));
  console.log(JSON.stringify(ver.json.data.relationships, null, 1).slice(0, 2000));

  for (const rel of Object.keys(ver.json.data.relationships)) {
    const r = await api(`/v1/appStoreVersions/${VERSION_ID}/relationships/${rel}`);
    console.log(`rel ${rel}: HTTP ${r.status} ->`, JSON.stringify(r.json).slice(0, 200));
  }

  const infos = await api(`/v1/appInfos/${'831d07fa-1a88-47f3-b6fd-dc36fe5aec12'}`);
  console.log('\nappInfo 831d07fa relationships:', JSON.stringify(Object.keys(infos.json.data.relationships)));
  const locs = await api(`/v1/appInfos/831d07fa-1a88-47f3-b6fd-dc36fe5aec12/appInfoLocalizations`);
  console.log('appInfoLocalizations HTTP', locs.status, JSON.stringify(locs.json).slice(0, 800));
  const age = await api(`/v1/appInfos/831d07fa-1a88-47f3-b6fd-dc36fe5aec12/ageRatingDeclaration`);
  console.log('ageRatingDeclaration(appInfo) HTTP', age.status, JSON.stringify(age.json).slice(0, 600));
}
main();
