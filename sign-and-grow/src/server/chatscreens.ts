// What a signer and a sender most often ask the help chat, answered with the control that is on the screen they are
// on, by the label it has there (src/server/chatkb.ts adds these to its frequent questions, so the built-in answers
// and the model's instructions both have them).
//
// Why this file: someone on the signing page who typed "I cannot sign this today. What can I do?" was told the helper
// could not find that, while Finish later and Ask for more time were one tap away on that very page
// (research/ux.json, flow f-signer-help). The answers here name controls, so they must not drift from the screens:
// the entries of Other actions are typed against the page's own list (src/components/sign/actions.ts), so a new entry
// there does not compile until it has its words here, and tests/chat.test.ts reads every label named below out of
// the source of the page that shows it.
import { ACTION_ORDER } from '../components/sign/actions.ts';
import { BULK_COST_NOTE } from '../lib/policy.ts';
import type { ChatScreen } from '../lib/chat.ts';

export type Faq = { id: string; words: string[]; answer: (screen?: ChatScreen) => string };

// ---- The signing page ------------------------------------------------------------------------------------------
/**
 * Other actions on the signing page: each entry as the page labels it, and when it is there. Null: the page has the
 * key but shows it to nobody yet, so the helper never names it. The page puts the sender's name where "the sender" is.
 */
export const SIGN_ACTIONS: Record<(typeof ACTION_ORDER)[number], { label: string; when: string } | null> = {
  later: { label: 'Finish later', when: 'always, also on the first screen before agreeing' },
  time: { label: 'Ask the sender for more time', when: 'only when the document has a deadline; the page shows the sender\'s name in it' },
  handback: { label: 'Hand back to the group', when: 'only for someone who took on a document that was sent to a group' },
  reassign: { label: 'Pass to someone else', when: 'for a signer or an approver, unless the document went to a group' },
  ask: { label: 'Questions and comments', when: 'always' },
  paper: null,
  decline: { label: 'Decline to sign', when: 'for everyone who signs or approves; always the last entry' },
};
/** Labels on the signing page that are not entries of Other actions. */
export const SIGN_LABELS = { menu: 'Other actions', next: 'Next', finish: 'Finish', report: 'Report this request', textView: 'Text view', download: 'Download', stopReminders: 'Stop reminder emails', fixName: 'Fix my name', check: 'Check before you finish' } as const;
/** Labels in the app, for people who send. `where` is the source file each one is read from in the tests. */
export const APP_LABELS = {
  start: { label: 'Send for signature', where: 'src/app/app/page.tsx' },
  envelopes: { label: 'Envelopes', where: 'src/components/AppShell.tsx' },
  templates: { label: 'Templates', where: 'src/components/AppShell.tsx' },
  bulk: { label: 'Bulk send', where: 'src/components/AppShell.tsx' },
  settings: { label: 'Settings', where: 'src/components/AppShell.tsx' },
  remind: { label: 'Send reminder', where: 'src/app/app/envelopes/[id]/page.tsx' },
  moreTime: { label: 'Give more time', where: 'src/app/app/envelopes/[id]/page.tsx' },
  void: { label: 'Void', where: 'src/app/app/envelopes/[id]/page.tsx' },
  download: { label: 'Download with certificate', where: 'src/app/app/envelopes/[id]/page.tsx' },
  saveTemplate: { label: 'Save as template', where: 'src/app/app/envelopes/[id]/page.tsx' },
  copyLink: { label: 'Copy link', where: 'src/components/sender/Recipients.tsx' },
  addMyself: { label: 'Add myself', where: 'src/components/editor/StepAdd.tsx' },
  order: { label: 'Set signing order', where: 'src/components/editor/StepAdd.tsx' },
  newTemplate: { label: 'New template', where: 'src/app/app/templates/page.tsx' },
  profile: { label: 'Profile', where: 'src/app/app/settings/page.tsx' },
  notifications: { label: 'Notifications', where: 'src/app/app/settings/page.tsx' },
  team: { label: 'Team', where: 'src/app/app/settings/page.tsx' },
  inviteByEmail: { label: 'Invite by email', where: 'src/app/app/settings/page.tsx' },
} as const;

