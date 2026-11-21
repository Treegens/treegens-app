// UX baseline: walks the core flows of the app in a real browser and counts what a person has to do.
//
// HOW TO RUN
//   1. Start a dev server with the dev outbox, on a throwaway database, with its own build folder so it can run
//      next to other servers on this checkout:
//        NEXT_DIST_DIR=.next-uxbase DATA_DIR=$(mktemp -d) DEV_OUTBOX=1 APP_URL=http://localhost:3690 npx next dev -p 3690
//   2. Run this script with the server address and an output folder:
//        node tests/ux/flows.cjs http://localhost:3690 tests/out/ux-baseline/
//   3. Read <out>/ux-flows.json (counts per flow) and the screenshots in <out>/<flow>/ (one per step, in order).
//   Afterwards: stop the server, delete .next-uxbase, and take the two ".next-uxbase" lines back out of
//   tsconfig.json if next dev added them.
//
//   Options (environment variables):
//     UX_WARMUP=0     skip the warm-up pass. With it (the default), every page is opened once on a separate account
//                     first, so the timings measure the app and not the dev server compiling a page for the first time.
//     UX_HEADED=1     show the browser.
//     UX_PROFILE      default (zero setup), everything or government. See PROFILES below.
//     UX_CEILINGS     the ceilings file, default tests/ux/ceilings.json (one set per profile).
//     UX_RECORD=1     write this run's numbers into the ceilings file for flows that have none yet, and lower the
//                     numbers that went down. Never raises one. Use it only when your batch merges.
//     UX_STRICT=1     the "not there yet" warnings (rules the app cannot pass until a simplify batch has marked or
//                     shortened its screen) count as broken. The integrator sets it once the five simplify batches
//                     have merged; until then they are listed as warnings with the batch that owns each.
//     UX_SAME_AS      for the government profile: the output folder of a default-profile run on the same code. The
//                     sidebar, Home and the editor's three steps must offer the same controls in both (P8).
//   Exit codes: 1 when a step of a flow fails (as before); 3 when every flow ran but a rule or a ceiling was broken;
//   0 otherwise. Warnings never change the exit code. The JSON and the screenshots are written either way.
//
// PROFILES (research/ux-charter.md, section 3)
//   default     zero setup: only DEV_OUTBOX and APP_URL on the server.
//   everything  every operator service faked, and the account set up after sign-up: details, a deletion schedule,
//               a second member, plus whatever exists of 2 languages and the AI switch. Start the server with
//                 env $(node tests/ux/flows.cjs --env everything) NEXT_DIST_DIR=... DATA_DIR=... npx next dev ...
//               This script then answers for the fake services on UX_FAKE_PORT (default 3739) while it runs, and
//               says in "profile_setup" what it could and could not switch on.
//   government  zero setup with DEPLOYMENT_PROFILE=government on the server (node tests/ux/flows.cjs --env government).
//
// RULES (checked on every screen and state, written to "rules" in the JSON, printed at the end)
//   P4   data-more="screen": at most 1 per screen. data-more="item": inside an element marked data-item, at most 1
//        per item. data-fold: content sections. data-more="nav": the sidebar's More group, not counted. Every
//        data-more and data-fold is closed when a screen opens. The inventory opens each More and counts its lines.
//        A <details> or a button with aria-expanded that has none of these is reported as a warning until the batch
//        that owns the screen marks it.
//   P3   data-feature="<key>": with zero setup no element of a feature whose gate is "operator" appears anywhere, and
//        none whose gate is "admin" appears outside /app/settings, and none whose gate is "docs" on a sender or signer
//        screen. The gates are the "gate" of each key in research/ux-notes.json.
//   P5   one main button: at most 1 element with class "btn primary" in the page body or the open dialog (the
//        sidebar and the bottom bar are not counted).
//   P7   the consent screen: 120 words or fewer before the tick and one phone screenful. Other actions: 6 at most.
//   2.2  Settings: an owner with zero setup sees at most 10 sections, a member at most 4; at most 4 cards
//        (data-item="card") per section with zero setup.
//   3    with everything set up, a core flow has no more screens than the default ceiling and at most 1 more action.
//   P12  the labels in ONCE appear at most once per screen outside data-item elements.
//   P6, P13  the words in CLAIMS, TECHNICAL and AVOID, on signer, public and trust pages (see checkWords).
//
// WHAT IS COUNTED, PER FLOW
//   actions   every click (desktop), tap (phone), field typed (one per field, plus the characters), key press that
//             moves on (Enter), and file picked (2: opening the file picker and choosing the file). Opening an email
//             in the mailbox counts as one click or tap.
//   screens   every page, dialog or email the person passes through. A page that only changes in place (a file
//             finished uploading, a field was placed) is a "state": it gets a screenshot and is measured, but is not
//             counted as a new screen.
//   choices   on each screen and state: every control the person could use (buttons, links, form fields, tabs),
//             visible and enabled, inside the open dialog when there is one. Also how many of them are on the first
//             screenful, how many notices and warnings are shown, how many words are on it, and how many screenfuls
//             tall the page is.
//   timing    wall_ms is the time the script took, with no human thinking time: it is the time spent waiting for the
//             app. klm_estimate_s is a keystroke-level-model estimate of a person's time for the same actions (mental
//             preparation 1.35 s, pointing 1.1 s, press 0.2 s, 0.28 s a character, 4 s to find a file), plus the wait.
//             It leaves out reading: read_all_s is how long reading every word on every screen would take at 240
//             words a minute, as a measure of how much text a flow puts in front of someone.
//
// THE FLOWS
//   a  A new sender signs up, confirms their address and sends their first document to one person, one signature.
//   b  That person opens the email, agrees, signs and finishes. On a phone (iPhone 13) and on a desktop.
//   c  The sender sends from a template (the template is made through the API beforehand, not counted).
//   d  The sender finds the completed document and downloads it.
//   e  The sender opens Settings and changes their name.
//   f  A signer who cannot sign right now looks for help on the signing page, on a phone.
//   g  The sender signs in again from the landing page and lands on Home.
//   h  The sender signs a document themselves: today Home, "Sign a document yourself" (?self=1); once that is gone,
//      the start button and "Add me". After Send: "Sign now" when step 3 offers it, else "Sign now" on the envelope page,
//      else Home and Sign on its row.
//   Then an inventory (not counted as a flow): every Settings tab, every option in the editor, on the envelope page
//   and on the signing page, written to the JSON under "inventory" with screenshots in <out>/inventory/, every More
//   opened and counted (under "inventory_mores"), and the public pages checked for words.
//
// Buttons and links are found by role and by a pattern of their accessible name, so small changes of wording do not
// break the script. When a pattern no longer matches anything, the step fails with the pattern in the message.

const fs = require('node:fs');
const path = require('node:path');

// `node tests/ux/flows.cjs --env everything` (or government) prints the server settings of a profile, for env $(...).
if (process.argv[2] === '--env') {
  const which = (process.argv[3] || 'default').toLowerCase();
  const fake = `http://127.0.0.1:${Number(process.env.UX_FAKE_PORT || 3739)}`;
  const out = [];
  if (which === 'government') out.push('DEPLOYMENT_PROFILE=government');
  else if (which === 'everything') {
    out.push('SMS_DEV_OUTBOX=1', 'SUPPORT_CHAT_API_KEY=ux-fake', `SUPPORT_CHAT_BASE_URL=${fake}/v1`, 'SUPPORT_CHAT_MODEL=ux-fake',
      'CONVERTER=gotenberg', `CONVERTER_URL=${fake}`, 'GOOGLE_CLIENT_ID=ux-fake', 'GOOGLE_CLIENT_SECRET=ux-fake',
      'MICROSOFT_CLIENT_ID=ux-fake', 'MICROSOFT_CLIENT_SECRET=ux-fake', 'SUPPORT_EMAIL=help@example.org', 'OPERATOR_EMAILS=operator@example.org');
    // A self-signed seal key and certificate, so the digital seal is on. Made with openssl, kept for later runs.
    try {
      const dir = path.join(require('node:os').tmpdir(), 'growsigning-ux-fakes');
      const key = path.join(dir, 'seal-key.pem');
      const cert = path.join(dir, 'seal-cert.pem');
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(cert) || Date.now() - fs.statSync(cert).mtimeMs > 300 * 864e5)
        require('node:child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert,
          '-days', '365', '-subj', '/CN=UX test seal', '-addext', 'keyUsage=critical,digitalSignature,nonRepudiation'], { stdio: 'ignore' });
      out.push(`SEAL_KEY_PEM=${key}`, `SEAL_CERT_PEM=${cert}`);
    } catch {
      console.error('openssl did not run, so the digital seal stays off in this profile.');
    }
  } else if (which !== 'default') {
    console.error('Profiles: default, everything, government.');
    process.exit(2);
  }
  console.log(out.join(' '));
  process.exit(0);
}

let pw;
try {
  pw = require('playwright');
} catch {
  console.error('Playwright is not installed where Node can find it. Install it (npm i -g playwright) or set NODE_PATH.');
  process.exit(2);
}
const { chromium, devices } = pw;
const { PDFDocument, StandardFonts } = require('pdf-lib');

const BASE = (process.argv[2] || 'http://localhost:3690').replace(/\/$/, '');
const OUT = path.resolve(process.argv[3] || 'tests/out/ux-baseline');
const WARMUP = process.env.UX_WARMUP !== '0';
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const PHONE = devices['iPhone 13'];
const STAMP = Date.now().toString(36);
const PASSWORD = 'plant-more-trees';
const SENDER = { name: 'Rosa Gardener', email: `rosa-${STAMP}@example.org` };
const SIGNER_PHONE = { name: 'Ada Sponsor', email: `ada-${STAMP}@example.org` };
const SIGNER_DESK = { name: 'Ben Partner', email: `ben-${STAMP}@example.org` };
const SIGNER_TPL = { name: 'Cleo Client', email: `cleo-${STAMP}@example.org` };
const SIGNER_HELP = { name: 'Dev Busy', email: `dev-${STAMP}@example.org` };
const DOC_NAME = 'Planting partnership';
const PROFILE = (process.env.UX_PROFILE || 'default').toLowerCase();
if (!['default', 'everything', 'government'].includes(PROFILE)) {
  console.error(`UX_PROFILE is "${PROFILE}". Use default, everything or government.`);
  process.exit(2);
}
const ZERO_SETUP = PROFILE !== 'everything';
const CEILINGS_FILE = path.resolve(process.env.UX_CEILINGS || path.join(__dirname, 'ceilings.json'));
const RECORD = process.env.UX_RECORD === '1';
const SAME_AS = process.env.UX_SAME_AS ? path.resolve(process.env.UX_SAME_AS) : null;
const FAKE_PORT = Number(process.env.UX_FAKE_PORT || 3739);
const MEMBER = { name: 'Mo Member', email: `mo-${STAMP}@example.org` };

