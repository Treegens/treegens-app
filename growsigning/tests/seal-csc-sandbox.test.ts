// The cloud seal against SSL.com's real eSigner SANDBOX (scripts/seal-sandbox.ts does the work and the checks, with
// openssl, pdfsig, pdftoppm and pyHanko when installed). Skipped, with a message saying why, when the sandbox cannot be
// reached from this machine. It writes to a temporary folder, never to research/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { useProxyForFetch } from './netproxy.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

async function reachable(): Promise<string | null> {
  const restore = useProxyForFetch();
  try {
    const r = await fetch('https://cs-try.ssl.com/csc/v0/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) });
    return r.ok ? null : `the SSL.com sandbox answered HTTP ${r.status}`;
  } catch (e: any) {
    return `the SSL.com sandbox (cs-try.ssl.com) cannot be reached from this machine (${e?.cause?.code || e?.message || e})`;
  } finally {
    restore();
  }
}

const why = await reachable();

test('a real envelope sealed by the SSL.com sandbox holds when openssl, pdfsig and pyHanko check it, and its page is unchanged', { skip: why ? `skipped: ${why}` : false, timeout: 240_000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-out-'));
  try {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(ROOT, 'scripts/seal-sandbox.ts'), out], { encoding: 'utf8', timeout: 230_000, env: process.env });
    const last = r.stdout.trim().split('\n').pop() || '{}';
    const summary = JSON.parse(last);
    if (summary.code === 2) return; // went away between the probe and the run
    const failed = summary.checks.filter((c: any) => c.ok === false);
    assert.deepEqual(failed, [], r.stdout.slice(-4000));
    const passed = (name: RegExp) => summary.checks.some((c: any) => c.ok === true && name.test(c.name));
    assert.ok(passed(/openssl cms -verify/), 'the CMS holds over the ByteRange');
    assert.ok(passed(/sandbox credential/), 'the signer is the sandbox credential');
    assert.ok(passed(/signature time stamp/), 'the signature time stamp verifies to a bundled root');
    assert.ok(passed(/page 1 looks the same/), 'the page is unchanged');
    assert.ok(fs.existsSync(path.join(out, 'sealed-sandbox-sample.pdf')));
    // The DSS and the document time stamp are only "not done" when the sandbox's own OCSP and CRL hosts were refused.
    for (const c of summary.checks.filter((x: any) => x.ok === null && /DSS|document time stamp covers/.test(x.name))) assert.match(c.note, /ocsp-dev\.ssl\.com|long-term step did not complete/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
