// The one list of every certification, accreditation, listing and legal status a public buyer may ask about, and the
// only sentence any page may print about each one (claimText). /security/certifications is built from this list and
// from nothing else, and tests/gov-g01.test.ts fails when a page says something about one of these names that this
// list does not say.
//
// THE RULE. Read it before changing a status.
//   - Every entry starts as 'not_held'.
//   - Only the owner may set an entry to 'held', and only with the link to the official registry or listing, which
//     the owner has opened and read, the number, the scope, the dates, and who checked it and when. An entry marked
//     'held' with any of these missing, with a date that cannot be read, or past its expiry date reads as not held.
//   - No entry is 'in_progress' unless the owner has signed an engagement with the body that assesses it. "We plan
//     to" is not in progress. An entry marked 'in_progress' without the assessor's name and the date of the
//     engagement reads as not held.
//   - A page never writes its own sentence about one of these. It prints claimText(id), or it explains what a law or
//     a standard asks for without saying anything about us.
//
// What the list is about: GrowSigning, the software and the service its makers run. Someone who runs their own copy
// of the software may hold certificates of their own; this list says nothing about them, and the page says so.
//
// No dependencies, no environment: pages, server code and tests can all import it.
import { dayText } from './dates.ts';

export type ClaimStatus = 'not_held' | 'in_progress' | 'held';

/** What must be written down before an entry may read as held. */
export type Held = {
  /** The official registry or listing where anyone can check it. https only. */
  registry_url: string;
  /** The certificate, report or listing number as the registry shows it. */
  number: string;
  /** What it covers, in the words of the certificate. */
  scope: string;
  /** YYYY-MM-DD */
  issued: string;
  /** YYYY-MM-DD. From the day after, the entry reads as not held. */
  expires: string;
  /** Who opened the registry link and compared it with this entry. */
  checked_by: string;
  /** YYYY-MM-DD */
  checked_on: string;
};

/** What must be written down before an entry may read as in progress. */
export type Engaged = {
  /** The body that assesses it, as named on the signed engagement. */
  assessor: string;
  /** YYYY-MM-DD, the day the owner signed the engagement. */
  engaged_on: string;
};

export type Claim = {
  id: string;
  /** The name as a buyer writes it. */
  name: string;
  /** One plain line on what it is and who asks for it. It explains; it says nothing about us. */
  what: string;
  /** The whole sentence while it is not held. */
  no: string;
  /** The thing itself, as it stands after "GrowSigning holds" or "is working towards": "an ISO/IEC 27001 certificate". */
  thing: string;
  group: 'security' | 'government' | 'signatures' | 'accessibility' | 'other';
  status: ClaimStatus;
  held?: Held;
  engaged?: Engaged;
};

const cert = (id: string, name: string, thing: string, what: string, group: Claim['group'], no = `GrowSigning does not hold ${thing}.`): Claim =>
  ({ id, name, thing, what, no, group, status: 'not_held' });

export const CLAIM_GROUPS: [Claim['group'], string][] = [
  ['security', 'Security standards'],
  ['government', 'Government cloud programmes'],
  ['signatures', 'Signatures, seals and trust services'],
  ['accessibility', 'Accessibility'],
  ['other', 'Other'],
];