// The lists of research/ux-charter.md (section 4, "Lists the script checks"). Change them there and here together.
// P12: labels allowed at most once per screen, outside data-item elements. A control repeated in each item names its
// item in its accessible name ("Download Planting partnership"), so it never matches.
const ONCE = ['Download', 'Help', 'Delete', 'Remind', 'Send', 'Questions and comments', 'Language'];
// P13: claims, on signer, public and trust pages. A hit passes only inside a sentence that says it is not held, or in
// a sentence of HELD (the registry's entries marked held, once gov-G01 has built the registry: none today).
const CLAIMS = [/\b(certified|qualified|compliant|accredited)\b/i, /\b(ISO|SOC ?2|HIPAA|eIDAS)\b/];
const NOT_HELD = /\b(not|no|never|without|nor)\b|n't\b/i;
const HELD = [];
// A claim is about us when we are its subject (we, GrowSigning, this service or "our ..." within a few words before
// the claim word, with no comma between), or when it is a bare label (a badge) of 4 words or fewer on a page that
// does not explain the law. A sentence that explains what a law or another service asks is not a claim.
const US = "(?:we|we're|we are|GrowSigning|this (?:service|product|site|software)|our \\w+|signatures? (?:made|you make) here)";
const aboutUs = (s, claim) => new RegExp(`\\b${US}(?: [\\w'-]+){0,6} ${claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s);
const SENTENCE_MAX = 20; // P6: words in a sentence on a signer screen
const CONSENT_WORDS = 120; // P7
const LANDING_WORDS = 800; // 2.7
const SETTINGS_CAP = { owner: 10, member: 4, cards: 4 }; // 2.2, zero setup
const STRICT = process.env.UX_STRICT === '1';
// P1: nothing in the ceilings file is ever raised. The zero-setup ceilings may never be above these (the baseline of
// tests/out/ux-baseline, and for g and h their first measurement), whatever the file says.
const NEVER_ABOVE = {
  'a-send-first': [19, 10, 193, 42, 3751, 2], 'b-sign-phone': [8, 6, 48, 13, 751, 0], 'b-sign-desktop': [8, 6, 48, 13, 761, 0],
  'c-template-send': [5, 4, 92, 34, 666, 1], 'd-find-download': [4, 3, 99, 43, 739, 0], 'e-settings-name': [3, 2, 68, 36, 487, 0],
  'f-signer-help': [7, 5, 42, 10, 927, 2], 'g-sign-in': [4, 3, 81, 42, 2807, 0], 'h-sign-myself': [14, 9, 156, 37, 1493, 1],
};
// P6: technical names, never on signer pages, nor on public pages other than the trust pages.
const TECHNICAL = /\b(PAdES|PKI|SAML|SCIM|SIEM|OIDC|OpenID|QES|AES|QTSP|PDF\/A|RFC ?3161|FIPS|PKCS(#\d+)?|HSM|KMS|OTP|LTV|OCSP|IDV|IAL|AAL|PIV|CAC|Part 11|LLM)\b/;
// P6: sender words, never on signer pages (and only a warning on public pages).
const AVOID = /\b(envelopes?|recipients?|adopt(ed)?|audit trail|void(ed)?|clone|nudge|PowerForms?|clickwrap|bulk send)\b/i;
// P4: the most lines an opened More may hold.
const MORE_CAP = { item: ZERO_SETUP ? 6 : 8, screen: 9, step3: 7, signing: 6, role_options: 8, other_actions: 6 };

// Which pages a person sees as whom, by address.
const pageKind = (url, kind, flowId) => {
  if (kind === 'email') return /^(b|f|h)-/.test(flowId || '') ? 'signer' : 'sender';
  if (/^\/(sign|f|agree)\//.test(url)) return 'signer';
  if (/^\/(security|procurement|accessibility|developers)(\/|$|\?)/.test(url)) return 'trust';
  if (/^\/app(\/|$|\?)/.test(url)) return 'sender';
  return 'public';
};
// The simplify batch that owns a screen: it adds the attributes there.
const ownerOf = (url, kind, flowId, inSidebar) => {
  if (inSidebar) return 'simplify-start';
  if (kind === 'email') return pageKind(url, kind, flowId) === 'signer' ? 'simplify-signing' : 'simplify-start';
  if (/^\/(sign|f|agree)\//.test(url)) return 'simplify-signing';
  if (/^\/app\/(envelopes|templates)\/[^/?]+\/edit/.test(url)) return 'simplify-editor';
  if (/^\/app\/(envelopes|templates)/.test(url)) return 'simplify-envelope';
  if (/^\/app\/settings/.test(url) || !/^\/app/.test(url)) return 'simplify-public';
  return 'simplify-start';
};

// The gate of every feature key, from research/ux-notes.json, so the script and the notes never drift.
function readGates() {
  try {
    const notes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'research', 'ux-notes.json'), 'utf8'));
    return Object.fromEntries(Object.entries(notes).filter(([, v]) => v && typeof v === 'object' && v.gate).map(([k, v]) => [k, v.gate]));
  } catch {
    return {};
  }
}
const GATES = readGates();

fs.mkdirSync(OUT, { recursive: true });
const report = { base: BASE, profile: PROFILE, started_at: new Date().toISOString(), conventions: {}, flows: {}, inventory: {}, inventory_mores: {}, failures: [], rules: { broken: [], warnings: [] }, console_errors: [] };

// A rule result. The same finding on many screens is kept once, with the screens listed.
// Level "todo": the app cannot pass yet because a simplify batch has not marked or shortened the screen. A warning
// that names the batch, and broken with UX_STRICT=1.
function rule(level, id, detail, where) {
  if (level === 'todo') level = STRICT ? 'broken' : 'warning';
  const list = report.rules[level === 'broken' ? 'broken' : 'warnings'];
  const had = list.find((x) => x.rule === id && x.detail === detail);
  if (had) {
    if (where && !had.where.includes(where) && had.where.length < 12) had.where.push(where);
  } else list.push({ rule: id, detail, where: where ? [where] : [] });
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const visible = (loc) => loc.filter({ visible: true });
const byRole = (scope, role, name) => visible(scope.getByRole(role, { name })).first();

async function makePdf() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const bold = await d.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < 2; p++) {
    const page = d.addPage([612, 792]);
    page.drawText(p === 0 ? `${DOC_NAME} agreement` : 'Signatures', { x: 72, y: 700, size: 22, font: bold });
    const lines = p === 0
      ? ['This agreement is made between the Planting Partner and the Sponsor.', 'The Sponsor agrees to fund the planting and care of mangrove seedlings', 'along the agreed stretch of coastline for a period of three years.']
      : ['Signed by the Sponsor:', '', '', '', 'Date:'];
    lines.forEach((l, i) => page.drawText(l, { x: 72, y: 650 - i * 24, size: 12, font }));
  }
  const dir = path.join(OUT, '_files');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(DOC_NAME)}.pdf`);
  fs.writeFileSync(file, await d.save());
  return file;
}

async function outbox() {
  const r = await fetch(`${BASE}/api/dev/outbox`);
  if (!r.ok) throw new Error(`The dev outbox answered ${r.status}. Start the server with DEV_OUTBOX=1 and no SMTP_URL.`);
  return (await r.json()).emails || [];
}
async function waitMail(to, test, what) {
  for (let i = 0; i < 60; i++) {
    const m = (await outbox()).find((x) => x.to_email === to && test(x));
    if (m) return m;
    await sleep(250);
  }
  throw new Error(`No email to ${to} (${what}) in the dev outbox after 15 seconds`);
}

// The API, called from inside a browser page that is signed in, the way the app itself calls it.
async function apiIn(page, pathname, { method, body, pdfBase64, fileName } = {}) {
  const res = await page.evaluate(async ([pathname, method, body, pdfBase64, fileName]) => {
    let init = { method: method || (body || pdfBase64 ? 'POST' : 'GET') };
    if (pdfBase64) {
      const bytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), fileName);
      init.body = form;
    } else if (body) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const r = await fetch(`/api${pathname}`, init);
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, [pathname, method, body, pdfBase64, fileName]);
  if (res.status >= 400) throw new Error(`${method || 'POST'} /api${pathname}: ${res.status} ${res.data?.error || ''}`);
  return res.data;
}

// Makes and sends an envelope for one signer with one signature field, through the API (setup, never counted).
async function sendByApi(page, pdf, subject, signer, kind = 'envelope') {
  const file = await apiIn(page, '/files', { pdfBase64: fs.readFileSync(pdf).toString('base64'), fileName: `${slug(subject)}.pdf` });
  const tpl = kind === 'template';
  const { envelope } = await apiIn(page, '/envelopes', { body: {
    kind, subject, message: '',
    documents: [{ id: 'd1', file_id: file.id, name: subject }],
    recipients: [{ id: 'r1', routing_order: 1, role: 'signer', name: tpl ? '' : signer.name, email: tpl ? '' : signer.email, ...(tpl ? { role_name: 'Client' } : {}) }],
    fields: [{ document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 1, x: 0.14, y: 0.2, w: 0.3, h: 0.06 }],
  } });
  if (!tpl) await apiIn(page, `/envelopes/${envelope.id}/send`, { method: 'POST', body: {} });
  return envelope.id;
}

// ---------------------------------------------------------------------------------------------------------------
// Measuring one screen: runs in the page. Looks inside the open dialog when there is one.

