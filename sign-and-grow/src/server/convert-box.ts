// The box LibreOffice runs in when it turns a file into a PDF (src/server/convert.ts starts it).
//
// A document can name things outside itself: a picture on another server, or a file on this machine's own disk. So
// the job gets, where the machine allows it (`unshare -rnmpf`, Linux user namespaces):
//   - no network at all (a network namespace with only a loopback that is down),
//   - a file system of its own: a new root (pivot_root, the machine's own root let go) that holds LibreOffice and
//     the system's fonts read-only, and the job's own folder as /work. Nothing else of this machine is there: not the app, not its data folder, not /home, /root,
//     /tmp, /var or /etc (only the font, linker and LibreOffice settings under /etc),
//   - its own process list, so it cannot see or signal anything else.
// Where that does not work, `unshare -rn` (no network, but the machine's files) is tried, then nothing; convert.ts
// writes in the server log which of the three it is. In all three the job gets a memory limit (CONVERT_MEMORY_MB).
import fs from 'node:fs';
import path from 'node:path';

export type BoxLevel = 'box' | 'net' | 'open';

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// What LibreOffice needs from the machine, read-only. Anything that is not there is skipped.
const SYSTEM = ['/usr', '/lib', '/lib64', '/lib32', '/libx32', '/bin', '/sbin', '/etc/fonts', '/etc/libreoffice', '/etc/alternatives', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/var/lib/libreoffice', '/var/cache/fontconfig'];

/** Where a LibreOffice outside /usr is installed (/opt/libreoffice7.6, say), so the box can hold it. Only a real
 *  LibreOffice folder counts: the program must sit in a folder called "program". */
export function installRoot(program: string): string | null {
  try {
    let found = program;
    if (!program.includes('/')) {
      found = '';
      for (const d of (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':')) {
        const p = path.join(d || '.', program);
        if (fs.existsSync(p)) { found = p; break; }
      }
      if (!found) return null;
    }
    const real = fs.realpathSync(found);
    const dir = path.dirname(real);
    if (/^\/(usr|bin|sbin|lib\w*)\//.test(real) && !real.startsWith('/usr/local/')) return null;
    if (path.basename(dir) !== 'program') return null;
    const root = path.dirname(dir);
    return root === '/' || /['\n]/.test(root) ? null : root;
  } catch {
    return null;
  }
}

/** The shell script that builds the new root inside the namespaces and starts the program in it. `dir` is the job's
 *  folder (it holds work/); `hide` are folders that must not be seen even when they sit under /usr (the app itself
 *  and its data, when someone installed them there). */
export function boxScript(dir: string, memKb: number, extra: string[], hide: string[]): string {
  const binds = [...SYSTEM, ...extra];
  return `set -e
N=${q(path.join(dir, 'root'))}
mkdir -p "$N"
mount -t tmpfs -o mode=755,size=1m none "$N"
for p in ${binds.map(q).join(' ')}; do
  [ -e "$p" ] || continue
  if [ -L "$p" ]; then mkdir -p "$(dirname "$N$p")"; cp -P "$p" "$N$p"
  elif [ -d "$p" ]; then mkdir -p "$N$p"; mount --rbind -o ro "$p" "$N$p"
  else mkdir -p "$(dirname "$N$p")"; : > "$N$p"; mount --bind -o ro "$p" "$N$p"; fi
done
for p in ${hide.map(q).join(' ') || "''"}; do
  if [ -n "$p" ] && [ -d "$N$p" ]; then mount -t tmpfs -o mode=755,size=1m none "$N$p"; fi
done
mkdir -p "$N/proc" "$N/dev" "$N/tmp" "$N/work"
mount -t proc proc "$N/proc"
for f in null zero urandom random; do : > "$N/dev/$f"; mount --bind "/dev/$f" "$N/dev/$f"; done
mount --bind ${q(path.join(dir, 'work'))} "$N/work"
${memKb > 0 ? `ulimit -v ${memKb}` : ':'}
# The new root becomes the only root: the machine's own is put aside and let go, so there is no way back to it,
# also not for a program that breaks out of a plain chroot.
mkdir "$N/.old"
cd "$N"
pivot_root . .old
exec chroot . sh -c 'umount -l /.old && rmdir /.old && cd / && exec "$@"' sh "$@"
`;
}

/** The command line for one job at one level. In the box the job's folder is /work; otherwise it is where it is. */
export function boxed(level: BoxLevel, o: { unshare: string; dir: string; memKb: number; program: string; args: string[] }): { cmd: string; args: string[] } {
  const limit = o.memKb > 0 ? `ulimit -v ${o.memKb}; ` : '';
  if (level === 'box') {
    const root = installRoot(o.program);
    const hide = [process.cwd(), process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ''].filter((p) => p && p !== '/' && !/['\n]/.test(p));
    return { cmd: o.unshare, args: ['-rnmpf', '--', 'sh', '-c', boxScript(o.dir, o.memKb, root ? [root] : [], hide), 'sh', o.program, ...o.args] };
  }
  const plain = ['sh', '-c', `${limit}exec "$@"`, 'sh', o.program, ...o.args];
  return level === 'net' ? { cmd: o.unshare, args: ['-rn', '--', ...plain] } : { cmd: plain[0], args: plain.slice(1) };
}
