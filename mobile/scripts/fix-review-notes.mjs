// Corrige a nota/credenciais do revisor (appStoreReviewDetail) da versao 1.0.1.
import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY_ID = '6CQX832WVJ';
const ISSUER_ID = '92705617-9a5f-4c92-8656-d810930fc323';
const KEY_PATH = 'C:/Users/Geraldo/Downloads/AuthKey_6CQX832WVJ.p8';
const BASE = 'https://api.appstoreconnect.apple.com';
const REVIEW_DETAIL_ID = 'da50b620-bf9b-42ba-aff2-c29fb5d78a2b';

const NOTE = `Hello Review Team,

LadiesGo! is in Portuguese, for women in Luanda, Angola. A app is a secure ride-hailing service: only women drivers and only women passengers.

TEST ACCOUNTS - no SMS needed, ready in production:

1. Passenger: +244923000001 / 1234567890
   - Login > allow location > request a trip > see the driver on the map.

2. Driver (women only): +244923000002 / 1234567890
   - Already APPROVED > tap Online > accept the passenger's trip.

Backend (Cloudflare Workers + D1): https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1

Background location: only active when the driver taps Online, to keep sharing position with the passenger while Waze / Maps is open. Stops on Offline.

Contact: Ines Leao, +244943412688, chiquembaines@gmail.com
Thanks!`;

function token() {
  const key = fs.readFileSync(KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const d = b({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }) + '.' + b({ iss: ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' });
  const sig = crypto.sign('sha256', Buffer.from(d), { key, dsaEncoding: 'ieee-p1363' });
  return d + '.' + sig.toString('base64url');
}

const body = {
  data: {
    type: 'appStoreReviewDetails',
    id: REVIEW_DETAIL_ID,
    attributes: {
      notes: NOTE,
      demoAccountName: '+244923000001',
      demoAccountPassword: '1234567890',
      demoAccountRequired: true,
    },
  },
};

const res = await fetch(`${BASE}/v1/appStoreReviewDetails/${REVIEW_DETAIL_ID}`, {
  method: 'PATCH',
  headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log('HTTP', res.status);
console.log(text ? JSON.stringify(JSON.parse(text), null, 1).slice(0, 1200) : '(sem corpo)');
