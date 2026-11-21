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

/**
 * One frequent question. `side` says whose question it is: on the signing page only a signer's answers are given
 * (never a price, a plan or a word like "envelope"), and `acts` names the entries of Other actions that do what the
 * answer says, so the dialog can show them as buttons that open that entry on the page underneath.
 */
export type SignAct = (typeof ACTION_ORDER)[number] | 'menu';
export type Faq = { id: string; words: string[]; answer: (screen?: ChatScreen) => string; side?: 'sender'; acts?: SignAct[] };

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
/** The entry only a witness has (WITNESS_ACTIONS in the same file of the page). */
export const WITNESS_LABELS = { absent: 'I was not there' } as const;
/** Labels on the signing page that are not entries of Other actions. */
export const SIGN_LABELS = { menu: 'Other actions', next: 'Next', finish: 'Finish', report: 'Report this request', more: 'More', textView: 'Text view', download: 'Download the document', stopReminders: 'Stop reminder emails', fixName: 'Fix my name', check: 'Check before you finish' } as const;
/** Labels in the app, for people who send. `where` is the source file each one is read from in the tests. */
export const APP_LABELS = {
  start: { label: 'Send a document', where: 'src/lib/nav.ts' },
  envelopes: { label: 'Documents', where: 'src/lib/nav.ts' },
  templates: { label: 'Templates', where: 'src/lib/nav.ts' },
  bulk: { label: 'Send to many', where: 'src/lib/nav.ts' },
  more: { label: 'More', where: 'src/components/AppNav.tsx' },
  settings: { label: 'Settings', where: 'src/lib/nav.ts' },
  remind: { label: 'Remind', where: 'src/lib/envelopepage.ts' },
  moreTime: { label: 'Give more time', where: 'src/lib/envelopepage.ts' },
  void: { label: 'Cancel the request', where: 'src/lib/envelopepage.ts' },
  download: { label: 'Download', where: 'src/lib/envelopepage.ts' },
  saveTemplate: { label: 'Save as template', where: 'src/lib/envelopepage.ts' },
  copyLink: { label: 'Copy link', where: 'src/components/sender/Recipients.tsx' },
  addMyself: { label: 'Add me', where: 'src/components/editor/StepAdd.tsx' },
  order: { label: 'Set signing order', where: 'src/components/editor/StepAdd.tsx' },
  newTemplate: { label: 'New template', where: 'src/app/app/templates/page.tsx' },
  profile: { label: 'Profile', where: 'src/app/app/settings/page.tsx' },
  security: { label: 'Security', where: 'src/lib/settingsnav.ts' },
  team: { label: 'Team', where: 'src/app/app/settings/page.tsx' },
  inviteByEmail: { label: 'Invite by email', where: 'src/app/app/settings/page.tsx' },
} as const;

const S = SIGN_ACTIONS, L = SIGN_LABELS, A = APP_LABELS;
/** "Ask for more time", as the helper says it: the page puts the sender's name in the middle of its own label. */
export const TIME_WORDS = 'Ask for more time';
const signing = (s?: ChatScreen) => s === 'signing';
/** True on the screens of someone who is signed in to an account. */
export const sending = (s?: ChatScreen) => s === 'app' || s === 'editor' || s === 'plan';
/** How to get to Other actions from where the person is. */
const other = (s?: ChatScreen) => (signing(s) ? `On this page, choose ${L.menu}` : `Open your signing link. On the signing page, choose ${L.menu}`);
const otherLow = (s?: ChatScreen) => other(s).replace(/^O/, 'o');
/** How to get to a page of the app from where the person is. */
const inApp = (s: ChatScreen | undefined, page: string) => (sending(s) ? `Open ${page}` : `Log in and open ${page}`);

/** Where a signer corrects the spelling of their own name: under the list of Other actions, once the document is open. */
export const nameFix = (s?: ChatScreen): string =>
  `${signing(s) ? 'Once the document is open, choose' : 'Open your signing link and, once the document is open, choose'} ${L.menu}. Under the list is the name you sign as, with "Not spelled right? ${L.fixName}". A small slip is corrected at once. A bigger change goes to the sender to confirm.`;

