// The signing page made simpler (research/ux-charter.md 2.6 and quick wins 10 to 12, with the corrections in
// research/ux.json "ux:check"). Plain functions with no React in them, so tests/simplify-signing.test.ts reads them
// as they are, and the page (src/app/sign/[token]/page.tsx) only asks them.
//
//   - Other actions: one fixed list in one fixed order, no descriptions, never more than six entries.
//   - Finish: signs at once, unless something needs another look first. Then "Check before you finish" opens with it.
//   - Next: goes to the field and opens it when a tap would only have opened a dialog anyway.

// ---- Other actions -------------------------------------------------------------------------------------------------

/**
 * The order is fixed so two screens never show two different menus: Finish later, Ask for more time, Pass to someone
 * else (or Hand back to the group), Questions and comments, Sign on paper instead (when the sender allows it), and
 * Decline, always last. Help is not in the list: it is one button in the top bar, for everyone but a witness.
 */
export const ACTION_ORDER = ['later', 'time', 'handback', 'reassign', 'ask', 'paper', 'decline'] as const;
/** A witness signs nothing for themselves and closes nothing for others: their own short list. */
export const WITNESS_ACTIONS = ['absent', 'ask', 'help'] as const;
export const MAX_ACTIONS = 6;
export type ActionKey = (typeof ACTION_ORDER)[number] | (typeof WITNESS_ACTIONS)[number];

export type Signer = { role: string; group?: { can_hand_back?: boolean; name?: string } | null };

/**
 * The entries of Other actions that apply, in their order. `stage` is the screen ('consent' or 'sign'), `deadline`
 * whether the document has one, `paper` whether "Sign on paper instead" applies: for now when the account has its own
 * consent text, whose one choice is to ask the sender to send it by post (src/components/sign/Withdraw.tsx).
 */
export function otherActions(me: Signer, o: { stage: string; deadline: boolean; paper?: boolean }): ActionKey[] {
  if (me.role === 'witness') return [...WITNESS_ACTIONS];
  const on: Record<string, boolean> = {
    // Also on the consent screen, where someone who cannot sign today actually is.
    later: (o.stage === 'consent' || o.stage === 'sign') && me.role !== 'cc',
    time: o.deadline && me.role !== 'cc',
    // The one who took on a group's document hands it back to the group, and passes it to nobody outside it.
    handback: !!me.group?.can_hand_back,
    reassign: (me.role === 'signer' || me.role === 'approver') && !me.group,
    ask: true,
    // Asking for paper stops this person's part, so only someone who has a part to stop gets it (askForPaper).
    // Nor someone who changes the document or chooses who comes next: they sign nothing (src/lib/recipienttypes.ts).
    paper: !!o.paper && me.role !== 'viewer' && me.role !== 'cc' && me.role !== 'editor' && me.role !== 'agent',
    decline: me.role !== 'viewer' && me.role !== 'cc',
  };
  const keys: ActionKey[] = ACTION_ORDER.filter((k) => on[k]);
  // Never more than six. Decline stays, and stays last: what goes is from the middle.
  while (keys.length > MAX_ACTIONS) keys.splice(keys.length - 2, 1);
  return keys;
}

/**
 * The entries of `keys` that the sender's switches leave (src/lib/switches.ts, the signing page's "switches"): pass_on
 * false takes Pass to someone else away, comments false takes Questions and comments away (also a witness's). Nothing
 * on the page says so; Help's built-in answer does (chatscreens.ts). Left out, both are on, as before the switches.
 */
export const bySwitches = (keys: ActionKey[], sw?: { pass_on?: boolean; comments?: boolean } | null): ActionKey[] =>
  keys.filter((k) => !(k === 'reassign' && sw?.pass_on === false) && !(k === 'ask' && sw?.comments === false));

// ---- Finish --------------------------------------------------------------------------------------------------------

/** Why "Check before you finish" opens when Finish is pressed. None: Finish signs and sends at once. */
export type LookAgain = 'question' | 'witness' | 'name' | 'print' | 'problem';

