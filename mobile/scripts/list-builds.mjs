import crypto from 'node:crypto';
import fs from 'node:fs';
const key = fs.readFileSync('C:/Users/Geraldo/Downloads/AuthKey_6CQX832WVJ.p8', 'utf8');
const now = Math.floor(Date.now() / 1000);
const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const d = b({ alg: 'ES256', kid: '6CQX832WVJ', typ: 'JWT' }) + '.' + b({ iss: '92705617-9a5f-4c92-8656-d810930fc323', iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' });
const t = d + '.' + crypto.sign('sha256', Buffer.from(d), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const j = await fetch('https://api.appstoreconnect.apple.com/v1/builds?filter[app]=6820322547&limit=6&sort=-uploadedDate&include=preReleaseVersion', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.json());
const pre = {};
(j.included || []).forEach((i) => (pre[i.id] = i.attributes));
for (const bl of j.data) {
  const r = bl.relationships;
  const pv = r.preReleaseVersion && r.preReleaseVersion.data ? pre[r.preReleaseVersion.data.id].version : '?';
  console.log('build', bl.attributes.version, '| marketing', pv, '|', bl.attributes.processingState, '|', bl.attributes.uploadedDate);
}