/** For "more time", asked by someone who signs: on the signing page the two controls, elsewhere how to get to them. */
export const moreTimeForSigner = (s?: ChatScreen): string =>
  signing(s)
    ? `${other(s)}, then ${TIME_WORDS}. It is there when the document has a deadline. The sender decides, and this same link keeps working. To stop only for now, choose ${S.later!.label} in the same list.`
    : `Open your link anyway. If the deadline has passed, the page has a button that asks the sender for more time. Before the deadline it is under ${L.menu} on the signing page. When the sender agrees, the same link works again.`;
/** For "more time", asked by someone who sends. */
export const moreTimeForSender = (s?: ChatScreen): string =>
  `${inApp(s, A.envelopes.label)}, choose the document, then More and ${A.moreTime.label}. It also reopens an envelope whose deadline has passed: the same links work again. The deadline for a new envelope is set in the editor's last step: open More options, and it is under Deadline.`;

/** Asked on the signing page: does the person who signs pay? Never a price or a plan there. */
export const FREE_FOR_SIGNER = 'Signing is free for you, and you need no account. The sender pays for it.';
/** Asked on the signing page: the email or the code did not come. */
export const noCodeForSigner = (): string =>
  'The code goes to the address or phone the sender gave. Look in spam, wait a minute, then choose Send a new code. Still nothing? Choose "I do not get the code" on the same screen: it tells the sender. Or choose Talk to a person.';
/** The same, asked where we cannot tell who asks: first for someone who signs, then for someone who sent. */
export const noEmailAnywhere = (): string =>
  `Look in spam for a message from GrowSigning. Then use Find my documents with the address the document was sent to: we email your link again. If you sent the document, log in, open ${A.envelopes.label}, choose the document, then ${A.remind.label}, or ${A.copyLink.label} in that person's More.`;
/** Asked by someone who sent a document. */
export const noEmailForSender = (s?: ChatScreen): string =>
  `${inApp(s, A.envelopes.label)} and choose the document: it shows whether each email left our server and whether the person opened the document. From there choose ${A.remind.label}, or open that person's More for ${A.copyLink.label} or to change their address.`;
/** Reminding someone now. */
export const remindNow = (s?: ChatScreen, days = 3): string =>
  `${inApp(s, A.envelopes.label)}, choose the document, then ${A.remind.label}. Reminders also go out by themselves every ${days} days unless you changed that.`;
/** On the signing page, for a question that is about an account, a plan or sending. */
export const ELSEWHERE = 'This page is for signing, which is free for you and needs no account. For a question about an account, a plan or sending documents, open the help page or choose Talk to a person.';
/** For a greeting or a thank-you. */
export const HELLO = 'Hello. Ask me anything about signing or sending with GrowSigning, or choose one of the questions below.';
export const THANKS = 'You are welcome. Ask anything else about GrowSigning, or choose one of the questions below.';

