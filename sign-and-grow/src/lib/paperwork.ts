// Documents that often need more than a simple electronic signature: ink on paper, a witness, a notary, or a
// qualified signature. One list of words, used by the server (the "warnings" in the answer to sending and the line
// in the audit trail), by the review step of the editor and by the help page, so all three name the same words.
//
// What this is: a reminder. It looks for words, it cannot read a contract, it does not know which country anyone is
// in, and it never stops a send. What it is not: legal advice, or a promise that a document without these words is
// fine. The country notes at the end are what our research found, each with the month it was looked at and the
// source it came from. Nobody here is a lawyer, and the pages that print these notes say so.
//
// No environment and no side effects in this file, so pages, 'use client' files and the server may all import it.

/** Where on the help page all of this is explained. */
export const PAPER_HELP = '/help#outside-us';

// A word is matched as a whole word, in any letter case and with or without accents. A trailing * lets any letters
// follow ("befrist*" finds befristet, befristeter and Befristung). Spaces also match a hyphen or a line break.
// Document names are usually file names, so an underscore or a dot counts as a space and a capital inside a word
// starts a new one ("Power_of_Attorney.pdf", "PowerOfAttorney.pdf"). An umlaut may be written out ("Kuendigung" for
// "Kündigung") and ß as ss, as people do on a keyboard without them. Invisible characters (a soft hyphen, a
// zero-width space) are skipped.
// `title: true` means the word is only looked for in the subject and the document names: in the running text of an
// ordinary contract it is too common to mean anything ("the tenant will...", "Kündigung" as a clause heading).
// `name: true` is narrower still, document names only: "Will - Jo Bloggs.pdf" is a will, a subject "Will you sign
// this?" is not.
// `with` names stems of which one must appear somewhere in the same envelope, so that "fixed term" in a software
// contract says nothing and "fixed term" in an employment contract does.
type Word = string | { word: string; title?: true; name?: true; with?: string[] };
export type PaperKind = { id: string; a: string; why: string; words: Word[] };

export const PAPER_KINDS: PaperKind[] = [
  {
    id: 'will', a: 'a will',
    why: 'In many countries a will has to be signed by hand in front of witnesses, and one signed electronically may not count at all.',
    words: [
      'last will', 'will and testament', 'living will', { word: 'my will', title: true }, { word: 'will of', title: true }, { word: 'testament', title: true }, { word: 'will', name: true }, 'codicil',
      'testamento', 'codicilo', 'letzter wille', 'mein testament', 'letztwillige verfügung', 'mon testament', 'codicille', 'dernières volontés',
    ],
  },
  {
    id: 'trust', a: 'a trust deed',
    why: 'In several countries a deed that sets up a trust is on the list of documents that cannot be signed electronically, or it needs a witness.',
    words: ['trust deed', 'deed of trust', 'declaration of trust', 'trust instrument', 'fideicomiso', 'treuhandvertrag', 'contrat de fiducie'],
  },
  {
    id: 'attorney', a: 'a power of attorney',
    why: 'A power of attorney often has to be witnessed, notarised or registered, and in several countries it cannot be signed electronically at all.',
    words: [
      'lasting power of attorney', 'enduring power of attorney', 'power of attorney', 'power of atty', { word: 'poa', title: true }, { word: 'lpa', title: true },
      'poder notarial', 'carta poder', 'procuração', 'vorsorgevollmacht', 'generalvollmacht', { word: 'vollmacht', title: true }, 'procuration',
    ],
  },
  {
    id: 'land', a: 'a sale or transfer of land, or a long lease',
    why: 'Sales and transfers of land and long leases often have to be signed on paper, in front of a notary, or with a kind of signature that GrowSigning does not provide.',
    words: [
      'deed of sale', 'deed of transfer', 'title deed', 'sale of land', 'transfer of land', 'offer to purchase', 'long lease', 'immovable property', { word: 'conveyance', title: true },
      'escritura de compraventa', 'compraventa de inmueble', 'escritura pública', 'escritura de compra e venda', 'compra e venda de imóvel',
      'grundstückskaufvertrag', 'grundstückskauf', 'auflassung', 'acte de vente', 'compromis de vente', 'vente immobilière',
    ],
  },
  {
    id: 'employment', a: 'a fixed-term employment contract, a notice of termination or a separation agreement',
    why: 'In Germany, for example, a fixed term in an employment contract needs written form (ink on paper, or a qualified electronic signature, which GrowSigning does not provide), and a notice of termination or a separation agreement needs ink on paper. Signed here, the fixed term may not hold and the job may count as permanent.',
    words: [
      { word: 'befrist*', with: ['arbeit', 'anstell', 'employ'] }, { word: 'kündigung*', title: true }, 'kündigungsschreiben', 'aufhebungsvertrag',
      { word: 'fixed term', with: ['employ', 'arbeit'] }, { word: 'notice of termination', title: true }, 'separation agreement',
    ],
  },
  {
    id: 'witness', a: 'a document that needs a witness or a notary',
    why: 'A witness usually has to be physically present when the document is signed, and so does a notary. GrowSigning can add a witness who states that they were there, and it cannot check that they were. It has no notary step.',
    words: ['executed as a deed', 'signed as a deed', 'in the presence of a witness', 'notary public', 'notarised', 'notarized', 'notariell*', 'ante notario', 'devant notaire', 'affidavit', 'statutory declaration', 'deed of gift', 'deed of assignment', 'deed of variation', 'deed of covenant', 'deed poll', 'mortgage deed'],
  },
];