function measureInPage() {
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open]')].filter(vis);
  const dialog = dialogs[dialogs.length - 1] || null;
  const scope = dialog || document.body;
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=link], [role=checkbox], [role=radio], [role=menuitem], [role=switch], [role=option]';
  const seen = new Set();
  const controls = [];
  for (let el of scope.querySelectorAll(sel)) {
    // A visually hidden input (a file picker or a styled checkbox) is used through the label around it.
    const r0 = el.getBoundingClientRect();
    if (el.matches('input') && (r0.width < 4 || r0.height < 4)) el = el.closest('label') || el;
    if (seen.has(el) || !vis(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
    const lab = el.labels?.[0]?.innerText || el.closest('label')?.innerText;
    const name = (el.getAttribute('aria-label') || labelled || (el.matches('input, select, textarea') ? lab || el.getAttribute('placeholder') : '') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const kind = el.matches('a') ? 'link' : el.matches('select') ? 'select' : el.matches('textarea') ? 'textbox' : el.matches('input[type=checkbox], [role=checkbox]') ? 'checkbox' : el.matches('input[type=radio], [role=radio]') ? 'radio' : el.matches('input[type=file]') || (el.matches('label') && el.querySelector('input[type=file]')) ? 'file' : el.matches('input') ? 'textbox' : el.matches('[role=tab]') ? 'tab' : 'button';
    const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
    controls.push({ kind, name, disabled, first_screen: r.top < innerHeight && r.bottom > 0, in_item: !!el.closest('[data-item]'), in_sidebar: !!el.closest('aside, nav, [role=navigation]') });
  }
  const enabled = controls.filter((c) => !c.disabled);
  // The attributes of the charter (P4, P3), inside the open dialog or on the page.
  const isOpen = (el) => (el.matches('details') ? el.open : el.getAttribute('aria-expanded') === 'true');
  const mores = [...scope.querySelectorAll('[data-more], [data-fold]')].filter(vis);
  const items = [...scope.querySelectorAll('[data-item]')].filter(vis);
  const ownMores = (it) => [...it.querySelectorAll('[data-more="item"]')].filter((m) => vis(m) && m.closest('[data-item]') === it).length;
  const unmarked = [...scope.querySelectorAll('details, [aria-expanded]')].filter((el) => vis(el) && !el.matches('select, [role=combobox], [data-more], [data-fold]')
    && !el.closest('[data-more="nav"]') && !(el.matches('summary') && el.parentElement?.matches('[data-more], [data-fold]')));
  const attrs = {
    more_screen: mores.filter((m) => m.dataset.more === 'screen').length,
    more_item: mores.filter((m) => m.dataset.more === 'item').length,
    folds: mores.filter((m) => m.hasAttribute('data-fold')).length,
    items: items.length,
    items_with_two_mores: items.filter((it) => ownMores(it) > 1).length,
    item_mores_outside_items: mores.filter((m) => m.dataset.more === 'item' && !m.closest('[data-item]')).length,
    open: mores.filter((m) => m.dataset.more !== 'nav' && isOpen(m)).map((m) => (m.getAttribute('aria-label') || m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60)),
    unmarked_page: unmarked.filter((el) => !el.closest('aside, nav, [role=navigation]')).map((el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)),
    unmarked_sidebar: unmarked.filter((el) => el.closest('aside, nav, [role=navigation]')).length,
    features: [...new Set([...scope.querySelectorAll('[data-feature]')].filter(vis).map((el) => el.dataset.feature))],
    cards: items.filter((it) => it.dataset.item === 'card').length,
    // P5: filled buttons in the page body or the open dialog; the sidebar and the bottom bar are not counted.
    primary: [...scope.querySelectorAll('.btn.primary')].filter((el) => vis(el) && !el.closest('aside, nav, [role=navigation]')).map((el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)),
  };
  // P7: the words before the first tick box (the consent screen).
  const tick = [...scope.querySelectorAll('input[type=checkbox], [role=checkbox]')].find((el) => vis(el) || vis(el.closest('label')));
  let wordsBeforeTick = null;
  if (tick) {
    const range = document.createRange();
    range.setStart(scope, 0);
    range.setEndBefore(tick.closest('label') || tick);
    wordsBeforeTick = range.toString().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }
  const words = (scope.innerText || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const notices = [...scope.querySelectorAll('.notice, [role=alert], [role=note], .ed-banner')].filter(vis).filter((n, i, all) => !all.some((o) => o !== n && o.contains(n)));
  const heading = (dialog && (dialog.getAttribute('aria-label') || document.getElementById(dialog.getAttribute('aria-labelledby') || '')?.innerText))
    || document.querySelector('h1')?.innerText || document.title;
  const count = (k) => enabled.filter((c) => c.kind === k).length;
  return {
    heading: (heading || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    in_dialog: !!dialog,
    choices: enabled.length,
    choices_first_screen: enabled.filter((c) => c.first_screen).length,
    by_kind: { buttons: count('button'), links: count('link'), fields: count('textbox') + count('select') + count('file'), checkboxes: count('checkbox') + count('radio'), tabs: count('tab') },
    disabled: controls.length - enabled.length,
    notices: notices.length,
    notice_text: notices.map((n) => n.innerText.replace(/\s+/g, ' ').trim().slice(0, 160)),
    words,
    screenfuls: dialog ? +(dialog.scrollHeight / innerHeight).toFixed(1) : +(document.documentElement.scrollHeight / innerHeight).toFixed(1),
    controls: enabled.map((c) => `${c.kind}: ${c.name}`),
    attrs,
    words_before_tick: wordsBeforeTick,
    // For the rule checks only; taken out before the entry is written to the JSON.
    _once: enabled.filter((c) => !c.in_item).map((c) => c.name),
    _text: (scope.innerText || '').slice(0, 60000),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The charter's rules, on one measured screen or state. `where` names it in the report.

function checkScreen(m, { url, kind, flowId, isScreen, where }) {
  const a = m.attrs || {};
  const owner = ownerOf(url, kind, flowId, false);
  // P4: how many Mores, one per item, closed on arrival.
  if (a.more_screen > 1) rule('broken', 'P4 one data-more="screen"', `${a.more_screen} on one screen`, where);
  if (a.items_with_two_mores) rule('broken', 'P4 one More per item', `${a.items_with_two_mores} data-item elements hold 2 or more data-more="item"`, where);
  if (a.item_mores_outside_items) rule('broken', 'P4 data-more="item" inside its item', `${a.item_mores_outside_items} data-more="item" not inside a data-item element`, where);
  if (isScreen && a.open?.length) rule('broken', 'P4 closed when the screen opens', `open on arrival: ${a.open.join(', ')}`, where);
  if (isScreen && a.unmarked_page?.length) rule('todo', 'P4 attributes not there yet', `expanders without data-more or data-fold, to be marked by ${owner}`, `${where} (${a.unmarked_page.length}: ${a.unmarked_page.slice(0, 3).join(' | ')})`);
  if (isScreen && a.unmarked_sidebar) rule('todo', 'P4 attributes not there yet', 'sidebar expanders without data-more="nav", to be marked by simplify-start', where);
  // P3: gated features absent with zero setup.
  if (ZERO_SETUP) for (const f of a.features || []) {
    const gate = GATES[f];
    if (!gate) rule('broken', 'P3 data-feature key', `data-feature="${f}" is not a feature key of the charter`, where);
    else if (gate === 'operator' || (gate === 'admin' && !/^\/app\/settings/.test(url)) || (gate === 'docs' && /^(sender|signer)$/.test(pageKind(url, kind, flowId)) && !/^\/app\/operator/.test(url))) rule('broken', 'P3 hidden until set up', `data-feature="${f}" (gate: ${gate}) shows with zero setup`, where);
  }
  // P12: labels at most once outside items.
  const norm = (s) => s.replace(/\s*\(\d+\)$/, '').trim().toLowerCase();
  for (const label of ONCE) {
    const n = (m._once || []).filter((x) => norm(x) === label.toLowerCase()).length;
    if (n > 1) rule(a.items ? 'broken' : 'todo', a.items ? 'P12 one control per job' : 'P12 one control per job (rows not marked data-item yet)', `"${label}" ${n} times${a.items ? '' : `, to be marked by ${owner}`}`, where);
  }
  // P5: one main button in the page body or the dialog.
  if (kind !== 'email' && (a.primary || []).length > 1) rule('todo', 'P5 one main button', `${a.primary.length} filled buttons, to be brought to 1 by ${owner}`, `${where} (${a.primary.slice(0, 4).join(' | ')})`);
  const who = pageKind(url, kind, flowId);
  // P7: the consent screen, and Other actions.
  if (who === 'signer' && kind !== 'email' && /consent/i.test(where) && !m.in_dialog && m.words_before_tick != null) {
    if (m.words_before_tick > CONSENT_WORDS) rule('todo', 'P7 consent screen', `${m.words_before_tick} words before the tick, at most ${CONSENT_WORDS} (simplify-signing)`, where);
    if (/phone|inventory|f-signer/.test(where) && m.screenfuls > 1.05) rule('todo', 'P7 consent screen', `${m.screenfuls} phone screenfuls, at most 1 (simplify-signing)`, where);
  }
  if (who === 'signer' && m.in_dialog && /other actions/i.test(where)) {
    const n = (m.controls || []).filter((c) => !/: (close|cancel|back)$/i.test(c)).length;
    if (n > MORE_CAP.other_actions) rule('todo', 'P7 Other actions', `${n} entries, at most ${MORE_CAP.other_actions} (simplify-signing)`, where);
  }
  // 2.7: the landing page.
  if (url === '/' && m.words > LANDING_WORDS) rule('todo', '2.7 landing page', `${m.words} words, at most ${LANDING_WORDS} (simplify-public)`, where);
  // 2.2: cards open in one Settings section with zero setup.
  if (ZERO_SETUP && /^\/app\/settings/.test(url) && a.cards > SETTINGS_CAP.cards) rule('broken', '2.2 Settings cards', `${a.cards} cards in one section, at most ${SETTINGS_CAP.cards} with zero setup`, where);
  // P6 and P13: words.
  checkWords(m._text || '', who, where);
}

function checkWords(text, who, where) {
  if (who === 'sender') return;
  const explains = who === 'trust' || /public \/(help|pricing)|\/help\b/.test(where);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  let long = 0;
  for (const s of sentences) {
    const n = s.split(/\s+/).length;
    for (const re of CLAIMS) {
      const hit = s.match(re);
      if (!hit || NOT_HELD.test(s) || HELD.some((h) => s.includes(h))) continue;
      if (aboutUs(s, hit[0]) || (n <= 4 && !explains)) rule('broken', 'P13 honest words', `"${hit[0]}" in "${s.slice(0, 140)}"`, where);
    }
    if (who === 'trust') continue;
    const tech = s.match(TECHNICAL);
    if (tech) rule('broken', `P6 technical name on a ${who} page`, `"${tech[0]}" in "${s.slice(0, 140)}"`, where);
    const avoid = s.match(AVOID);
    if (avoid) rule(who === 'signer' ? 'todo' : 'warning', `P6 sender word on a ${who} page`, `"${avoid[0].toLowerCase()}" in "${s.replace(/env_[\w-]+/g, 'env_...').replace(/\d+/g, '#').slice(0, 140)}"`, where);
    if (who === 'signer' && n > SENTENCE_MAX) long += 1;
  }
  if (long) rule('todo', 'P6 short sentences on signer screens', `sentences of more than ${SENTENCE_MAX} words (simplify-signing)`, `${where} (${long})`);
}

// ---------------------------------------------------------------------------------------------------------------
// A flow: counts actions, screens, choices and time, and takes the screenshots.

class Flow {
  constructor(id, title, page, { touch = false, device = 'desktop' } = {}) {
    Object.assign(this, { id, title, page, touch, device });
    this.dir = path.join(OUT, id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.n = 0;
    this.actions = { clicks: 0, taps: 0, fields_typed: 0, characters_typed: 0, key_presses: 0, files_picked: 0 };
    this.klm = 0;
    this.waitMs = 0;
    this.log = [];
    this.screens = [];
    this.states = [];
    this.notes = [];
    this.t0 = Date.now();
  }
  get total() {
    const a = this.actions;
    return a.clicks + a.taps + a.fields_typed + a.key_presses + a.files_picked * 2;
  }
  async settle() {
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    // Text that says it is loading has to go first.
    await this.page.waitForFunction(() => !/^(Loading|Opening your document|Starting a new)/i.test(document.querySelector('main, .sn, .ed, body')?.innerText?.trim() || ''), null, { timeout: 15000 }).catch(() => {});
    await sleep(350);
  }
  async shoot(label, isScreen) {
    this.n += 1;
    const base = `${String(this.n).padStart(2, '0')}-${slug(label)}`;
    const m = await this.page.evaluate(measureInPage);
    const url = this.page.url().replace(BASE, '') || '/';
    checkScreen(m, { url, kind: isScreen && this.isMail ? 'email' : 'page', flowId: this.id, isScreen, where: `${this.id} ${String(this.n).padStart(2, '0')} ${label}` });
    delete m._once;
    delete m._text;
    const file = path.join(this.dir, `${base}.png`);
    await this.page.screenshot({ path: file });
    let full = null;
    if (!m.in_dialog && m.screenfuls > 1.3) {
      full = path.join(this.dir, `${base}-full.png`);
      await this.page.screenshot({ path: full, fullPage: true });
    }
    const entry = { n: this.n, label, kind: isScreen ? (m.in_dialog ? 'dialog' : this.isMail ? 'email' : 'page') : 'state', url: this.page.url().replace(BASE, ''), at_ms: Date.now() - this.t0, screenshot: path.relative(OUT, file), ...(full ? { screenshot_full: path.relative(OUT, full) } : {}), ...m };
    (isScreen ? this.screens : this.states).push(entry);
    this.tEnd = Date.now();
    this.log.push({ step: this.n, [isScreen ? 'screen' : 'state']: label, heading: m.heading, choices: m.choices, words: m.words });
    return entry;
  }
  // A new page, dialog or email the person passes through.
  async screen(label, { mail = false } = {}) {
    this.isMail = mail;
    await this.settle();
    return this.shoot(label, true);
  }
  // The same page, changed in place.
  async state(label) {
    await this.settle();
    return this.shoot(label, false);
  }
  async timed(what, fn) {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      const ms = Date.now() - t;
      this.waitMs += ms;
      this.tEnd = Date.now();
      this.log.push({ action: what, ms });
    }
  }
  // A click on a desktop, a tap on a phone. `then` waits for whatever the press leads to.
  async press(loc, what, then) {
    await loc.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new Error(`Could not find ${what}`); });
    if (this.touch) this.actions.taps++;
    else this.actions.clicks++;
    this.klm += 2.65;
    await this.timed(`${this.touch ? 'tap' : 'click'}: ${what}`, async () => {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      if (this.touch) await loc.tap();
      else await loc.click();
      if (then) await then();
    });
  }
  // Pressing at a point (placing a field on a page).
  async pressAt(x, y, what, then) {
    if (this.touch) this.actions.taps++;
    else this.actions.clicks++;
    this.klm += 2.65;
    await this.timed(`${this.touch ? 'tap' : 'click'}: ${what}`, async () => {
      if (this.touch) await this.page.touchscreen.tap(x, y);
      else await this.page.mouse.click(x, y);
      if (then) await then();
    });
  }
  // Counts as a press without doing one, for a link followed with goto (email links open in a new tab).
  async follow(href, what, then) {
    if (this.touch) this.actions.taps++;
    else this.actions.clicks++;
    this.klm += 2.65;
    await this.timed(`${this.touch ? 'tap' : 'click'}: ${what}`, async () => {
      await this.page.goto(href);
      if (then) await then();
    });
  }
  async type(loc, text, what) {
    await loc.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new Error(`Could not find the field ${what}`); });
    this.actions.fields_typed++;
    this.actions.characters_typed += text.length;
    this.klm += 1.35 + 1.1 + 0.2 + 0.28 * text.length;
    await this.timed(`type: ${what} (${text.length} characters)`, async () => {
      if (this.touch) await loc.tap().catch(() => {});
      await loc.fill(text);
    });
  }
  async key(key, what, then) {
    this.actions.key_presses++;
    this.klm += 1.35 + 0.28;
    await this.timed(`key ${key}: ${what}`, async () => {
      await this.page.keyboard.press(key);
      if (then) await then();
    });
  }
  async file(loc, file, what, then) {
    this.actions.files_picked++;
    this.klm += 2 * 2.65 + 4;
    await this.timed(`pick file: ${what}`, async () => {
      await loc.setInputFiles(file);
      if (then) await then();
    });
  }
  note(text) {
    this.notes.push(text);
  }
  summary() {
    const s = this.screens;
    const all = [...this.screens, ...this.states];
    // Up to the last thing the person did or saw: checks the script makes afterwards are not counted.
    const wall = (this.tEnd || Date.now()) - this.t0;
    const words = s.reduce((n, x) => n + x.words, 0);
    return {
      title: this.title,
      device: this.device,
      ok: !this.error,
      ...(this.error ? { error: this.error } : {}),
      actions_total: this.total,
      actions: this.actions,
      screens_total: s.length,
      screens_by_kind: { pages: s.filter((x) => x.kind === 'page').length, dialogs: s.filter((x) => x.kind === 'dialog').length, emails: s.filter((x) => x.kind === 'email').length },
      choices_seen_total: s.reduce((n, x) => n + x.choices, 0),
      choices_max_one_screen: Math.max(0, ...all.map((x) => x.choices)),
      choices_first_screen_avg: s.length ? Math.round(s.reduce((n, x) => n + x.choices_first_screen, 0) / s.length) : 0,
      notices_seen_total: s.reduce((n, x) => n + x.notices, 0),
      words_seen_total: words,
      read_all_s: Math.round((words / 240) * 60),
      wall_ms: wall,
      app_wait_ms: this.waitMs,
      klm_estimate_s: Math.round(this.klm + this.waitMs / 1000),
      notes: this.notes,
      path: s.map((x) => `${x.kind}: ${x.label}`),
      screens: s,
      states: this.states,
      log: this.log,
    };
  }
}

async function runFlow(flow, fn) {
  console.log(`\n== ${flow.id}: ${flow.title}`);
  try {
    await fn(flow);
    console.log(`ok    ${flow.id}: ${flow.total} actions, ${flow.screens.length} screens`);
  } catch (e) {
    flow.error = String(e?.message || e).split('\n').slice(0, 4).join(' ');
    report.failures.push(`${flow.id}: ${flow.error}`);
    console.log(`FAIL  ${flow.id}: ${flow.error}`);
    try {
      await flow.page.screenshot({ path: path.join(flow.dir, `FAIL-${String(flow.n + 1).padStart(2, '0')}.png`), fullPage: true });
    } catch {}
  }
  report.flows[flow.id] = flow.summary();
  writeReport();
  return !flow.error;
}

function writeReport() {
  report.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'ux-flows.json'), JSON.stringify(report, null, 2));
}