// ---- What someone who signs asks ---------------------------------------------------------------------------------
// Each answer is for the person on that screen, in two to four short sentences. The edge cases are on the help page.
export const SIGNER_FAQ: Faq[] = [
  { id: 'later', acts: ['later', 'time'], words: ['cannot sign', "can't sign", 'can not sign', 'unable to sign', 'sign later', 'sign it later', 'sign this later', 'finish later', 'sign this today', 'sign today', 'not today', 'sign tomorrow', 'come back later', 'not now', 'no time', 'not ready', 'do it later', 'save and', 'pause'],
    answer: (s) => `${other(s)}, then ${S.later!.label}. What you filled in is saved, and the same link brings you back, on any device. If the deadline is too close, ${TIME_WORDS} is in the same list: the sender decides.` },
  { id: 'decline', acts: ['decline', 'ask'], words: ['decline', 'do not want to sign', "don't want to sign", 'not want to sign', 'refuse to sign', 'not going to sign', 'say no', 'will not sign', "won't sign", 'disagree'],
    answer: (s) => `You do not have to sign. ${other(s)}, then ${S.decline!.label}, and add a short reason. That closes the document for everyone, and the sender is told why. Only a question? Choose ${S.ask!.label} instead.` },
  { id: 'pass', acts: ['reassign', 'ask'], words: ['someone else', 'wrong person', 'not for me', 'not meant for me', 'pass it', 'pass this', 'forward', 'reassign', 'another person', 'instead of me', 'right person', 'my boss', 'my manager', 'my colleague', 'delegate'],
    answer: (s) => `${other(s)}, then ${S.reassign!.label}, and give their name and email address. They get their own link, yours stops working, and the sender is told. If it is not in your list, choose ${S.ask!.label} and ask the sender to change the person.` },
  { id: 'ask-sender', acts: ['ask', 'later'], words: ['question for the sender', 'ask the sender', 'contact the sender', 'tell the sender', 'write to the sender', 'comment', 'do not understand', "don't understand", 'not understand', 'unclear', 'wrong in the document', 'mistake in the document', 'error in the document', 'change the document', 'wrong amount', 'wrong date', 'contract is wrong', 'document is wrong', 'agreement is wrong', 'what does this mean'],
    answer: (s) => `${other(s)}, then ${S.ask!.label}. What you write goes to the sender, and their answer appears in the same place. ${S.later!.label} keeps your place while you wait. The helper cannot see your document and cannot say what it means.` },
  { id: 'paper', acts: ['ask'], words: ['on paper', 'paper copy', ' print', 'by hand', 'handwritten', 'wet ink', 'with a pen'],
    answer: (s) => `GrowSigning has no button for signing on paper. To ask the sender for a paper copy, ${otherLow(s)}, then ${S.ask!.label}. To read it on paper first, ${L.more} on the signing page has ${L.download}.` },
  { id: 'how-sign', words: ['where do i sign', 'how do i sign', 'how to sign', 'how can i sign', ' draw', 'type my signature', 'my signature', 'change my signature', 'next button', 'start signing', 'initials'],
    answer: () => `Tick the box to agree, then press ${L.next}: it takes you to each field in turn. At a signature field, choose Type, Draw or Upload. When every field is done, ${L.next} turns into ${L.finish}. Nothing is signed until you press ${L.finish}.` },
  { id: 'finish-stuck', acts: ['ask'], words: ['finish button', 'cannot finish', "can't finish", 'can not finish', 'finish does not', "finish doesn't", 'will not let me', "won't let me", 'required field', 'greyed', 'grayed', 'nothing happens', 'stuck', 'button does not', "button doesn't", 'cannot fill', "can't fill", 'cannot type', "can't type"],
    answer: () => `${L.finish} works once every required field is filled in. Press ${L.next}: it goes to the next field that is still open. If a field cannot be filled in, tell the sender with ${S.ask!.label}. Still stuck? Load the page again (your answers are kept), or choose Talk to a person.` },
  { id: 'cannot-see', words: ['cannot see the document', "can't see the document", 'cannot see', "can't see", 'does not load', "doesn't load", 'will not load', "won't load", 'not loading', 'blank page', 'does not open', "doesn't open", 'will not open', "won't open", 'cannot read', "can't read", 'too small', 'zoom', 'text view', 'bigger', 'screen reader'],
    answer: (s) => `${signing(s) ? 'On this page' : 'On the signing page'}, with the document open, choose ${L.more}. It has ${L.textView}, which shows the same document as plain text, the size of the pages, and ${L.download}.` },
  { id: 'signed-mistake', acts: ['ask'], words: ['signed by mistake', 'signed by accident', 'signed it by mistake', 'undo my signature', 'undo', 'take back', 'take it back', 'withdraw my', 'unsign', 'signed the wrong', 'already signed', 'regret', 'changed my mind'],
    answer: () => `Before you press ${L.finish}, nothing is signed: tap a field to change it. After ${L.finish}, neither you nor the helper can take a signature back. Write to the sender: they can cancel the document, or correct it and ask again. A person can help too.` },
  { id: 'stop-reminders', words: ['stop sending me', 'stop the reminders', 'stop reminders', 'stop reminding', 'stop emailing', 'stop these emails', 'too many emails', 'keep getting emails', 'keeps emailing'],
    answer: () => `Every reminder email has a link that stops the reminders for that document. On the signing page, ${S.later!.label} also shows "${L.stopReminders}". The document stays open and your link keeps working.` },
  { id: 'after-finish', words: ['after i finish', 'after i sign', 'after signing', 'once i sign', 'when i finish', 'what happens next', 'what happens then', 'what next', 'am i done', 'did it work', 'did it go through'],
    answer: () => `After ${L.finish} your part is done, and the sender is told. If others still have to sign, it goes on to them. When everyone has finished, each person gets an email with a link to the signed document.` },
  { id: 'safe', words: ['is this safe', 'is it safe', 'safe to open', 'can i trust', 'who are you', 'what is growsigning', 'what is this email', 'what is this site', 'what is this page', 'never heard'],
    answer: () => 'GrowSigning is a service for signing documents online: someone uploaded a document and asked you to sign it. To be sure an email is really from us, type its 12 character security code into Check an email. The helper cannot say whether you should sign.' },
  { id: 'phone', words: ['phone', 'mobile', 'tablet', 'ipad', 'iphone', 'android', ' app ', 'install', 'which browser'],
    answer: () => 'Signing works in the browser of a phone or a tablet, with no app to install and no account. "Can I sign on my phone? Which browsers work?" on the help page lists the browsers.' },
];

