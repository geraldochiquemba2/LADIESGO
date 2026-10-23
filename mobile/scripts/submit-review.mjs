// Submissao automatica ao App Review (App Store Connect API).
// Uso:
//   node scripts/submit-review.mjs status
//   node scripts/submit-review.mjs submit 1.0.1
// Variaveis (ou editar os defaults abaixo):
//   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, ASC_APP_ID
import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY_ID = process.env.ASC_KEY_ID || '6CQX832WVJ';
const ISSUER_ID = process.env.ASC_ISSUER_ID || '92705617-9a5f-4c92-8656-d810930fc323';
const KEY_PATH = process.env.ASC_KEY_PATH || 'C:/Users/Geraldo/Downloads/AuthKey_6CQX832WVJ.p8';
const APP_ID = process.env.ASC_APP_ID || '6820322547';
const BASE = 'https://api.appstoreconnect.apple.com';

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

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + makeToken(),
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${opts.method || 'GET'} ${path}`);
    err.body = json;
    throw err;
  }
  return json;
}

async function listBuilds(limit = 10) {
  const j = await api(`/v1/builds?filter[app]=${APP_ID}&limit=${limit}&sort=-uploadedDate&include=preReleaseVersion`);
  const pre = {};
  (j.included || []).forEach((i) => { if (i.type === 'preReleaseVersions') pre[i.id] = i.attributes; });
  return (j.data || []).map((b) => {
    const rel = b.relationships && b.relationships.preReleaseVersion && b.relationships.preReleaseVersion.data;
    return {
      id: b.id,
      build: b.attributes.version,
      marketing: rel && pre[rel.id] ? pre[rel.id].version : '?',
      state: b.attributes.processingState,
      uploaded: b.attributes.uploadedDate,
    };
  });
}

async function listVersions() {
  const j = await api(`/v1/apps/${APP_ID}/appStoreVersions?limit=20`);
  return (j.data || []).map((v) => ({
    id: v.id,
    version: v.attributes.versionString,
    state: v.attributes.appStoreState,
    platform: v.attributes.platform,
  }));
}

async function status() {
  const [builds, versions] = await Promise.all([listBuilds(), listVersions()]);
  console.log('=== BUILDS (App ' + APP_ID + ') ===');
  builds.forEach((b) => console.log(`  v${b.marketing} build ${b.build}  ${b.state}  ${b.uploaded}  id=${b.id}`));
  console.log('=== VERSOES ===');
  versions.forEach((v) => console.log(`  ${v.version}  ${v.state}  ${v.platform}  id=${v.id}`));
}

async function ensureVersion(versionString) {
  const versions = await listVersions();
  const found = versions.find((v) => v.version === versionString && v.platform === 'IOS');
  if (found) return { id: found.id, created: false, state: found.state };
  const j = await api('/v1/appStoreVersions', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'appStoreVersions',
        attributes: {
          platform: 'IOS',
          versionString,
          copyright: '2026 LadiesGo',
          releaseType: 'AFTER_APPROVAL',
        },
        relationships: { app: { data: { type: 'apps', id: APP_ID } } },
      },
    }),
  });
  return { id: j.data.id, created: true, state: j.data.attributes.appStoreState };
}

async function latestBuildFor(marketing) {
  const builds = await listBuilds(30);
  return builds.find((b) => b.marketing === marketing && b.state === 'VALID');
}

async function attachBuild(versionId, buildId) {
  await api(`/v1/appStoreVersions/${versionId}/relationships/build`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { type: 'builds', id: buildId } }),
  });
}

async function versionLocalizations(versionId) {
  const j = await api(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`);
  return (j.data || []).map((x) => ({
    id: x.id,
    locale: x.attributes.locale,
    whatsNew: x.attributes.whatsNew,
    description: x.attributes.description,
    privacyPolicyUrl: x.attributes.privacyPolicyUrl,
  }));
}

async function fillWhatIsNew(versionId, text) {
  const locs = await versionLocalizations(versionId);
  for (const l of locs) {
    const body = { data: { type: 'appStoreVersionLocalizations', id: l.id, attributes: { whatsNew: text } } };
    await api(`/v1/appStoreVersionLocalizations/${l.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    console.log(`  whatsNew preenchido (${l.locale})`);
  }
}

async function findOpenSubmission() {
  const j = await api(`/v1/reviewSubmissions?filter[app]=${APP_ID}&filter[state]=READY_FOR_REVIEW&limit=10`);
  return (j.data || [])[0] || null;
}

// Fluxo novo de submissao (reviewSubmissions) — substitui appStoreVersionSubmissions.
async function submitForReview(versionId) {
  let submission = await findOpenSubmission();
  let submissionId;
  if (submission) {
    submissionId = submission.id;
    console.log('  reutiliza reviewSubmission:', submissionId, submission.attributes.state);
  } else {
    const sub = await api('/v1/reviewSubmissions', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: 'IOS' },
          relationships: { app: { data: { type: 'apps', id: APP_ID } } },
        },
      }),
    });
    submissionId = sub.data.id;
    console.log('  reviewSubmission criada:', submissionId, sub.data.attributes.state);
  }
  await api('/v1/reviewSubmissionItems', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    }),
  });
  console.log('  item (versao) adicionado a submissao');
  const done = await api(`/v1/reviewSubmissions/${submissionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } } }),
  });
  return { id: submissionId, state: done.data.attributes.state };
}

async function submit(versionString) {
  console.log('A preparar versao', versionString, '...');
  const v = await ensureVersion(versionString);
  console.log(v.created ? `  versao criada: ${v.id}` : `  versao existente: ${v.id} (${v.state})`);
  const build = await latestBuildFor(versionString);
  if (!build) throw new Error(`Nenhum build VALID para a versao ${versionString}. Espera o processamento no TestFlight.`);
  console.log(`  build a usar: build ${build.build} (id=${build.id})`);
  await attachBuild(v.id, build.id);
  console.log('  build associado a versao');
  const WHATS_NEW = process.env.ASC_WHATS_NEW ||
    'Nesta versao: recuperacao de senha pelo WhatsApp e botao de apoio ao cliente na pagina inicial. Melhorias de estabilidade.';
  await fillWhatIsNew(v.id, WHATS_NEW);
  const r = await submitForReview(v.id);
  console.log('  SUBMETIDO. state =', r.state, '(submission', r.id + ')');
}

const cmd = process.argv[2] || 'status';
const arg = process.argv[3];
(async () => {
  if (cmd === 'status') return status();
  if (cmd === 'submit') return submit(arg || '1.0.1');
  console.log('Comandos: status | submit [versao]');
})().catch((e) => {
  console.error('ERRO:', e.message);
  if (e.body) console.error(JSON.stringify(e.body, null, 2));
  process.exit(1);
});
