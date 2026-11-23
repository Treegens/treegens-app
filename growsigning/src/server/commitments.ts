// The tree commitments of government contracts and their yearly planting statements (research/government.json, G14
// point 3). The operator fills them in (Review queue, Tree commitments); /impact lists the signed ones, each with its
// statements. A commitment is per contract, never per signature, never conditional on use, and never a gift to the
// body or to anyone in it (TREE_RULES in src/lib/govpricing.ts). A draft is never shown to anyone but the operator.
import { all, get, run } from './db.ts';
import { bad, id, now } from './util.ts';
import { GOV_PRICING } from '../lib/govpricing.ts';
import { dayOf } from '../lib/billingmode.ts';

const line = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
const whole = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === 'number' ? v : /^\s*\d+\s*$/.test(String(v ?? '')) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/** Links to evidence: https only, one per line, at most 20. Anything else is refused with what to change. */
export function evidenceLinks(v: unknown): string[] {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(/\s*\n\s*/)).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) throw bad('Add at least one link to the evidence Treegens provided, such as the geotagged photos or a partner report. Put one link on each line.');
  if (list.length > 20) throw bad('That is more than 20 links. Link to a folder or a report that holds the rest, one link on each line.');
  for (const s of list) {
    let u: URL | null = null;
    try { u = new URL(s); } catch { /* refused below */ }
    if (!u || u.protocol !== 'https:' || s.length > 500) throw bad(`"${s.slice(0, 60)}" is not a web address that starts with https://. Correct it, or remove that line.`);
  }
  return list;
}

export type CommitmentIn = { holder?: unknown; agreement_ref?: unknown; band?: unknown; share_pct?: unknown; trees_per_year?: unknown; starts_on?: unknown; ends_on?: unknown };

function check(b: CommitmentIn) {
  const holder = line(b.holder, 160);
  const ref = line(b.agreement_ref, 80);
  if (!holder) throw bad('Write who holds the contract, as it is named in the contract. Then save again.');
  if (!ref) throw bad('Write the reference of the contract, so the commitment can be checked against it. Then save again.');
  const band = String(b.band ?? '');
  if (!GOV_PRICING.bands.some((x) => x.key === band)) throw bad(`That is not one of the price bands. Choose one of ${GOV_PRICING.bands.map((x) => x.key).join(', ')}.`);
  // Kept to two decimals, so it is checked after rounding: 0.001 would be saved and published as 0%.
  const share = Math.round(Number(b.share_pct) * 100) / 100;
  if (!(share > 0 && share <= 100)) throw bad('The share of the fee that funds planting is a percentage of at least 0.01 and at most 100. Write it as the contract says.');
  const trees = whole(b.trees_per_year, 1, 100_000_000);
  if (trees == null) throw bad('Write the trees a year as a whole number, as the contract says. Then save again.');
  const starts = dayOf(b.starts_on);
  if (!starts) throw bad('Write the first day of the contract as YYYY-MM-DD. Then save again.');
  const ends = b.ends_on == null || b.ends_on === '' ? null : dayOf(b.ends_on);
  if (b.ends_on && !ends) throw bad('Write the last day of the contract as YYYY-MM-DD, or leave it empty. Then save again.');
  if (ends && ends < starts) throw bad('The last day of the contract is before its first day. Correct one of them and save again.');
  return { holder, ref, band, share, trees, starts, ends };
}

