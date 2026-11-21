// What the help chat knows, built on the server from the same sources the pages print, so the helper and the pages
// cannot disagree: the rules and numbers in src/lib/policy.ts and src/lib/impact.ts, the topics of /help, what is
// and is not in the product (README "What is not in it"), and a short list of frequent questions. The model gets all
// of it as its system prompt on every question, and the built-in answers (used when no model is set up, when it is
// down or slow, and past a limit) are taken from the same list of frequent questions.
//
// The questions of /help and README's "What is not in it" are read from those files themselves while the server runs
// (src/server/chatsources.ts), so an edit there reaches the next question. Only a few words on what each help topic
// covers are written here (TOPIC_NOTES); a topic without a note is still known by its question.
import {
  refundDays, refundRuleText, priceRuleText, dormantStopDays, CLOSE_GRACE_DAYS, CLOSING_REMINDER_DAYS, DELETED_WITH_ACCOUNT, KEPT_AFTER_DELETION,
  WHO_CAN_SEE, NO_BAA_TITLE, NO_BAA_TEXT, LANGUAGE_NOTE, consentWording, newAccountDailyRecipients, unpaidDailyRecipients, PAID_TRUST_DAYS,
  abuseSuspendAfter, TEAM_INVITES_PER_DAY, supportReachable, supportFirstReplyHours, supportUrgentReplyHours, SUPPORT_REOPEN_DAYS,
  SIGNER_CODE_DIGITS, SIGNER_CODE_MINUTES, SIGNER_CODE_TRIES, DEFAULT_REMINDER_DAYS, BULK_COST_NOTE, ACCESS_CODE_TRIES, GROUP_RULE, TWO_STEP_EMAIL_RESET_DAYS,
} from '../lib/policy.ts';
import { replyPromise } from '../lib/support.ts';
// When signatures expire (decided 2026-11-20), in the same words as the Plan page, /help and the pricing block.
import { expiryRuleText, HELD_EXPIRY_TEXT } from '../lib/policy.ts';
import { PRICING, usd, CURRENCY_NOTE } from '../lib/impact.ts';
import { CHAT_SCREENS, CHAT_TOOLS, type ChatScreen } from '../lib/chat.ts';
import { helpTopics, notInIt } from './chatsources.ts';
import { SIGNER_FAQ, SENDER_FAQ, screenFacts, sending, nameFix, moreTimeForSigner, moreTimeForSender, mistakeWhileSigning, APP_LABELS, type Faq } from './chatscreens.ts';

