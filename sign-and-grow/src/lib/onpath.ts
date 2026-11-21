// Is a program installed on this server? Read by server components only (the public help page), never by a screen
// in the browser: it looks at the disk. src/server/convert.ts starts LibreOffice by this same name on the PATH.
import fs from 'node:fs';
import path from 'node:path';

/** True when `program` is a file this server may run in one of the folders of PATH. */
export function onPath(program: string, env: { PATH?: string } = process.env): boolean {
  if (!program || /[\\/]/.test(program)) return false;
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) => {
    try {
      const f = path.join(dir, program);
      fs.accessSync(f, fs.constants.X_OK);
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  });
}