export function createCommitment(b: CommitmentIn, by: string) {
  const c = check(b);
  const cid = id('tc');
  run('INSERT INTO tree_commitments (id, holder, agreement_ref, band, share_pct, trees_per_year, starts_on, ends_on, status, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    cid, c.holder, c.ref, c.band, c.share, c.trees, c.starts, c.ends, 'draft', now(), by);
  return commitment(cid);
}

export const commitment = (cid: string) => get('SELECT * FROM tree_commitments WHERE id=?', cid) || null;

/** Mark a draft as a signed contract (it shows on /impact from then on), or back to a draft. */
export function setSigned(cid: string, signed: boolean, signedOn: unknown) {
  const c = commitment(cid);
  if (!c) throw bad('There is no such commitment. Refresh the list and try again.', 404);
  if (signed) {
    const day = dayOf(signedOn);
    if (!day) throw bad('Write the day the contract was signed as YYYY-MM-DD. Only a signed contract is shown on the impact page.');
    if (day > now().slice(0, 10)) throw bad('That day has not come yet. A commitment is shown once its contract has really been signed.');
    run("UPDATE tree_commitments SET status='signed', signed_on=?, updated_at=? WHERE id=?", day, now(), cid);
  } else run("UPDATE tree_commitments SET status='draft', signed_on=NULL, updated_at=? WHERE id=?", now(), cid);
  return commitment(cid);
}

export type StatementIn = { year?: unknown; sites?: unknown; planted_from?: unknown; planted_to?: unknown; species?: unknown; trees?: unknown; evidence?: unknown };

export function addStatement(cid: string, b: StatementIn, by: string) {
  const c = commitment(cid);
  if (!c) throw bad('There is no such commitment. Refresh the list and try again.', 404);
  const thisYear = Number(now().slice(0, 4));
  const year = whole(b.year, 2000, thisYear);
  if (year == null) throw bad(`Write the year the statement covers, from 2000 to ${thisYear}. A year that has not started has nothing planted yet.`);
  const sites = line(b.sites, 1000);
  const species = line(b.species, 500);
  if (!sites) throw bad('Write where the trees were planted, as Treegens reported the sites. Then save again.');
  if (!species) throw bad('Write which species were planted, as Treegens reported them. Then save again.');
  const from = dayOf(b.planted_from);
  const to = dayOf(b.planted_to);
  if (!from || !to) throw bad('Write the first and the last planting day as YYYY-MM-DD. Then save again.');
  if (to < from) throw bad('The last planting day is before the first. Correct one of them and save again.');
  if (to > now().slice(0, 10)) throw bad('The last planting day has not come yet. A statement reports planting that has happened.');
  // A statement is evidence for this contract and this year: its planting falls in the year it is for, and the year
  // falls inside the contract.
  if (from.slice(0, 4) !== String(year) || to.slice(0, 4) !== String(year)) throw bad(`The planting days must fall in ${year}, the year this statement covers. Correct the year or the days and save again.`);
  if (to < c.starts_on || (c.ends_on && from > c.ends_on)) throw bad(`This contract runs from ${c.starts_on}${c.ends_on ? ` to ${c.ends_on}` : ''}, and the planting days are outside it. A statement reports planting under this contract. Correct the days and save again.`);
  const trees = whole(b.trees, 0, 1_000_000_000);
  if (trees == null) throw bad('Write the number of trees planted as a whole number, as Treegens counted them. Then save again.');
  const evidence = evidenceLinks(b.evidence);
  if (get('SELECT 1 x FROM tree_statements WHERE commitment_id=? AND year=?', cid, year)) throw bad(`There is already a statement for ${year}. Each year has one statement; remove it first if it needs to change.`, 409);
  const sid = id('ts');
  run('INSERT INTO tree_statements (id, commitment_id, year, sites, planted_from, planted_to, species, trees, evidence, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    sid, cid, year, sites, from, to, species, trees, evidence.join('\n'), now(), by);
  return statementsOf(cid);
}

export function removeStatement(cid: string, sid: string) {
  if (!run('DELETE FROM tree_statements WHERE id=? AND commitment_id=?', sid, cid).changes) throw bad('There is no such statement. Refresh the list and try again.', 404);
  return statementsOf(cid);
}

const statementsOf = (cid: string) => all('SELECT id, year, sites, planted_from, planted_to, species, trees, evidence FROM tree_statements WHERE commitment_id=? ORDER BY year DESC', cid)
  .map((s: any) => ({ ...s, evidence: String(s.evidence).split('\n').filter(Boolean) }));

/** Everything, drafts too: for the operator only. */
export const allCommitments = () => all('SELECT * FROM tree_commitments ORDER BY created_at DESC').map((c: any) => ({ ...c, statements: statementsOf(c.id) }));

/** What /impact shows: signed contracts only, and of them only what the public may read. */
export const publicCommitments = () => all("SELECT id, holder, agreement_ref, band, share_pct, trees_per_year, starts_on, ends_on, signed_on FROM tree_commitments WHERE status='signed' ORDER BY signed_on DESC, id")
  .map((c: any) => ({ ...c, statements: statementsOf(c.id).map(({ id: _id, ...s }: any) => s) }));
