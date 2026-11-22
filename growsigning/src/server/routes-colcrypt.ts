// For /app/operator: whether this server encrypts what it stores (FILE_ENCRYPTION_KEY), and what needs a look in the
// encrypted columns of the database (src/server/colsweep.ts). The page draws one line only when there is something
// to say, so a server with a key and nothing wrong shows nothing new.
import { route } from './router.ts';
import { bad } from './util.ts';
import { isOperator } from './routes-trust.ts';
import { databaseWarning, scanColumns, type ColumnScan } from './colsweep.ts';
import { fileEncryptionOn } from '../lib/storedfiles.ts';

const g = globalThis as any;
// Counting reads every listed value, so it is done at most every ten minutes, not for every visit to the page.
function scanned(): ColumnScan | null {
  if (!fileEncryptionOn()) return null;
  const sig = `${process.env.FILE_ENCRYPTION_KEY}\n${process.env.FILE_ENCRYPTION_KEYS_OLD || ''}`;
  if (!g.__tscolscan || g.__tscolscan.sig !== sig || Date.now() - g.__tscolscan.at > 600_000) g.__tscolscan = { sig, at: Date.now(), scan: scanColumns() };
  return g.__tscolscan.scan;
}

route('GET', '/operator/encryption', (c) => {
  if (!isOperator(c.user)) throw bad('Not found', 404);
  const on = fileEncryptionOn();
  const s = scanned();
  return { on, warning: databaseWarning(s ?? undefined), waiting: s ? s.plain + s.old_key : null };
});
