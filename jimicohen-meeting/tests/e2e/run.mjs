#!/usr/bin/env node
/**
 * End-to-end runner. Plain Node, no test framework.
 *
 *   node tests/e2e/run.mjs                 every tests/e2e/*.e2e.mjs
 *   node tests/e2e/run.mjs smoke           suites whose file name contains "smoke"
 *   node tests/e2e/run.mjs booking -g zone only scenarios whose name contains "zone"
 *
 * Options:
 *   -g, --grep <text>   run only scenarios whose name contains <text>
 *   --ports <a-b>       port range for the dev servers (default: env E2E_PORTS, else 8800-8899)
 *   --bail              stop after the first failing suite
 *   --list              print the suites and exit
 *
 * Environment:
 *   E2E_DIST_DIR        where to build the app (a folder; the app lands in <dir>/meeting). Default: dist
 *   E2E_SKIP_BUILD=1    reuse the build that is already there
 *   E2E_WORK_DIR        where the data folders and server logs go. Default: a fresh folder in the temp dir
 *   E2E_PORTS           port range, e.g. 8800-8809
 *   E2E_TIMEOUT_MS      how long a browser action may take (default 10000)
 *
 * Each suite gets its own dev server, its own empty data folder and its own log file. The exit
 * code is 0 only when every scenario of every suite passed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { E2E_DIR, ROOT, bold, buildApp, dim, distRoot, green, launchBrowser, red, runSuite } from './lib.mjs';

function parseArgs(argv) {
  const args = { filters: [], grep: null, ports: process.env.E2E_PORTS || '8800-8899', bail: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-g' || arg === '--grep') args.grep = argv[++i] ?? null;
    else if (arg.startsWith('--grep=')) args.grep = arg.slice('--grep='.length);
    else if (arg === '--ports') args.ports = argv[++i];
    else if (arg.startsWith('--ports=')) args.ports = arg.slice('--ports='.length);
    else if (arg === '--bail') args.bail = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else args.filters.push(arg.toLowerCase());
  }
  return args;
}

function discover(filters) {
  return fs
    .readdirSync(E2E_DIR)
    .filter((file) => file.endsWith('.e2e.mjs'))
    .sort()
    .filter((file) => filters.length === 0 || filters.some((f) => file.toLowerCase().includes(f)))
    .map((file) => path.join(E2E_DIR, file));
}

function duration(ms) {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
    return 0;
  }
  const files = discover(args.filters);
  if (files.length === 0) {
    console.error(red(`No suite matches ${args.filters.join(', ') || '*.e2e.mjs'} in ${path.relative(ROOT, E2E_DIR)}.`));
    return 1;
  }
  if (args.list) {
    for (const file of files) console.log(path.relative(ROOT, file));
    return 0;
  }

  const started = Date.now();
  const dist = buildApp({ dist: distRoot() });
  const workRoot = process.env.E2E_WORK_DIR ? path.resolve(process.env.E2E_WORK_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-e2e-'));
  fs.mkdirSync(workRoot, { recursive: true });

  const browser = await launchBrowser();
  const results = [];
  try {
    for (const file of files) {
      const fileName = path.basename(file, '.e2e.mjs');
      let suite;
      try {
        suite = (await import(pathToFileURL(file).href)).default;
        if (!suite || typeof suite.run !== 'function') throw new Error('The file must export defineSuite(...) as its default.');
      } catch (err) {
        console.log(`\n${bold(`▸ ${fileName}`)}\n${red(`  Could not load ${path.relative(ROOT, file)}: ${err?.stack ?? err}`)}`);
        results.push({ name: fileName, ok: false, scenarios: [], ms: 0, logFile: null, error: `could not load: ${err?.message ?? err}` });
        if (args.bail) break;
        continue;
      }
      const result = await runSuite(suite, { browser, ports: args.ports, dist, only: args.grep, workDir: path.join(workRoot, fileName) });
      results.push(result);
      if (!result.ok && args.bail) break;
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  // ── summary ──
  console.log(`\n${bold('Summary')}`);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const result of results) {
    const ran = result.scenarios.filter((s) => !s.skipped);
    const bad = ran.filter((s) => !s.ok);
    passed += ran.length - bad.length;
    failed += bad.length + (result.error ? 1 : 0);
    skipped += result.scenarios.length - ran.length;
    console.log(`${result.ok ? green('✓') : red('✗')} ${result.name}  ${ran.length - bad.length}/${ran.length} scenarios  ${dim(duration(result.ms))}`);
    if (result.error) console.log(red(`    ${result.error.split('\n')[0]}`));
    for (const scenario of bad) {
      console.log(red(`    ✗ ${scenario.name}`));
      for (const failure of scenario.failures) {
        console.log(red(`        ${failure.step}: ${failure.message.split('\n')[0]}`));
        for (const shot of failure.screenshots ?? []) console.log(dim(`        ${path.relative(ROOT, shot)}`));
      }
    }
    if (!result.ok && result.logFile) console.log(dim(`    server log: ${result.logFile}`));
  }
  const total = `${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`;
  console.log(`\n${failed === 0 && results.every((r) => r.ok) ? green(total) : red(total)}  ${dim(duration(Date.now() - started))}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(red(err?.stack ?? String(err)));
    process.exit(1);
  },
);