const S = SIGN_ACTIONS, L = SIGN_LABELS, A = APP_LABELS;
const signing = (s?: ChatScreen) => s === 'signing';
/** True on the screens of someone who is signed in to an account. */
export const sending = (s?: ChatScreen) => s === 'app' || s === 'editor' || s === 'plan';
/** How to get to Other actions from where the person is. */
const other = (s?: ChatScreen) => (signing(s) ? `On this page, choose ${L.menu}` : `Open your signing link. On the signing page, choose ${L.menu}`);
/** How to get to a page of the app from where the person is. */
const inApp = (s: ChatScreen | undefined, page: string) => (sending(s) ? `Open ${page}` : `Log in and open ${page}`);

/** Where a signer corrects the spelling of their own name. The check opens at Finish when the typed name differs. */
export const nameFix = (): string =>
  `Type your name the right way when you make your signature, then press ${L.finish}. "${L.check}" opens and shows your name with "Not spelled right? ${L.fixName}".`;

/** For "more time", asked by someone who signs: on the signing page the two controls, elsewhere how to get to them. */
export const moreTimeForSigner = (s?: ChatScreen): string =>
  signing(s)
    ? `${other(s)}. If the document has a deadline, "${S.time!.label}" is there, with the sender's name in it: the sender decides, and when they agree this same link works again. If you only need to stop for now, ${S.later!.label} in the same list saves what you filled in. If the deadline has already passed, the page offers the button to ask for more time by itself.`
    : `Open your link anyway. If the deadline has passed, the page has a button that asks the sender for more time, and before the deadline it is under ${L.menu} on the signing page. Only the sender can reopen it. When they do, the same link works again and anyone who already signed does not sign again.`;
/** For "more time", asked by someone who sends. */
export const moreTimeForSender = (s?: ChatScreen): string =>
  `${inApp(s, A.envelopes.label)}, choose the envelope, then ${A.moreTime.label}. It also reopens an envelope whose deadline has passed: the same links work again and nobody who signed signs again. The deadline for a new envelope is set in the editor's first step, under Deadline. When a signer asks for more time, you get an email and decide.`;