// ---- What someone who sends asks -------------------------------------------------------------------------------------
export const SENDER_FAQ: Faq[] = [
  { id: 'send', words: ['send a document', 'send a contract', 'send my first', 'how do i send', 'how to send', 'send for signature', 'get a document signed', 'get it signed', 'get this signed', 'upload', 'new envelope', 'first document', 'how does it work', 'get started', 'how do i start'],
    answer: (s) => s === 'editor'
      ? 'Here in the editor there are three steps: add the document and the people who sign, place a field for each person on the pages, then review and send. Each person gets an email with their own link and needs no account.'
      : `${sending(s) ? 'In the menu' : 'Log in, and in the menu'}, choose ${A.start.label}. On a phone it is Send, in the bar at the bottom. Upload the document, add the people who sign, place a field for each of them, then review and send. Each person gets an email with their own link and needs no account.` },
  { id: 'add-signer', words: ['add a signer', 'add signer', 'second signer', 'another signer', 'add a recipient', 'add someone', 'add a person', 'add another', 'more than one', 'two people', 'several people', 'signing order', 'sign in order', 'who signs first', 'sign first', 'sign it myself', 'sign myself', 'sign my own'],
    answer: () => `In the editor's first step, add each person with a name and an email address. For an order, open More options. Tick ${A.order.label} there to number who goes first: without it everyone gets the document at the same time. ${A.addMyself.label} puts you on the list.` },
  { id: 'status', words: ['has everyone signed', 'who has signed', 'who signed', 'who has not signed', 'has not signed', "hasn't signed", 'did they sign', 'did they open', 'have they signed', 'status of', 'envelope status', 'document status', ' track', 'progress', 'waiting for', 'still waiting'],
    answer: (s) => `${inApp(s, A.envelopes.label)} and choose the document. It shows for each person whether the email left our server, whether they opened the document and whether they have finished. From there you can choose ${A.remind.label}, or ${A.copyLink.label} in that person's More.` },
  { id: 'void', words: [' void', 'cancel an envelope', 'cancel the envelope', 'cancel a document', 'cancel the document', 'cancel this document', 'cancel this envelope', 'recall', 'unsend', 'withdraw the', 'withdraw a', 'stop the document', 'stop the envelope', 'delete an envelope', 'delete a document', 'delete the envelope'],
    answer: (s) => `${inApp(s, A.envelopes.label)}, choose the document, then More and ${A.void.label}. The links stop working, and the signatures held for people who had not signed come back to you. For a wrong name, address or field, correct it on the same page instead.` },
  { id: 'template', words: ['template', 'reuse', 'same document again', 'send it again'],
    answer: (s) => `A template keeps a document with its fields, so you only fill in who signs each time. ${inApp(s, A.templates.label)} and choose ${A.newTemplate.label}, or open a document you sent and choose More, then ${A.saveTemplate.label}.` },
  { id: 'bulk', words: ['many people', 'bulk', 'mass send', 'everyone at once', 'list of people', 'csv', 'spreadsheet', 'hundred people', 'all my customers', 'all employees'],
    answer: (s) => `${inApp(s, A.more.label)} in the menu, then ${A.bulk.label}: it sends one template to a list of people, and each of them gets a copy of their own to sign. ${BULK_COST_NOTE}` },
  { id: 'team', words: ['my team', 'team member', 'invite', 'add a user', 'add users', 'add a member', 'add a colleague', 'another user', 'coworker', 'co-worker', 'second admin', 'seats'],
    answer: (s) => `${inApp(s, A.settings.label)}, then ${A.team.label}. Owners and admins type an address under ${A.inviteByEmail.label}, choose Member or Admin, and the person gets an invitation.` },
  { id: 'settings', words: ['notification', 'too many notifications', 'change my email', 'change my password', 'change my name', 'my profile', 'profile', 'change a setting', 'where are the settings'],
    answer: (s) => `${inApp(s, A.settings.label)}. ${A.profile.label} has your name and which emails you get, ${A.security.label} has your password and two-step login, and the other tabs are named for what they hold.` },
  { id: 'deadline', words: ['set a deadline', 'set the deadline', 'add a deadline', 'change the deadline', 'due date', 'give more time', 'give them more time', 'reopen', 'asked for more time'], answer: (s) => moreTimeForSender(s) },
];
for (const f of SENDER_FAQ) f.side = 'sender';