// A browser context with the Next.js dev tools badge hidden, so it is neither in the pictures nor counted.
async function newContext(browser, opts) {
  const ctx = await browser.newContext({ ...opts, acceptDownloads: true });
  await ctx.addInitScript(() => {
    const css = 'nextjs-portal, [data-nextjs-toast], #__next-build-watcher { display: none !important; }';
    const add = () => { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
    if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
  });
  return ctx;
}
function watchErrors(page, who) {
  page.on('pageerror', (e) => report.console_errors.push(`${who}: ${String(e).slice(0, 300)}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|favicon|\[HMR\]|webpack-hmr|Download the React DevTools/i.test(m.text()) && report.console_errors.push(`${who}: ${m.text().slice(0, 300)}`));
}

// ---------------------------------------------------------------------------------------------------------------
// Warm-up: opens every page once on its own account, so the dev server has compiled them before anything is timed.

async function warmUp(browser, pdf) {
  const t = Date.now();
  const ctx = await newContext(browser, DESKTOP);
  const p = await ctx.newPage();
  p.setDefaultTimeout(60000);
  const who = { name: 'Warm Up', email: `warm-${STAMP}@example.org` };
  await p.goto(BASE);
  await p.goto(`${BASE}/signup`);
  await apiIn(p, '/auth/signup', { body: { ...who, password: PASSWORD } });
  const m = await waitMail(who.email, (x) => x.link?.includes('verify-email'), 'confirmation');
  await p.goto(m.link);
  await p.getByText(/confirmed/i).first().waitFor().catch(() => {});
  const id = await sendByApi(p, pdf, 'Warm-up agreement', { name: 'Wanda Warm', email: `wanda-${STAMP}@example.org` });
  const tpl = await sendByApi(p, pdf, 'Warm-up template', null, 'template');
  for (const u of ['/app', '/app/envelopes', '/app/templates', '/app/settings', `/app/envelopes/${id}`, `/app/templates/${tpl}/edit`, '/help']) {
    await p.goto(BASE + u);
    await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  }
  // The editor, with a draft that is thrown away afterwards.
  const { envelope } = await apiIn(p, '/envelopes', { body: { kind: 'envelope' } });
  await p.goto(`${BASE}/app/envelopes/${envelope.id}/edit`);
  await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await apiIn(p, `/envelopes/${envelope.id}`, { method: 'DELETE' }).catch(() => {});
  const link = (await waitMail(`wanda-${STAMP}@example.org`, (x) => x.link?.includes('/sign/'), 'invitation')).link;
  const s = await ctx.newPage();
  await s.goto(`${BASE}/api/dev/outbox`);
  await s.goto(link);
  await s.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await s.goto(`${BASE}/verify-email?token=nothing`).catch(() => {});
  await ctx.close();
  return Date.now() - t;
}

// ---------------------------------------------------------------------------------------------------------------
// The flows

// (a) Sign up, confirm the address, send a first document to one person with one signature field.
async function flowA(f, pdf) {
  const p = f.page;
  await p.goto(BASE);
  await f.screen('Landing page');
  const cta = byRole(p, 'link', /start free|sign up|create (an |your )?account|get started|try (it )?free/i);
  await f.press(cta, 'the sign-up button on the landing page', () => p.waitForURL(/\/signup/));
  await f.screen('Sign up form');
  await f.type(p.getByLabel(/your name|full name|^name/i).first(), SENDER.name, 'name');
  await f.type(p.getByLabel(/^email/i).first(), SENDER.email, 'email');
  await f.type(p.getByLabel(/password/i).first(), PASSWORD, 'password');
  await f.press(byRole(p, 'button', /create (an |my |your )?account|sign up|start/i), 'Create account', () => p.waitForURL(/\/app(\/|$|\?)/));
  await f.screen('App home before the address is confirmed');

  // The confirmation email, read from the dev outbox as the mailbox.
  const mail = await waitMail(SENDER.email, (x) => x.link?.includes('verify-email'), 'confirmation');
  const app = p;
  let box = await p.context().newPage();
  f.page = box;
  await f.follow(`${BASE}/api/dev/outbox?id=${mail.id}`, 'open the confirmation email in the mailbox');
  await f.screen(`Email: ${mail.subject}`, { mail: true });
  const code = ((await box.innerText('body').catch(() => '')).match(/Your code is (\d{3}) ?(\d{3})/) || []).slice(1).join('');
  const codeBox = app.getByLabel(/code from the email/i).first();
  if (code && (await codeBox.count())) {
    // Back to the tab the person signed up in (one click on that tab), where the banner asks for the 6-digit code.
    // Six digits confirm by themselves, and the banner goes in place.
    f.actions.clicks++;
    f.klm += 2.65;
    await box.close();
    box = app;
    f.page = app;
    await app.bringToFront();
    await f.type(codeBox, code, 'the 6-digit code from the email');
    await f.timed('the code confirms by itself', () => app.waitForFunction(() => !document.querySelector('.cc-banner'), null, { timeout: 15000 }));
    await f.state('App home, address confirmed');
    f.note('The address was confirmed with the 6-digit code, typed in the tab the person signed up in.');
  } else {
    const href = await box.locator('a[href*="verify-email"]').first().getAttribute('href');
    await f.follow(href, 'the confirm link in the email', () => box.getByText(/confirmed|did not work|one more step/i).first().waitFor());
    await f.screen('Email confirmed');
    await f.press(byRole(box, 'link', /go to|continue|open|start/i), 'the link back into the app', () => box.waitForURL(/\/app(\/|$|\?)/));
    await f.screen('App home');
    f.note('The confirmation link opens in a new tab. The tab the person signed up in still shows the "confirm your email" banner until it is reloaded.');
    await app.close();
  }

  await f.press(byRole(box, 'link', /send (for signature|a document)|new envelope|send your first/i), 'Send for signature', () => box.waitForURL(/\/edit/));
  await f.screen('Editor, step 1 (Add)');
  await f.file(box.locator('input[type=file]').first(), pdf, 'the PDF, from the drop zone', () => box.getByLabel(/^(document|file) name$/i).first().waitFor());
  await f.state('Editor, step 1, after the upload');
  if (!(await visible(box.getByLabel(/^(recipient )?name$/i)).count())) await f.press(byRole(box, 'button', /add (a )?recipient|add (a )?person|add signer/i), 'Add recipient');
  await f.type(visible(box.getByLabel(/^(recipient )?name$/i)).first(), SIGNER_PHONE.name, 'recipient name');
  await f.type(visible(box.getByLabel(/^(recipient )?email$/i)).first(), SIGNER_PHONE.email, 'recipient email');
  // The subject is on step 1 in the baseline, and on step 3 since simplify-editor moved it there.
  const subject = visible(box.getByLabel(/subject/i)).first();
  if (await subject.count()) {
    if (!(await subject.inputValue().catch(() => ''))) await f.type(subject, `Please sign: ${DOC_NAME}`, 'email subject');
    else f.note(`The email subject was filled in from the file name: "${await subject.inputValue()}".`);
    report.first_subject = await subject.inputValue();
  }
  await f.state('Editor, step 1, filled in');

  await f.press(byRole(box, 'button', /^(next|continue)$/i), 'Next', () => box.locator('.pdfpage canvas, canvas').first().waitFor());
  await f.screen('Editor, step 2 (Place fields)');
  const palette = box.getByRole('group', { name: /add a field|field types|add fields?/i }).first();
  await f.press(byRole((await palette.count()) ? palette : box, 'button', /^signature$/i), 'the Signature field type');
  const pg = box.locator('.pdfpage').nth(1);
  await pg.scrollIntoViewIfNeeded();
  const b = await pg.boundingBox();
  await f.pressAt(b.x + b.width * 0.3, b.y + b.height * 0.22, 'the place on page 2 for the signature', () => box.locator('.field').first().waitFor());
  await f.state('Editor, step 2, signature placed');
  await f.press(byRole(box, 'button', /^(next|continue)$/i), 'Next', () => box.getByRole('button', { name: /^send( now)?$/i }).first().waitFor());
  await f.screen('Editor, step 3 (Review and send)');
  if (!report.first_subject) {
    const s3 = visible(box.getByLabel(/subject/i)).first();
    if (!(await s3.inputValue().catch(() => ''))) await f.type(s3, `Please sign: ${DOC_NAME}`, 'email subject');
    else f.note(`The email subject was filled in from the file name: "${await s3.inputValue()}".`);
    report.first_subject = await s3.inputValue();
  }
  await f.press(visible(box.getByRole('button', { name: /^send( now)?$/i })).last(), 'Send', async () => {
    // A question before sending (an address that bounced before) is answered and counted.
    const r = await Promise.race([box.waitForURL(/\/app\/envelopes\/env_[^/]+(\?|$)/).then(() => 'sent'), box.getByRole('dialog').first().waitFor().then(() => 'asked')]);
    if (r === 'asked') f.note('A dialog came up after Send.');
  });
  if (!/\/app\/envelopes\/env_[^/]+(\?|$)/.test(box.url())) {
    await f.screen('Question after Send');
    await f.press(byRole(box.getByRole('dialog').first(), 'button', /send/i), 'Send in the dialog', () => box.waitForURL(/\/app\/envelopes\/env_[^/]+(\?|$)/));
  }
  await f.screen('Envelope page, just sent');
  return box;
}

// (b) The person opens the email, agrees, signs and finishes.
async function flowB(f, signer) {
  const p = f.page;
  const mail = await waitMail(signer.email, (x) => x.link?.includes('/sign/'), 'signing invitation');
  await f.follow(`${BASE}/api/dev/outbox?id=${mail.id}`, 'open the invitation in the mailbox');
  await f.screen(`Email: ${mail.subject}`, { mail: true });
  const cta = visible(p.locator('a[href*="/sign/"]')).first();
  const ctaText = (await cta.innerText().catch(() => '')).trim();
  f.note(`The button in the email says "${ctaText}".`);
  await f.follow(await cta.getAttribute('href'), `"${ctaText}" in the email`, () => p.getByRole('checkbox').first().waitFor());
  await signOnPage(f, p);
}

// From the consent screen to Done, on the page that shows it (flows b and h).
async function signOnPage(f, p) {
  await f.screen('Signing: who sent it, and the consent');
  await f.press(byRole(p, 'checkbox', /agree|electronic/i), 'the box to agree to electronic records');
  await f.press(byRole(p, 'button', /^(continue|start|agree and continue|next)$/i), 'Continue', () => p.locator('.pdfpage canvas').first().waitFor());
  await f.screen('Signing: the document');
  const sigField = byRole(p, 'button', /sign here|signature.*(required|sign)/i);
  const next = byRole(p, 'button', /^(next|start)$/i);
  if (await next.count()) {
    await f.press(next, 'Next (takes them to the signature)');
    await f.state('Signing: at the signature field');
  } else f.note('There was no Next button; the person has to find the field themselves.');
  if (!(await p.getByRole('dialog').count())) await f.press(sigField, 'the signature field', () => p.getByRole('dialog').first().waitFor());
  else f.note('Next opened the signature dialog by itself.');
  await f.screen('Adopt your signature');
  await f.press(byRole(p.getByRole('dialog').first(), 'button', /adopt|^sign$|use this/i), 'Adopt and sign', () => p.locator('.field img, .field.fill').first().waitFor());
  // The check before finishing: it may open by itself, open on Finish, or (the charter, 2.6) not come at all when
  // nothing needs attention, and Finish goes straight to Done.
  const review = p.getByRole('dialog').filter({ hasText: /signing as|before you finish/i });
  const done = p.getByRole('heading', { name: /done|thank|finished/i }).first();
  let opened = await review.first().waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  if (opened) f.note('The check before finishing opened by itself once the signature was on.');
  else {
    await f.press(byRole(p, 'button', /^finish/i), 'Finish', () => Promise.race([review.first().waitFor(), done.waitFor()]));
    opened = (await review.count()) > 0 && await review.first().isVisible().catch(() => false);
    f.note(opened ? 'The check before finishing did not open by itself; it came after Finish.' : 'Finish went straight to Done: nothing needed attention.');
  }
  if (opened) {
    await f.screen('Check before you finish');
    await f.press(byRole(review.first(), 'button', /^(finish|approve|sign)( and send| now)?$|^send$/i), 'Finish and send', () => done.waitFor());
  }
  await f.screen('Done');
  const sideways = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (sideways) f.note('The done page scrolls sideways.');
}

// (c) Send from a template.
async function flowC(f, templateName) {
  const p = f.page;
  await p.goto(`${BASE}/app`);
  await f.screen('App home');
  await f.press(byRole(p, 'link', /^templates$/i), 'Templates in the menu', () => p.waitForURL(/\/app\/templates/));
  await f.screen('Templates');
  await f.press(byRole(p, 'button', new RegExp(`^use\\b.*${templateName.split(' ')[0]}`, 'i')), `Use on "${templateName}"`, () => p.getByRole('dialog').first().waitFor());
  await f.screen('Use the template');
  const d = p.getByRole('dialog').first();
  await f.type(d.getByLabel(/full name|^name/i).first(), SIGNER_TPL.name, 'name of the person signing');
  await f.type(d.getByLabel(/email/i).first(), SIGNER_TPL.email, 'their email');
  await f.press(byRole(d, 'button', /^send( now)?$/i), 'Send now', () => p.waitForURL(/\/app\/envelopes\/env_[^/]+(\?|$)/));
  await f.screen('Envelope page, just sent');
}

// (d) Find the completed document and download it.
async function flowD(f, subject) {
  const p = f.page;
  await p.goto(`${BASE}/app`);
  // Home lists what was completed lately, each with a Download that names it: the shortest way, when it is there.
  await p.getByRole('heading', { name: /recently completed/i }).first().waitFor({ timeout: 5000 }).catch(() => {});
  await f.screen('App home');
  const onHome = byRole(p, 'link', new RegExp(`^download ${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
  if (await onHome.count()) {
    let got;
    const arriving = p.waitForEvent('download', { timeout: 30000 });
    await f.press(onHome, `"Download" on its row in Recently completed`, async () => {
      got = await arriving;
    });
    const dest = path.join(f.dir, got.suggestedFilename());
    await got.saveAs(dest);
    f.note(`Downloaded ${got.suggestedFilename()}, ${fs.statSync(dest).size} bytes, from Home. A document that is not among the five completed last is found under Documents, as before.`);
    return;
  }
  await f.press(byRole(p, 'link', /^envelopes$|^documents$/i), 'Envelopes in the menu', () => p.waitForURL(/\/app\/envelopes(\?|$)/));
  await f.screen('Envelopes');
  await f.type(p.getByRole('searchbox').first(), DOC_NAME, 'the search box');
  await p.getByText(subject).first().waitFor();
  await f.state('Envelopes, search typed');
  await f.press(byRole(p, 'link', new RegExp(`^${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')), 'the document in the list', () => p.waitForURL(/\/app\/envelopes\/env_[^/]+(\?|$)/));
  await f.screen('Envelope page, completed');
  const dl = byRole(p, 'link', /download.*(certificate|signed)|download pdf|^download$/i);
  const name = (await dl.innerText().catch(() => '')).trim();
  let file;
  await dl.waitFor();
  const coming = p.waitForEvent('download', { timeout: 30000 });
  await f.press(dl, `"${name}"`, async () => {
    file = await coming;
  });
  const to = path.join(f.dir, file.suggestedFilename());
  await file.saveAs(to);
  f.note(`Downloaded ${file.suggestedFilename()}, ${fs.statSync(to).size} bytes, with "${name}".`);
  const rowDl = await p.goto(`${BASE}/app/envelopes?box=completed`).then(() => visible(p.getByRole('link', { name: /download/i })).count());
  if (rowDl) f.note('A shorter way exists: the list itself has a Download button on each completed row (Envelopes, Completed, Download).');
}

// (e) Settings: change their name.
async function flowE(f) {
  const p = f.page;
  await p.goto(`${BASE}/app`);
  await f.screen('App home');
  await f.press(byRole(p, 'link', /^settings$/i), 'Settings in the menu', () => p.waitForURL(/\/app\/settings/));
  await f.screen('Settings, first tab');
  let nameBox = visible(p.getByLabel(/^(your )?(full )?name$/i)).first();
  if (!(await nameBox.count())) {
    await f.press(byRole(p, 'tab', /profile|you|account/i), 'the Profile tab');
    await f.state('Settings, Profile');
    nameBox = visible(p.getByLabel(/^(your )?(full )?name$/i)).first();
  }
  await f.type(nameBox, 'Rosa M. Gardener', 'their name');
  await f.press(byRole(p, 'button', /save( profile| name| changes)?$/i), 'Save', () => p.getByText(/saved/i).first().waitFor());
  await f.state('Settings, saved');
  const me = await apiIn(p, '/me');
  if (me.user?.name !== 'Rosa M. Gardener') throw new Error(`The name was not saved: it is "${me.user?.name}"`);
}

// (f) A signer who cannot sign right now looks for help, on a phone.
async function flowF(f, signer) {
  const p = f.page;
  const mail = await waitMail(signer.email, (x) => x.link?.includes('/sign/'), 'signing invitation');
  await f.follow(`${BASE}/api/dev/outbox?id=${mail.id}`, 'open the invitation in the mailbox');
  await f.screen(`Email: ${mail.subject}`, { mail: true });
  const helpInMail = await visible(p.getByRole('link', { name: /help|cannot|can't|questions/i })).allInnerTexts().catch(() => []);
  f.note(helpInMail.length ? `The email has help links: ${helpInMail.map((t) => `"${t.trim()}"`).join(', ')}.` : 'The email has no help link.');
  await f.follow(await visible(p.locator('a[href*="/sign/"]')).first().getAttribute('href'), 'the signing button in the email', () => p.getByRole('checkbox').first().waitFor());
  await f.screen('Signing: who sent it, and the consent');
  const footHelp = await visible(p.locator('footer').getByRole('link', { name: /help/i })).count();
  f.note(footHelp ? 'There is also a Help link in the footer, below the consent text.' : 'No Help link in the footer.');
  await f.press(byRole(p, 'button', /other actions|more|menu|help/i), 'Other actions', () => p.getByRole('dialog').first().waitFor());
  await f.screen('Other actions');
  await f.press(byRole(p.getByRole('dialog').first(), 'button', /^help/i), 'Help in Other actions', () => p.getByRole('dialog').filter({ hasText: /question|helper|person/i }).first().waitFor());
  await f.screen('Help');
  const box = visible(p.getByRole('dialog').first().getByRole('textbox')).first();
  await f.type(box, 'I cannot sign this today. What can I do?', 'the question');
  const before = await p.getByRole('dialog').first().innerText();
  await f.key('Enter', 'send the question', () => p.waitForFunction((b) => {
    const d = document.querySelector('[role=dialog]');
    return d && d.innerText !== b && !/thinking|…$/i.test(d.innerText.trim().slice(-20));
  }, before, { timeout: 20000 }));
  await sleep(1500);
  await f.state('Help, answered');
  const answer = await p.locator('[role=log]').first().innerText().catch(() => '');
  f.note(`The helper answered: "${answer.replace(/\s+/g, ' ').trim().slice(0, 500)}"`);
  await f.press(byRole(p.getByRole('dialog').first(), 'button', /talk to a person|write to a person|contact/i), 'Talk to a person', () => p.getByRole('dialog').filter({ hasText: /write to a person|message/i }).first().waitFor());
  await f.screen('Write to a person');
}

// (g) The sender signs in again, from the landing page to Home. Email and password on one screen today; when the
// password box only comes after a Continue, that screen is counted too.
async function flowG(f) {
  const p = f.page;
  await p.goto(BASE);
  await f.screen('Landing page');
  await f.press(byRole(p, 'link', /^(sign in|log in)$/i), 'Sign in on the landing page', () => p.waitForURL(/\/(login|signin)/));
  await f.screen('Sign in');
  await f.type(p.getByLabel(/^email/i).first(), SENDER.email, 'email');
  let pwd = visible(p.getByLabel(/^password/i)).first();
  if (!(await pwd.count())) {
    f.note('The password box only came after Continue.');
    await f.press(byRole(p, 'button', /^(continue|next)$/i), 'Continue', () => visible(p.getByLabel(/^password/i)).first().waitFor());
    await f.screen('Sign in, password');
    pwd = visible(p.getByLabel(/^password/i)).first();
  }
  await f.type(pwd, PASSWORD, 'password');
  await f.press(byRole(p, 'button', /^(sign in|log in|continue)$/i), 'Sign in', () => p.waitForURL(/\/app(\/|$|\?)/));
  await f.screen('App home');
}

// (h) The sender signs a document themselves, from Home to Done.
async function flowH(f, pdf) {
  const p = f.page;
  const sent = /\/app\/envelopes\/env_[^/]+(\?|$)/;
  await p.goto(`${BASE}/app`);
  await f.screen('App home');
  const self = byRole(p, 'link', /sign (a document )?(yourself|myself)/i);
  if (await self.count()) {
    f.note('Started from "Sign a document yourself" on Home (/app/envelopes/new?self=1).');
    await f.press(self, 'Sign a document yourself', () => p.waitForURL(/\/edit/));
  } else {
    f.note('Home has no "Sign a document yourself": started from the start button, then "Add me".');
    await f.press(byRole(p, 'link', /send (for signature|a document)|new envelope|send your first/i), 'Send a document', () => p.waitForURL(/\/edit/));
  }
  await f.screen('Editor, step 1 (Add)');
  await f.file(p.locator('input[type=file]').first(), pdf, 'the PDF, from the drop zone', () => p.getByLabel(/document name|file name/i).first().waitFor());
  await f.state('Editor, step 1, after the upload');
  const me = SENDER.email.toLowerCase();
  if (!(await p.locator('input').evaluateAll((els, e) => els.some((x) => (x.value || '').toLowerCase() === e), me))) await f.press(byRole(p, 'button', /^add me$/i), 'Add me');
  const subject = visible(p.getByLabel(/subject/i)).first();
  if ((await subject.count()) && !(await subject.inputValue().catch(() => ''))) await f.type(subject, `Please sign: ${DOC_NAME} (myself)`, 'email subject');
  await f.press(byRole(p, 'button', /^(next|continue)$/i), 'Next', () => p.locator('.pdfpage canvas, canvas').first().waitFor());
  await f.screen('Editor, step 2 (Place fields)');
  const palette = p.getByRole('group', { name: /add a field|field types|add fields?/i }).first();
  await f.press(byRole((await palette.count()) ? palette : p, 'button', /^signature$/i), 'the Signature field type');
  const pg = p.locator('.pdfpage').nth(1);
  await pg.scrollIntoViewIfNeeded();
  const b = await pg.boundingBox();
  await f.pressAt(b.x + b.width * 0.3, b.y + b.height * 0.22, 'the place on page 2 for the signature', () => p.locator('.field').first().waitFor());
  await f.state('Editor, step 2, signature placed');
  await f.press(byRole(p, 'button', /^(next|continue)$/i), 'Next', () => p.getByRole('button', { name: /^(send( now)?|sign now)$/i }).first().waitFor());
  await f.screen('Editor, step 3 (Review and send)');
  const title = (await visible(p.getByLabel(/subject/i)).first().inputValue().catch(() => '')) || DOC_NAME;
  const signNow = visible(p.getByRole('button', { name: /^sign now$/i }));
  if (await signNow.count()) {
    await f.press(signNow.last(), 'Sign now', () => p.waitForURL(/\/sign\//).then(() => p.getByRole('checkbox').first().waitFor()));
  } else {
    await f.press(visible(p.getByRole('button', { name: /^send( now)?$/i })).last(), 'Send', async () => {
      const r = await Promise.race([p.waitForURL(sent).then(() => 'sent'), p.getByRole('dialog').first().waitFor().then(() => 'asked')]);
      if (r === 'asked') f.note('A dialog came up after Send.');
    });
    if (!sent.test(p.url())) {
      await f.screen('Question after Send');
      await f.press(byRole(p.getByRole('dialog').first(), 'button', /send/i), 'Send in the dialog', () => p.waitForURL(sent));
    }
    await f.screen('Envelope page, just sent');
    let here = byRole(p.locator('main'), 'button', /^(sign|review) now$/i);
    if (!(await here.count())) here = visible(p.locator('main a[href*="/sign/"]')).first();
    if (await here.count()) await f.press(here, 'Sign now, on the envelope page', () => p.waitForURL(/\/sign\//).then(() => p.getByRole('checkbox').first().waitFor()));
    else {
      f.note('The envelope page has no way to sign it: the sender goes Home and signs from "Waiting for you".');
      await f.press(byRole(p, 'link', /^home$/i), 'Home in the menu', () => p.waitForURL(/\/app(\?|$)/));
      await f.screen('App home, after sending');
      const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let row = byRole(p, 'link', new RegExp(`^(sign|review)\\b.*${esc}`, 'i'));
      if (!(await row.count())) row = visible(p.locator('a[href*="/sign/"]')).first();
      await f.press(row, 'Sign, on the row in Waiting for you', () => p.getByRole('checkbox').first().waitFor());
    }
  }
  await signOnPage(f, p);
}

// ---------------------------------------------------------------------------------------------------------------
// The everything profile: fake services while the script runs, and the account set up after sign-up.

async function startFakes() {
  if (PROFILE !== 'everything') return null;
  const http = require('node:http');
  let pdf = null;
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req); // read the body
    const u = req.url || '';
    if (u.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'You can choose Finish later and come back to it, or ask for more time. (A test answer from the UX fake model.)' } }] }));
    }
    if (u.startsWith('/forms/libreoffice/convert')) {
      if (!pdf) {
        const d = await PDFDocument.create();
        d.addPage([612, 792]).drawText('Converted by the UX fake converter', { x: 72, y: 700, size: 14, font: await d.embedFont(StandardFonts.Helvetica) });
        pdf = Buffer.from(await d.save());
      }
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(pdf);
    }
    if (u === '/version') return res.writeHead(200).end('8.0.0-ux-fake');
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    srv.once('error', (e) => (console.log(`fake services: port ${FAKE_PORT} is taken (${e.code}); whatever answers there is used`), resolve(null)));
    srv.listen(FAKE_PORT, '127.0.0.1', () => resolve(srv));
  });
}

// Never counted. Says what it could switch on and what is not possible yet, in report.profile_setup.
async function setUp(browser, sender) {
  const done = [];
  const missing = [];
  if (PROFILE === 'government') {
    missing.push('Nothing on the server says its deployment profile yet: start it with DEPLOYMENT_PROFILE=government (node tests/ux/flows.cjs --env government).');
    rule('warning', 'P8 government profile', 'nothing in the app reads DEPLOYMENT_PROFILE yet (gov-G01, gov-G02 are not built), so this run can only differ from the default profile once they are');
    report.profile_setup = { done, missing };
    return;
  }
  const me = await apiIn(sender, '/me');
  const chat = await apiIn(sender, '/public/chat').catch(() => ({}));
  for (const [on, what] of [[me.text_messages, 'text messages'], [me.converts, 'office files to PDF'], [chat.ai, 'a model for the help chat'], [me.billing?.enabled, 'payments']])
    (on ? done : missing).push(on ? what : `${what}: not on this server${what === 'payments' ? ' (no fake for the payment provider yet)' : ' (start it with the everything settings)'}`);
  const step = async (what, fn) => {
    try {
      await fn();
      done.push(what);
    } catch (e) {
      missing.push(`${what}: ${e.message}`);
    }
  };
  await step('details: Case number', () => apiIn(sender, '/custom-fields', { body: { name: 'Case number', kind: 'text' } }));
  await step('deletion schedule: 365 days', () => apiIn(sender, '/account/retention', { method: 'PUT', body: { days: 365, level: 'documents' } }));
  await step(`a second member (${MEMBER.email})`, async () => {
    await apiIn(sender, '/account/invites', { body: { email: MEMBER.email, role: 'member' } });
    const m = await waitMail(MEMBER.email, (x) => /invite=/.test(x.link || ''), 'team invitation');
    const ctx = await newContext(browser, DESKTOP);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/signup`);
    await apiIn(p, '/auth/signup', { body: { ...MEMBER, password: PASSWORD, invite: new URL(m.link).searchParams.get('invite') } });
    // 2.2: what a member sees in Settings.
    await p.goto(`${BASE}/app/settings`);
    const tabs = await p.getByRole('tab').first().waitFor({ timeout: 15000 }).then(() => visible(p.getByRole('tab')).allInnerTexts()).catch(() => []);
    report.member_settings_tabs = tabs;
    if (tabs.length > SETTINGS_CAP.member) rule('todo', '2.2 Settings sections', `a member sees ${tabs.length} sections, at most ${SETTINGS_CAP.member} (simplify-public): ${tabs.join(', ')}`, 'profile setup');
    await ctx.close();
  });
  missing.push('2 languages: only English ships (SUPPORTED_LOCALES in src/lib/i18n.ts). Switch the second one on here once a setting can.');
  missing.push('the account AI switch: not built yet (gov-G01, ds-ai-assist). Switch it on here once it exists.');
  report.profile_setup = { done, missing };
  console.log(`profile ${PROFILE}: on: ${done.join('; ')}\n  not on: ${missing.join('\n          ')}`);
}

// P8: the sidebar, Home and the editor's three steps, as flow a saw them.
function p8Controls(rep) {
  const a = rep?.flows?.['a-send-first'];
  if (!a?.screens) return null;
  const pick = (re) => a.screens.filter((s) => re.test(s.label)).pop()?.controls || null;
  return { home: pick(/^App home$/), step1: pick(/^Editor, step 1/), step2: pick(/^Editor, step 2/), step3: pick(/^Editor, step 3/) };
}
function checkP8() {
  report.p8 = p8Controls(report);
  if (PROFILE !== 'government') return;
  if (!SAME_AS) return rule('warning', 'P8 not compared', 'run the default profile on the same code first and pass its folder as UX_SAME_AS');
  let other;
  try {
    other = JSON.parse(fs.readFileSync(fs.statSync(SAME_AS).isDirectory() ? path.join(SAME_AS, 'ux-flows.json') : SAME_AS, 'utf8'));
  } catch (e) {
    return rule('warning', 'P8 not compared', `cannot read ${SAME_AS}: ${e.message}`);
  }
  const theirs = other.p8 || p8Controls(other);
  const norm = (s) => s.replace(/[\w.+-]+@example\.org/g, '<email>').replace(/\d+/g, '#');
  for (const k of ['home', 'step1', 'step2', 'step3']) {
    const a = new Set((report.p8?.[k] || []).map(norm));
    const b = new Set((theirs?.[k] || []).map(norm));
    const added = [...a].filter((x) => !b.has(x));
    const gone = [...b].filter((x) => !a.has(x));
    if (added.length || gone.length) rule('broken', 'P8 same controls in the government profile', `${k}: ${added.length ? `added ${added.slice(0, 5).join(', ')}` : ''}${added.length && gone.length ? '; ' : ''}${gone.length ? `missing ${gone.slice(0, 5).join(', ')}` : ''}`);
  }
}

// P1: the ceilings of this profile (tests/ux/ceilings.json). UX_RECORD=1 fills the missing ones and lowers.
function checkCeilings() {
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(CEILINGS_FILE, 'utf8'));
  } catch {
    rule('warning', 'P1 ceilings', `no ceilings file at ${CEILINGS_FILE}`);
  }
  const mine = all[PROFILE] || (all[PROFILE] = {});
  const keys = ['actions', 'screens', 'choices_seen', 'max_choices', 'words', 'notices'];
  for (const [flow, top] of Object.entries(NEVER_ABOVE)) keys.forEach((k, i) => {
    const c = (all.default || {})[flow];
    if (!c || c[k] == null) rule('broken', 'P1 ceiling missing', `${path.basename(CEILINGS_FILE)} has no default ceiling for ${flow} ${k}`);
    else if (c[k] > top[i]) rule('broken', 'P1 ceiling raised', `${path.basename(CEILINGS_FILE)} default ${flow} ${k} is ${c[k]}, and was ${top[i]}: ceilings only go down`);
  });
  const lines = [];
  let changed = false;
  for (const r of report.table || []) {
    if (!r.ok) continue;
    const c = mine[r.flow];
    if (!c) {
      if (RECORD) {
        mine[r.flow] = Object.fromEntries(keys.map((k) => [k, r[k]]));
        changed = true;
        lines.push(`${r.flow.padEnd(16)} recorded as its ceiling`);
      } else rule('warning', 'P1 ceilings', `no ceiling yet for ${PROFILE} ${r.flow}: its first run after the simplify batches merge is recorded with UX_RECORD=1`);
      continue;
    }
    for (const k of keys) {
      if (c[k] == null) continue;
      const over = r[k] > c[k];
      if (over) rule('broken', 'P1 ceiling', `${r.flow} ${k}: ${r[k]}, ceiling ${c[k]}`, `profile ${PROFILE}`);
      if (RECORD && r[k] < c[k]) {
        c[k] = r[k];
        changed = true;
      }
      lines.push(`${r.flow.padEnd(16)} ${k.padEnd(13)} ${String(r[k]).padStart(5)}  ceiling ${String(c[k]).padStart(5)}${over ? '  OVER' : ''}`);
    }
  }
  // Section 3: with everything set up, the core flows use no switched-on feature, so they get no screen and at
  // most 1 action more than the zero-setup ceiling.
  if (PROFILE === 'everything') for (const r of report.table || []) {
    const d = (all.default || {})[r.flow];
    if (!r.ok || !d) continue;
    if (r.screens > d.screens) rule('broken', 'P1 everything set up', `${r.flow}: ${r.screens} screens, the zero-setup ceiling is ${d.screens}`);
    if (r.actions > d.actions + 1) rule('broken', 'P1 everything set up', `${r.flow}: ${r.actions} actions, the zero-setup ceiling is ${d.actions} and at most 1 more is allowed`);
  }
  if (changed) fs.writeFileSync(CEILINGS_FILE, `${JSON.stringify(all, null, 2)}\n`);
  report.ceilings = { file: CEILINGS_FILE, profile: PROFILE, recorded: changed, lines };
  if (lines.length) console.log(`\nCeilings, profile ${PROFILE} (${path.relative(process.cwd(), CEILINGS_FILE)}):\n${lines.join('\n')}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The inventory: every place a person can set something today.

function inventoryInPage() {
  const vis = (el) => {
    if (el.closest('[aria-hidden="true"], [hidden]')) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const dialogs = [...document.querySelectorAll('[role=dialog]')].filter(vis);
  const scope = dialogs[dialogs.length - 1] || document.querySelector('main, .sn, .ed, .settings') || document.body;
  const text = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();
  const items = [];
  for (const el of scope.querySelectorAll('h1, h2, h3, legend, label, input, select, textarea, button, a[href], [role=tab], summary')) {
    if (el.matches('input, select, textarea') && el.closest('label')) continue; // said with its label
    const hidden = el.matches('input') && el.getBoundingClientRect().width < 4;
    if (!hidden && !vis(el)) continue;
    if (el.matches('h1, h2, h3, legend')) items.push(`## ${text(el)}`);
    else if (el.matches('label')) {
      const c = el.querySelector('input, select, textarea');
      if (!c) continue;
      const kind = c.matches('select') ? `select [${[...c.options].map((o) => o.text).join(' | ')}]` : c.type === 'checkbox' ? 'checkbox' : c.type === 'radio' ? 'radio' : c.type === 'file' ? 'file' : c.matches('textarea') ? 'text area' : `${c.type || 'text'} field`;
      items.push(`${kind}: ${text(el).slice(0, 140)}`);
    } else if (el.matches('select')) items.push(`select ${el.getAttribute('aria-label') || ''} [${[...el.options].map((o) => o.text).join(' | ')}]`);
    else if (el.matches('input, textarea')) items.push(`${el.type || 'text'} field: ${el.getAttribute('aria-label') || el.placeholder || el.name || ''}`);
    else if (el.matches('[role=tab]')) items.push(`tab: ${text(el)}`);
    else if (el.matches('summary')) items.push(`expander: ${text(el)}`);
    else items.push(`${el.matches('a') ? 'link' : 'button'}: ${(el.getAttribute('aria-label') || text(el)).slice(0, 100)}`);
  }
  return items.filter((x, i, all) => x.trim() && all.indexOf(x) === i);
}

async function inventory(browser, page, ids) {
  const dir = path.join(OUT, 'inventory');
  fs.mkdirSync(dir, { recursive: true });
  // `fresh`: nothing was opened by the script, so the closed-on-arrival and unmarked-expander rules apply too.
  const take = async (key, p = page, fresh = false) => {
    await p.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await sleep(400);
    await p.screenshot({ path: path.join(dir, `${slug(key)}.png`), fullPage: !(await p.getByRole('dialog').count()) });
    report.inventory[key] = await p.evaluate(inventoryInPage);
    const m = await p.evaluate(measureInPage);
    checkScreen(m, { url: p.url().replace(BASE, '') || '/', kind: 'page', flowId: 'inventory', isScreen: fresh, where: `inventory: ${key}` });
    if (!(await p.getByRole('dialog').count())) report.inventory_mores[key] = await openMores(p, key);
  };
  // Settings: every tab.
  await page.goto(`${BASE}/app/settings`);
  await page.getByRole('tab').first().waitFor();
  const tabs = await visible(page.getByRole('tab')).allInnerTexts();
  report.inventory_settings_tabs = tabs;
  if (ZERO_SETUP && tabs.length > SETTINGS_CAP.owner) rule('todo', '2.2 Settings sections', `an owner with zero setup sees ${tabs.length} sections, at most ${SETTINGS_CAP.owner} (simplify-public)`, 'inventory: settings');
  for (const t of tabs) {
    await page.getByRole('tab', { name: t, exact: true }).click();
    await take(`settings - ${t}`, page, true);
  }
  // The editor: a fresh draft with the PDF and one person, every option opened.
  const { envelope } = await apiIn(page, '/envelopes', { body: { kind: 'envelope' } });
  await page.goto(`${BASE}/app/envelopes/${envelope.id}/edit`);
  await page.locator('input[type=file]').first().setInputFiles(ids.pdf);
  await page.getByLabel(/^(document|file) name$/i).first().waitFor();
  if (!(await visible(page.getByLabel(/^(recipient )?name$/i)).count())) await byRole(page, 'button', /add recipient/i).click();
  await visible(page.getByLabel(/^(recipient )?name$/i)).first().fill('Ivy Inventory');
  await visible(page.getByLabel(/^(recipient )?email$/i)).first().fill(`ivy-${STAMP}@example.org`);
  const more = byRole(page, 'button', /more options/i);
  if (await more.count()) await more.click();
  const order = page.getByText(/signing order/i).first();
  await take('editor - step 1 (with More opened for one person)');
  await page.getByRole('button', { name: /^next$/i }).first().click();
  await page.locator('.pdfpage canvas').first().waitFor();
  await take('editor - step 2 (field types)', page, true);
  // Select one field of each kind that has its own settings and list them.
  const pg = page.locator('.pdfpage').first();
  for (const [type, y] of [['Text', 0.3], ['Signature', 0.5], ['Dropdown', 0.7]]) {
    const kinds = page.getByRole('group', { name: /add a field/i }).first();
    // A kind beyond the six common ones is behind "More fields" (simplify-editor).
    if (!(await byRole(kinds, 'button', new RegExp(`^${type}$`, 'i')).count())) await byRole(kinds, 'button', /^more fields$/i).click().catch(() => {});
    await byRole(kinds, 'button', new RegExp(`^${type}$`, 'i')).click();
    const b = await pg.boundingBox();
    await page.mouse.click(b.x + b.width * 0.4, b.y + b.height * y);
    await sleep(300);
    const sheet = byRole(page, 'button', /^settings$/i);
    if (await sheet.count()) await sheet.click().catch(() => {});
    await sleep(200);
    const panel = page.locator('.ed-side, .pane').filter({ hasText: /field settings|assigned to/i }).first();
    report.inventory[`editor - field settings (${type})`] = await (await panel.count() ? panel : page.locator('body')).evaluate((root) => {
      const out = [];
      for (const el of root.querySelectorAll('label, button, select')) {
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        if (el.matches('label')) out.push(`${el.querySelector('select') ? 'select' : el.querySelector('input[type=checkbox]') ? 'checkbox' : 'field'}: ${el.innerText.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
        else if (el.matches('button')) out.push(`button: ${(el.getAttribute('aria-label') || el.innerText).replace(/\s+/g, ' ').trim()}`);
      }
      return out.filter((x, i, a) => a.indexOf(x) === i);
    });
    await page.screenshot({ path: path.join(dir, `editor-field-settings-${slug(type)}.png`) });
  }
  await page.getByRole('button', { name: /^next$/i }).first().click();
  await page.getByRole('button', { name: /^send$/i }).first().waitFor();
  await take('editor - step 3 (review)', page, true);
  void order;
  await apiIn(page, `/envelopes/${envelope.id}`, { method: 'DELETE' }).catch(() => {});
  // The envelope page, while out and when completed.
  if (ids.outEnvelope) {
    await page.goto(`${BASE}/app/envelopes/${ids.outEnvelope}`);
    await page.getByRole('heading').first().waitFor();
    await take('envelope page - waiting for someone', page, true);
  }
  if (ids.doneEnvelope) {
    await page.goto(`${BASE}/app/envelopes/${ids.doneEnvelope}`);
    await page.getByRole('heading').first().waitFor();
    await take('envelope page - completed', page, true);
  }
  // The signing page: Other actions, the signature dialog, on a fresh link.
  if (ids.signLink) {
    const ctx = await newContext(browser, PHONE);
    const s = await ctx.newPage();
    await s.goto(ids.signLink);
    await s.getByRole('checkbox').first().waitFor();
    await take('signing page - consent', s, true);
    await byRole(s, 'button', /other actions/i).tap();
    await s.getByRole('dialog').first().waitFor();
    await take('signing page - other actions (consent)', s);
    await s.keyboard.press('Escape');
    await byRole(s, 'checkbox', /agree/i).tap();
    await byRole(s, 'button', /^continue$/i).tap();
    await s.locator('.pdfpage canvas').first().waitFor();
    await take('signing page - document', s, true);
    await byRole(s, 'button', /other actions/i).tap();
    await s.getByRole('dialog').first().waitFor();
    await take('signing page - other actions (document)', s);
    await s.keyboard.press('Escape');
    await sleep(300);
    await byRole(s, 'button', /sign here|signature/i).tap();
    await s.getByRole('dialog').first().waitFor();
    for (const t of await visible(s.getByRole('dialog').getByRole('tab')).allInnerTexts()) {
      await s.getByRole('dialog').getByRole('tab', { name: t, exact: true }).tap();
      await take(`signing page - adopt signature, ${t}`, s);
    }
    await ctx.close();
  }
  // The public and trust pages a signer or a buyer reads, signed out: words only (P6, P13), and P4 on arrival.
  const ctxP = await newContext(browser, DESKTOP);
  const pp = await ctxP.newPage();
  for (const u of ['/', '/pricing', '/help', '/verify', '/check', '/login', '/signup', '/security', '/security/processing', '/accessibility', '/procurement']) {
    const res = await pp.goto(BASE + u).catch(() => null);
    if (!res || res.status() >= 400) continue;
    await pp.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await sleep(300);
    checkScreen(await pp.evaluate(measureInPage), { url: u, kind: 'page', flowId: 'inventory', isScreen: true, where: `public ${u}` });
  }
  await ctxP.close();
}

// Opens every data-more on the page the way a person would, counts the lines inside, and closes it again (P4).
async function openMores(p, key) {
  const out = [];
  const all = p.locator('[data-more="screen"], [data-more="item"]');
  const n = Math.min(await all.count(), 30);
  const isOpen = (e) => (e.matches('details') ? e.open : e.getAttribute('aria-expanded') === 'true');
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const info = await el.evaluate((e) => ({ kind: e.dataset.more, details: e.matches('details'), open: e.matches('details') ? e.open : e.getAttribute('aria-expanded') === 'true',
      name: (e.getAttribute('aria-label') || (e.matches('details') ? e.querySelector('summary')?.innerText : e.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 60) }));
    const trigger = info.details ? el.locator(':scope > summary').first() : el;
    if (!info.open) {
      await trigger.click({ timeout: 3000 }).catch(() => {});
      await sleep(400);
    }
    const count = await el.evaluate(countPanel);
    out.push({ kind: info.kind, name: info.name, ...count });
    if (!info.open) {
      if ((await el.evaluate(isOpen).catch(() => false)) || (await p.getByRole('dialog').count())) {
        await p.keyboard.press('Escape');
        await sleep(200);
      }
      if (await el.evaluate(isOpen).catch(() => false)) await trigger.click({ timeout: 3000 }).catch(() => {});
      await sleep(200);
    }
    const cap = info.kind === 'item' ? MORE_CAP.item : /step 3/.test(key) ? MORE_CAP.step3 : /^signing page/.test(key) ? MORE_CAP.signing : MORE_CAP.screen;
    if (count.lines > cap) rule('broken', `P4 lines in a data-more="${info.kind}"`, `"${info.name}" holds ${count.lines} lines, at most ${cap}`, `inventory: ${key}`);
    if (count.role_options > MORE_CAP.role_options) rule('broken', 'P4 role list', `${count.role_options} roles, at most ${MORE_CAP.role_options}`, `inventory: ${key}`);
  }
  return out;
}

// Runs in the page: the controls inside an opened More (a <details>, the element its aria-controls names, or the
// menu or dialog it opened). Each one is a line.
function countPanel(e) {
  const vis = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const popups = [...document.querySelectorAll('[role=dialog], [role=menu], [role=listbox]')].filter(vis);
  const panel = e.matches('details') ? e : document.getElementById(e.getAttribute('aria-controls') || '') || popups[popups.length - 1] || e.nextElementSibling;
  if (!panel) return { lines: 0, role_options: 0 };
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=menuitem], [role=menuitemradio], [role=checkbox], [role=radio], [role=switch], [role=option], [role=tab]';
  const lines = [...panel.querySelectorAll(sel)].filter((c) => vis(c) && !c.disabled && c !== e && !c.closest('summary') && !/^close$/i.test(c.getAttribute('aria-label') || c.innerText || '')).length;
  const role = [...panel.querySelectorAll('select')].find((s) => /\brole\b/i.test(s.labels?.[0]?.innerText || s.getAttribute('aria-label') || ''));
  return { lines, role_options: role ? [...role.options].filter((o) => !o.disabled).length : 0 };
}

// ---------------------------------------------------------------------------------------------------------------

(async () => {
  let browser;
  let fakes = null;
  try {
    if (!Object.keys(GATES).length) rule('warning', 'P3 gates', 'no gates found in research/ux-notes.json, so data-feature is not checked');
    fakes = await startFakes();
    const up = await fetch(`${BASE}/api/me`).catch(() => null);
    if (!up) throw new Error(`Nothing answers at ${BASE}. Start the dev server first (see the top of this file).`);
    await outbox();
    const pdf = await makePdf();
    browser = await chromium.launch(process.env.UX_HEADED === '1' ? { headless: false } : undefined);
    report.conventions = {
      desktop: `${DESKTOP.viewport.width}x${DESKTOP.viewport.height}`, phone: 'iPhone 13 (390x844, touch)',
      action_total: 'clicks + taps + fields typed + key presses + 2 per file picked',
      choices: 'enabled, visible controls inside the open dialog, or on the whole page when no dialog is open',
      klm: 'M 1.35 s + P 1.1 s + B 0.2 s per press, + 0.28 s a character, + 4 s to find a file, + the time the app took',
    };
    if (WARMUP) {
      console.log('warming up the dev server (every page once, on its own account)…');
      report.warmup_ms = await warmUp(browser, pdf).catch((e) => (console.log(`warm-up had a problem: ${e.message}`), -1));
    }

    // (a)
    const ctxA = await newContext(browser, DESKTOP);
    const pa = await ctxA.newPage();
    pa.setDefaultTimeout(20000);
    watchErrors(pa, 'sender');
    ctxA.on('page', (p) => watchErrors(p, 'sender'));
    const fa = new Flow('a-send-first', 'New sender signs up and sends a first document to one person, one signature field', pa);
    let sender = pa;
    const okA = await runFlow(fa, async (f) => { sender = await flowA(f, pdf); });
    sender = fa.page;
    const firstEnvelope = (sender.url().match(/env_[A-Za-z0-9_-]+/) || [])[0];

    // Set-up for the other flows, through the API as the sender (never counted).
    const ids = { pdf };
    if (okA && PROFILE !== 'default') await setUp(browser, sender).catch((e) => report.failures.push(`profile setup: ${e.message}`));
    if (okA) {
      ids.desk = await sendByApi(sender, pdf, `Please sign: ${DOC_NAME} (desktop)`, SIGNER_DESK).catch((e) => report.failures.push(`setup desktop envelope: ${e.message}`));
      ids.template = await sendByApi(sender, pdf, 'Sponsor agreement', null, 'template').catch((e) => report.failures.push(`setup template: ${e.message}`));
      ids.help = await sendByApi(sender, pdf, `Please sign: ${DOC_NAME} (help)`, SIGNER_HELP).catch((e) => report.failures.push(`setup help envelope: ${e.message}`));
    }

    // (b) on a phone, then on a desktop.
    const ctxB = await newContext(browser, PHONE);
    const pb = await ctxB.newPage();
    pb.setDefaultTimeout(20000);
    watchErrors(pb, 'signer phone');
    const okB = okA && await runFlow(new Flow('b-sign-phone', 'The person signs on a phone', pb, { touch: true, device: 'iPhone 13' }), (f) => flowB(f, SIGNER_PHONE));
    await ctxB.close();
    const ctxB2 = await newContext(browser, DESKTOP);
    const pb2 = await ctxB2.newPage();
    pb2.setDefaultTimeout(20000);
    watchErrors(pb2, 'signer desktop');
    if (okA) await runFlow(new Flow('b-sign-desktop', 'A person signs on a desktop', pb2), (f) => flowB(f, SIGNER_DESK));
    await ctxB2.close();

    // (c) template, (d) download, (e) settings: the sender again, signed in.
    if (okA && ids.template) await runFlow(new Flow('c-template-send', 'The sender sends from a template', sender), (f) => flowC(f, 'Sponsor agreement'));
    const tplSent = (sender.url().match(/env_[A-Za-z0-9_-]+/) || [])[0];
    if (okB) await runFlow(new Flow('d-find-download', 'The sender finds the completed document and downloads it', sender), (f) => flowD(f, report.first_subject || `Please sign: ${DOC_NAME}`));
    if (okA) await runFlow(new Flow('e-settings-name', 'The sender changes their name in Settings', sender), (f) => flowE(f));

    // (f) help on the signing page, on a phone.
    let helpLink = null;
    if (okA && ids.help) {
      const ctxF = await newContext(browser, PHONE);
      const pf = await ctxF.newPage();
      pf.setDefaultTimeout(20000);
      watchErrors(pf, 'signer needing help');
      await runFlow(new Flow('f-signer-help', 'A signer who cannot sign right now looks for help', pf, { touch: true, device: 'iPhone 13' }), (f) => flowF(f, SIGNER_HELP));
      helpLink = (await waitMail(SIGNER_HELP.email, (x) => x.link?.includes('/sign/'), 'invitation').catch(() => null))?.link;
      await ctxF.close();
    }

    // (g) signing in again, in a browser of its own; (h) signing your own document, as the sender.
    if (okA) {
      const ctxG = await newContext(browser, DESKTOP);
      const pg = await ctxG.newPage();
      pg.setDefaultTimeout(20000);
      watchErrors(pg, 'sender signing in');
      await runFlow(new Flow('g-sign-in', 'The sender signs in again from the landing page', pg), (f) => flowG(f));
      await ctxG.close();
      await runFlow(new Flow('h-sign-myself', 'The sender signs a document themselves', sender), (f) => flowH(f, pdf));
    }

    // The inventory.
    if (okA) {
      console.log('\n== inventory');
      try {
        await inventory(browser, sender, { pdf, outEnvelope: tplSent || ids.desk, doneEnvelope: firstEnvelope, signLink: helpLink });
        console.log(`ok    inventory: ${Object.keys(report.inventory).length} places`);
      } catch (e) {
        report.failures.push(`inventory: ${e.message.split('\n')[0]}`);
        console.log(`FAIL  inventory: ${e.message.split('\n')[0]}`);
        await sender.screenshot({ path: path.join(OUT, 'inventory', 'FAIL.png'), fullPage: true }).catch(() => {});
      }
    }

    // One line per flow.
    report.table = Object.entries(report.flows).map(([id, x]) => ({ flow: id, ok: x.ok, actions: x.actions_total, screens: x.screens_total, choices_seen: x.choices_seen_total, max_choices: x.choices_max_one_screen, words: x.words_seen_total, notices: x.notices_seen_total, wall_s: +(x.wall_ms / 1000).toFixed(1), klm_s: x.klm_estimate_s }));
    console.log('');
    console.table(report.table);
    checkCeilings();
    checkP8();
  } catch (e) {
    report.failures.push(`run: ${e.message}`);
    console.error(e);
  } finally {
    writeReport();
    await browser?.close().catch(() => {});
    fakes?.close();
    const { broken, warnings } = report.rules;
    const show = (x) => `${x.rule}: ${x.detail}${x.where.length ? `\n            at ${x.where.slice(0, 4).join('; ')}${x.where.length > 4 ? `; and ${x.where.length - 4} more` : ''}` : ''}`;
    console.log(`\nRules, profile ${PROFILE}: ${broken.length} broken, ${warnings.length} warnings`);
    for (const x of broken) console.log(`  BROKEN  ${show(x)}`);
    for (const x of warnings) console.log(`  warn    ${show(x)}`);
    console.log(`\nWrote ${path.join(OUT, 'ux-flows.json')}${report.failures.length ? `\nFAILED: ${report.failures.join('; ')}` : broken.length ? '\nUX FLOWS RAN, RULES BROKEN' : '\nUX FLOWS OK'}`);
    process.exit(report.failures.length ? 1 : broken.length ? 3 : 0);
  }
})();