/** Letters only, in one case and one spacing, so "Ada  sponsor" and "Ada Sponsor" are the same name. */
const plainName = (s: string) => String(s || '').normalize('NFKC').toLocaleLowerCase('en').replace(/[\s.\-'’]+/g, ' ').trim();

/** True when the name typed for the signature is not the name the document gives this person: a name to fix, maybe. */
export const nameDiffers = (typed: string | null | undefined, name: string | null | undefined): boolean =>
  !!typed && !!plainName(typed) && plainName(typed) !== plainName(name || '');

/**
 * What needs another look before Finish signs: an unanswered question of theirs, a witness to name, a typed signature
 * that reads as another name than the one on the document, characters the signed PDF cannot print, or a Finish that
 * did not get through. The order is the order they are mentioned in.
 */
export function lookAgain(o: {
  questions: number;
  witness?: { may_name?: boolean; name?: string | null; state?: string } | null;
  typedName?: string | null;
  name: string;
  cannotPrint?: number;
  problem?: string;
}): LookAgain[] {
  const w = o.witness;
  return [
    o.questions > 0 && 'question',
    !!w && !!w.may_name && (!w.name || w.state === 'absent') && 'witness',
    nameDiffers(o.typedName, o.name) && 'name',
    (o.cannotPrint || 0) > 0 && 'print',
    !!o.problem && 'problem',
  ].filter(Boolean) as LookAgain[];
}

// ---- Next ----------------------------------------------------------------------------------------------------------

/**
 * Whether Next opens the field itself, and not only goes to it: a signature, initials or a stamp that still has to be
 * made. A signature that was made in this tab already goes on with a tap of its own, never by Next alone.
 */
export const nextOpens = (f: { type: string }, filled: boolean, markReady: boolean): boolean =>
  !filled && ((f.type === 'signature' || f.type === 'initials') ? !markReady : f.type === 'stamp');

// ---- Words -------------------------------------------------------------------------------------------------------

/**
 * "Finish later" on the consent screen, where nothing was typed yet. On the document the words are laterWords
 * (src/lib/bysender.ts). Someone whose link the sender passes on has no email from us to go back to.
 */
export const laterAtConsent = (bySender: boolean): string =>
  bySender ? 'Nothing is lost. Open this same link again when you are ready.' : 'Nothing is lost. Use the link in your email when you are ready.';

/** The guide above the document, in one short sentence. */
export const GUIDE_NEXT = 'Choose Next to go to each place that needs you.';
export const GUIDE_FINISH = 'Everything needed is filled in. Choose Finish to sign and send it.';

// ---- The "Sign here" pointer ---------------------------------------------------------------------------------------

/**
 * Room kept clear around the printed words of the page when the pointer is placed (placeFlag in fields.ts), in CSS
 * pixels: 18 across, so it never stands right beside a label on the same line, and 3 up and down.
 */
export const FLAG_MARGIN = { x: 18, y: 3 };

// ---- The consent screen --------------------------------------------------------------------------------------------

/** The most words the consent screen holds before its tick, with every option on (research/ux-charter.md, P7). */
export const CONSENT_WORDS = 120;
/** Words the way tests/ux/flows.cjs counts them: anything between spaces that holds a letter or a digit. */
export const wordsIn = (text: string): number => String(text || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** "Finish later" for someone who was only asked to read: there is nothing for them to finish. */
export const laterLabel = (role: string): string => (role === 'viewer' ? 'Read it later' : 'Finish later');

/**
 * The title of the step that opens at Finish, by the first thing that needs a look, so it says why it came.
 * "Check before you finish" is left for a Finish that did not get through, or a check that could not be made.
 */
export const reviewTitle = (why: LookAgain[], approving = false): string =>
  why[0] === 'name' ? 'Check your name' : why[0] === 'question' ? 'One question is not answered' : why[0] === 'witness' ? 'Name your witness'
    : why[0] === 'print' ? 'Some characters cannot be printed' : approving ? 'Approve this document' : 'Check before you finish';

// ---- The Done screen -----------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many: string, digits = 0) => `${n.toLocaleString('en', { maximumFractionDigits: digits })} ${n === 1 ? one : many}`;

/**
 * "Signed without paper", in words that are true for one sheet too: "About 1 sheet of paper and 10 litres of water
 * were not used." A figure that rounds to nothing is left out (never "0 kg of CO2e"), and the share of a tree is
 * said only from a hundredth of a tree up.
 */
export function savedLine(impact: { sheets: number; litresWater?: number; kgCo2?: number; trees?: number }): { sheets: string; rest: string; verb: string; trees: boolean } {
  const water = Math.round(Number(impact.litresWater) || 0);
  const co2 = Math.round((Number(impact.kgCo2) || 0) * 100) / 100;
  const more = [water > 0 ? plural(water, 'litre of water', 'litres of water') : '', co2 > 0 ? `${co2.toLocaleString('en', { maximumFractionDigits: 2 })} kg of CO2e` : ''].filter(Boolean);
  const sheets = Math.round(Number(impact.sheets) || 0);
  return {
    sheets: plural(sheets, 'sheet of paper', 'sheets of paper'),
    rest: more.length === 2 ? `, ${more[0]} and ${more[1]}` : more.length ? ` and ${more[0]}` : '',
    verb: sheets === 1 && !more.length ? 'was' : 'were',
    trees: (Number(impact.trees) || 0) >= 0.01,
  };
}
