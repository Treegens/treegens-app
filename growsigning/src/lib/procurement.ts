// The procurement documents: the papers a buyer's procurement and security people ask for on day one. /procurement
// lists them with their dates and serves each one at /procurement/<slug> (src/app/procurement/[doc]/route.ts), read
// from the docs/ folder as it is on the server. tests/gov-g03.test.ts checks that each file exists, carries its date
// and "What this is not" before anything else, names only files that exist and says nothing the honesty scan of
// tests/claims-scan.ts refuses.
//
// Pure data and text functions: pages, route handlers and tests can import it. Nothing here reads a file.

export type ProcurementDoc = {
  /** The last part of its address, /procurement/<slug>. */
  slug: string;
  /** Where it is, from the project folder. */
  file: string;
  /** Its name on the page. */
  title: string;
  /** One line on what it is for. */
  what: string;
};

export const PROCUREMENT_DOCS: ProcurementDoc[] = [
  { slug: 'security-whitepaper.md', file: 'docs/procurement/security-whitepaper.md', title: 'Security whitepaper', what: 'How the software is built, where data flows, every use of cryptography, sessions, logging, backups and what is not done. Each statement names the file it rests on.' },
  { slug: 'controls.md', file: 'docs/controls.md', title: 'Control self-assessment', what: 'Area by area, what the software does and what the operator must do. A self-assessment by the authors, not audited by anyone.' },
  { slug: 'data-processing-terms-template.md', file: 'docs/procurement/data-processing-terms-template.md', title: 'Data processing terms: a template for a lawyer', what: 'Clauses to start from, each with a note on which code makes it true or that it is a promise only. Not legal advice, not a contract.' },
  { slug: 'dpia-pack.md', file: 'docs/procurement/dpia-pack.md', title: 'Data protection impact assessment pack', what: 'The categories of data, the risks, what the code does about each, and the choices left to the operator.' },
  { slug: 'transfer-impact-assessment-template.md', file: 'docs/procurement/transfer-impact-assessment-template.md', title: 'Transfer impact assessment template', what: 'What can leave the country, and a form to assess each transfer.' },
  { slug: 'exit-plan.md', file: 'docs/procurement/exit-plan.md', title: 'Exit plan', what: 'What the export holds and in which formats, the steps, how long it takes, and what is not in it today.' },
  { slug: 'incident-response.md', file: 'docs/procurement/incident-response.md', title: 'Incident response', what: 'What the software records and alerts on, what an operator must staff to meet a deadline, and notices to start from.' },
  { slug: 'acr.md', file: 'docs/acr.md', title: 'Accessibility report (draft)', what: 'Guideline by guideline, what the screens support, partly support or do not support, with a remark on each. Self-assessed by the authors, not audited.' },
  { slug: 'a11y-checks.md', file: 'docs/a11y-checks.md', title: 'Accessibility checks', what: 'The steps the authors took to check the screens with axe-core and by hand, what they found, and how to repeat them.' },
  { slug: 'runbooks.md', file: 'docs/runbooks.md', title: 'Runbooks', what: 'Backups, restores, rotating keys, a leaked key, a breach, rebuilding the same image, running with no network.' },
];

export const procurementDoc = (slug: string): ProcurementDoc | null => PROCUREMENT_DOCS.find((d) => d.slug === slug) || null;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The date a document says it was written ("Written on 21 November 2026"), as YYYY-MM-DD, or null when it has none. */
export function writtenOn(text: string): string | null {
  const m = /(?:^|[.\s])Written on (\d{1,2}) ([A-Z][a-z]+) (\d{4})\b/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  const day = Number(m[1]);
  if (month < 0 || day < 1 || day > 31) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The size of a file in words a person reads: "12 KB". */
export const sizeWords = (bytes: number): string => (bytes < 1024 ? `${bytes} bytes` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
