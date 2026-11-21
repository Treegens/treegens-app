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
 * Decline, always last. Help is the dialog's own second button, under the list, for everyone but a witness.
 */
export const ACTION_ORDER = ['later', 'time', 'handback', 'reassign', 'ask', 'paper', 'decline'] as const;
/** A witness signs nothing for themselves and closes nothing for others: their own short list. */
export const WITNESS_ACTIONS = ['absent', 'ask', 'help'] as const;
export const MAX_ACTIONS = 6;
export type ActionKey = (typeof ACTION_ORDER)[number] | (typeof WITNESS_ACTIONS)[number];

export type Signer = { role: string; group?: { can_hand_back?: boolean; name?: string } | null };

/**
 * The entries of Other actions that apply, in their order. `stage` is the screen ('consent' or 'sign'), `deadline`
 * whether the document has one, `paper` whether the sender allows signing on paper (not built yet: always false).
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
    paper: !!o.paper,
    decline: me.role !== 'viewer' && me.role !== 'cc',
  };
  const keys: ActionKey[] = ACTION_ORDER.filter((k) => on[k]);
  // Never more than six. Decline stays, and stays last: what goes is from the middle.
  while (keys.length > MAX_ACTIONS) keys.splice(keys.length - 2, 1);
  return keys;
}

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