/** A mistake, asked about on the signing page: there it is the signer's own field, not a sent envelope. */
export const mistakeWhileSigning = (s?: ChatScreen): string =>
  `Before you press ${L.finish}, nothing is signed: tap any field to change what you put in it, and tap a signature to make it again. If the mistake is in the document itself, ${otherLow(s)}, then ${S.ask!.label}, and tell the sender.`;

// ---- The same, for the model ---------------------------------------------------------------------------------------------
/** What is on the screens, by label, as one block of the model's instructions. */
export function screenFacts(): string {
  const acts = ACTION_ORDER.map((k) => S[k]).filter((a): a is { label: string; when: string } => !!a);
  return [
    `- The signing page (people who sign): the first screen shows who sent the document and a box to tick to agree. Then ${L.next} goes from field to field, and turns into ${L.finish} when every field is done. Nothing is signed before ${L.finish}.`,
    `- The signing page has one menu, "${L.menu}", on both screens. Its entries, in this order: ${acts.map((a) => `"${a.label}" (${a.when})`).join('; ')}. Under them: Help (this chat).`,
    `- Once the document is open, the bar of the signing page also has "${L.more}": Pages or ${L.textView} (the same document as plain text), the size of the pages (100, 150 or 200 percent), and "${L.download}".`,
    `- "${S.later!.label}" saves what was filled in; the same link brings the person back. After it the page shows "${L.stopReminders}". "${L.report}" is on the signing page for a request that looks wrong.`,
    `- A witness has a shorter list: "${WITNESS_LABELS.absent}", "${S.ask!.label}" and Help. A witness who stops for now closes the page; the same link works again.`,
    `- There is no way to sign on paper in GrowSigning, and no button for it.`,
    `- The app (people who send, signed in): the menu starts with "${A.start.label}" (on a phone: Send, in the bar at the bottom). It has Home, ${A.envelopes.label}, To sign, ${A.templates.label}, Contacts, ${A.more.label}, ${A.settings.label} and Help. Under ${A.more.label} are ${A.bulk.label}, Forms, Reports and Trees planted.`,
    `- An envelope's own page shows each person's progress and has one main button ("${A.remind.label}" and the person's name while it is out, "${A.download.label}" once it is completed), a "More" with "${A.moreTime.label}", "${A.void.label}" (while it is out) and "${A.saveTemplate.label}", and a "More" for each person with "${A.copyLink.label}".`,
    `- ${A.settings.label} has tabs: ${A.profile.label} (your name, your signature, which emails you get), ${A.security.label} (password, two-step login, where you are signed in), ${A.team.label} and API and webhooks. Owners and admins also have Account, Sending (reminders, deadline and date format of new documents), Stamps, Plan and Your data.`,
  ].join('\n');
}