export const CLAIMS: Claim[] = [
  cert('iso-27001', 'ISO/IEC 27001', 'an ISO/IEC 27001 certificate', 'The international standard for how an organisation manages information security, checked by an outside auditor.', 'security'),
  cert('iso-27017', 'ISO/IEC 27017', 'an ISO/IEC 27017 certificate', 'Security controls for cloud services, added to ISO/IEC 27001.', 'security'),
  cert('iso-27018', 'ISO/IEC 27018', 'an ISO/IEC 27018 certificate', 'Protection of personal data in public clouds, added to ISO/IEC 27001.', 'security'),
  cert('iso-27701', 'ISO/IEC 27701', 'an ISO/IEC 27701 certificate', 'A privacy management system, added to ISO/IEC 27001.', 'security'),
  cert('soc2-type2', 'SOC 2 Type II', 'a SOC 2 Type II report', 'A report by an outside auditor on how a service kept to its security controls over several months. Common in the United States.', 'security', 'GrowSigning has no SOC 2 report, of Type I or of Type II.'),
  cert('cyber-essentials-plus', 'Cyber Essentials Plus', 'a Cyber Essentials Plus certificate', 'The United Kingdom scheme of basic security controls, tested by an assessor.', 'security', 'GrowSigning does not hold a Cyber Essentials or a Cyber Essentials Plus certificate.'),
  cert('fips-140-3', 'FIPS 140-3 validated module', 'a FIPS 140-3 validation for its cryptography', 'A United States and Canadian validation of the cryptographic module a product uses.', 'security', 'GrowSigning does not use a cryptographic module validated under FIPS 140-3, and has no FIPS mode.'),

  cert('fedramp-moderate', 'FedRAMP Moderate', 'a FedRAMP Moderate authorization', 'The United States federal programme that authorizes cloud services for government data of moderate sensitivity.', 'government', 'GrowSigning is not FedRAMP authorized at the Moderate level, and is not listed on the FedRAMP Marketplace.'),
  cert('fedramp-high', 'FedRAMP High', 'a FedRAMP High authorization', 'The same programme, for the most sensitive unclassified federal data.', 'government', 'GrowSigning is not FedRAMP authorized at the High level.'),
  cert('dod-il4', 'DoD Impact Level 4', 'a DoD Impact Level 4 provisional authorization', 'The United States Department of Defense level for controlled unclassified information in a cloud.', 'government', 'GrowSigning has no DoD Impact Level 4 authorization.'),
  cert('dod-il5', 'DoD Impact Level 5', 'a DoD Impact Level 5 provisional authorization', 'The Department of Defense level above it, for more sensitive unclassified information.', 'government', 'GrowSigning has no DoD Impact Level 5 authorization.'),
  cert('govramp', 'GovRAMP (formerly StateRAMP)', 'a GovRAMP authorization', 'The programme many United States state and local governments use to authorize cloud services.', 'government', 'GrowSigning is not GovRAMP (StateRAMP) authorized.'),
  cert('bsi-c5', 'BSI C5', 'a BSI C5 attestation', 'The German federal catalogue of cloud security criteria, attested by an auditor.', 'government', 'GrowSigning has no BSI C5 attestation.'),
  cert('ens', 'ENS (Esquema Nacional de Seguridad)', 'an ENS certificate', 'The Spanish national security scheme for systems used by public bodies.', 'government'),
  cert('acn-qc', 'ACN qualification (QC1 to QC4)', 'an ACN qualification', 'The Italian national cybersecurity agency\'s qualification of cloud services for public bodies.', 'government', 'GrowSigning has no ACN qualification for cloud services.'),
  cert('secnumcloud', 'SecNumCloud', 'a SecNumCloud qualification', 'The French security agency\'s qualification for trusted cloud providers.', 'government', 'GrowSigning has no SecNumCloud qualification.'),
  cert('ismap', 'ISMAP', 'an ISMAP registration', 'The Japanese government\'s register of assessed cloud services.', 'government', 'GrowSigning is not registered under ISMAP.'),
  cert('csap', 'CSAP', 'a CSAP certificate', 'The South Korean security assurance programme for cloud services used by public bodies.', 'government'),
  cert('irap', 'IRAP assessment', 'an IRAP assessment', 'An assessment by a registered assessor against the Australian government\'s security manual.', 'government', 'GrowSigning has not been assessed under IRAP.'),
  cert('cccs-pbmm', 'CCCS Medium (Protected B, Medium Integrity, Medium Availability)', 'a CCCS Medium assessment', 'The Canadian Centre for Cyber Security\'s assessment of cloud services for Protected B information.', 'government', 'GrowSigning has not been assessed by the Canadian Centre for Cyber Security for Protected B information.'),
  cert('g-cloud', 'G-Cloud listing', 'a G-Cloud listing', 'The United Kingdom framework through which public bodies buy cloud services.', 'government', 'GrowSigning is not listed on the G-Cloud framework.'),

  cert('eidas-qtsp', 'eIDAS qualified trust service provider', 'the status of a qualified trust service provider under eIDAS', 'A provider that a European Union member state has approved to issue qualified certificates, seals or time stamps. The approved ones are on the EU Trusted List.', 'signatures', 'GrowSigning is not a qualified trust service provider under eIDAS, and is not on the EU Trusted List.'),
  cert('qes', 'Qualified electronic signature (QES)', 'the means to make qualified electronic signatures', 'The level of electronic signature that European Union law gives the same effect as a handwritten one. It needs a qualified certificate and an approved signing device.', 'signatures', 'GrowSigning does not make qualified electronic signatures, and does not make advanced ones. It makes simple electronic signatures.'),
  cert('qualified-seal', 'Qualified electronic seal', 'the means to make qualified electronic seals', 'The seal of an organisation, made with a qualified certificate.', 'signatures', 'GrowSigning does not make qualified electronic seals. The digital seal a server can put on a completed PDF is made with the certificate of whoever runs that server, and is not a qualified or an advanced seal.'),
  cert('cca-esp', 'CCA eSign Service Provider (India)', 'a licence as an eSign Service Provider', 'A provider licensed by India\'s Controller of Certifying Authorities to offer Aadhaar eSign.', 'signatures', 'GrowSigning is not an eSign Service Provider licensed by India\'s Controller of Certifying Authorities.'),
  cert('icp-brasil', 'ICP-Brasil', 'ICP-Brasil accreditation', 'Brazil\'s public key infrastructure. Its certificates are what a qualified signature in Brazil is made with.', 'signatures', 'GrowSigning is not part of ICP-Brasil and does not issue or use ICP-Brasil certificates.'),

  cert('wcag-audit', 'Third-party WCAG 2.2 AA or EN 301 549 audit', 'an accessibility audit by a third party', 'A check by an outside expert that the screens meet the accessibility guidelines public bodies must buy to.', 'accessibility', 'No third party has audited GrowSigning against WCAG 2.2 AA or EN 301 549.'),
  cert('section-508-acr', 'Section 508 Accessibility Conformance Report (VPAT)', 'a published Accessibility Conformance Report', 'The report, written on the VPAT template, that United States federal buyers ask for.', 'accessibility', 'GrowSigning has only a draft Accessibility Conformance Report on the VPAT template, written and self-assessed by its authors and not audited by anyone.'),

  cert('hipaa-baa', 'HIPAA business associate agreement', 'a HIPAA business associate agreement to offer', 'The agreement United States law asks a healthcare provider to have with every service that handles patient information.', 'other', 'There is no HIPAA business associate agreement for GrowSigning. Nobody can sign one with us, on any plan.'),
  cert('dpg-registry', 'Digital Public Goods registry', 'a listing in the Digital Public Goods registry', 'The register of open software that the Digital Public Goods Alliance has reviewed against its standard.', 'other', 'GrowSigning is not listed in the Digital Public Goods registry.'),
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (s: unknown): string | null => {
  const v = String(s ?? '').trim();
  return DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? v : null;
};
const said = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const today = (now: Date) => now.toISOString().slice(0, 10);

/** Why an entry marked 'held' or 'in_progress' does not read as such. Empty when it does, or when it is 'not_held'. */
export function claimProblems(c: Claim, now: Date = new Date()): string[] {
  const out: string[] = [];
  if (c.status === 'held') {
    const h = c.held;
    if (!h) return ['Marked held, with nothing written down to check it by.'];
    if (!/^https:\/\/[^\s/]+\.[^\s/]+/i.test(said(h.registry_url))) out.push('The registry link is missing or is not an https address.');
    if (!said(h.number)) out.push('The certificate or listing number is missing.');
    if (!said(h.scope)) out.push('The scope is missing.');
    if (!day(h.issued)) out.push('The date of issue is missing or is not written YYYY-MM-DD.');
    if (!day(h.expires)) out.push('The expiry date is missing or is not written YYYY-MM-DD.');
    if (!said(h.checked_by) || !day(h.checked_on)) out.push('Who checked the registry, and on which day, is missing.');
    if (day(h.issued) && day(h.issued)! > today(now)) out.push('The date of issue is in the future.');
    if (day(h.checked_on) && day(h.checked_on)! > today(now)) out.push('The day it was checked is in the future.');
    if (day(h.issued) && day(h.expires) && h.expires < h.issued) out.push('It expires before it was issued.');
    if (day(h.expires) && day(h.expires)! < today(now)) out.push(`It expired on ${dayText(h.expires)}.`);
  } else if (c.status === 'in_progress') {
    if (!said(c.engaged?.assessor)) out.push('The assessor is not named.');
    if (!day(c.engaged?.engaged_on) || day(c.engaged?.engaged_on)! > today(now)) out.push('The day the engagement was signed is missing, cannot be read or is in the future.');
  }
  return out;
}

export function claimById(id: string, list: Claim[] = CLAIMS): Claim {
  const c = list.find((x) => x.id === id);
  if (!c) throw new Error(`There is no claim "${id}" in src/lib/claims.ts.`);
  return c;
}

/** The status a page goes by: what is written, unless what must stand behind it is missing or out of date. */
export function claimStatus(c: Claim, now: Date = new Date()): ClaimStatus {
  return c.status !== 'not_held' && claimProblems(c, now).length === 0 ? c.status : 'not_held';
}

/** The only sentence any page may print about an entry. */
export function claimSentence(c: Claim, now: Date = new Date()): string {
  const s = claimStatus(c, now);
  if (s === 'held') {
    const h = c.held!;
    return `GrowSigning holds ${c.thing}: number ${said(h.number)}, for ${said(h.scope).replace(/\.$/, '')}, issued ${dayText(h.issued)} and running until ${dayText(h.expires)}. Check it yourself at ${said(h.registry_url)}`;
  }
  if (s === 'in_progress') return `${c.no} ${said(c.engaged!.assessor)} was engaged on ${dayText(c.engaged!.engaged_on)} to assess it. Until that is done, it is not held.`;
  return c.no;
}

export const claimText = (id: string, now: Date = new Date()): string => claimSentence(claimById(id), now);

/** True when no entry reads as held: the line /security prints then. */
export const noneHeld = (now: Date = new Date(), list: Claim[] = CLAIMS): boolean => list.every((c) => claimStatus(c, now) !== 'held');

/** The short point on /security. It quotes the registry and never says more than it. */
export function claimsSummary(now: Date = new Date(), list: Claim[] = CLAIMS): string {
  const held = list.filter((c) => claimStatus(c, now) === 'held');
  if (!held.length) return `GrowSigning holds none of the ${list.length} certifications, authorizations and listings that public buyers most often ask about. ${claimSentence(claimById('iso-27001', list), now)} ${claimSentence(claimById('soc2-type2', list), now)}`;
  return `Of the ${list.length} certifications, authorizations and listings that public buyers most often ask about, GrowSigning holds ${held.length}: ${held.map((c) => c.name).join(', ')}. It holds none of the others.`;
}

/** Where the list is shown. */
export const CLAIMS_PAGE = '/security/certifications';