// ---- What someone who signs asks ---------------------------------------------------------------------------------
export const SIGNER_FAQ: Faq[] = [
  { id: 'later', words: ['cannot sign', "can't sign", 'can not sign', 'unable to sign', 'sign later', 'sign it later', 'sign this later', 'finish later', 'sign this today', 'sign today', 'not today', 'sign tomorrow', 'come back later', 'not now', 'no time', 'not ready', 'do it later', 'save and', 'pause'],
    answer: (s) => `${other(s)}, then ${S.later!.label}. What you filled in is saved, and the same link brings you back when you are ready, on any device. If the document has a deadline, the same list has "${S.time!.label}" (the page shows the sender's name): the sender decides. If you cannot sign because something on the page does not work, say what you see, or choose Talk to a person.` },
  { id: 'decline', words: ['decline', 'do not want to sign', "don't want to sign", 'not want to sign', 'refuse to sign', 'not going to sign', 'say no', 'will not sign', "won't sign", 'disagree'],
    answer: (s) => `You do not have to sign. ${other(s)}, then ${S.decline!.label}, and add a short reason. Declining closes the document for everyone, and the sender is told why. If you only have a question, choose ${S.ask!.label} instead and nothing is closed. If the request is not meant for you or looks wrong, choose ${L.report} on the signing page.` },
  { id: 'pass', words: ['someone else', 'wrong person', 'not for me', 'not meant for me', 'pass it', 'pass this', 'forward', 'reassign', 'another person', 'instead of me', 'right person', 'my boss', 'my manager', 'my colleague', 'delegate'],
    answer: (s) => `${other(s)}, then ${S.reassign!.label}, and give their name and email address. They get their own link by email, yours stops working, and the sender is told. Someone who took on a document that was sent to a group sees ${S.handback!.label} instead. If neither is there, choose ${S.ask!.label} and ask the sender to change the person.` },
  { id: 'ask-sender', words: ['question for the sender', 'ask the sender', 'contact the sender', 'tell the sender', 'write to the sender', 'comment', 'do not understand', "don't understand", 'not understand', 'unclear', 'wrong in the document', 'mistake in the document', 'error in the document', 'change the document', 'wrong amount', 'wrong date', 'contract is wrong', 'document is wrong', 'agreement is wrong', 'what does this mean'],
    answer: (s) => `${other(s)}, then ${S.ask!.label}. What you write goes to the sender, and their answer appears in the same place. You do not have to sign while you wait: ${S.later!.label} keeps your place. The helper cannot see your document and cannot say what it means.` },
  { id: 'paper', words: ['on paper', 'paper copy', ' print', 'by hand', 'handwritten', 'wet ink', 'with a pen'],
    answer: (s) => `GrowSigning has no button for signing on paper. You can ask the sender for a paper copy: ${other(s).replace(/^O/, 'o')}, then ${S.ask!.label}, and say so. To read it on paper first, the same list has ${L.download}, and you can print the file. A copy signed on paper is between you and the sender: GrowSigning keeps no record of it.` },
  { id: 'how-sign', words: ['where do i sign', 'how do i sign', 'how to sign', 'how can i sign', ' draw', 'type my signature', 'my signature', 'change my signature', 'next button', 'start signing', 'initials'],
    answer: () => `On the signing page, tick the box to agree, then press ${L.next}: it takes you to each field in turn. At a signature field you choose Type, Draw or Upload to make your signature; to change it later, tap the signature itself. When every field is done, ${L.next} turns into ${L.finish}. Nothing is signed until you press ${L.finish}.` },
  { id: 'finish-stuck', words: ['finish button', 'cannot finish', "can't finish", 'can not finish', 'finish does not', "finish doesn't", 'will not let me', "won't let me", 'required field', 'greyed', 'grayed', 'nothing happens', 'stuck', 'button does not', "button doesn't", 'cannot fill', "can't fill", 'cannot type', "can't type"],
    answer: (s) => `${L.finish} works once every required field is filled in. Press ${L.next}: it goes to the next field that is still open. If a field cannot be filled in, or asks for something that is not yours to give, ${other(s).replace(/^O/, 'o')}, then ${S.ask!.label}, to tell the sender. If the page does not react at all, load it again: what you filled in is kept. Still stuck? Choose Talk to a person.` },
  { id: 'cannot-see', words: ['cannot see the document', "can't see the document", 'cannot see', "can't see", 'does not load', "doesn't load", 'will not load', "won't load", 'not loading', 'blank page', 'does not open', "doesn't open", 'will not open', "won't open", 'cannot read', "can't read", 'too small', 'zoom', 'text view', 'bigger', 'screen reader'],
    answer: (s) => `${other(s)}. Under The document it has ${L.textView}, which shows the words without the pages, sizes from 100 to 200 percent, and ${L.download}. If the pages cannot be opened, the page says so and offers to try again or to download the file. "Can I sign on my phone? Which browsers work?" on the help page lists the browsers.` },
  { id: 'signed-mistake', words: ['signed by mistake', 'signed by accident', 'signed it by mistake', 'undo my signature', 'undo', 'take back', 'take it back', 'withdraw my', 'unsign', 'signed the wrong', 'already signed', 'regret', 'changed my mind'],
    answer: () => `Before you press ${L.finish}, nothing is signed: tap a field to change it, or choose ${S.decline!.label}. After ${L.finish}, neither you nor the helper can take a signature back. Write to the sender: while others still have to sign, the sender can void the document or correct it and ask for signatures again. If you never signed it at all, that is another matter: see "I am named on a document I did not sign" on the help page. A person can help too: choose Talk to a person.` },
  { id: 'stop-reminders', words: ['stop sending me', 'stop the reminders', 'stop reminders', 'stop reminding', 'stop emailing', 'stop these emails', 'too many emails', 'keep getting emails', 'keeps emailing'],
    answer: () => `Every reminder email has a link that stops the reminders for that document. On the signing page, ${S.later!.label} shows "${L.stopReminders}" next to its note. The document stays open and your link keeps working. If you did not expect the request at all, you do not have to sign: report it from the email or with ${L.report} on the signing page.` },
  { id: 'after-finish', words: ['after i finish', 'after i sign', 'after signing', 'once i sign', 'when i finish', 'what happens next', 'what happens then', 'what next', 'am i done', 'did it work', 'did it go through'],
    answer: () => `After ${L.finish}, your part is done, the page says so, and the sender is told. If others still have to sign, it goes on to them. When everyone has finished, each person gets an email with a link to the signed document. You can download what you signed from the signing page straight away, with the same link.` },
  { id: 'safe', words: ['is this safe', 'is it safe', 'safe to open', 'can i trust', 'who are you', 'what is growsigning', 'what is this email', 'what is this site', 'what is this page', 'never heard'],
    answer: () => 'GrowSigning is a service for signing documents online. Someone uploaded a document and asked you to sign it. Signing is free for you and needs no account. To be sure an email is really from us before you click anything, type its 12 character security code into Check an email: it tells you who sent it. The helper cannot say whether you should sign a document. That is for you to decide, with a lawyer if you are unsure.' },
  { id: 'phone', words: ['phone', 'mobile', 'tablet', 'ipad', 'iphone', 'android', ' app ', 'install', 'which browser'],
    answer: () => 'Signing works in the browser of a phone or a tablet, with no app to install and no account. "Can I sign on my phone? Which browsers work?" on the help page lists the browsers that show the document.' },
];