// ---- The topics of /help -------------------------------------------------------------------------------------
// The questions and their anchors come from the page itself (helpTopics()). These are a few words on what each one
// covers, by anchor, for the model; a note whose topic is no longer on the page is not used.
export const TOPIC_NOTES: Record<string, string> = {
  'find-documents': 'Find my documents emails a link to every document sent to an address. Links do not wear out.',
  'real': 'Type the 12 character security code from the email into Check an email.',
  'unexpected': 'You do not have to sign. Report it from the email, from Check an email, or from the signing page.',
  'not-me': '"I did not sign this, or this was not me" marks it as disputed. What we give out and to whom.',
  'more-time': 'Open the link anyway: a passed deadline offers to ask the sender for more time.',
  'copy': 'The completion email links to the signed document. Find my documents sends it again.',
  'while-signing': 'Questions and comments, Fix my name, pass it on, decline, finish later, stop reminders.',
  'phone': 'Yes, in the phone\'s browser, with no app and no account. Which browsers show the document.',
  'group-taken': 'A document sent to a group: the first who agreed has it. Only the sender can give it back.',
  'one-time-code': 'A code sent to your email (or by text where this server sends texts). Only the sender can change where it goes.',
  'consent-wording': 'The exact words of the consent screen, with their version.',
  'cancel': 'Three ways: the Plan page, the stop link in payment emails, and two tools without logging in.',
  'refunds': 'The refund rule, with no form and no approval.',
  'signatures': 'Prices, what uses a signature, what is always free.',
  'code': 'A code that makes the monthly plan free, entered at sign-up or on the Plan page.',
  'after-cancel': 'Nothing is deleted or locked. Export is free.',
  'close': 'Closing, the days to undo it, what is deleted and what is kept.',
  'fix-after-sending': 'Correct an envelope in place without voiding it.',
  'not-received': 'What the envelope shows, copying the link, reminding one person, correcting the address.',
  'bounced': 'What those words mean and what to do. Only on a server connected to its mail provider.',
  'checking-signers': 'Access codes and one-time codes, and what each proves.',
  'witness': 'A witness for one signer. GrowSigning records what the witness states and cannot check it.',
  'stamps': 'A picture of a stamp printed like ink. Not an electronic seal and not stamp duty.',
  'reminders': 'Reminders by default, and where to change them.',
  'enough': 'What a simple electronic signature is, and when to check first. Not legal advice.',
  'outside-us': 'Documents not to sign here without checking, the check before sending, notes by country.',
  'language': 'English for now. The document can be in any language.',
  'cannot-open': 'Send them the PDF yourself. A signature collected that way is outside GrowSigning.',
  'no-email': '"I will send the link myself": a name and no address.',
  'patient-information': 'No. There is no HIPAA business associate agreement.',
  'payment-link': 'GrowSigning takes no payments. A trusted account can show a link to its own payment page after Finish.',
  'signing-groups': 'Signing groups, made by admins under Contacts.',
  'template-access': 'Who can use a template, who can change it, and locking its wording.',
  'cannot-send': 'An unconfirmed address, the daily limit, a fake payment notice, a pause, a short access code, no signatures left.',
  'locked-out': 'Password reset, Google or Microsoft logins, a lost authenticator phone, a team.',
  'unknown-charge': 'Find my subscription with each address, then write to a person with the date and amount.',
  'after-writing': 'A reference, a person who has it, every answer by email with a private link.',
  'lost-link': 'The links to your help requests are emailed again.',
};

