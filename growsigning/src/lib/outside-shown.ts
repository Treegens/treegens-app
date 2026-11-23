// The outside services as the public pages show them: /security ("What this server connects to") and
// /security/subprocessors ("Also connected to"). Both read this one function so they cannot disagree.
//
// It keeps every row of outsideServices() (src/lib/outside.ts) and changes only words:
//  - The time-stamp service is shown whenever it is set up, with or without a seal: finishPdf (src/server/finalpipe.ts)
//    asks it for a time stamp over the last line of each record at completion either way (src/server/auditstamp.ts),
//    and, without a seal, for one over the whole completed PDF.
//    Without a seal its words do not speak of one, and the certificate checks (OCSP, revocation lists) are not
//    mentioned, because those happen only after a seal (withLongTerm in src/server/ltv.ts).
//  - Webhooks and the document converter get words a non-technical reader can follow, and the converter says that it
//    receives whole files.
//
// It reads the environment: server code and server components only.
import { outsideServices, type OutsideService } from './outside.ts';
import { sealSet } from './seal.ts';

type Env = Record<string, string | undefined>;

export const TSA_WITHOUT_SEAL = 'Adds a time stamp from that service over each completed PDF and over the last line of each document\'s record when everyone has finished. It is sent fingerprints of those, never the document.';
export const WEBHOOKS_NAME = 'Messages to an account\'s own systems (webhooks)';
export const WEBHOOKS_PURPOSE = 'When an admin of an account sets it up, this server tells an address they choose when one of their documents changes. Nothing is sent until an admin adds an address.';
export const CONVERTER_PURPOSE = 'Turns Word, Excel, PowerPoint and similar files into PDF. It receives the whole file someone uploads. It is usually run by the operator of this server; ask them who runs it and where.';

export function outsideShown(env: Env = process.env): OutsideService[] {
  const seal = sealSet(env);
  return outsideServices(env).map((s) => {
    if (s.id === 'tsa' && !seal) return { ...s, purpose: TSA_WITHOUT_SEAL };
    if (s.id === 'webhooks') return { ...s, name: WEBHOOKS_NAME, purpose: WEBHOOKS_PURPOSE };
    if (s.id === 'converter') return { ...s, purpose: CONVERTER_PURPOSE };
    return s;
  });
}

/**
 * The "not stated" sentences of dataPlace() as one sentence, so a reader is not told "Ask them" five times. Each
 * sentence reads "The operator of this server has not said X. Ask them."; the X parts are joined. Null when nothing
 * is missing.
 */
export function unstatedSentence(unstated: string[]): string | null {
  if (!unstated.length) return null;
  const parts = unstated.map((u) => /has not said (.+?)\. Ask them\.$/.exec(u)?.[1] || u.replace(/\.$/, ''));
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
  return `The operator of this server has not said ${list}.`;
}
