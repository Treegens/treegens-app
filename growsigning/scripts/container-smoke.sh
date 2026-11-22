#!/usr/bin/env bash
# Run by hand, where Docker is: builds the image, starts it with NO network at all, sends one envelope and signs it
# through the API, downloads the signed PDF and asks the server's own verify call whether it is the stored file.
#
#   scripts/container-smoke.sh                 builds from this folder
#   IMAGE=growsigning:1.2.3 scripts/container-smoke.sh     uses an image that is there already
#
# It talks to the server from inside the container (docker exec), because a container without a network has no
# published port. It needs nothing but Docker. It leaves nothing behind.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-}"
if [ -z "$IMAGE" ]; then
  IMAGE="growsigning:smoke"
  docker build -t "$IMAGE" .
fi
NAME="growsigning-smoke-$$"
VOLUME="$NAME-data"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOLUME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker volume create "$VOLUME" >/dev/null
# The same limits as docker-compose.example.yml: no network, a read-only root, no capabilities, one volume.
docker run -d --name "$NAME" --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:size=256m --tmpfs /app/.next/cache:size=128m,uid=1000,gid=1000 \
  -v "$VOLUME:/data" \
  -e APP_URL=http://localhost:3000 -e OUTSIDE_CALLS=none -e DEV_OUTBOX=1 \
  -e FILE_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64)" -e APP_SECRET="$(head -c 48 /dev/urandom | base64)" \
  "$IMAGE" >/dev/null

echo "Waiting for the health check..."
for i in $(seq 1 60); do
  if docker exec "$NAME" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then break; fi
  if [ "$i" = 60 ]; then echo "The server did not become healthy:"; docker logs "$NAME" | tail -40; exit 1; fi
  sleep 2
done
docker exec "$NAME" id -u | grep -qx 1000 || { echo "The server does not run as the unprivileged user."; exit 1; }

# Everything else is one script run inside the container, against 127.0.0.1.
docker exec -i "$NAME" node --input-type=module - <<'JS'
import { PDFDocument } from 'pdf-lib';
const base = 'http://127.0.0.1:3000/api';
let cookie = '';
const call = async (method, path, body, raw) => {
  const headers = { origin: 'http://127.0.0.1:3000', ...(cookie ? { cookie } : {}) };
  let payload = body;
  if (body && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + path, { method, headers, body: payload });
  const set = r.headers.getSetCookie?.() || [];
  if (set.length) cookie = [...new Map([...cookie.split('; ').filter(Boolean), ...set.map((c) => c.split(';')[0])].map((c) => [c.split('=')[0], c])).values()].join('; ');
  const data = raw ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}: ${raw ? data.toString().slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  return data;
};
const step = (s) => console.log(`  ok  ${s}`);

const h = await call('GET', '/health');
if (!h.ok || h.mail !== 'not configured') throw new Error('health: ' + JSON.stringify(h));
step('health answers 200 with no network and no mail server');

const email = `smoke-${Date.now()}@example.org`;
await call('POST', '/auth/signup', { name: 'Smoke Test', email, password: 'a long password for the smoke test 1' });
step('signed up');

// A login sends only once its address is confirmed, and the confirmation comes by email. This container has no mail
// server, so the script reads the email from the outbox, which DEV_OUTBOX=1 opens (never set that on a real server:
// it shows every email to anyone). A real closed network needs a mail relay inside it for this one step.
const box = await call('GET', '/dev/outbox');
const confirm = (box.emails || []).find((m) => m.to_email === email && /verify-email\?token=/.test(m.link || ''));
if (!confirm) throw new Error('the confirmation email is not in the outbox');
await call('POST', '/auth/verify', { token: new URL(confirm.link).searchParams.get('token') });
step('confirmed the address from the stored email');

const pdf = await PDFDocument.create();
pdf.addPage([595, 842]).drawText('Smoke test agreement', { x: 60, y: 760, size: 18 });
const form = new FormData();
form.append('file', new Blob([await pdf.save()], { type: 'application/pdf' }), 'Smoke.pdf');
const file = await call('POST', '/files', form);
step('uploaded a PDF');

// A person with a name and no email address: "I will send the link myself". No email is needed for anything here.
const made = await call('POST', '/envelopes', {
  subject: 'Smoke test',
  documents: [{ id: 'd', file_id: file.id }],
  recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', link_by_sender: true }],
  fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }],
});
const id = made.envelope.id;
await call('POST', `/envelopes/${id}/send`);
step('sent an envelope without any email');

const sent = (await call('GET', `/envelopes/${id}`)).envelope;
const view = await call('POST', `/envelopes/${id}/recipient-view`, { recipient_id: sent.recipients[0].id });
const token = String(view.url || view.link || '').split('/sign/')[1]?.split(/[?#/]/)[0];
if (!token) throw new Error('recipient-view gave no signing link: ' + JSON.stringify(view));
step('got the signing link from the API');

// The signer is someone else: no session cookie.
const mine = cookie;
cookie = '';
await call('POST', `/sign/${token}/consent`);
const page = await call('GET', `/sign/${token}`);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const values = {};
for (const f of page.fields || []) values[f.id] = '1';
await call('POST', `/sign/${token}/complete`, { values, signature_png: PNG, initials_png: PNG });
step('signed');
cookie = mine;

let signed;
for (let i = 0; i < 30 && !signed; i++) {
  const e = (await call('GET', `/envelopes/${id}`)).envelope;
  if (e.status === 'completed') signed = await call('GET', `/envelopes/${id}/download`, undefined, true).catch(() => null);
  if (!signed) await new Promise((r) => setTimeout(r, 1000));
}
if (!signed || signed.subarray(0, 5).toString() !== '%PDF-') throw new Error('no signed PDF came back');
step(`downloaded the signed PDF (${signed.length} bytes)`);

const vf = new FormData();
vf.append('file', new Blob([signed], { type: 'application/pdf' }), 'signed.pdf');
const v = await call('POST', '/public/verify', vf);
if (v.match !== true) throw new Error('verify does not match: ' + JSON.stringify(v));
step('verify says it is the stored file, unchanged');
JS

echo "Checking that the container could reach nothing..."
if docker exec "$NAME" node -e "fetch('https://example.org',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
  echo "The container reached the internet. It was not started without a network."; exit 1
fi
docker logs "$NAME" 2>&1 | grep -F "[outside]" | head -5 || true
echo "All of it worked: built, started with --network none, sent, signed, downloaded and verified on $(date -u +%Y-%m-%d)."