// ---- What someone who sends asks -------------------------------------------------------------------------------------
export const SENDER_FAQ: Faq[] = [
  { id: 'send', words: ['send a document', 'send a contract', 'send my first', 'how do i send', 'how to send', 'send for signature', 'get a document signed', 'get it signed', 'get this signed', 'upload', 'new envelope', 'first document', 'how does it work', 'get started', 'how do i start'],
    answer: (s) => s === 'editor'
      ? 'Here in the editor there are three steps: add the document and the people who sign, place a field for each person on the pages, then review and send. Each person gets an email with their own link and needs no account. A signature is used only when someone actually signs.'
      : `${sending(s) ? 'On Home' : 'Log in, and on Home'}, choose ${A.start.label}. Upload the document, add the people who sign with a name and an email address, place a field for each of them, then review and send. Each person gets an email with their own link and needs no account. A signature is used only when someone actually signs.` },
  { id: 'add-signer', words: ['add a signer', 'add signer', 'second signer', 'another signer', 'add a recipient', 'add someone', 'add a person', 'add another', 'more than one', 'two people', 'several people', 'signing order', 'sign in order', 'who signs first', 'sign first', 'sign it myself', 'sign myself', 'sign my own'],
    answer: () => `In the editor's first step you add each person with a name and an email address, and choose what they do: sign, approve, view, or receive a copy. Tick ${A.order.label} there to choose who goes first. ${A.addMyself.label} puts you on the list, and signing your own documents is free. After sending, people are added or changed from the envelope, without voiding it.` },
  { id: 'status', words: ['has everyone signed', 'who has signed', 'who signed', 'who has not signed', 'has not signed', "hasn't signed", 'did they sign', 'did they open', 'have they signed', 'status of', 'envelope status', 'document status', ' track', 'progress', 'waiting for', 'still waiting'],
    answer: (s) => `${inApp(s, A.envelopes.label)} and choose the envelope. It shows for each person whether the email left our server, whether they opened the document and whether they have finished. From there you can choose ${A.remind.label}, ${A.copyLink.label} to send someone their link yourself, or correct a name or an address.` },
  { id: 'void', words: [' void', 'cancel an envelope', 'cancel the envelope', 'cancel a document', 'cancel the document', 'cancel this document', 'cancel this envelope', 'recall', 'unsend', 'withdraw the', 'withdraw a', 'stop the document', 'stop the envelope', 'delete an envelope', 'delete a document', 'delete the envelope'],
    answer: (s) => `${inApp(s, A.envelopes.label)}, choose the envelope, then ${A.void.label}. That works while it is out for signing: the links stop working, and the signatures held for people who had not signed come back to you. For a wrong name, address or field you do not need to void: correct it in place on the same page. A completed envelope cannot be voided.` },
  { id: 'template', words: ['template', 'reuse', 'same document again', 'send it again'],
    answer: (s) => `A template keeps a document with its fields, so you only fill in who signs each time. ${inApp(s, A.templates.label)} and choose ${A.newTemplate.label} to make one, or open an envelope you sent and choose ${A.saveTemplate.label}. To send from one, open ${A.templates.label} and choose Use next to it.` },
  { id: 'bulk', words: ['many people', 'bulk', 'mass send', 'everyone at once', 'list of people', 'csv', 'spreadsheet', 'hundred people', 'all my customers', 'all employees'],
    answer: (s) => `${inApp(s, A.bulk.label)}: it sends one template to a list of people, and each of them gets a copy of their own to sign. ${BULK_COST_NOTE}` },
  { id: 'team', words: ['my team', 'team member', 'invite', 'add a user', 'add users', 'add a member', 'add a colleague', 'another user', 'coworker', 'co-worker', 'second admin', 'seats'],
    answer: (s) => `${inApp(s, A.settings.label)}, then ${A.team.label}. Owners and admins type an address under ${A.inviteByEmail.label}, choose Member or Admin, and the person gets an invitation. An admin can manage the team, the plan and every document.` },
  { id: 'settings', words: ['notification', 'too many notifications', 'change my email', 'change my password', 'change my name', 'my profile', 'profile', 'change a setting', 'where are the settings'],
    answer: (s) => `${inApp(s, A.settings.label)}. ${A.profile.label} has your name, ${A.notifications.label} has which emails you get, and the other tabs are named for what they hold. If the name is wrong on a document you were sent to sign, that is fixed on the signing page instead. ${nameFix()}` },
];