// ---- Frequent questions --------------------------------------------------------------------------------------
// The built-in answers. Each has the words that pick it, the answer, and the tool buttons that go with it. The answer
// texts are built from policy.ts where a rule is quoted. The model is given the same list, so the two say the same.
// What a signer and a sender ask about their own screen is in src/server/chatscreens.ts, and an answer may depend on
// the screen the person is on (`screen`), so it can say "on this page".
const sigs = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;
export const FAQ: Faq[] = [
  { id: 'not-me', words: ['did not sign', "didn't sign", 'never signed', 'not me', 'forged', 'dispute', 'someone signed', 'in my name'],
    answer: () => 'If you are named on a document you did not sign, open it and choose Report this request, then "I did not sign this, or this was not me". Or type the security code from our email into Check an email and choose the same. The document is then marked as disputed wherever it is shown, the sender and the people who run GrowSigning are told, and nothing is deleted. We cannot tell who really signed. If it is a legal matter, ask a lawyer, or the police if you think a crime was committed.' },
  { id: 'refund', words: ['refund', 'money back', 'charged twice', 'double charge', 'overcharged', 'charged after', 'charged me after', 'after i cancel', 'still charged', 'still being charged', 'charged again'],
    answer: () => `${refundRuleText(refundDays())} Open Settings, then Plan: your latest payment is offered at the top. A charge after you cancelled, a second charge for the plan, or more than the reminder said is refunded by the software by itself. Anything outside this rule goes to a person: choose Talk to a person.` },
  { id: 'cancel', words: ['cancel', 'stop paying', 'stop billing', 'unsubscribe', 'end my plan', 'stop the plan'],
    answer: () => 'There are three ways. In the app: Settings, then Plan, then Cancel plan (owners and admins). From your inbox: every email about a payment while a plan renews has a link that stops it, without logging in. Without logging in: Find my subscription emails every paid plan tied to an address with a stop link, and Stop billing with my card works with the last four digits of the card. The plan runs to the end of the month already paid for. Nothing is deleted, and the signatures you have can be used until their own dates: what is left of the month expires when it ends, top-ups keep theirs.' },
  { id: 'price', words: ['price', 'cost', 'how much', 'pricing', 'free', 'plan', 'pay', 'expensive'],
    answer: () => `A new account gets ${sigs(PRICING.welcomeSignatures)} free to try. ${PRICING.planName} is ${usd(PRICING.monthlyUsd)} a month and adds ${sigs(PRICING.monthlySignatures)} with every payment, and extra signatures are ${usd(PRICING.topUpUsd)} each. A signature is used only when someone actually signs. ${expiryRuleText()} Signing is always free for the people who sign. ${CURRENCY_NOTE} 100% of what customers pay goes to Treegens tree planting.` },
  { id: 'price-change', words: ['price go up', 'price increase', 'raise the price', 'price change', 'new price'],
    answer: () => priceRuleText() },
  { id: 'find', words: ['lost', 'cannot find', "can't find", 'link stopped', 'link does not work', 'link expired', 'resend', 'signing link', 'where is my document', 'never got', 'deleted the email'],
    answer: () => 'Signing links do not wear out: one link works for as long as the document is open. If the email is lost, use Find my documents on the help page with the address the document was sent to. We email a link to every document waiting for you, every one you signed and every completed one. Only that inbox gets it. If the sender sent you the link themselves by chat or text, we have no address for you: ask the sender.' },
  { id: 'real', words: ['scam', 'real', 'genuine', 'phishing', 'fake', 'is this email', 'really from', 'suspicious', 'did not expect', 'unexpected'],
    answer: () => 'Do not click anything in the email. Every signing email has a 12 character security code near the bottom. Type our address into your browser yourself, open Check an email and enter the code: it tells you who sent it. You do not have to sign anything you did not expect, and you can report it from the email, from Check an email or from the signing page. We never ask for a password, a card number or a payment by email.' },
  { id: 'verify', words: ['verify', 'unchanged', 'tampered', 'authentic', 'fingerprint', 'original', 'printed copy', 'envelope id'],
    answer: () => 'Verify a document tells you whether a PDF is unchanged since signing finished here. It does not show who was behind each signature. With only a printed copy, type the envelope ID from the foot of a page: you see its status, day, pages and the fingerprint of the signed file, never a name or an address. The file you check is not stored.' },
  { id: 'more-time', words: ['expired', 'deadline', 'more time', 'ran out', 'too late', 'extend', 'extension'],
    answer: (s) => (sending(s) ? moreTimeForSender(s) : moreTimeForSigner(s)) },
  { id: 'name', words: ['my name', 'misspelled', 'spelled wrong', 'spelling', 'typo', 'wrong name', 'name is wrong'],
    answer: (s) => (sending(s) ? `Your own name is under ${APP_LABELS.settings.label}, then ${APP_LABELS.profile.label}. A signer's name on an envelope you sent is corrected on the envelope's page, without voiding it. Your name on a document you were sent to sign: ` : '') + `${nameFix()} A small slip (a letter, the spacing, a hyphen or a dot) is corrected at once, and the sender is told. A name that could be someone else's, or one in another alphabet, is not changed: it goes to the sender to confirm, and they can correct it for you.` },
  { id: 'copy', words: ['copy', 'download', 'signed pdf', 'signed document', 'completed document', 'finished document', 'get my document', 'find my document', 'where is my document', 'keep a copy', 'certificate', 'audit trail'],
    answer: (s) => (sending(s) ? `If you sent it: open ${APP_LABELS.envelopes.label}, choose the completed envelope, then ${APP_LABELS.download.label}. If someone else sent it to you: ` : '') + 'When everyone has finished, each person gets a completion email that links to the signed document, with the PDF attached when it is small enough. Lost it? Find my documents sends the link again, also months later. To be safe, download the PDF and keep it.' },
  { id: 'agree', words: ['agree', 'agreeing', 'consent', 'what am i signing', 'electronic records'],
    answer: () => `Before any field opens you are shown these words and asked to tick a box: "${consentWording('the sender', true).legal}" You can decline instead, or ask the sender for a paper copy. The help page prints the full wording with its version.` },
  { id: 'legal', words: ['legal', 'legally', 'is it valid', 'is this valid', 'is that valid', 'signature valid', 'valid signature', 'still valid', 'valid in', 'binding', 'enforceable', 'hold up', 'stand up', 'court', 'lawyer', 'law', 'should i sign', 'safe to sign', 'qualified', 'eidas'],
    answer: () => 'GrowSigning makes a simple electronic signature: the signer\'s name or mark on the page and a record of when and from where they signed. It does not check identity documents and has no notary step. Whether that is enough depends on the country and the kind of document, and some documents need a handwritten, witnessed, notarised or qualified signature. The helper gives no legal advice: ask a lawyer, and see "Is this signature enough for my document?" on the help page.' },
  { id: 'locked', words: ['log in', 'login', 'sign in', 'password', 'locked out', 'two-step', '2fa', 'authenticator', 'reset', 'lost my phone', 'lost the phone', 'recovery code', 'cannot sign in', "can't sign in", 'cannot log in', "can't log in"],
    answer: () => `Forgot the password? Use Forgot password on the sign-in page: the link works for one hour. Made your login with Google or Microsoft? Use that button. Lost the phone with your authenticator app? Type one of your recovery codes in place of the code. Without them, a team admin can switch it off, or you can start a reset by email after your password, which takes effect after ${TWO_STEP_EMAIL_RESET_DAYS} days. "I cannot log in" on the help page has every case. A person can help too, and the contact form works without signing in.` },
  { id: 'close', words: ['close my account', 'delete my account', 'delete everything', 'remove my data', 'close account', 'deleted'],
    answer: () => `Settings, then Your data, then Close my account. Any subscription stops at once. You have ${CLOSE_GRACE_DAYS} days to undo it by signing in again, and ${CLOSING_REMINDER_DAYS} days before the end we email you. Export first if you want copies. Some things are kept after deleting, such as the record of payments without your name: the help page and Security and trust list exactly what.` },
  { id: 'who-sees', words: ['who can see', 'who sees', 'privacy', 'private', 'confidential', 'admins see', 'operator'],
    answer: () => `In short: ${WHO_CAN_SEE.map((w) => w.who.replace(/\.$/, '')).join('; ')}. A signing link opens its document for whoever holds it, which is why a sender can add an access code or a one-time code. Security and trust lists it in full.` },
  { id: 'account', words: ['need an account', 'register', 'sign up to sign', 'create an account', 'do i need'],
    answer: () => 'People who sign never need an account or a password, signing is always free, and they are never sent marketing. Only people who send documents have an account.' },
  { id: 'language', words: ['language', 'english', 'translate', 'spanish', 'french', 'german', 'arabic', 'chinese'],
    answer: () => `${LANGUAGE_NOTE} The help page prints the consent wording so a sender can translate it.` },
  { id: 'health', words: ['hipaa', 'patient', 'health', 'medical', 'clinic', 'baa'],
    answer: () => `${NO_BAA_TITLE} ${NO_BAA_TEXT.split('. ').slice(0, 2).join('. ')}.` },
  { id: 'cannot-send', words: ['cannot send', "can't send", 'can i not send', 'not able to send', 'send button', 'limit', 'paused', 'blocked'],
    answer: () => `The usual reasons: your email address is not confirmed yet; the account reached its daily limit (an account that has not paid can newly email ${newAccountDailyRecipients()} people a day in its first week and ${unpaidDailyRecipients()} after that, until a payment is ${PAID_TRUST_DAYS} days old); the document reads like a fake payment notice; sending is paused after reports; an access code is too short; or there are no signatures left. The message on screen says which. "Why can I not send?" on the help page explains each.` },
  { id: 'fix-sent', words: ['mistake', 'wrong address', 'wrong email', 'correct', 'after sending', 'change after sending', 'edit sent', 'fix a document'],
    answer: (s) => s === 'signing' ? mistakeWhileSigning(s) : 'You do not need to void it. Open the envelope and correct it in place: a name, an email address, fields, people. Signatures already collected stay. Once someone has finished, a change to the pages themselves is saved only if you choose to ask them to sign again, and you are asked first.' },
  { id: 'not-received', words: ['did not get the email', "didn't get the email", 'never got the email', 'never received', 'not received', 'recipient', 'spam folder'],
    answer: () => 'Open the envelope: it shows whether each email left our server and whether the person opened the document. You can copy their signing link and send it yourself, show it as a QR code, remind just that person, or correct their address without voiding anything.' },
  { id: 'after-cancel', words: ['documents after cancel', 'documents when i cancel', 'happens to my documents', 'lose my documents', 'export', 'download everything', 'keep my documents'],
    answer: () => 'Cancelling or a failed payment deletes nothing and locks nothing. Every document, audit trail and receipt stays, documents that are out can still be signed, and your signatures can be used until their own dates. Settings, Your data, Export everything gives you all of it as one ZIP file, free, on any plan.' },
  { id: 'signatures', words: ['signature used', 'what uses', 'held', 'balance', 'run out', 'top up', 'top-up'],
    answer: () => `A signature is one person signing one envelope. Sending holds one for each signer, and voiding, declining or expiring gives back the ones not used. ${HELD_EXPIRY_TEXT} Always free: signing your own documents, approvers, viewers, copies, reminders, more time and corrections. ${BULK_COST_NOTE} With none left, sending pauses: it never turns into a charge.` },
  { id: 'free-code', words: ['was given a code', 'free code', 'promo', 'coupon', 'voucher', 'community code'],
    answer: () => `Some communities get ${PRICING.planName} free with a code. Enter it when you sign up, or under Settings, then Plan, where it says Have a code? With a code the ${sigs(PRICING.monthlySignatures)} of the monthly plan arrive every calendar month and nothing is charged for the plan. They belong to that month and expire when it ends, and the next month brings a fresh ${PRICING.monthlySignatures}.` },
  { id: 'code', words: ['one-time code', 'verification code', 'code did not arrive', 'access code', 'code'],
    answer: () => `A one-time code has ${SIGNER_CODE_DIGITS} digits, works for ${SIGNER_CODE_MINUTES} minutes and for ${SIGNER_CODE_TRIES} tries, and only the newest one works. A code by email goes to the same mailbox as the link, so look in the spam folder. "I do not get the code" on the same screen tells the sender. An access code is set by the sender, who tells it to you: it is never in our email, and after ${ACCESS_CODE_TRIES} wrong tries it freezes until the sender sets a new one. Never pass a code on to anyone, us included.` },
  { id: 'reminders', words: ['reminder', 'reminders', 'remind'],
    answer: () => `A new account reminds whoever has not finished every ${DEFAULT_REMINDER_DAYS} days by default. You see and change it on the last step before every send, and each person can stop the reminders to themselves. To remind someone now, open the envelope and choose ${APP_LABELS.remind.label}.` },
  { id: 'groups', words: ['group', 'team signs', 'anyone in the team'],
    answer: () => GROUP_RULE },
  ...SIGNER_FAQ,
  ...SENDER_FAQ,
  { id: 'person', words: ['person', 'human', 'someone', 'support', 'contact', 'talk to', 'email you'],
    answer: () => 'Choose Talk to a person under this answer. It opens our contact form with this chat attached, which you can take off. It works without an account and without logging in, gives you a reference at once, and a person answers by email.' },
];
export const NO_MATCH = 'I could not find that in our help pages, and I would rather not guess. Choose Talk to a person: a person reads every message and answers by email. The help page also lists every topic.';