/** What every warning ends with: what the product is, that rules differ, and that nothing is blocked. */
export const PAPER_TAIL = 'GrowSigning makes simple electronic signatures and has no notary step. It can add a witness who states that they saw the signature, and it cannot check that they were there. The rules differ by country and by kind of document, so check before you rely on this one. This is a reminder only: nothing is blocked, and you can send it as it is.';

export type PaperWarning = {
  /** Which kind of document the word points to: will, trust, attorney, land, employment or witness. */
  kind: string;
  /** The word on the list that matched. */
  word: string;
  /** The same word as it stands in the subject or the document: "Befristung" for the list's "befrist". */
  seen: string;
  /** Where it was found. */
  where: 'subject' | 'document name' | 'document text';
  /** The name of the document, when it was found in a document's name or text. */
  document: string | null;
  /** What was seen and what it may mean: 'The subject says "last will", so this may be a will.' */
  found: string;
  /** Why that kind of document is on the list. */
  why: string;
  /** The whole warning for a person to read: what was found, why it matters, and that nothing is blocked. */
  message: string;
  /** Where the help page explains it. A path on this site. */
  help: string;
};

// Text is compared the way the eye reads it: no accents, no capitals. "Kündigung" and "KUNDIGUNG" are one word.
const flat = (s: unknown): string => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');
// Characters nobody sees, which would otherwise cut a word in two: soft hyphen, zero-width space and joiners, BOM.
const INVISIBLE = /[­​-‍⁠﻿]/u;
// The same, keeping for every flattened letter where it stands in the original, so that a warning can quote the
// word exactly as the document has it ("Befristung", "LAST WILL") and not as the list spells it. File names are
// read like words: "_" and "." are spaces, and "PowerOfAttorney" is three words.
function flatWithPlaces(s: unknown): { text: string; src: string; at: number[] } {
  const src = String(s ?? '');
  const at: number[] = [];
  let text = '';
  let before = '';
  for (let i = 0; i < src.length; ) {
    const code = src.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    let f = INVISIBLE.test(ch) ? '' : ch === '_' || ch === '.' ? ' ' : code < 128 ? ch.toLowerCase() : flat(ch);
    if (/\p{Lu}/u.test(ch) && /\p{Ll}/u.test(before)) f = ` ${f}`;
    for (let k = 0; k < f.length; k++) at.push(i);
    text += f;
    if (f) before = ch;
    i += ch.length;
  }
  return { text, src, at };
}
// A letter of a list word as a pattern: an umlaut also matches its written-out form (ü is u or ue).
const letter = (ch: string): string => (/[äöüÄÖÜ]/.test(ch) ? `${flat(ch)}e?` : esc(flat(ch)));
const quote = (p: { src: string; at: number[] }, from: number, length: number): string => {
  const last = p.at[from + length - 1];
  return p.src.slice(p.at[from], last + String.fromCodePoint(p.src.codePointAt(last)!).length).replace(/\s+/g, ' ').trim().slice(0, 80);
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const finder = (word: string): RegExp => {
  const open = word.endsWith('*');
  const core = (open ? word.slice(0, -1) : word).trim().split(/\s+/).map((part) => [...part].map(letter).join('')).join('[\\s\\-\\u2010-\\u2015]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${core}${open ? '[\\p{L}]*' : ''}(?![\\p{L}\\p{N}])`, 'u');
};
const COMPILED = PAPER_KINDS.map((k) => ({
  kind: k,
  words: k.words.map((w) => (typeof w === 'string' ? { word: w } : w)).map((w) => ({ word: w.word.replace(/\*$/, ''), stem: w.word.endsWith('*'), re: finder(w.word), title: !!(w as any).title || !!(w as any).name, name: !!(w as any).name, need: ((w as any).with as string[] | undefined)?.map(flat) })),
}));

/**
 * Every word the check looks for, by kind, for the help page: nobody should have to guess what sets it off. A word
 * that stands for every word beginning that way is printed with three dots after it ("befrist...").
 */
export const paperWordList = (): { a: string; words: string[]; titleOnly: string[]; namesOnly: string[] }[] => {
  const shown = (w: { word: string; stem: boolean }) => (w.stem ? `${w.word}...` : w.word);
  return COMPILED.map(({ kind, words }) => ({ a: kind.a, words: words.filter((w) => !w.title).map(shown), titleOnly: words.filter((w) => w.title && !w.name).map(shown), namesOnly: words.filter((w) => w.name).map(shown) }));
};

const whereText = (w: Pick<PaperWarning, 'where' | 'document'>): string =>
  w.where === 'subject' ? 'The subject' : w.where === 'document name' ? `The name of the document "${w.document}"` : `The text of "${w.document}"`;

/**
 * Looks at what is about to be sent. `documents` carry the name the sender gave each one and, where the server
 * has it, the text read from the file. Returns at most one warning for each kind of document, and for each the
 * first place the word was seen: the subject, then the names, then the text. An empty list means only that none
 * of the words was found.
 */
export function paperWarnings(input: { subject?: string | null; documents?: { name?: string | null; text?: string | null }[] }): PaperWarning[] {
  const docs = (input.documents || []).map((d) => ({ name: String(d.name || 'Document'), title: flatWithPlaces(d.name), body: flatWithPlaces(d.text) }));
  const subject = flatWithPlaces(input.subject);
  const everything = [subject.text, ...docs.flatMap((d) => [d.title.text, d.body.text])].join('\n');
  const places: { where: PaperWarning['where']; document: string | null; in: ReturnType<typeof flatWithPlaces> }[] = [
    { where: 'subject', document: null, in: subject },
    ...docs.map((d) => ({ where: 'document name' as const, document: d.name, in: d.title })),
    ...docs.map((d) => ({ where: 'document text' as const, document: d.name, in: d.body })),
  ];
  const out: PaperWarning[] = [];
  for (const { kind, words } of COMPILED) {
    search: for (const p of places) {
      if (!p.in.text) continue;
      for (const w of words) {
        if (w.title && p.where === 'document text') continue;
        if (w.name && p.where !== 'document name') continue;
        const m = w.re.exec(p.in.text);
        if (!m) continue;
        if (w.need && !w.need.some((stem) => everything.includes(stem))) continue;
        const at = { kind: kind.id, word: w.word, seen: quote(p.in, m.index, m[0].length), where: p.where, document: p.document };
        const found = `${whereText(at)} says "${at.seen}", so this may be ${kind.a}.`;
        out.push({ ...at, found, why: kind.why, message: `${found} ${kind.why} ${PAPER_TAIL}`, help: PAPER_HELP });
        break search;
      }
    }
  }
  return out;
}

/**
 * The same findings as one line for the audit trail, which is printed on the certificate. It states, it does not
 * judge. `told` is whether the answer to sending went to the sender: it does not when a visitor starts a public form.
 */
export const paperAuditNote = (found: PaperWarning[], told = true): string =>
  `${found.map((w) => `${whereText(w)} says "${w.seen}"`).join('. ')}. Documents of this kind often need a handwritten, witnessed, notarised or qualified signature, depending on the country. ${told ? 'The sender was told when sending.' : 'This came through a public form, so nobody was told at that moment.'} Nothing was blocked.`;

// ---- Stamp duty ------------------------------------------------------------------------------------
// Signing does not pay stamp duty. The editor shows this to a sender whose own clock is set to India or Indonesia.
// The server does not, because it does not know where anyone is.
export const STAMP_ZONES: Record<string, 'India' | 'Indonesia'> = {
  'Asia/Kolkata': 'India', 'Asia/Calcutta': 'India',
  'Asia/Jakarta': 'Indonesia', 'Asia/Pontianak': 'Indonesia', 'Asia/Makassar': 'Indonesia', 'Asia/Ujung_Pandang': 'Indonesia', 'Asia/Jayapura': 'Indonesia',
};
export const stampNote = (country: 'India' | 'Indonesia'): string =>
  `Signing here does not pay stamp duty. In ${country} an agreement that should carry a stamp and does not can be refused as evidence. The ${country === 'India' ? 'e-stamp certificate' : 'electronic duty stamp (e-meterai)'} is bought separately, and the stamped page can be added as the first document of the envelope.`;

// ---- Country notes ---------------------------------------------------------------------------------
// Short, dated, with the source each one rests on. `official` says whether the link is to a government or a court,
// or to someone writing about the law: several of these rest on a law firm's or a vendor's summary, because that was
// all the research could reach, and the page says which is which. Change a note only together with its date.
export type CountryNote = { id: string; place: string; text: string; checked: string; sources: { label: string; url: string; official: boolean }[] };
const CHECKED = 'November 2026';
export const COUNTRY_NOTES: CountryNote[] = [
  {
    id: 'eu', place: 'European Union', checked: CHECKED,
    text: 'EU law knows three levels of electronic signature: simple, advanced and qualified. GrowSigning makes the first. The regulation says that an electronic signature cannot be refused as evidence only because it is electronic, and that a qualified one has the same effect as a handwritten signature. It does not say that of a simple one. Each member state decides which documents need written form or a qualified signature, so the answer for your document is in your national law.',
    sources: [
      { label: 'Regulation (EU) No 910/2014 (eIDAS), the EU\'s own text on EUR-Lex; Article 25 is about signatures. It was amended in 2024 by Regulation (EU) 2024/1183, and we have not read the amendment', url: 'https://eur-lex.europa.eu/eli/reg/2014/910/oj', official: true },
      { label: 'Article 25 on legislation.gov.uk, where our research read it. That site shows the text as the United Kingdom kept and changed it after leaving the EU, not the EU\'s own current text', url: 'https://www.legislation.gov.uk/eur/2014/910/article/25', official: false },
    ],
  },
  {
    id: 'de', place: 'Germany', checked: CHECKED,
    text: 'Where a law demands written form, a simple electronic signature like ours does not meet it. The best known case is the fixed term in an employment contract: a labour court in Berlin held a fixed term that was signed electronically without a qualified signature to be invalid, which leaves a job with no end date. Written form means ink on paper or a qualified electronic signature, which GrowSigning does not provide. A notice of termination and a separation agreement need ink on paper.',
    sources: [
      { label: 'Luther, report of the decision of the Berlin Labour Court', url: 'https://www.luther-lawfirm.com/en/newsroom/blog/detail/recent-decision-of-the-berlin-labour-court-electronic-signature-regularly-insufficient-for-fixed-term-employment-contracts', official: false },
      { label: 'Görg, on fixed terms and qualified signatures (May 2024)', url: 'https://www.goerg.de/en/insights/publications/14-05-2024/can-the-section-of-an-employment-contract-agreeing-a-fixed-term-period-be-legally-valid-if-using-a-qualified-electronic-signature-through-docusign', official: false },
    ],
  },
  {
    id: 'uk', place: 'United Kingdom: England and Wales', checked: CHECKED,
    text: 'This note is about England and Wales. Scotland and Northern Ireland have their own law on deeds, wills and land, which our research did not look at. The law of the United Kingdom says an electronic signature can be put before a court as evidence. A deed is different: in England and Wales it needs a witness who is physically present when it is signed. GrowSigning can add a witness who states that they saw the signature, and it cannot check that they were there, so whether a deed witnessed here is accepted depends on whoever it is for. The Law Commission\'s view is that a will cannot be made electronically under the Wills Act 1837 as it stands, and a lasting power of attorney has formal steps of its own: GrowSigning is not made for either. HM Land Registry, which covers England and Wales only, has rules of its own that have changed more than once; its current practice guide says what it accepts.',
    sources: [
      { label: 'Electronic Communications Act 2000, section 7', url: 'https://www.legislation.gov.uk/ukpga/2000/7/section/7', official: true },
      { label: 'HM Land Registry, practice guide 8: execution of deeds', url: 'https://www.gov.uk/government/publications/execution-of-deeds/practice-guide-8-execution-of-deeds', official: true },
    ],
  },
  {
    id: 'in', place: 'India', checked: CHECKED,
    text: 'GrowSigning makes an ordinary electronic signature, not an Aadhaar eSign and not a digital signature certificate. Where a law requires a signature, the Information Technology Act recognises electronic signatures of the kinds it lists, and those two are the usual ones. Where no law demands one, ours can be used, and whoever relies on it may have to prove who signed. The Act also has a list of documents it does not cover. Our research confirmed that wills and trusts are still on it after a 2022 amendment. It did not confirm the rest of that list, which has also named powers of attorney and contracts for the sale of land, so read the current First Schedule. And signing here does not pay stamp duty: an agreement that should be stamped and is not can be refused as evidence. Duty is paid separately, for example with an e-stamp certificate, and the stamped page can be added as the first document of the envelope. Duty differs by state.',
    sources: [
      { label: 'Notification S.O. 4720(E) amending the First Schedule of the Information Technology Act', url: 'https://www.cca.gov.in/sites/files/pdf/ACT/SO4720.pdf', official: true },
      { label: 'Leegality, questions and answers on eSign and e-stamping', url: 'https://www.leegality.com/blog/esign-estamp-faqs', official: false },
    ],
  },
  {
    id: 'id', place: 'Indonesia', checked: CHECKED,
    text: 'Signing here does not pay stamp duty. The tax office sells an electronic duty stamp (e-meterai) for documents that need one, and the stamped page can be added as the first document of the envelope.',
    sources: [{ label: 'Directorate General of Taxes, on the electronic duty stamp', url: 'https://pajak.go.id/en/node/71611', official: true }],
  },
  {
    id: 'za-ke', place: 'South Africa and Kenya', checked: CHECKED,
    text: 'For ordinary commercial contracts a simple electronic signature like ours can be used. Where a statute itself requires a signature, only an advanced electronic signature from an accredited provider counts, or ink on paper. GrowSigning is not such a provider. In South Africa the law on electronic transactions leaves out agreements to sell land, so GrowSigning is not made for a sale of land there; our research did not look at leases. For Kenya it read only a summary of the 2020 amendment, so the current law there is the place to check.',
    sources: [
      { label: 'De Rebus (2012), quoting section 13 of the Electronic Communications and Transactions Act (South Africa)', url: 'https://www.saflii.org/za/journals/DEREBUS/2012/69.html', official: false },
      { label: 'CIPIT, Strathmore University, on the Business Laws (Amendment) Act 2020 (Kenya)', url: 'https://cipit.strathmore.edu/?p=4710', official: false },
    ],
  },
  {
    id: 'sg-ng', place: 'Singapore and Nigeria', checked: CHECKED,
    text: 'Both have a list of documents that their law does not let be signed electronically, and GrowSigning is not made for those. In Singapore the Electronic Transactions Act has named wills, trusts, powers of attorney and contracts for land; our research had the regulator\'s 2019 fact sheet and not the current list, which has changed since, so the current list is the one to read. In Nigeria section 17(2) of the Cybercrimes Act 2015 leaves out wills and birth and death certificates, as reported in the source below; our research heard of a 2024 amendment to that section and did not read it.',
    sources: [
      { label: 'IMDA, fact sheet on the review of the Electronic Transactions Act (Singapore, 2019)', url: 'https://www.imda.gov.sg/-/media/imda/files/about/media-releases/2019/fact-sheet-public-consultation-on-review-of-electronic-transactions-act.pdf', official: true },
      { label: 'Mondaq, on electronic signatures in Nigeria and section 17(2) of the Cybercrimes Act', url: 'https://www.mondaq.com/nigeria/contracts-and-commercial-law/1314284/electronic-signatures-in-nigeria', official: false },
    ],
  },
  {
    id: 'br', place: 'Brazil', checked: CHECKED,
    text: 'The law knows a simple, an advanced and a qualified signature. The qualified one uses an ICP-Brasil certificate, which GrowSigning does not provide. The 2020 law asks for it for transfers and registration of real estate, and many dealings with public bodies ask for it too; later laws changed parts of this, so check the current rule. Other ways of signing may be used between parties who accept them, which is why every signer here is asked to accept the electronic method before signing, and the audit trail records that they did.',
    sources: [
      { label: 'Lei 14.063/2020', url: 'https://planalto.gov.br/ccivil_03/_ato2019-2022/2020/lei/l14063.htm', official: true },
      { label: 'Medida Provisória 2.200-2/2001, article 10', url: 'https://planalto.gov.br/ccivil_03/mpv/Antigas_2001/2200-2.htm', official: true },
    ],
  },
  {
    id: 'au', place: 'Australia', checked: CHECKED,
    text: 'The federal law on electronic transactions has a list of exemptions, and each state and territory has rules of its own that change over time. Wills, some deeds and documents that need a witness are the usual exceptions, and the rules of your state or territory decide. When two officers have to sign for a company, each can sign from their own link.',
    sources: [{ label: 'Attorney-General\'s Department, exemptions from the Electronic Transactions Act', url: 'https://ag.gov.au/legal-system/electronic-signatures-documents-and-transactions/exemptions-eta', official: true }],
  },
  {
    id: 'mx', place: 'Mexico', checked: CHECKED,
    text: 'We do not issue a NOM-151 conservation certificate (constancia de conservación). The SHA-256 fingerprint of the signed PDF is on our certificate, and an accredited provider (PSC) can issue a constancia for that file if you need one.',
    sources: [{ label: 'NOM-151-SCFI-2016, Diario Oficial de la Federación', url: 'https://dof.gob.mx/normasOficiales/6499/seeco11_C/seeco11_C.html', official: true }],
  },
];