SENDER_FAQ.push({ id: 'deadline', words: ['set a deadline', 'set the deadline', 'add a deadline', 'change the deadline', 'due date', 'give more time', 'give them more time', 'reopen', 'asked for more time'], answer: (s) => moreTimeForSender(s) });

/** A mistake, asked about on the signing page: there it is the signer's own field, not a sent envelope. */
export const mistakeWhileSigning = (s?: ChatScreen): string =>
  `Before you press ${L.finish}, nothing is signed: tap any field to change what you put in it, and tap a signature to make it again. If the mistake is in the document itself, ${other(s).replace(/^O/, 'o')}, then ${S.ask!.label}, and tell the sender: they can correct it without starting again. A name spelled wrong? ${nameFix()}`;

// ---- The same, for the model ---------------------------------------------------------------------------------------------
/** What is on the screens, by label, as one block of the model's instructions. */
export function screenFacts(): string {
  const acts = ACTION_ORDER.map((k) => S[k]).filter((a): a is { label: string; when: string } => !!a);
  return [
    `- The signing page (people who sign): the first screen shows who sent the document and a box to tick to agree. Then ${L.next} goes from field to field, and turns into ${L.finish} when every field is done. Nothing is signed before ${L.finish}.`,
    `- The signing page has one menu, "${L.menu}", on both screens. Its entries, in this order: ${acts.map((a) => `"${a.label}" (${a.when})`).join('; ')}. Under them: Help (this chat), and under The document: Document or ${L.textView}, the size of the pages, and ${L.download}.`,
    `- "${S.later!.label}" saves what was filled in; the same link brings the person back. After it the page shows "${L.stopReminders}". "${L.report}" is on the signing page for a request that looks wrong.`,
    `- There is no way to sign on paper in GrowSigning, and no button for it.`,
    `- The app (people who send, signed in): Home has "${A.start.label}". The menu has ${A.envelopes.label}, ${A.templates.label}, ${A.bulk.label} and ${A.settings.label}, among others.`,
    `- An envelope's own page shows each person's progress and has "${A.remind.label}", "${A.moreTime.label}", "${A.void.label}" (while it is out), "${A.copyLink.label}" for each person, "${A.saveTemplate.label}", and "${A.download.label}" once it is completed.`,
    `- ${A.settings.label} has tabs: ${A.profile.label}, ${A.notifications.label}, Account, ${A.team.label}, Plan, Your data, and others.`,
  ].join('\n');
}