/** The built-in answer for a question: the frequent question whose words fit best, or the honest "not found". */
export function builtInAnswer(question: string, screen: ChatScreen = 'public'): { id: string | null; reply: string } {
  // Lower case, one kind of apostrophe, and the marks of a sentence as spaces, so "app?" is the word "app".
  const q = ` ${String(question || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[?!.,;:()"“”]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  let best: Faq | null = null, bestScore = 0;
  for (const f of FAQ) {
    let score = 0;
    // A word inside a longer one that also fits ("remind" in "reminders") counts once, as the longer one.
    const counted: string[] = [];
    for (const w of f.words.filter((x) => q.includes(x)).sort((a, b) => b.length - a.length)) {
      if (counted.some((c) => c.includes(w.trim()))) continue;
      counted.push(w);
      score += w.trim().includes(' ') ? 3 : w.trim().length > 4 ? 2 : 1;
    }
    if (score > bestScore) (best = f), (bestScore = score);
  }
  return best ? { id: best.id, reply: best.answer(screen) } : { id: null, reply: NO_MATCH };
}

// ---- The system prompt -----------------------------------------------------------------------------------------

const lines = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
/** The topics of /help as the page has them now, each with its note where there is one. */
function topicLines(): string {
  const topics = helpTopics();
  if (!topics) return '- The list of topics could not be read on this server. Point people to the help page (/help), which lists every topic.';
  return lines(topics.map((t) => `"${t.q}" (/help#${t.id})${TOPIC_NOTES[t.id] ? `: ${TOPIC_NOTES[t.id]}` : ''}`));
}
/** README "What is not in it", as it is now. */
function notInItLines(): string {
  const list = notInIt();
  if (!list) return '- This list could not be read on this server. If someone asks whether something exists that the facts here do not mention, say you do not know and offer a person.';
  return lines(list);
}

/** Everything the model is told, for one question asked on one kind of screen. */
export function systemPrompt(screen: ChatScreen, env: Record<string, string | undefined> = process.env): string {
  const days = refundDays();
  const dormant = dormantStopDays();
  const reachable = supportReachable(env);
  const email = (env.SUPPORT_EMAIL || '').trim();
  return `You are the GrowSigning helper, an AI assistant inside GrowSigning, an e-signature service. You answer questions from visitors, from people who were sent a document to sign, and from people who send documents. 100% of what customers pay goes to Treegens tree planting.

How you answer:
- You are an AI and you can be wrong. When it matters, say so. The rules printed on GrowSigning's own pages are what count, not what you say.
- Answer only from the facts below. If they do not answer the question, say plainly that you do not know, and offer a person: under every answer there is a "Talk to a person" button that opens the contact form with this chat attached.
- Never give legal advice. Never say that a signature or a document "is valid", "is legally binding", "will hold up" or "is enforceable", for any country. Say what GrowSigning does and does not do, that the rules differ by country and by kind of document, and that a lawyer can say what applies.
- Never promise a refund, a credit, an exception, a date, a reply time other than the one below, or anything else the rules below do not say. You take no action and cannot see or change any document, account or payment. Name the tool that does it, by its exact name from the list of tools, and say where it is.
- You do not know who is asking, what is in their documents, or anything about their account, and you must not ask for it. Never ask for a password, a card number, a signing link or a code from an email. If the person typed one, tell them not to and that it was taken out.
- Offer a person yourself, in one sentence, when: money was taken or is owed; someone says they did not sign something, or there is a dispute; there is a security problem; the person is locked out; anything legal; the person is upset; or your last answer did not help.
- Answer in the language the person writes in. When they write in a language other than English, say once that GrowSigning's screens and emails are in English for now.
- Plain text only: no Markdown, no tables, no headings, no bold. Short, kind sentences. Two to six sentences unless the person asks for detail. Never use em dashes. Do not make up web addresses; you may name pages like the help page, Check an email or Verify a document.
- When someone asks how to do something, name the control that does it on the screen they are on, by its exact label from WHAT IS ON THE SCREENS below, and say where it is. Never name a button that is not in the facts below.
- If a question is not about GrowSigning, say you can only help with GrowSigning.

The person is on ${CHAT_SCREENS[screen]}.

=== WHAT IS ON THE SCREENS ===
${screenFacts()}

=== TOOLS THAT EXIST (the person uses them; you never do) ===
${lines(CHAT_TOOLS.map((t) => `${t.label} (${t.href}): ${t.what}`))}

=== PRICES ===
- A new account gets ${sigs(PRICING.welcomeSignatures)} free, once. ${PRICING.planName} is ${usd(PRICING.monthlyUsd)} a month and adds ${sigs(PRICING.monthlySignatures)} with every payment. On ${PRICING.planName}, extra signatures are ${usd(PRICING.topUpUsd)} each. ${CURRENCY_NOTE}
- A signature is one person signing one envelope. It is used only when someone actually signs. Sending holds one per signer; voiding, declining or expiring gives back the ones not used. ${HELD_EXPIRY_TEXT} Running out pauses sending and never creates a charge.
- ${expiryRuleText()}
- Always free: signing, for the people who sign; a sender signing their own documents; approvers, viewers and copies; reminders, more time and corrections.
- ${BULK_COST_NOTE}

=== REFUNDS ===
- ${refundRuleText(days)}
- The button is under Settings, then Plan. There is no form and no approval. Money goes back to the card that paid; banks usually show it within 5 to 10 working days.
- A charge after cancelling, a second charge for the plan, or a renewal above what the reminder said is refunded by the software by itself.
- Anything outside this rule is for a person to look at. Never promise one.

=== PRICE CHANGES ===
- ${priceRuleText()}

=== CANCELLING ===
- One button: Settings, then Plan, then Cancel plan (owners and admins). A stop link in every email about a payment while a plan renews, working without logging in. Without logging in: Find my subscription, and Stop billing with my card.
- The plan runs until the end of the month already paid for. Nothing is deleted or locked, the signatures left can be used until their own dates (what is left of the month expires when it ends), export is free on every plan.${dormant > 0 ? `\n- A paid plan that has sent nothing for ${dormant} days is not renewed, and the owner is told.` : ''}

=== DEADLINES AND LINKS ===
- A signing link works for as long as the document is open, however often it is opened. A sender may set a deadline. After it the document closes, and the signing page offers to ask the sender for more time. When the sender reopens it, the same link works again and nobody who signed signs again.
- Lost the email? Find my documents. Signers never need an account or a password and are never sent marketing.
- One-time codes: ${SIGNER_CODE_DIGITS} digits, ${SIGNER_CODE_MINUTES} minutes, ${SIGNER_CODE_TRIES} tries, only the newest works. Access codes are set by the sender and never in our email; after ${ACCESS_CODE_TRIES} wrong tries one freezes until the sender sets a new one. Only the sender can change or take off a check.
- Reminders: a new account reminds every ${DEFAULT_REMINDER_DAYS} days by default; the sender changes it before each send; each person can stop the reminders to themselves.

=== LIMITS THAT KEEP SCAMMERS OUT ===
- An account that has not paid can newly email ${newAccountDailyRecipients()} people a day in its first week and ${unpaidDailyRecipients()} a day after that. A payment lifts this once it is ${PAID_TRUST_DAYS} days old and was not refunded or disputed, or a person on our team clears the account.
- A team can invite ${TEAM_INVITES_PER_DAY} people a day. When ${abuseSuspendAfter()} different recipients report one account, its sending is paused until a person has looked. Documents that read like a fake payment notice cannot be sent by an account that is not trusted yet.

=== CLOSING AND DELETING AN ACCOUNT ===
- Settings, then Your data, then Close my account. ${CLOSE_GRACE_DAYS} days to undo it by signing in again; an email ${CLOSING_REMINDER_DAYS} days before the end. It can also be deleted at once.
- Deleted with it:
${lines(DELETED_WITH_ACCOUNT)}
- Kept after deleting:
${lines(KEPT_AFTER_DELETION)}

=== WHO CAN SEE DOCUMENTS ===
${lines(WHO_CAN_SEE.map((w) => `${w.who} ${w.what}`))}

=== WHAT KIND OF SIGNATURE THIS IS ===
- The words every signer agrees to before signing: "${consentWording('the sender', true).legal}"
- GrowSigning makes simple electronic signatures. It does not make advanced or qualified signatures, checks no identity documents, and has no notary step.

=== HEALTH INFORMATION ===
- ${NO_BAA_TITLE} ${NO_BAA_TEXT}

=== LANGUAGE ===
- ${LANGUAGE_NOTE}

=== TOPICS ON THE HELP PAGE (/help, each at /help#id) ===
${topicLines()}

=== WHAT GROWSIGNING DOES NOT HAVE ===
${notInItLines()}

=== FREQUENT QUESTIONS, WITH THE ANSWERS OUR PAGES GIVE ===
${lines(FAQ.filter((f) => f.id !== 'person').map((f) => f.answer(screen)))}

=== TALKING TO A PERSON ===
- The "Talk to a person" button under every answer opens the contact form with this chat attached; the person sees what is attached and can take it off. It works without an account and without logging in, and gives a reference at once.${reachable ? `\n- ${replyPromise(supportFirstReplyHours(env), supportUrgentReplyHours(env))}` : '\n- No response time is promised on this server.'}
- Every answer from a person is emailed in full with a private link to the request. A request is never closed without a written answer; a reply within ${SUPPORT_REOPEN_DAYS} days opens it again.${email ? `\n- People can also email ${email}. It reaches the same people.` : ''}`;
}
