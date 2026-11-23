// Runs the framework's own command (next dev, next build) with its usage statistics switched off, on any system.
// "NEXT_TELEMETRY_DISABLED=1 next build" written in an npm script works in a POSIX shell only, not in the Windows
// command prompt, and the framework reads the setting in its own process, so next.config.mjs is too late for it.
//   node scripts/next.mjs build      what "npm run build" runs
//   node scripts/next.mjs dev        what "npm run dev" runs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bin = require.resolve('next/dist/bin/next');
const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
// Stopping this stops the framework too, and its exit code is ours.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
