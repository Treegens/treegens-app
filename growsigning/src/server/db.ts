import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { storeFile, readStored } from './filestore.ts';
import { openRow, registerSql } from './colcrypt.ts';
import { PRICING } from '../lib/impact.ts';

// SQLite via Node's built-in driver: no native build step, one file on disk.
// getBuiltinModule keeps bundlers from trying to resolve `node:sqlite` themselves.

const g = globalThis as any;

export const dataDir = () => path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || './data');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, verify_token TEXT,
  title TEXT, company TEXT, signature_png TEXT, initials_png TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'seedling',
  brand_color TEXT, brand_logo TEXT, default_reminder_days INTEGER NOT NULL DEFAULT 0,
  default_expire_days INTEGER NOT NULL DEFAULT 120,
  stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, PRIMARY KEY (account_id, user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL, created_at TEXT NOT NULL, accepted_at TEXT
);
CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, account_id TEXT, sha256 TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
  pages INTEGER NOT NULL, page_sizes TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, sender_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'envelope', status TEXT NOT NULL DEFAULT 'draft',
  subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', ordered INTEGER NOT NULL DEFAULT 0,
  reminder_days INTEGER NOT NULL DEFAULT 0, expire_days INTEGER NOT NULL DEFAULT 120, expires_at TEXT,
  folder TEXT, template_id TEXT, powerform_id TEXT, bulk_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT, completed_at TEXT, last_reminder_at TEXT,
  void_reason TEXT, final_sha256 TEXT, final_size INTEGER, sheets INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS envelopes_account ON envelopes(account_id, kind, status);
CREATE INDEX IF NOT EXISTS envelopes_final ON envelopes(final_sha256);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_env ON documents(envelope_id);
CREATE TABLE IF NOT EXISTS recipients (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'signer', role_name TEXT, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  routing_order INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  token TEXT UNIQUE, access_code TEXT, note TEXT, sent_at TEXT, viewed_at TEXT, completed_at TEXT,
  decline_reason TEXT, consent_at TEXT, ip TEXT, user_agent TEXT, signature_png TEXT, initials_png TEXT, reassigned_from TEXT
);
CREATE INDEX IF NOT EXISTS recipients_env ON recipients(envelope_id);
CREATE INDEX IF NOT EXISTS recipients_email ON recipients(email);
CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL, recipient_id TEXT, type TEXT NOT NULL, page INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, required INTEGER NOT NULL DEFAULT 1,
  label TEXT, value TEXT, options TEXT, group_name TEXT, validation TEXT, readonly INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fields_env ON fields(envelope_id);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, envelope_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ip TEXT, user_agent TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_env ON audit(envelope_id, seq);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, company TEXT, created_at TEXT NOT NULL, UNIQUE(account_id, email)
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, url TEXT NOT NULL,
  secret TEXT NOT NULL, events TEXT NOT NULL DEFAULT '*', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT NOT NULL, event TEXT NOT NULL, envelope_id TEXT,
  status INTEGER, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_hook ON webhook_deliveries(webhook_id, id);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_email TEXT NOT NULL, subject TEXT NOT NULL, html TEXT NOT NULL,
  link TEXT, envelope_id TEXT, status TEXT NOT NULL, error TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS powerforms (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, template_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bulk_batches (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, sender_id TEXT NOT NULL, template_id TEXT NOT NULL, name TEXT NOT NULL,
  total INTEGER NOT NULL, created_at TEXT NOT NULL
);
-- One line per row of a bulk send, written before anything is sent: which envelope it became, when it went out, or
-- why it could not. This is what lets a batch be finished after the process died half way without sending anyone
-- twice. fill is the row as it was submitted (names and emails) and is cleared once the row is sent.
CREATE TABLE IF NOT EXISTS bulk_rows (
  bulk_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, position INTEGER NOT NULL,
  fill TEXT, envelope_id TEXT, sent_at TEXT, error TEXT, PRIMARY KEY (bulk_id, position)
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, account_id TEXT, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, at TEXT NOT NULL
);
-- An Idempotency-Key on POST /envelopes. It belongs to the person who used it (user_id), so the same text used by
-- two members of a team never meets, and it goes when its envelope goes. request_hash is the body it came with.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  account_id TEXT NOT NULL, user_id TEXT NOT NULL, key TEXT NOT NULL,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, request_hash TEXT, at TEXT NOT NULL,
  PRIMARY KEY (account_id, user_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_env ON idempotency_keys(envelope_id);
CREATE TABLE IF NOT EXISTS credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT NOT NULL,
  at TEXT NOT NULL, UNIQUE (account_id, reason, ref)
);
CREATE INDEX IF NOT EXISTS credits_account ON credits(account_id);
-- Signatures expire (src/server/credits.ts, expiryRuleText in src/lib/policy.ts). Each line that brings signatures
-- is a lot: where they came from (the trial, a plan month, a month free with a code, a top-up payment) and when
-- they expire. Every line that takes some away says which lot it took them from (credit_draws), and every signature
-- held for someone who has been asked and not signed yet is held in one lot (credit_holds, keyed by a fingerprint
-- of the ledger line its signature will have, so no address is kept here). A held one does not expire while held.
CREATE TABLE IF NOT EXISTS credit_lots (
  id INTEGER PRIMARY KEY REFERENCES credits(id) ON DELETE CASCADE, account_id TEXT NOT NULL, source TEXT NOT NULL,
  ref TEXT NOT NULL, qty INTEGER NOT NULL, at TEXT NOT NULL, expires_at TEXT, paid INTEGER NOT NULL DEFAULT 0,
  warned TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS credit_lots_account ON credit_lots(account_id, expires_at);
CREATE TABLE IF NOT EXISTS credit_draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT, credit_id INTEGER NOT NULL REFERENCES credits(id) ON DELETE CASCADE,
  lot_id INTEGER REFERENCES credit_lots(id) ON DELETE SET NULL, n INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credit_draws_credit ON credit_draws(credit_id);
CREATE INDEX IF NOT EXISTS credit_draws_lot ON credit_draws(lot_id);
CREATE TABLE IF NOT EXISTS credit_holds (
  account_id TEXT NOT NULL, key TEXT NOT NULL, lot_id INTEGER REFERENCES credit_lots(id) ON DELETE SET NULL,
  since TEXT NOT NULL, rid TEXT, PRIMARY KEY (account_id, key)
);
CREATE INDEX IF NOT EXISTS credit_holds_lot ON credit_holds(lot_id);
CREATE TABLE IF NOT EXISTS retired_tokens (token TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, retired_at TEXT NOT NULL);
-- The security codes of emails about documents that were deleted since, as fingerprints only: no name, no address,
-- no subject. They let the check page say "that email was real, the document has been deleted" instead of "fake".
CREATE TABLE IF NOT EXISTS forgotten_codes (code_hash TEXT PRIMARY KEY, at TEXT NOT NULL);
-- The same for the signed PDF of a completed envelope that was deleted with its account: the SHA-256 of the file,
-- the envelope id and the day it was completed, nothing else (no name, no address, no title). /verify can then say
-- "completed here on that day, deleted by its sender since" instead of "no match". Kept a year (src/server/evidence.ts).
CREATE TABLE IF NOT EXISTS forgotten_files (file_sha256 TEXT PRIMARY KEY, envelope_id TEXT NOT NULL, completed_at TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS forgotten_files_env ON forgotten_files(envelope_id);
-- A dispute that was still open when its envelope was deleted with the sender's account (src/server/evidence.ts):
-- the envelope id, the fingerprint of the signed file if there was one, the day of the dispute and the state the
-- envelope was in. No name, no address, no title, no words. It goes when a person at GrowSigning closes the dispute.
CREATE TABLE IF NOT EXISTS forgotten_disputes (envelope_id TEXT PRIMARY KEY, file_sha256 TEXT, disputed_on TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL);
-- "I did not sign this, or this was not me", from a person named on the envelope (src/server/evidence.ts). One row
-- per person and envelope. Nothing is ever deleted because of one; the row goes with the envelope.
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, recipient_id TEXT NOT NULL,
  name TEXT NOT NULL, email TEXT, via TEXT NOT NULL, detail TEXT, ip TEXT, user_agent TEXT, at TEXT NOT NULL, UNIQUE (envelope_id, recipient_id)
);
-- A signature that was set aside because the sender changed the document afterwards and asked for a new one. The
-- audit trail says so in words. This keeps the signature itself and the answers exactly as they were.
CREATE TABLE IF NOT EXISTS earlier_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, recipient_id TEXT NOT NULL,
  name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, completed_at TEXT, ip TEXT, signature_png TEXT, initials_png TEXT,
  answers TEXT NOT NULL, set_aside_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS abuse_reports (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL, account_id TEXT NOT NULL, reporter TEXT, reason TEXT NOT NULL, detail TEXT,
  ip TEXT, status TEXT NOT NULL DEFAULT 'open', at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, at TEXT NOT NULL, what TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS billing_log_account ON billing_log(account_id);
CREATE TABLE IF NOT EXISTS billing_todo (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, account_id TEXT, detail TEXT NOT NULL DEFAULT '',
  tries INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, done_at TEXT, UNIQUE (kind, ref)
);
CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, at TEXT NOT NULL);
-- Messages from the payment provider that have arrived and are not applied yet. The provider is answered as soon as
-- a message is safely in here; a row goes when its message has been applied, and the timer tries the rest again.
CREATE TABLE IF NOT EXISTS stripe_inbox (id TEXT PRIMARY KEY, body TEXT NOT NULL, at TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, last_at TEXT, error TEXT);
-- Every account that was ever deleted. A payment that names one of these is known to be for an account that is
-- gone (and goes straight back); a payment that names an id nobody has heard of is not.
CREATE TABLE IF NOT EXISTS deleted_accounts (id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS accounts_deleted AFTER DELETE ON accounts BEGIN
  INSERT OR IGNORE INTO deleted_accounts (id, at) VALUES (old.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, account_id TEXT, cents INTEGER NOT NULL, signatures INTEGER NOT NULL DEFAULT 0,
  why TEXT NOT NULL DEFAULT '', auto INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', provider_id TEXT,
  tries INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, last_at TEXT, done_at TEXT
);
CREATE INDEX IF NOT EXISTS refunds_payment ON refunds(payment_id, status);
CREATE TABLE IF NOT EXISTS support_requests (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, topic TEXT NOT NULL, message TEXT NOT NULL, envelope_id TEXT,
  user_id TEXT, account_id TEXT, status TEXT NOT NULL DEFAULT 'open', at TEXT NOT NULL
);
-- What happened on a help request after its first message: what the customer added ('customer'), what an operator
-- answered ('answer') or asked ('question'), notes only operators see ('note'), and a line for everything that was
-- done to it, with who and when ('event'). It hangs on the request, so whatever deletes a request (an answered one
-- goes with a deleted account) deletes its thread in the same statement.
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, by_id TEXT, by_name TEXT, body TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_messages_request ON support_messages(request_id, id);
-- One line for every person an account newly emailed: a first send, a person added or an address changed by a
-- correction, a bulk row, a public form. The daily limits count these lines and not the envelopes, so voiding or
-- deleting an envelope never hands the day's allowance back.
CREATE TABLE IF NOT EXISTS reached (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE, envelope_id TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reached_account ON reached(account_id, at);
-- A way into a login besides its password: one line for each Google or Microsoft account connected to it. The
-- person is known by the provider's own id for them (provider, subject) and never by the address in email, which is
-- kept only to show in Settings which account it is. vouched is 1 when the provider itself stood behind that address
-- at the moment the line was written (see identityOf in oidc.ts). The lines go with the login when it is deleted.
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '' COLLATE NOCASE, vouched INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);
-- A sign-in at Google or Microsoft that was started and has not come back yet. id is the fingerprint of the "state"
-- value that travels through the provider, and the same value sits in a cookie of the browser that started, so only
-- that browser can finish it. The line is deleted the moment it is used, which is what makes it work once. user_id
-- is set when someone who is signed in is connecting a provider to their own login.
CREATE TABLE IF NOT EXISTS signin_states (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, mode TEXT NOT NULL,
  invite TEXT, code TEXT, next TEXT, user_id TEXT, expires_at TEXT NOT NULL
);
-- Checking who signs (src/server/signercode.ts). One line for every one-time code that was made: who it was for,
-- how it travelled (email_code or sms_code), where to (masked, for the record) and a keyed fingerprint of that
-- address or number, so the limits on one mailbox or one phone can be counted without storing either here. The code
-- itself is never stored: code_hash is a keyed fingerprint of it. fails counts wrong tries at this code. ended_at is
-- set when it was used, replaced by a newer one, or made void by a correction. stamp ties it to the link and the
-- check it was made for. The lines go with the recipient.
CREATE TABLE IF NOT EXISTS signer_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_id TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  envelope_id TEXT NOT NULL, account_id TEXT NOT NULL, channel TEXT NOT NULL, dest TEXT NOT NULL, dest_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL, stamp TEXT NOT NULL, fails INTEGER NOT NULL DEFAULT 0, ip TEXT, at TEXT NOT NULL,
  expires_at TEXT NOT NULL, ended_at TEXT, ended_how TEXT, delivery TEXT
);
CREATE INDEX IF NOT EXISTS signer_codes_recipient ON signer_codes(recipient_id, id);
CREATE INDEX IF NOT EXISTS signer_codes_dest ON signer_codes(dest_hash, at);
CREATE INDEX IF NOT EXISTS signer_codes_ip ON signer_codes(ip, at);
-- Every text message, like emails for email (src/server/sms.ts). kind is 'code', 'link' or 'reminder'. to_phone
-- holds the number only while the text still has to be handed to the provider, and is emptied after that: the
-- number is kept on the recipient and nowhere else. to_masked is what the sender and the record are shown. The body
-- of a text that carried a code is blanked once the provider has taken it. status, tries, tried_at, next_try_at and
-- expires_at work as they do on emails. The lines go with the envelope and with the account.
CREATE TABLE IF NOT EXISTS texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  envelope_id TEXT REFERENCES envelopes(id) ON DELETE CASCADE, recipient_id TEXT, kind TEXT NOT NULL,
  to_phone TEXT, to_masked TEXT NOT NULL, dest_hash TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
  tries INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, tried_at TEXT, next_try_at TEXT, expires_at TEXT, provider TEXT, provider_id TEXT
);
CREATE INDEX IF NOT EXISTS texts_envelope ON texts(envelope_id, id);
CREATE INDEX IF NOT EXISTS texts_due ON texts(status, next_try_at);
-- One line for every new text message an account caused, whatever became of it. SMS_DAILY_PER_ACCOUNT counts these
-- lines and not the texts table, so voiding or deleting an envelope never hands the day's allowance back.
CREATE TABLE IF NOT EXISTS sms_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, dest_hash TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sms_usage_account ON sms_usage(account_id, at);
-- Numbers that someone using a signing link said are not theirs ("This is not my number", src/server/signercode.ts),
-- for each account: a keyed fingerprint of the number, never the number. Nothing more is texted to it from that
-- account, on any of its envelopes, until its sender confirms the number with the person (number_confirmed).
CREATE TABLE IF NOT EXISTS text_stops (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, dest_hash TEXT NOT NULL, envelope_id TEXT, at TEXT NOT NULL,
  PRIMARY KEY (account_id, dest_hash)
);
-- An account's do-not-mail list (src/server/bounces.ts): an address at which an email about one of the account's
-- envelopes could not be delivered for good, with what the mail server said and when. A new envelope to that
-- address within BOUNCE_WARN_DAYS is answered with a warning first, and goes out when the sender says so. One line
-- for each account and address: a newer bounce replaces it, and an email that arrives there takes it away. The
-- lines go with the account.
CREATE TABLE IF NOT EXISTS bounced_addresses (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, email TEXT NOT NULL COLLATE NOCASE,
  reason TEXT NOT NULL DEFAULT '', at TEXT NOT NULL, PRIMARY KEY (account_id, email)
);
-- The days on which an address answered "try later" (a full mailbox, say). Three separate days within
-- BOUNCE_WARN_DAYS count as an address that does not work. The address itself is not kept here, only a keyed
-- fingerprint of it, and a line is deleted once it is older than that.
CREATE TABLE IF NOT EXISTS soft_bounce_days (address_hash TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (address_hash, day));
-- An address whose owner marked an email from this account as spam (src/server/routes-bounces.ts). Nothing more is
-- emailed to it about the account's documents, also after a correction away and back or on a new envelope, until
-- that person asks for it themselves on a signing page. The lines go with the account.
CREATE TABLE IF NOT EXISTS mail_complaints (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, email TEXT NOT NULL COLLATE NOCASE, at TEXT NOT NULL,
  PRIMARY KEY (account_id, email)
);
-- An email about an envelope that was deleted since: our number for it and its Message-ID, the account that sent it,
-- a keyed fingerprint of the address (never the address) and what was heard about it. So news that names it still
-- counts against that account, and is never pinned on another email to the same address. Kept BOUNCE_WARN_DAYS.
CREATE TABLE IF NOT EXISTS mail_gone (
  mail_id INTEGER PRIMARY KEY, message_id TEXT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address_hash TEXT NOT NULL, bounce_kind TEXT, complained_at TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_gone_message ON mail_gone(message_id);
-- A code emailed to someone who marked our email as spam and asks, on their signing page, for our emails again.
-- Holding the link is not enough (the sender can copy it): reading their own mailbox is. One per recipient.
CREATE TABLE IF NOT EXISTS mail_again_codes (
  recipient_id TEXT PRIMARY KEY REFERENCES recipients(id) ON DELETE CASCADE, code_hash TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL
);
-- A login's address that is being changed (POST /me/email): the new address, and the fingerprint of the secret in
-- the link that was emailed to it. The address changes only when that link is opened by the login itself.
CREATE TABLE IF NOT EXISTS email_changes (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email TEXT NOT NULL COLLATE NOCASE, expires_at TEXT NOT NULL
);
-- The welcome signatures are given once per email address, also when a login is deleted and a new one is made
-- under the same address. One line for each deleted login that had been given them and whose address was
-- confirmed: a keyed fingerprint of the address (it cannot be turned back into the address, and without the
-- server's secret an address cannot even be tested against it) and the day they were given. No name, no account.
CREATE TABLE IF NOT EXISTS welcomed (email_hash TEXT PRIMARY KEY, at TEXT NOT NULL);
-- Whose list a contact is in. The address book is one list for the account (contacts) and admins see all of it. A
-- member is shown the people they added by hand (a line here) or sent to themselves, never who a colleague sends
-- to. The lines go with the contact.
CREATE TABLE IF NOT EXISTS contact_users (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, user_id TEXT NOT NULL, PRIMARY KEY (contact_id, user_id)
);
-- Signing groups (src/server/groups.ts): a named list of people an account keeps, any one of whom can act when the
-- group is put on an envelope as one recipient ("HR team"). The lists go with the account.
CREATE TABLE IF NOT EXISTS signing_groups (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (account_id, name)
);
CREATE TABLE IF NOT EXISTS signing_group_members (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES signing_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, position INTEGER NOT NULL DEFAULT 0, UNIQUE (group_id, email)
);
-- The members of a group recipient on one envelope, as they were when it was sent: changing or deleting the
-- account's group later changes nothing here. The recipient stays one row in recipients (one signature, one place
-- in the order, one access code), and every member has a line here with a link of their own (token) and the
-- security code of their own emails (check_code), so it is known who opened and who acted. removed_at is set when
-- a correction took the member off: their link then says so and opens nothing. The lines go with the recipient.
CREATE TABLE IF NOT EXISTS recipient_members (
  id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE, envelope_id TEXT NOT NULL,
  name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, position INTEGER NOT NULL DEFAULT 0, token TEXT UNIQUE, check_code TEXT,
  sent_at TEXT, viewed_at TEXT, muted INTEGER NOT NULL DEFAULT 0, removed_at TEXT, link_issued_at TEXT
);
CREATE INDEX IF NOT EXISTS recipient_members_recipient ON recipient_members(recipient_id, position);
CREATE INDEX IF NOT EXISTS recipient_members_email ON recipient_members(email);
CREATE INDEX IF NOT EXISTS recipient_members_check ON recipient_members(check_code);
-- The code that starts our emails again for one member of a signing group (mail-again in routes-bounces.ts), kept
-- per member: the members share one recipient row, and one member asking must never cancel another member's code.
CREATE TABLE IF NOT EXISTS member_mail_again (
  member_id TEXT PRIMARY KEY REFERENCES recipient_members(id) ON DELETE CASCADE, code_hash TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL
);
-- The members a template's owner or an admin chose (src/server/tplroles.ts): a line lets that person use the template
-- when it is for chosen members, and can_change also lets them change it when it may be changed by chosen members.
-- The lines go with the template, and with the person when they leave the team or are removed (handOver).
CREATE TABLE IF NOT EXISTS template_members (
  template_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, can_change INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (template_id, user_id)
);
CREATE INDEX IF NOT EXISTS template_members_user ON template_members(account_id, user_id);
-- Questions and comments on a document while it is out (src/server/comments.ts). Not printed on the document and not
-- part of what is signed. A thread is for everyone on the envelope (private 0), or between the sender's side and one
-- person on it (private 1: recipient_id and party, which says which person on that row, see partyOf). Everything
-- goes with the envelope. comment_news is who is to be emailed about which comment, and when they were.
CREATE TABLE IF NOT EXISTS comment_threads (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  private INTEGER NOT NULL DEFAULT 1, recipient_id TEXT, party TEXT, party_name TEXT,
  document_id TEXT, page INTEGER, x REAL, y REAL, at TEXT NOT NULL, settled_at TEXT, settled_by TEXT
);
CREATE INDEX IF NOT EXISTS comment_threads_env ON comment_threads(envelope_id);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE, envelope_id TEXT NOT NULL,
  by_sender INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL, recipient_id TEXT, party TEXT, name TEXT NOT NULL, email TEXT,
  body TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_env ON comments(envelope_id, author);
CREATE TABLE IF NOT EXISTS comment_news (
  id INTEGER PRIMARY KEY AUTOINCREMENT, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE, audience TEXT NOT NULL, at TEXT NOT NULL, mailed_at TEXT, dropped TEXT
);
CREATE INDEX IF NOT EXISTS comment_news_env ON comment_news(envelope_id, audience);
-- Two-step login (src/server/twostep.ts). two_step_pending: a sign-in that passed its first step (or typed a wrong
-- password for a login that has two-step login: password_ok says which, and nothing outside the server ever does) and
-- waits for the code. id is the fingerprint of a secret in an HttpOnly cookie of that browser, so only that browser
-- can finish it. two_step_devices: browsers that skip the second step of one login ("Remember this device"), id the
-- fingerprint of the secret in their cookie. two_step_resets: the emailed link that starts a reset by email.
-- two_step_log: what happened to a person's second step and who did it, shown to them under Settings. All of it
-- goes with the login.
CREATE TABLE IF NOT EXISTS two_step_pending (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, password_ok INTEGER NOT NULL DEFAULT 0,
  invite TEXT, next TEXT, note TEXT, via TEXT, ip TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS two_step_devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ua TEXT,
  created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS two_step_devices_user ON two_step_devices(user_id);
CREATE TABLE IF NOT EXISTS two_step_resets (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS two_step_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, at TEXT NOT NULL,
  what TEXT NOT NULL, by_id TEXT, by_name TEXT, account_id TEXT, account_name TEXT
);
CREATE INDEX IF NOT EXISTS two_step_log_user ON two_step_log(user_id, id);
-- two_step_tries: wrong codes in a row that do not belong to the login as a whole (twostep.ts, useCode): those typed
-- after a wrong password, by internet address ("ip:<login>:<address>"), and those typed under Settings, by browser
-- ("session:<session>"). paused_until is set at the fifth. two_step_stops: links in the emails about a reset by email
-- that stop it without signing in, as fingerprints.
CREATE TABLE IF NOT EXISTS two_step_tries (
  key TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, wrong INTEGER NOT NULL DEFAULT 0, paused_until TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS two_step_stops (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL
);
-- Click-to-agree (src/server/clickwrap.ts). clickwraps: terms of one account that a website's visitors accept with a
-- click, with the draft being written (draft_*) and the number of the version that is live. clickwrap_versions: each
-- published version as it was shown, terms_sha256 the fingerprint of the exact terms. clickwrap_acceptances: one row
-- for each acceptance, sealed with the server's secret (seal). Versions and acceptances are never changed: the
-- triggers below refuse it, whatever code asks. All of it goes with the account.
CREATE TABLE IF NOT EXISTS clickwraps (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created_by TEXT,
  slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, secret TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  draft_format TEXT NOT NULL DEFAULT 'text', draft_text TEXT, draft_file_id TEXT, draft_checkbox TEXT, draft_button TEXT,
  draft_scroll INTEGER NOT NULL DEFAULT 0, signed_only INTEGER NOT NULL DEFAULT 0, current_version INTEGER NOT NULL DEFAULT 0,
  alerted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clickwraps_account ON clickwraps(account_id);
CREATE TABLE IF NOT EXISTS clickwrap_versions (
  id TEXT PRIMARY KEY, clickwrap_id TEXT NOT NULL REFERENCES clickwraps(id) ON DELETE CASCADE, number INTEGER NOT NULL,
  title TEXT NOT NULL, format TEXT NOT NULL, body TEXT, file_sha256 TEXT, pages INTEGER, terms_sha256 TEXT NOT NULL,
  checkbox TEXT NOT NULL, button TEXT NOT NULL, scroll INTEGER NOT NULL DEFAULT 0, note TEXT, ask_again INTEGER NOT NULL DEFAULT 1,
  published_by TEXT, published_at TEXT NOT NULL, UNIQUE (clickwrap_id, number)
);
CREATE TABLE IF NOT EXISTS clickwrap_acceptances (
  id TEXT PRIMARY KEY, clickwrap_id TEXT NOT NULL REFERENCES clickwraps(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  version_id TEXT NOT NULL, version INTEGER NOT NULL, terms_sha256 TEXT NOT NULL, identity TEXT NOT NULL, person_id TEXT,
  name TEXT, email TEXT, via TEXT NOT NULL, page_url TEXT, ip TEXT, ua TEXT, given_ip TEXT, given_ua TEXT, shown_ms INTEGER,
  scrolled INTEGER, unobscured INTEGER, recorded_by TEXT, receipt_hash TEXT, seal TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clickwrap_acceptances_account ON clickwrap_acceptances(account_id, at);
CREATE INDEX IF NOT EXISTS clickwrap_acceptances_person ON clickwrap_acceptances(clickwrap_id, person_id);
CREATE INDEX IF NOT EXISTS clickwrap_acceptances_email ON clickwrap_acceptances(clickwrap_id, email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS clickwrap_acceptances_receipt ON clickwrap_acceptances(receipt_hash);
CREATE TRIGGER IF NOT EXISTS clickwrap_acceptances_fixed BEFORE UPDATE ON clickwrap_acceptances BEGIN SELECT RAISE(ABORT, 'An acceptance is never changed.'); END;
CREATE TRIGGER IF NOT EXISTS clickwrap_versions_fixed BEFORE UPDATE ON clickwrap_versions BEGIN SELECT RAISE(ABORT, 'A published version is never changed.'); END;
-- The one copy by email an acceptance may have (clickwrap.ts copyClaim): a row here means it was asked for and sent.
CREATE TABLE IF NOT EXISTS clickwrap_copies (acceptance_id TEXT PRIMARY KEY REFERENCES clickwrap_acceptances(id) ON DELETE CASCADE, at TEXT NOT NULL);
-- Stamps (src/server/stamps.ts). stamp_images: every stamp impression once, by the SHA-256 of its PNG, which is
-- what a stamp field holds as its value. A picture nothing points at any more is taken away (pruneStampImages).
-- stamps: the account's own stamps under Settings, each with the impression it has now. Changing one gives it a
-- new picture and leaves every field that holds the old one as it is.
CREATE TABLE IF NOT EXISTS stamp_images (sha256 TEXT PRIMARY KEY, png BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stamps (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, image_sha TEXT NOT NULL,
  ink TEXT NOT NULL, seed INTEGER NOT NULL, tilt REAL NOT NULL DEFAULT 0, texture REAL NOT NULL DEFAULT 0.5, size_mm REAL NOT NULL DEFAULT 40,
  created_by TEXT, created_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stamps_account ON stamps(account_id);
-- Who was shown which payment link after Finish, and pressed it (src/server/routes-paylink.ts): one row for each person
-- and each address, so after the link changes the sender sees who saw the earlier address and who the new one.
CREATE TABLE IF NOT EXISTS pay_seen (
  recipient_id TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  url TEXT NOT NULL, shown_at TEXT NOT NULL, opened_at TEXT, PRIMARY KEY (recipient_id, url)
);
CREATE INDEX IF NOT EXISTS pay_seen_envelope ON pay_seen(envelope_id);
-- The help chat's limits (src/server/chat.ts): how many questions went to the model in one minute or one day (slot),
-- counted under a keyed fingerprint of an internet address, a signing link or an account, or for everyone ('all').
-- Nothing of what was asked or answered. Rows go after two days.
CREATE TABLE IF NOT EXISTS chat_counts (key TEXT NOT NULL, slot TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, PRIMARY KEY (key, slot));
-- The security record of each account (src/server/seclog.ts): who signed in and who changed what. One line per event
-- and account, chained by hash per account like the audit trail. Ids only, never a password, token, code, key, email
-- address or document content. A line is never changed, and is deleted only once it is older than the days in
-- security_log_keep (SECURITY_LOG_DAYS, written there by the purge) or when its account is deleted: the triggers
-- below refuse an UPDATE, a DELETE, and an INSERT that names a number already used (INSERT OR REPLACE). They stop
-- code and careless hands, not someone who can change the database's own rules: for that the fingerprints are keyed
-- with the server's secret, and security_heads holds the newest line of each account under the same key, so a line
-- rewritten or the newest lines taken away without that secret show (seclog.ts verifySecurityChain).
-- security_alerts_sent: when each alert last emailed an account's admins, and how many more it held back since.
-- api_key_addresses: the internet addresses each key has been used from, so a new one is noticed.
CREATE TABLE IF NOT EXISTS security_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, at TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT,
  ip TEXT, ua TEXT, kind TEXT NOT NULL, outcome TEXT NOT NULL, about_type TEXT, about_id TEXT, details TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS security_events_account ON security_events(account_id, seq);
CREATE INDEX IF NOT EXISTS security_events_at ON security_events(at);
CREATE TABLE IF NOT EXISTS security_log_keep (id INTEGER PRIMARY KEY CHECK (id = 1), days INTEGER NOT NULL);
INSERT OR IGNORE INTO security_log_keep (id, days) VALUES (1, 400);
CREATE TRIGGER IF NOT EXISTS security_events_fixed BEFORE UPDATE ON security_events BEGIN SELECT RAISE(ABORT, 'A line of the security record is never changed.'); END;
CREATE TRIGGER IF NOT EXISTS security_events_kept BEFORE DELETE ON security_events
  WHEN old.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (SELECT days FROM security_log_keep WHERE id = 1) || ' days')
    AND EXISTS (SELECT 1 FROM accounts WHERE id = old.account_id)
  BEGIN SELECT RAISE(ABORT, 'A line of the security record is kept for its days and deleted only with its account.'); END;
CREATE TRIGGER IF NOT EXISTS accounts_security_gone AFTER DELETE ON accounts BEGIN DELETE FROM security_events WHERE account_id = old.id; END;
CREATE TRIGGER IF NOT EXISTS security_events_numbered BEFORE INSERT ON security_events
  WHEN new.seq IS NOT NULL AND new.seq <> -1 AND new.seq <= (SELECT COALESCE(MAX(seq), 0) FROM security_events)
  BEGIN SELECT RAISE(ABORT, 'A line of the security record is never replaced.'); END;
CREATE TRIGGER IF NOT EXISTS security_log_keep_days BEFORE UPDATE ON security_log_keep WHEN new.days < 1 OR new.id <> 1
  BEGIN SELECT RAISE(ABORT, 'The security record is kept for at least one day.'); END;
CREATE TRIGGER IF NOT EXISTS security_log_keep_stays BEFORE DELETE ON security_log_keep
  BEGIN SELECT RAISE(ABORT, 'The security record is kept for at least one day.'); END;
CREATE TABLE IF NOT EXISTS security_heads (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, seq INTEGER NOT NULL, hash TEXT NOT NULL, at TEXT NOT NULL, mac TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS security_alerts_sent (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, rule TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (account_id, rule));
CREATE TABLE IF NOT EXISTS api_key_addresses (key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE, ip TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (key_id, ip));
-- Keeping closed envelopes for a set time (src/server/records.ts). retention_queue: one row for an envelope that the
-- timer has told its sender and admins about (noticed_at, goes_at, level), that someone kept past its date (kept_*), or
-- whose purge someone asked for (asked_*). legal_holds: a hold an admin put on one envelope or on a folder, with the
-- reason, a matter reference and who set and lifted it; override_*: the first of the two people who run the server
-- asking to lift it. legal_hold_items: the envelopes a hold covered when it was placed, or when one left its folder,
-- so moving an envelope out of a held folder never frees it. retention_log: the disposition record (every policy
-- change, keep, hold, purge and refused attempt). A line is never changed; when its account is deleted its names and
-- words are blanked (gone_at), and it may be deleted a year after that. The triggers refuse anything else.
CREATE TABLE IF NOT EXISTS retention_queue (
  envelope_id TEXT PRIMARY KEY REFERENCES envelopes(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  noticed_at TEXT, goes_at TEXT, level TEXT, kept_until TEXT, kept_reason TEXT, kept_by TEXT,
  asked_level TEXT, asked_at TEXT, asked_by TEXT, asked_by_id TEXT
);
CREATE INDEX IF NOT EXISTS retention_queue_account ON retention_queue(account_id);
CREATE TABLE IF NOT EXISTS legal_holds (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, envelope_id TEXT, folder TEXT,
  reason TEXT NOT NULL, matter TEXT, set_by_id TEXT, set_by TEXT NOT NULL, set_at TEXT NOT NULL,
  lifted_at TEXT, lifted_by TEXT, lift_reason TEXT, override_by TEXT, override_reason TEXT, override_at TEXT
);
CREATE INDEX IF NOT EXISTS legal_holds_account ON legal_holds(account_id, lifted_at);
CREATE TABLE IF NOT EXISTS legal_hold_items (hold_id TEXT NOT NULL REFERENCES legal_holds(id) ON DELETE CASCADE, envelope_id TEXT NOT NULL, PRIMARY KEY (hold_id, envelope_id));
CREATE INDEX IF NOT EXISTS legal_hold_items_env ON legal_hold_items(envelope_id);
CREATE TABLE IF NOT EXISTS retention_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, envelope_id TEXT, at TEXT NOT NULL, what TEXT NOT NULL,
  level TEXT, sha256 TEXT, who TEXT, detail TEXT, gone_at TEXT
);
CREATE INDEX IF NOT EXISTS retention_log_account ON retention_log(account_id, id);
CREATE TRIGGER IF NOT EXISTS retention_log_fixed BEFORE UPDATE ON retention_log
  WHEN new.id IS NOT old.id OR new.envelope_id IS NOT old.envelope_id OR new.at IS NOT old.at OR new.what IS NOT old.what OR new.level IS NOT old.level OR new.sha256 IS NOT old.sha256
    OR (new.account_id IS NOT old.account_id AND new.account_id IS NOT NULL) OR (new.who IS NOT old.who AND new.who IS NOT NULL)
    OR (new.detail IS NOT old.detail AND new.detail IS NOT NULL) OR (new.gone_at IS NOT old.gone_at AND old.gone_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'A line of the retention record is never changed.'); END;
CREATE TRIGGER IF NOT EXISTS retention_log_kept BEFORE DELETE ON retention_log
  WHEN old.gone_at IS NULL OR old.gone_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days')
  BEGIN SELECT RAISE(ABORT, 'A line of the retention record is kept.'); END;
-- The certificates this server has sealed completed PDFs with (src/server/seal.ts), so /verify still calls a seal
-- ours after the operator changes the key. Only public facts: the certificate's fingerprint and names.
CREATE TABLE IF NOT EXISTS seal_certs (sha256 TEXT PRIMARY KEY, name TEXT, issuer TEXT, first_at TEXT NOT NULL);
-- Custom fields (src/server/customfields.ts). custom_field_defs: the fields an account defined (a case number, a cost
-- centre), name_key being the name as compared (src/lib/customfields.ts customKey). custom_values: the value of each
-- on an envelope or template, with the name and certificate choice it has there; document_id is '' for the
-- envelope's own fields and the id of a document for that document's name and value pairs (API only). def_id stays
-- after its field is deleted: an envelope that was sent keeps its values.
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, name_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text', choices TEXT, required INTEGER NOT NULL DEFAULT 0, on_certificate INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_defs_name ON custom_field_defs(account_id, name_key);
CREATE TABLE IF NOT EXISTS custom_values (
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, document_id TEXT NOT NULL DEFAULT '', def_id TEXT,
  name TEXT NOT NULL, name_key TEXT NOT NULL, value TEXT NOT NULL, value_key TEXT NOT NULL, on_certificate INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (envelope_id, document_id, name_key)
);
CREATE INDEX IF NOT EXISTS custom_values_find ON custom_values(name_key, value_key);
CREATE INDEX IF NOT EXISTS custom_values_def ON custom_values(def_id);
-- Archive addresses (src/server/archivemail.ts, routes-archive.ts): the addresses an admin named to get a copy of
-- every email the account sends about its documents. confirm_hash: the SHA-256 of the link that confirms it, until
-- confirm_until. confirmed_at: since when copies go there. bounces: copies that came back for good since the last
-- one that arrived; at ARCHIVE_BOUNCES_TO_PAUSE, or when one is marked as spam, paused_at and paused_why ('bounced',
-- 'spam') stop copies until the address is confirmed again, and missed counts the copies that did not go meanwhile.
-- archive_asked: one line for each email that asked an address to confirm, for the daily limits. archive_refused:
-- an address whose reader said "this was not me", which that account cannot ask again until "until".
CREATE TABLE IF NOT EXISTS archive_addresses (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, email TEXT NOT NULL COLLATE NOCASE,
  added_by TEXT, added_by_name TEXT, added_at TEXT NOT NULL, confirm_hash TEXT, confirm_sent_at TEXT, confirm_until TEXT, confirmed_at TEXT,
  bounces INTEGER NOT NULL DEFAULT 0, last_bounce_at TEXT, paused_at TEXT, paused_why TEXT, missed INTEGER NOT NULL DEFAULT 0,
  copies INTEGER NOT NULL DEFAULT 0, last_copy_at TEXT, problem TEXT, problem_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS archive_addresses_one ON archive_addresses(account_id, email);
CREATE INDEX IF NOT EXISTS archive_addresses_hash ON archive_addresses(confirm_hash);
CREATE TABLE IF NOT EXISTS archive_asked (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, email TEXT NOT NULL COLLATE NOCASE, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS archive_asked_account ON archive_asked(account_id, at);
CREATE TABLE IF NOT EXISTS archive_refused (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, email TEXT NOT NULL COLLATE NOCASE, at TEXT NOT NULL, until TEXT NOT NULL,
  token_hash TEXT, added_by TEXT, added_by_name TEXT, added_at TEXT, PRIMARY KEY (account_id, email)
);
-- Trees (src/server/impact.ts). One row for each finished signature of a person who signs: how many mangroves its
-- payment funds (10 when the signature was paid for, 0 when it was free). "who" is a keyed hash of the address, never
-- the address, so a row can outlive its envelope without keeping anybody's name or email.
CREATE TABLE IF NOT EXISTS impact_signed (
  recipient_id TEXT NOT NULL, gen INTEGER NOT NULL DEFAULT 0, envelope_id TEXT, account_id TEXT, who TEXT,
  trees INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, PRIMARY KEY (recipient_id, gen)
);
CREATE INDEX IF NOT EXISTS impact_signed_who ON impact_signed(who);
CREATE INDEX IF NOT EXISTS impact_signed_account ON impact_signed(account_id);
CREATE INDEX IF NOT EXISTS impact_signed_envelope ON impact_signed(envelope_id);
-- The first-time picture is shown once: who has seen it (a keyed hash for a person who signs, the account for a sender).
CREATE TABLE IF NOT EXISTS impact_seen (key TEXT PRIMARY KEY, at TEXT NOT NULL);
-- Wrong confirmation codes typed for an email address, over every login made with it (confirmcode.ts). The key is an
-- HMAC of the address, never the address; a row is forgotten 30 days after its first guess.
CREATE TABLE IF NOT EXISTS confirm_guesses (address_key TEXT PRIMARY KEY, wrong INTEGER NOT NULL DEFAULT 0, first_at TEXT NOT NULL);
-- The account's own consent text (src/server/disclosure.ts). disclosure_versions: every text an admin saved, for one
-- language, with the words as a signer reads them (sections) and their fingerprint. A version is never changed: the
-- trigger refuses it, whatever code asks, and it is never deleted while a document refers to it. Which version is
-- shown today is on the account (accounts.disclosure_now). disclosure_shown: which version a person was shown when
-- they agreed on one document, by the line of the audit trail that says so (audit_seq), so no name is kept here. It
-- goes with the document.
CREATE TABLE IF NOT EXISTS disclosure_versions (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, language TEXT NOT NULL, number INTEGER NOT NULL,
  fields TEXT NOT NULL, sections TEXT NOT NULL, sha256 TEXT NOT NULL, saved_by TEXT, saved_by_name TEXT, saved_at TEXT NOT NULL,
  UNIQUE (account_id, language, number)
);
CREATE TRIGGER IF NOT EXISTS disclosure_versions_fixed BEFORE UPDATE ON disclosure_versions BEGIN SELECT RAISE(ABORT, 'A saved consent text is never changed.'); END;
CREATE TABLE IF NOT EXISTS disclosure_shown (
  id INTEGER PRIMARY KEY AUTOINCREMENT, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, recipient_id TEXT NOT NULL,
  audit_seq INTEGER, version_id TEXT NOT NULL, again INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS disclosure_shown_envelope ON disclosure_shown(envelope_id, id);
CREATE INDEX IF NOT EXISTS disclosure_shown_version ON disclosure_shown(version_id);
CREATE TRIGGER IF NOT EXISTS disclosure_versions_kept BEFORE DELETE ON disclosure_versions
  WHEN EXISTS (SELECT 1 FROM disclosure_shown WHERE version_id = OLD.id) AND EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id)
  BEGIN SELECT RAISE(ABORT, 'A consent text that a document refers to is kept.'); END;
-- Why a rule of an account signed a browser out (src/server/secpolicy.ts): 'idle' or 'elsewhere', by the session's
-- id, so that browser's sign-in page can say why. Forgotten after a day.
CREATE TABLE IF NOT EXISTS session_ends (id TEXT PRIMARY KEY, why TEXT NOT NULL, at TEXT NOT NULL);
-- The monthly report email (src/server/routes-reports.ts): which admins of an account asked for it, since when, and
-- the last month (YYYY-MM) it went out for, so it goes once a month.
CREATE TABLE IF NOT EXISTS report_monthly (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  on_at TEXT NOT NULL, last_month TEXT, PRIMARY KEY (account_id, user_id)
);
-- Saved lists for Send to many (src/server/bulklists.ts): the list as it was pasted or uploaded, who saved it and when,
-- and when it was last used. A list nobody used for accounts.list_days (default 180) is deleted by the timer.
CREATE TABLE IF NOT EXISTS bulk_lists (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, csv TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT
);
CREATE INDEX IF NOT EXISTS bulk_lists_account ON bulk_lists(account_id, name);
-- The time stamp of an envelope's audit trail at completion (src/server/auditstamp.ts): the chain head it is over, the
-- RFC 3161 token (base64) and who gave it and when; or, when no service gave one, why (token NULL).
CREATE TABLE IF NOT EXISTS audit_stamps (
  envelope_id TEXT PRIMARY KEY REFERENCES envelopes(id) ON DELETE CASCADE, head TEXT NOT NULL, token TEXT, tsa_name TEXT,
  tsa_host TEXT, trusted INTEGER NOT NULL DEFAULT 0, stamped_at TEXT, why TEXT, created_at TEXT NOT NULL
);
-- Organisations above accounts (src/server/orgs.ts): a government, its ministries, their agencies. An account
-- belongs to at most one (accounts.org_id). policy is JSON of the rules passed down (src/lib/orgs.ts); break_glass is
-- 1 only when the operator allowed emergency access to a document for this organisation's admins.
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES orgs(id), policy TEXT NOT NULL DEFAULT '{}',
  break_glass INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orgs_parent ON orgs(parent_id);
CREATE TABLE IF NOT EXISTS org_admins (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by TEXT, added_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id)
);
-- What was done at the level of an organisation, for its admins to read. Lines are only ever added. What an org
-- action changed in an account is also written to that account's own security record.
CREATE TABLE IF NOT EXISTS org_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, at TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT,
  kind TEXT NOT NULL, account_id TEXT, details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS org_events_org ON org_events(org_id, seq);
-- Text read by a machine from pages of a file that are pictures (src/server/ocr.ts), one row per file. state: queued,
-- running, done or failed. pages: the page numbers (from 1) to read. The text is a JSON object of page number to
-- text, kept like files.text: in the clear without FILE_ENCRYPTION_KEY, sealed in text_sealed with it.
CREATE TABLE IF NOT EXISTS ocr_jobs (
  file_id TEXT PRIMARY KEY, state TEXT NOT NULL, pages TEXT NOT NULL, lang TEXT, text TEXT, text_sealed TEXT, text_key TEXT,
  tries INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, started_at TEXT, done_at TEXT
);
CREATE INDEX IF NOT EXISTS ocr_jobs_state ON ocr_jobs(state);
-- Whatever deletes a file (a purge, a closed account, a starter) deletes the text read from it too.
CREATE TRIGGER IF NOT EXISTS ocr_jobs_with_file AFTER DELETE ON files BEGIN DELETE FROM ocr_jobs WHERE file_id=OLD.id; END;
-- WhatsApp messages with a signing link (src/server/whatsapp.ts), kept like texts: the number only until the
-- provider took the message, always masked in what anyone reads. status: queued, sent, delivered, failed, outbox.
CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  envelope_id TEXT, recipient_id TEXT, kind TEXT NOT NULL, to_phone TEXT, to_masked TEXT NOT NULL, dest_hash TEXT NOT NULL,
  body TEXT NOT NULL, params TEXT, status TEXT NOT NULL, error TEXT, tries INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL,
  tried_at TEXT, next_try_at TEXT, provider TEXT, provider_id TEXT, delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS wa_messages_envelope ON wa_messages(envelope_id, id);
CREATE INDEX IF NOT EXISTS wa_messages_due ON wa_messages(status, next_try_at);
CREATE INDEX IF NOT EXISTS wa_messages_provider ON wa_messages(provider_id);
CREATE INDEX IF NOT EXISTS wa_messages_dest ON wa_messages(dest_hash);
-- One line for every new WhatsApp message an account caused, for WHATSAPP_DAILY_PER_ACCOUNT.
CREATE TABLE IF NOT EXISTS wa_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, dest_hash TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_usage_account ON wa_usage(account_id, at);
-- Numbers that replied STOP to a WhatsApp message from an account: nothing more goes to them by WhatsApp from it.
CREATE TABLE IF NOT EXISTS wa_stops (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, dest_hash TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (account_id, dest_hash)
);
-- Calls that read a one-time code (src/server/voice.ts). Never the code, and the number only masked.
CREATE TABLE IF NOT EXISTS voice_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  envelope_id TEXT, recipient_id TEXT, to_masked TEXT NOT NULL, dest_hash TEXT NOT NULL, status TEXT NOT NULL,
  error TEXT, at TEXT NOT NULL, provider TEXT, provider_id TEXT,
  said TEXT -- only on a machine without a provider (the outbox): what the call would have read out, code and all
);
-- The text a document was written from in the app (src/server/writedoc.ts), kept with the PDF made from it so the
-- sender can edit it again. source is in the clear only without FILE_ENCRYPTION_KEY; with it, source_sealed holds it.
-- ai is 1 when any of it came from the model: said to the sender only, never on the document or its record.
CREATE TABLE IF NOT EXISTS written_docs (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL, source TEXT, source_sealed TEXT, source_key TEXT, paper TEXT NOT NULL DEFAULT 'a4', ai INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- A full export made in the background (src/server/exportfull.ts): the ZIP is on the disk under exports/ until
-- expires_at, and only an owner or admin of the account downloads it, signed in. error says why one failed.
CREATE TABLE IF NOT EXISTS full_exports (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, ready_at TEXT, expires_at TEXT, bytes INTEGER, envelopes INTEGER, error TEXT, downloaded_at TEXT
);
-- Documents brought in from another server's export or from DocuSign (src/server/importer.ts). They are archived
-- records, never envelopes: nothing here is counted, sent, signed or shown on /verify as completed here. source_id
-- is the id it had where it came from, so the same record is never brought in twice. data is what came with it.
CREATE TABLE IF NOT EXISTS imported_records (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, source TEXT NOT NULL,
  source_deployment TEXT, source_id TEXT, imported_at TEXT NOT NULL, imported_by TEXT NOT NULL, subject TEXT NOT NULL,
  status TEXT, sent_at TEXT, completed_at TEXT, chain_ok INTEGER, banner TEXT NOT NULL, data TEXT NOT NULL,
  UNIQUE(account_id, source, source_deployment, source_id)
);
CREATE TABLE IF NOT EXISTS imported_files (
  record_id TEXT NOT NULL REFERENCES imported_records(id) ON DELETE CASCADE, sha256 TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  PRIMARY KEY (record_id, sha256)
);
CREATE INDEX IF NOT EXISTS imported_files_sha ON imported_files(sha256);
-- Every stored file an import wrote. It outlives its record on purpose: once no record names a file any more (the
-- record or its account was deleted), the timer takes the file off the disk unless something else uses it.
CREATE TABLE IF NOT EXISTS imported_shas (sha256 TEXT PRIMARY KEY, at TEXT NOT NULL);
-- What an import made here (a template, a contact, a group) and what it was where it came from: the id map, and
-- the mark "imported from ... on ..." that stays with it.
CREATE TABLE IF NOT EXISTS import_marks (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, kind TEXT NOT NULL, local_id TEXT NOT NULL,
  source TEXT NOT NULL, source_deployment TEXT, source_id TEXT NOT NULL, at TEXT NOT NULL, note TEXT NOT NULL,
  PRIMARY KEY (account_id, kind, source, source_deployment, source_id)
);
-- A plain summary for signers (src/server/aiassist.ts), written once per file (one version of a document) and kept
-- with it: in the clear only without FILE_ENCRYPTION_KEY, sealed in text_sealed with it. Deleted with its file.
CREATE TABLE IF NOT EXISTS ai_summaries (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  text TEXT, text_sealed TEXT, text_key TEXT, created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ai_summaries_with_file AFTER DELETE ON files BEGIN DELETE FROM ai_summaries WHERE file_id=OLD.id; END;
-- Who was shown a summary of which version (the file ids of the envelope's documents), so the record says it once.
CREATE TABLE IF NOT EXISTS ai_summary_seen (
  recipient_id TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE, version TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (recipient_id, version)
);
-- Email domains an account claims for single sign-on (src/server/orgsso.ts). value is the random text of the TXT
-- record at _growsigning.<domain> that proves it. verified_at: when the record was first found; from then the domain
-- is this account's, and no other account can claim it (org_domains_held) unless the record goes and theirs is found.
-- lost_at: the daily check did not find the record any more; single sign-on is paused for the domain until it is back.
-- use_sso: people at this domain go to the account's sign-in service.
CREATE TABLE IF NOT EXISTS org_domains (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, domain TEXT NOT NULL COLLATE NOCASE,
  value TEXT NOT NULL, use_sso INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, verified_at TEXT, checked_at TEXT, lost_at TEXT,
  UNIQUE (account_id, domain)
);
CREATE INDEX IF NOT EXISTS org_domains_domain ON org_domains(domain);
CREATE UNIQUE INDEX IF NOT EXISTS org_domains_held ON org_domains(domain) WHERE verified_at IS NOT NULL;
-- The account's own sign-in service (OpenID Connect). The client secret is only ever kept encrypted with
-- FILE_ENCRYPTION_KEY (secret_sealed, with the key id in secret_key). tested_at: an admin signed in through it with
-- success since its issuer or client id last changed; nothing on the sign-in page uses it before then. enforce:
-- everyone at its domains signs in through it. join_new: people at its domains become members on their first sign-in.
CREATE TABLE IF NOT EXISTS org_idps (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, issuer TEXT NOT NULL, client_id TEXT NOT NULL,
  secret_sealed TEXT NOT NULL, secret_key TEXT NOT NULL, enforce INTEGER NOT NULL DEFAULT 0, join_new INTEGER NOT NULL DEFAULT 0,
  tested_at TEXT, tested_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- Signing inside a customer's website (src/server/embed.ts). embed_origins: the https websites an account lets show
-- its signing pages and its sender screen inside a frame, up to 5. embed_views: which of them a signing link was
-- handed out for (POST /envelopes/{id}/recipient-view with "frame_origin"); only that website may frame the link.
CREATE TABLE IF NOT EXISTS embed_origins (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, origin TEXT NOT NULL, added_by TEXT, added_at TEXT NOT NULL,
  PRIMARY KEY (account_id, origin)
);
CREATE TABLE IF NOT EXISTS embed_views (
  recipient_id TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE, origin TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (recipient_id, origin)
);
-- The sender's screen inside an app (POST /envelopes/{id}/sender-view). id is the SHA-256 of the link's secret; it
-- opens once, within expires_at. Opening it starts a session for that one draft (session_hash, the SHA-256 of the
-- token the page then sends) that ends at session_expires_at, or when the draft is sent or the screen is closed.
CREATE TABLE IF NOT EXISTS sender_views (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, origin TEXT NOT NULL, return_url TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, session_hash TEXT UNIQUE, session_expires_at TEXT, ended_at TEXT
);
-- The files a sender screen uploaded itself: the only files besides its draft's own that it may read back.
CREATE TABLE IF NOT EXISTS sender_view_files (
  view_id TEXT NOT NULL REFERENCES sender_views(id) ON DELETE CASCADE, file_id TEXT NOT NULL, PRIMARY KEY (view_id, file_id)
);
-- Each time someone opened, or ticked "I have been given" for, a file given to read with a document
-- (src/server/supplements.ts). kind: 'opened' or 'acknowledged'; never "read". By the file it was at the time
-- (file_id), so a replaced file is opened afresh, and counted only after the person's own agreement (consent_at), so
-- whoever takes the place of someone else starts again. The audit trail says who it was.
CREATE TABLE IF NOT EXISTS supplement_marks (
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, document_id TEXT NOT NULL, file_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supplement_marks_env ON supplement_marks(envelope_id);
-- A rule changed by a correction while the document was out (src/server/supplements.ts): from what, to what, when.
-- The certificate says when someone finished before the rule they are listed under was set.
CREATE TABLE IF NOT EXISTS supplement_rules (
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, document_id TEXT NOT NULL,
  from_rule TEXT NOT NULL, rule TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supplement_rules_env ON supplement_rules(envelope_id);
-- Signing at a service counter (src/server/counter.ts). counter_staff: who has the counter permission.
-- counter_templates: the templates used at the counter; show_values lets officials see what the person types.
-- counter_settings: the agency's contact for the receipt, whether an official may also be the witness, and
-- whether a picture of an ID document is kept (only with stored files encrypted).
CREATE TABLE IF NOT EXISTS counter_staff (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by TEXT, at TEXT NOT NULL, PRIMARY KEY (account_id, user_id)
);
CREATE TABLE IF NOT EXISTS counter_templates (
  template_id TEXT PRIMARY KEY REFERENCES envelopes(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  show_values INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counter_settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, contact TEXT,
  official_may_witness INTEGER NOT NULL DEFAULT 0, id_scans INTEGER NOT NULL DEFAULT 0, updated_at TEXT
);
-- One person at the counter with one official: what the official recorded before the document opened.
CREATE TABLE IF NOT EXISTS counter_visits (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL, official_id TEXT NOT NULL, official_name TEXT NOT NULL, created_at TEXT NOT NULL,
  id_method TEXT, id_doc_type TEXT, id_last4 TEXT, id_country TEXT, id_at TEXT, id_scan BLOB, id_scan_type TEXT, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS counter_visits_rcp ON counter_visits(recipient_id);
CREATE TABLE IF NOT EXISTS counter_helps (
  id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES counter_visits(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  language TEXT, interpreter TEXT, by_id TEXT NOT NULL, by_name TEXT NOT NULL, at TEXT NOT NULL,
  second_id TEXT, second_name TEXT, second_at TEXT, withdrawn_at TEXT
);
-- A short code that connects the person's own screen (one use, ten minutes), and the screens it connected.
CREATE TABLE IF NOT EXISTS counter_codes (
  code_hash TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES counter_visits(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS counter_screens (
  token_hash TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES counter_visits(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, ended_at TEXT
);
-- Key dates (src/server/airepo.ts): the dates and amounts of a completed agreement. kind: parties, start, end,
-- renewal, notice or amount. The value and the words it came from are document text: kept sealed in data_sealed with
-- FILE_ENCRYPTION_KEY (in data, as JSON {value, quote}, only without one). day: the date as 2027-03-03, for the
-- filter, the calendar and reminders, and only once confirmed (a proposal's day is in its data). status: 'proposed'
-- (found by the AI, nobody checked it) or 'confirmed' (the sender confirmed or corrected it; then it is also a detail
-- of the envelope in custom_values). by_ai: 1 when the AI found it, 0 when the sender typed it.
CREATE TABLE IF NOT EXISTS key_terms (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
  kind TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, page INTEGER, document TEXT, data TEXT, data_sealed TEXT, data_key TEXT,
  day TEXT, status TEXT NOT NULL DEFAULT 'proposed', by_ai INTEGER NOT NULL DEFAULT 1, corrected INTEGER NOT NULL DEFAULT 0,
  custom_name TEXT, confirmed_by TEXT, confirmed_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS key_terms_env ON key_terms(envelope_id);
CREATE INDEX IF NOT EXISTS key_terms_day ON key_terms(account_id, status, kind, day);
-- When the AI last read an envelope for key dates, and what came of it: 'found', 'none' (nothing found) or 'failed'.
CREATE TABLE IF NOT EXISTS key_scans (
  envelope_id TEXT PRIMARY KEY REFERENCES envelopes(id) ON DELETE CASCADE, state TEXT NOT NULL, at TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 1
);
-- "Remind me": the person who asked is emailed this many days before each confirmed end, notice and renewal date of
-- the envelope. key_reminders_sent: each email once, by the date it was about (a corrected date is a new email).
CREATE TABLE IF NOT EXISTS key_reminders (
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  days INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (envelope_id, user_id)
);
CREATE TABLE IF NOT EXISTS key_reminders_sent (
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, user_id TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL,
  sent_at TEXT NOT NULL, PRIMARY KEY (envelope_id, user_id, kind, day)
);
-- Roles an admin made (src/server/perm.ts, src/lib/perm.ts): a copy of Admin or Member (base) less what it leaves
-- out (left_out, a JSON list of things). memberships.profile_id and invites.profile_id name one.
CREATE TABLE IF NOT EXISTS perm_profiles (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL,
  base TEXT NOT NULL, left_out TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, created_by TEXT
);
CREATE INDEX IF NOT EXISTS perm_profiles_account ON perm_profiles(account_id);
-- Groups of members (Settings, Team): named sets of people on the team. A template's "Who can use this" can name a
-- group (template_member_groups), and a group can give its people a role (profile_id; NULL gives none).
CREATE TABLE IF NOT EXISTS member_groups (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL,
  profile_id TEXT, created_at TEXT NOT NULL, created_by TEXT
);
CREATE INDEX IF NOT EXISTS member_groups_account ON member_groups(account_id);
CREATE TABLE IF NOT EXISTS member_group_people (
  group_id TEXT NOT NULL REFERENCES member_groups(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL, PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS member_group_people_user ON member_group_people(user_id);
CREATE TABLE IF NOT EXISTS template_member_groups (
  template_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, group_id TEXT NOT NULL REFERENCES member_groups(id) ON DELETE CASCADE,
  can_change INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (template_id, group_id)
);
-- Someone who signs for a person while they are away (src/server/delegation.ts). A person with a login names one
-- delegate for dates, in an account whose admins allowed it. starts_on and ends_on are days (YYYY-MM-DD), both
-- included. ended_at is set when the person stops it early or replaces it.
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS delegations_user ON delegations(user_id, account_id);
-- The delegate's own link to one recipient's request, made when the request reached the person during their dates.
-- for_token is the person's own link. Whoever agrees first takes the request on; recipients.delegate_link_id says
-- the delegate did. removed_at: the sender said only the person named may sign, or the person was replaced.
CREATE TABLE IF NOT EXISTS delegate_links (
  id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE, envelope_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL, for_name TEXT NOT NULL, for_email TEXT NOT NULL, for_token TEXT, person_gen INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL, email TEXT NOT NULL, token TEXT NOT NULL UNIQUE, check_code TEXT, set_on TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL,
  created_at TEXT NOT NULL, sent_at TEXT, viewed_at TEXT, checked_at TEXT, checked_how TEXT, removed_at TEXT
);
CREATE INDEX IF NOT EXISTS delegate_links_recipient ON delegate_links(recipient_id);
CREATE INDEX IF NOT EXISTS delegate_links_for ON delegate_links(for_token);
CREATE INDEX IF NOT EXISTS delegate_links_envelope ON delegate_links(envelope_id);
-- Working for a colleague (src/server/shares.ts): owner_id shares the documents they send with grantee_id, in the
-- same account, at a level ('see', 'manage', 'send') from starts_on to ends_on (days, YYYY-MM-DD, both included;
-- ends_on NULL: until someone ends it). ended_at and ended_by when it was ended early or replaced.
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, grantee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT, created_at TEXT NOT NULL, created_by TEXT, ended_at TEXT, ended_by TEXT
);
CREATE INDEX IF NOT EXISTS shares_owner ON shares(account_id, owner_id);
CREATE INDEX IF NOT EXISTS shares_grantee ON shares(account_id, grantee_id);
-- The completed copy made for one person whose view was limited ("Each person sees only their files",
-- src/server/visibility.ts): their files and the certificate. sha256 is the stored file, so /verify knows it too.
-- A group has one copy for the group's row.
CREATE TABLE IF NOT EXISTS final_copies (
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, recipient_id TEXT NOT NULL,
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, docs TEXT NOT NULL, made_at TEXT NOT NULL, PRIMARY KEY (envelope_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS final_copies_sha ON final_copies(sha256);
-- Tree commitments of government contracts (src/server/commitments.ts), filled in by the operator. Per contract,
-- never per signature: share_pct of the fee funds trees_per_year mangroves. Only status 'signed' is ever shown.
CREATE TABLE IF NOT EXISTS tree_commitments (
  id TEXT PRIMARY KEY, holder TEXT NOT NULL, agreement_ref TEXT NOT NULL, band TEXT NOT NULL, share_pct REAL NOT NULL,
  trees_per_year INTEGER NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT, status TEXT NOT NULL DEFAULT 'draft',
  signed_on TEXT, created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT
);
-- The yearly planting statement of a commitment: where, when, which species, how many, and the evidence Treegens
-- provides (links, one per line). One per commitment and year.
CREATE TABLE IF NOT EXISTS tree_statements (
  id TEXT PRIMARY KEY, commitment_id TEXT NOT NULL REFERENCES tree_commitments(id) ON DELETE CASCADE, year INTEGER NOT NULL,
  sites TEXT NOT NULL, planted_from TEXT NOT NULL, planted_to TEXT NOT NULL, species TEXT NOT NULL, trees INTEGER NOT NULL,
  evidence TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT, UNIQUE (commitment_id, year)
);
-- A form's answers that were not signed yet (src/server/webforms.ts), kept for the one browser that typed them
-- (browser is a random id in that browser's cookie) for a day, or for the minutes of a shared-device form. Nothing
-- else: no envelope and no signature exist until the person goes on to sign.
CREATE TABLE IF NOT EXISTS form_drafts (
  powerform_id TEXT NOT NULL REFERENCES powerforms(id) ON DELETE CASCADE, browser TEXT NOT NULL, ip TEXT,
  name TEXT, email TEXT, answers TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (powerform_id, browser)
);
CREATE INDEX IF NOT EXISTS form_drafts_ip ON form_drafts(ip, updated_at);
-- SAML 2.0 single sign-on (src/server/saml.ts). org_saml: one line per account whose admin opened the card, with the
-- random part of our own address for it (sp_id: entity id and metadata at /api/sso/saml/<sp_id>), and, once the
-- identity provider's metadata was pasted, its entity id, its sign-in address (HTTP-Redirect) and its signing
-- certificates (JSON list of base64 DER). org_idps holds the name, the switches and "tried" for it, with kind 'saml'.
-- saml_requests: the AuthnRequests we sent that have not been answered (InResponseTo must name one, once).
-- saml_seen: every assertion accepted, until it would expire, so none is accepted twice.
CREATE TABLE IF NOT EXISTS org_saml (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, sp_id TEXT NOT NULL UNIQUE, entity_id TEXT, sso_url TEXT,
  certs TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saml_requests (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saml_seen (key TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
-- Members from a directory (SCIM 2.0, src/server/scim.ts). org_directory: the account's one bearer token (only its
-- SHA-256 is kept), whether invitations by hand are stopped (managed), and who takes over what a removed member sent
-- (heir_id; NULL: the owner). scim_users: each person the directory told us about, by address (user_name); active 0
-- when the directory switched them off. Whether they are a member is always read from memberships, never kept here.
CREATE TABLE IF NOT EXISTS org_directory (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, token_hash TEXT UNIQUE, token_prefix TEXT, made_by TEXT, made_at TEXT,
  last_used_at TEXT, managed INTEGER NOT NULL DEFAULT 0, heir_id TEXT
);
CREATE TABLE IF NOT EXISTS scim_users (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, user_name TEXT NOT NULL COLLATE NOCASE,
  external_id TEXT, given_name TEXT, family_name TEXT, display_name TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (account_id, user_name)
);
-- Saved fields (src/server/fieldkinds.ts, src/lib/fieldkinds.ts): a field an admin saved under a name for the team's
-- editor. spec: JSON of its kind, label, checks, size and text style; never a value, a person or a place on a page.
CREATE TABLE IF NOT EXISTS saved_fields (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, name_key TEXT NOT NULL,
  spec TEXT NOT NULL, made_by TEXT, made_at TEXT NOT NULL, UNIQUE (account_id, name_key)
);
-- The photo each page was cleaned from, when the sender's browser found the page in a photo, straightened it and
-- raised its contrast before uploading (src/server/scanphotos.ts). page counts from 1. They go with their file: the
-- trigger (not a foreign key, so it sees the rows) notes each stored photo in scan_photos_gone, and the timer takes it off the disk once nothing uses it.
CREATE TABLE IF NOT EXISTS scan_photos (
  file_id TEXT NOT NULL, page INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  name TEXT, cleaned INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY (file_id, page)
);
CREATE TABLE IF NOT EXISTS scan_photos_gone (sha256 TEXT PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS scan_photos_with_file AFTER DELETE ON files BEGIN
  INSERT OR IGNORE INTO scan_photos_gone (sha256) SELECT sha256 FROM scan_photos WHERE file_id=OLD.id;
  DELETE FROM scan_photos WHERE file_id=OLD.id;
END;
-- Payments taken while signing, into the sending account's own Stripe account (src/server/collect.ts). GrowSigning is
-- never the merchant and never sees card details: Stripe's own page takes them. collect_accounts: the Stripe account
-- an account connected. collect_states: the one-time value of a connect in progress. collect_payments: one row for each
-- person and address that is asked to pay; "paid" only after Stripe's message says so and Stripe confirms it again.
-- finish_body: for "pay before finishing", what the person signed, kept until Stripe confirms and their part completes.
-- collect_events: the ids of Stripe's messages already handled, so a message sent twice is applied once.
CREATE TABLE IF NOT EXISTS collect_accounts (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, stripe_account TEXT NOT NULL, name TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0, connected_by TEXT, connected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collect_states (state TEXT PRIMARY KEY, account_id TEXT NOT NULL, user_id TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collect_payments (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE, email TEXT NOT NULL DEFAULT '', account_id TEXT NOT NULL,
  stripe_account TEXT NOT NULL, merchant TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, for_text TEXT, when_to TEXT NOT NULL,
  status TEXT NOT NULL, session_id TEXT UNIQUE, session_url TEXT, payment_intent TEXT, paid_at TEXT, refunded INTEGER NOT NULL DEFAULT 0,
  refunded_at TEXT, dispute TEXT, dispute_at TEXT, finish_body TEXT, finish_ip TEXT, finish_ua TEXT, note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (recipient_id, email)
);
CREATE INDEX IF NOT EXISTS collect_payments_envelope ON collect_payments(envelope_id);
CREATE INDEX IF NOT EXISTS collect_payments_intent ON collect_payments(payment_intent);
CREATE TABLE IF NOT EXISTS collect_events (id TEXT PRIMARY KEY, at TEXT NOT NULL);
-- collect_sessions: every Stripe page made for a payment row, with the amount it asked. A payment on an older page
-- (the amount changed meanwhile) is still found and recorded, never dropped. closed_at: Stripe said it is closed.
CREATE TABLE IF NOT EXISTS collect_sessions (
  session_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES collect_payments(id) ON DELETE CASCADE, stripe_account TEXT NOT NULL,
  amount INTEGER NOT NULL, currency TEXT NOT NULL, at TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS collect_sessions_payment ON collect_sessions(payment_id);
-- Signing in person without a connection (src/server/offlinesign.ts): one copy got ready on a host's device for one
-- person, the content version it was made from, when it ends, and, once it came back, the device's clock and when we got it.
CREATE TABLE IF NOT EXISTS offline_preps (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, recipient_id TEXT NOT NULL,
  user_id TEXT NOT NULL, session_id TEXT NOT NULL, content_version INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready', ended_at TEXT, ended_why TEXT, device_at TEXT, received_at TEXT
);
CREATE INDEX IF NOT EXISTS offline_preps_rec ON offline_preps(recipient_id, state);
CREATE INDEX IF NOT EXISTS offline_preps_session ON offline_preps(session_id, state);
-- Signed on paper (src/server/paper.ts): each scan one person sent back through their own link, the content version
-- and the security code of the print it was made from, where it came from, and what the sender decided about it.
-- state: waiting, accepted or asked_again (with the sender's reason).
CREATE TABLE IF NOT EXISTS paper_scans (
  id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, recipient_id TEXT NOT NULL,
  file_id TEXT NOT NULL, pages INTEGER NOT NULL, sha256 TEXT NOT NULL, content_version INTEGER NOT NULL, code TEXT NOT NULL,
  at TEXT NOT NULL, ip TEXT, ua TEXT, state TEXT NOT NULL DEFAULT 'waiting', decided_at TEXT, decided_by TEXT, reason TEXT
);
CREATE INDEX IF NOT EXISTS paper_scans_rec ON paper_scans(recipient_id, at);
-- A field anyone on the document can fill in (src/server/collab.ts): every change, who made it, what it said before and
-- after, and the initials they gave for it when the sender asked for initials on a change. before, after and
-- initials_png are sealed like answers (colcrypt.ts).
CREATE TABLE IF NOT EXISTS shared_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE, field_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL, name TEXT NOT NULL, before TEXT, after TEXT, initials_png TEXT, sign_again TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shared_changes_env ON shared_changes(envelope_id, field_id, id);
-- The automatic Adobe Acrobat check (src/server/acrobat.ts): one row per sample PDF made for the program that opens it
-- in Acrobat, with the time-stamp service that answered and, once reported, what Acrobat showed and the server's
-- verdict. The screenshot is a file in the blob store (screenshot_sha256). The last 60 are kept. No customer data.
CREATE TABLE IF NOT EXISTS acrobat_checks (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, tsa_host TEXT NOT NULL, tsa_name TEXT, tsa_time TEXT, trusted INTEGER NOT NULL DEFAULT 0,
  forced INTEGER NOT NULL DEFAULT 0, pdf_sha256 TEXT NOT NULL, ip TEXT, reported_at TEXT, verdict TEXT, banner_text TEXT, banner_colour TEXT,
  panel_lines TEXT, acrobat_version TEXT, os TEXT, notes TEXT, screenshot_sha256 TEXT, screenshot_size INTEGER,
  alerted INTEGER NOT NULL DEFAULT 0, missed_alerted_at TEXT
);
CREATE INDEX IF NOT EXISTS acrobat_checks_at ON acrobat_checks(created_at);
-- What the Acrobat check told the operators once (a day without a time stamp, a silence) and when the first check was.
CREATE TABLE IF NOT EXISTS acrobat_marks (key TEXT PRIMARY KEY, at TEXT NOT NULL);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS never alters an existing table, so each
// one is added here if it is missing. Only ever append to this list.
const COLUMNS: [table: string, column: string, definition: string][] = [
  // How far the page turns a stamp's picture when it prints it, in degrees (src/lib/stamps.ts stampTurn). 0 for a
  // picture made with its tilt drawn in.
  ['stamps', 'turn', 'REAL NOT NULL DEFAULT 0'],
  ['users', 'notify', 'TEXT'],
  ['users', 'locale', 'TEXT'],
  ['accounts', 'suspended_at', 'TEXT'],
  ['accounts', 'suspended_reason', 'TEXT'],
  ['accounts', 'renews_at', 'TEXT'],
  ['accounts', 'cancel_at', 'TEXT'],
  ['payments', 'receipt_url', 'TEXT'],
  ['payments', 'charge_id', 'TEXT'],
  ['payments', 'refunded_at', 'TEXT'],
  ['recipients', 'check_code', 'TEXT'],
  ['recipients', 'locale', 'TEXT'],
  ['envelopes', 'test_mode', 'INTEGER NOT NULL DEFAULT 0'],
  ['envelopes', 'locale', 'TEXT'],
  ['webhook_deliveries', 'body', 'TEXT'],
  ['envelopes', 'expiry_warned_at', 'TEXT'],
  ['recipients', 'muted', 'INTEGER NOT NULL DEFAULT 0'],
  ['accounts', 'cancel_ref', 'TEXT'],
  ['accounts', 'dormant_nudged_at', 'TEXT'],
  ['envelopes', 'date_format', 'TEXT'],
  ['users', 'closing_at', 'TEXT'],
  ['accounts', 'closing_at', 'TEXT'],
  ['files', 'text', 'TEXT'],
  ['recipients', 'unopened_alerted_at', 'TEXT'],
  ['recipients', 'dead_link_alerted_at', 'TEXT'],
  ['webhooks', 'alerted_at', 'TEXT'],
  ['payments', 'kind', "TEXT NOT NULL DEFAULT 'plan'"],
  ['payments', 'credits', 'INTEGER NOT NULL DEFAULT 0'],
  ['payments', 'refunded_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['powerforms', 'alerted_at', 'TEXT'],
  // The login an email to somebody else is about (an invitation someone sent, a notice about someone's API keys or
  // that they left a team), so our copy of it can be deleted with that login without guessing from names.
  ['emails', 'about_user', 'TEXT'],
  // The monthly price this account is on, before tax: what its last plan payment was held to. And the notice of a
  // higher price, if one was sent: the new price, the day it starts, and when the email about it left.
  ['accounts', 'price_cents', 'INTEGER'],
  ['accounts', 'price_notice_cents', 'INTEGER'],
  ['accounts', 'price_notice_from', 'TEXT'],
  ['accounts', 'price_notice_at', 'TEXT'],
  // 1 on a public form that people fill in on a shared device or from one office network (a tablet at the front
  // desk). More unfinished starts are allowed from one address, and an abandoned one is cleared sooner.
  ['powerforms', 'shared_device', 'INTEGER NOT NULL DEFAULT 0'],
  // The last time this person's answers were saved while filling in. Typing counts as being there.
  ['recipients', 'touched_at', 'TEXT'],
  ['accounts', 'promo_code', 'TEXT'],
  ['accounts', 'promo_at', 'TEXT'],
  ['emails', 'recipient_id', 'TEXT'],
  // 1 when this signer is the sender signing their own document (free), 0 when the signature is paid for. Decided
  // when the request goes out, so a later change of sender or of the sender's own address cannot flip it.
  ['recipients', 'free', 'INTEGER'],
  // The recipient a held signature is for (credits.ts), so a hold is kept for the moment between their Finish and
  // the "signature used" line, and the signature is taken from the lot it was held in.
  ['credit_holds', 'rid', 'TEXT'],
  // How many signatures of this lot were held when its date passed and have been let go since, not yet written off
  // as expired (credits.ts, letGo): the plan history then says so, with the moment they were let go.
  ['credit_lots', 'late', 'INTEGER DEFAULT 0'],
  ['users', 'tz', 'TEXT'],
  // The time zone a signer's device reported when they agreed and when they finished (an IANA name like
  // "Asia/Kolkata"). The date they sign on is the calendar day there, the certificate prints their local time, and
  // automatic reminders wait for their morning.
  ['recipients', 'tz', 'TEXT'],
  // Set when an automatic reminder fell in this person's night and waits for 8:00 their time. Cleared when it goes out.
  ['recipients', 'reminder_held_at', 'TEXT'],
  // The date format new envelopes of this account start with (one of DATE_FORMATS in src/lib/dates.ts). Empty means year-month-day.
  ['accounts', 'default_date_format', 'TEXT'],
  ['accounts', 'renewal_reminded', 'TEXT'],
  ['accounts', 'renewal_quoted_cents', 'INTEGER'],
  ['accounts', 'sub_event_at', 'INTEGER'],
  ['accounts', 'trusted_at', 'TEXT'],
  ['payments', 'customer_id', 'TEXT'],
  ['payments', 'applied_at', 'TEXT'],
  ['payments', 'self_refund_at', 'TEXT'],
  ['payments', 'refund_pending_at', 'TEXT'],
  ['payments', 'credits_refunded', 'INTEGER NOT NULL DEFAULT 0'],
  ['payments', 'subscription_id', 'TEXT'],
  ['payments', 'invoice_id', 'TEXT'],
  ['accounts', 'dispute_at', 'TEXT'],
  ['accounts', 'plan_started_at', 'TEXT'],
  ['accounts', 'dormant_kept_for', 'TEXT'],
  ['accounts', 'promo_missing_since', 'TEXT'],
  ['billing_todo', 'last_at', 'TEXT'],
  ['payments', 'disputed', 'TEXT'],
  ['payments', 'dispute_taken', 'INTEGER NOT NULL DEFAULT 0'],
  ['accounts', 'renewal_tax_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['accounts', 'invoice_checked_at', 'TEXT'],
  ['refunds', 'refused', 'INTEGER NOT NULL DEFAULT 0'],
  // What a key may do: 'send' (everyday work, the default) or 'admin' (account settings too). See router.ts.
  ['api_keys', 'scope', "TEXT NOT NULL DEFAULT 'send'"],
  // Set when the key's owner left the account: an admin removed them, or their own login was deleted. The row
  // stays so admins can see which keys stopped.
  ['api_keys', 'stopped_at', 'TEXT'],
  // The name of the person who made the key, kept on the row when their login is deleted, so a stopped key in a
  // team's list still says whose it was.
  ['api_keys', 'owner_was', 'TEXT'],
  // 0 while a webhook delivery is still being tried. The row is written before the first try.
  ['webhook_deliveries', 'done', 'INTEGER NOT NULL DEFAULT 1'],
  // The Idempotency-Key a bulk send came with, and a hash of its body. The key belongs to the batch's sender.
  ['bulk_batches', 'idem_key', 'TEXT'],
  ['bulk_batches', 'request_hash', 'TEXT'],
  // When "Signing link issued" was last written to the audit trail for this recipient. At most once a day per link.
  ['recipients', 'link_issued_at', 'TEXT'],
  // Wrong tries at this recipient's access code since the code was set, and when it was frozen for too many of them.
  // Setting a new code clears both.
  ['recipients', 'code_fails', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'code_frozen_at', 'TEXT'],
  // When a person last lifted a pause. Reports from before that have been looked at and do not count again.
  ['accounts', 'unpaused_at', 'TEXT'],
  // An envelope started from a public form: which recipient is the visitor, and the device address it was started from.
  ['envelopes', 'form_recipient_id', 'TEXT'],
  ['envelopes', 'form_ip', 'TEXT'],
  // What the sender wrote into a field that its signer may still change. It is kept beside the value, so every
  // signer can be shown the sender's wording before the field's owner has answered, and so it comes back when the
  // field passes to another person. Notes and read-only fields keep the sender's words in value itself.
  ['fields', 'prefill', 'TEXT'],
  // Goes up whenever a correction changes what a signer would see or sign. The signing screen sends the number it
  // was shown with every save and with Finish, and a Finish on an older number is refused.
  ['envelopes', 'content_version', 'INTEGER NOT NULL DEFAULT 1'],
  // The content version this recipient's signing screen was last given.
  ['recipients', 'seen_version', 'INTEGER'],
  // Goes up with every save from the editor or the API, with who saved and when, so a save made from an older copy
  // is refused instead of wiping a colleague's work.
  ['envelopes', 'edit_version', 'INTEGER NOT NULL DEFAULT 0'],
  ['envelopes', 'edited_by', 'TEXT'],
  ['envelopes', 'edited_at', 'TEXT'],
  // When this person finished before the sender changed the document and asked them to sign again. One time per
  // line, oldest first. The certificate prints them next to the new signature.
  ['recipients', 'signed_before', 'TEXT'],
  // What the latest correction changed on the documents, in words. Quoted to the people who have to look again.
  ['envelopes', 'last_change', 'TEXT'],
  // A replaced link keeps the security code of the email that carried it, so /check can still say that email was
  // genuine: which envelope it was for, who it was sent to, and why its link stopped (address, role, handed, removed).
  ['retired_tokens', 'check_code', 'TEXT'],
  ['retired_tokens', 'envelope_id', 'TEXT'],
  ['retired_tokens', 'sent_to', 'TEXT'],
  ['retired_tokens', 'why', 'TEXT'],
  // When this person was given the welcome signatures, at sign-up or with the workspace made for them when they
  // signed in without one. A person gets them once, however many workspaces are made for them.
  ['users', 'welcomed_at', 'TEXT'],
  // The workspace this person used last. Signing in opens it.
  ['users', 'last_account_id', 'TEXT'],
  // The closing date the "one week left" email was sent for, so it goes out once for each time an account is closed.
  ['users', 'closing_reminded', 'TEXT'],
  // Set when the sender deleted a completed envelope. It is gone from the sender's lists, search, export and
  // reports, and every recipient keeps their link and their copy. It is removed for good with the account.
  ['envelopes', 'hidden_at', 'TEXT'],
  // The reference a help request was answered with: eight characters nobody can misread.
  ['support_requests', 'ref', 'TEXT'],
  // 1 on a request that was still open when its writer's account was deleted. It goes once it has been answered.
  ['support_requests', 'forget', 'INTEGER NOT NULL DEFAULT 0'],
  // "Fix my name": the name the sender wrote for this person, kept when the signer changes how it is written, and
  // the name the signer changed it to. A fix is checked against what the sender wrote, not against an earlier fix.
  // When name is no longer self_name, the sender has changed it since and that is the sender's wording again.
  ['recipients', 'sender_name', 'TEXT'],
  ['recipients', 'self_name', 'TEXT'],
  // When the sender was told that somebody opened this replaced link. Said once for each link.
  ['retired_tokens', 'alerted_at', 'TEXT'],
  // The pages of an uploaded file that are pictures with no text (a scan, a photo), as a JSON list counted from 1.
  // Empty or missing means every page has text. Kept with the file, so the warning is there whenever it is listed.
  ['files', 'scan_pages', 'TEXT'],
  // An email the mail server would not take is tried again by the timer. payload holds what is needed to send it
  // again besides the html (who it is from, the plain text, which stored files are attached). tries counts the
  // attempts, tried_at is the latest one, next_try_at is when the timer tries again (empty: no more tries), and
  // expires_at is when a link or code in it stops working, after which it is never sent again.
  ['emails', 'payload', 'TEXT'],
  ['emails', 'tries', 'INTEGER NOT NULL DEFAULT 0'],
  ['emails', 'tried_at', 'TEXT'],
  ['emails', 'next_try_at', 'TEXT'],
  ['emails', 'expires_at', 'TEXT'],
  // A help request as a ticket (src/server/routes-support.ts). priority is 'urgent' or 'normal', decided by the
  // topic. owner_id is the operator who took it. due_at is the moment by which a person will have answered, and is
  // empty while the clock is stopped (we asked the customer something, we answered, it is closed) or when no promise
  // was made. escalated_for is the due time the operators were emailed about, so they are told once for each time a
  // request is late. first_reply_at is when a person first wrote back. closed_how says who closed it and why.
  ['support_requests', 'priority', 'TEXT'],
  ['support_requests', 'owner_id', 'TEXT'],
  ['support_requests', 'due_at', 'TEXT'],
  ['support_requests', 'escalated_for', 'TEXT'],
  ['support_requests', 'first_reply_at', 'TEXT'],
  ['support_requests', 'closed_at', 'TEXT'],
  ['support_requests', 'closed_how', 'TEXT'],
  ['support_requests', 'updated_at', 'TEXT'],
  // The fingerprint of the secret in the private link to this request. The secret itself is only ever in the email.
  ['support_requests', 'secret_hash', 'TEXT'],
  // 1 when the first message was written by someone signed in under their own confirmed address. Anyone can type
  // any address into the form, so the words of any other first message are not shown back until a person has read it.
  ['support_requests', 'verified', 'INTEGER NOT NULL DEFAULT 0'],
  // The writer's time zone where known, so "answered by Tuesday 14:00" in an email is their Tuesday 14:00.
  ['support_requests', 'tz', 'TEXT'],
  // The older request this one continues: a reply that came after the time for reopening had passed.
  ['support_requests', 'follows', 'TEXT'],
  // How the first message came in, so the people who answer are told who wrote it: 'signed_in' (signed in under
  // the address as a confirmed one), 'link' (through the private link we emailed to it), 'form' (anyone, or someone
  // signed in under another address), 'software' (an alert). Empty on rows from before (fillOldRequests in
  // src/server/routes-support.ts fills them in).
  ['support_requests', 'came_by', 'TEXT'],
  // What the latest change to an envelope was when it was not a save from the editor: a quick correction of one
  // person, a signer passing the document on or fixing their name, or sending. It finishes the sentence that starts
  // with edited_by ("passed this document on to Mary Deputy"), and is empty after an ordinary save.
  ['envelopes', 'edited_how', 'TEXT'],
  // Which count a line in `reached` belongs to. Empty: someone a sender chose to email. 'form:' and a form's id: a
  // visitor of that public form, counted for the form alone. 'invite': someone invited to the team.
  ['reached', 'via', 'TEXT'],
  // When the sender was told that emails for this envelope are being held back (the account is paused, or the
  // envelope reads like a fake payment notice). Said once, and cleared when they go out.
  ['envelopes', 'held_at', 'TEXT'],
  // 1 on a report made by the visitor of a public form. That person typed their own name and address, so three of
  // them are not three recipients: the report is kept and shown to operators, and never counts towards a pause.
  ['abuse_reports', 'via_form', 'INTEGER NOT NULL DEFAULT 0'],
  // The account a deleted document's email came from (an id, nothing about a person), so the holder of that email
  // can still report it against the account. reported is 1 when that same person had reported it before the
  // document was deleted, so the two never count as two people.
  ['forgotten_codes', 'account_id', 'TEXT'],
  ['forgotten_codes', 'reported', 'INTEGER NOT NULL DEFAULT 0'],
  // Checking who signs (src/server/signercode.ts). verify is the check the sender asked for before the document
  // opens for this person: 'email_code' or 'sms_code', empty for none. phone is the mobile number the sender typed
  // for them, in international form, kept here and nowhere else. text_link is 1 when the signing link is also sent
  // by text message. check_gen goes up whenever the check or the number changes, which makes every device pass the
  // check again. checked_at, checked_how and checked_for are the record of a code typed correctly: when, what it
  // was sent as and to where (masked), and a fingerprint of the link it was passed under, so the record stops
  // counting the moment the link passes to another person. check_stop is set when someone using the link said the
  // number is not theirs: no more codes go to it until the sender corrects it. texted_at is the last text with a
  // link or a reminder to this person, so reminders by text follow at most once a day.
  ['recipients', 'verify', 'TEXT'],
  ['recipients', 'phone', 'TEXT'],
  ['recipients', 'text_link', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'check_gen', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'checked_at', 'TEXT'],
  ['recipients', 'checked_how', 'TEXT'],
  ['recipients', 'checked_for', 'TEXT'],
  ['recipients', 'check_stop', 'TEXT'],
  ['recipients', 'texted_at', 'TEXT'],
  // Which daily allowance of codes to one mailbox or number a code counts against: the sender's account, or for the
  // visitor of a public form that form alone ("form:<id>"), so codes a stranger asks for through one never use up
  // what anyone else's document may send. Empty on older lines: the account.
  ['signer_codes', 'bucket', 'TEXT'],
  // The document exactly as this person signed it, as a stored PDF (its fingerprint), made at the moment their
  // signature was set aside. It is what they download when they ask for what they signed the first time.
  ['earlier_signatures', 'copy_sha256', 'TEXT'],
  // What the mail provider told us about an email after it took it (POST /mail/events, src/server/bounces.ts).
  // message_id is the Message-ID we gave the email, without the angle brackets, which providers hand back with their
  // news. delivered_at: the recipient's mail server took it. bounced_at, bounce_kind ('hard': the address does not
  // work, 'soft': try later) and bounce_reason: it came back. complained_at: the reader marked it as spam.
  ['emails', 'message_id', 'TEXT'],
  ['emails', 'delivered_at', 'TEXT'],
  ['emails', 'bounced_at', 'TEXT'],
  ['emails', 'bounce_kind', 'TEXT'],
  ['emails', 'bounce_reason', 'TEXT'],
  ['emails', 'complained_at', 'TEXT'],
  // What the mail server or the provider wrote about a bounce, cleaned. For the people who run the server only (the
  // dev outbox): it is written by whoever runs the recipient's mail server, so it never reaches a customer, who is
  // told bounce_reason, in our own words.
  ['emails', 'bounce_said', 'TEXT'],
  // An email to this recipient came back for good: when, and why in plain words. Reminders stop until the address
  // is changed or the sender says "try again". complained_at: this person marked an email about the envelope as
  // spam, so nothing more is emailed to them about it unless they ask. A trigger (see migrate) clears all three
  // when the address changes, because they are facts about an address.
  ['recipients', 'bounced_at', 'TEXT'],
  ['recipients', 'bounce_reason', 'TEXT'],
  ['recipients', 'complained_at', 'TEXT'],
  // An email to this login came back for good. The app says so on every page until the address is changed or the
  // person says it works again.
  ['users', 'email_bounced_at', 'TEXT'],
  ['users', 'email_bounce_reason', 'TEXT'],
  // Where a person is signed in (Settings, "Where you are signed in"). created_at: when this browser signed in.
  // last_used_at: the last time it was used, written at most once an hour. ua: what the browser called itself then,
  // from which the page makes "iPhone, Safari". No address is kept. A session from before these columns has none
  // of the three until it is next used.
  ['sessions', 'created_at', 'TEXT'],
  ['sessions', 'last_used_at', 'TEXT'],
  ['sessions', 'ua', 'TEXT'],
  // Set when this browser opened the signing page of someone who signs in person: the device is in a signer's
  // hands, so the session opens nothing until its owner types their password (src/server/handover.ts). locked_note
  // is where to go back to afterwards: the envelope and the signer's name, as JSON.
  ['sessions', 'locked_at', 'TEXT'],
  ['sessions', 'locked_note', 'TEXT'],
  // Tries at the owner's password since the lock went on, counted before each one is checked (handover.ts), so
  // tries sent at the same moment cannot all pass on one count.
  ['sessions', 'unlock_tries', 'INTEGER NOT NULL DEFAULT 0'],
  // When the owner of a public form made before the stacked-field rule was last told that two of its fields cover
  // each other (visitors are let through; Text view reaches every field). Once a day at most.
  ['powerforms', 'stacked_told_at', 'TEXT'],
  // The envelope through whose signing link a signer uploaded this file. Such a file belongs to no account, so
  // this is what lets it go with the envelope (or its account) also when it was never attached to a field.
  ['files', 'via_envelope', 'TEXT'],
  // A recipient that is a group (src/server/groups.ts). group_id is the account's group it was made from, and
  // group_name its name: on a draft or template both follow the saved group, and from the moment the envelope is
  // sent group_name is the name it went out under. claimed_by is the member (recipient_members.id) who took the
  // document on, with when: from then the row carries that person's name, address and link like any recipient's.
  ['recipients', 'group_id', 'TEXT'],
  ['recipients', 'group_name', 'TEXT'],
  ['recipients', 'claimed_by', 'TEXT'],
  ['recipients', 'claimed_at', 'TEXT'],
  // 1 when the sender said "I will send the link myself": the person has a name and no email address, nothing is
  // ever emailed to them, and the sender passes their link on (src/server/bysender.ts).
  ['recipients', 'link_by_sender', 'INTEGER NOT NULL DEFAULT 0'],
  // A link to the sender's own payment page, shown to a signer after Finish (src/server/routes-paylink.ts): the
  // address and which button it gets, and for each signer the address they were last shown and last pressed, with
  // when they first were.
  ['envelopes', 'pay_url', 'TEXT'],
  ['envelopes', 'pay_kind', 'TEXT'],
  ['recipients', 'pay_shown_url', 'TEXT'],
  ['recipients', 'pay_shown_at', 'TEXT'],
  ['recipients', 'pay_opened_url', 'TEXT'],
  ['recipients', 'pay_opened_at', 'TEXT'],
  // Who may use and change a template (src/server/tplroles.ts). tpl_use: 'team' (empty is the same), 'admins' or
  // 'chosen'. tpl_change: 'owner' (empty is the same: the person it belongs to and admins), 'chosen' or 'team'.
  // tpl_locked: 1 when its wording is locked for whoever may not change it. A template from before has the defaults.
  ['envelopes', 'tpl_use', 'TEXT'],
  ['envelopes', 'tpl_change', 'TEXT'],
  ['envelopes', 'tpl_locked', 'INTEGER NOT NULL DEFAULT 0'],
  // On an envelope started from a locked template: which template (wording_from), and which of its fields carry the
  // template's own wording (wording_fixed, a JSON list of field ids). Whoever may not change that template cannot
  // change the documents, the fields, that wording or the message of the envelope.
  ['envelopes', 'wording_from', 'TEXT'],
  ['envelopes', 'wording_fixed', 'TEXT'],
  // wording_people: what that template gave each person on it, by recipient id: their private note, the check before
  // the document opens and an access code ({"rcp_..": {"note": 1, "verify": "email_code", "code": 1}}), which stay.
  // wording_owner: who the template belonged to when it was deleted, who keeps changing these envelopes.
  ['envelopes', 'wording_people', 'TEXT'],
  ['envelopes', 'wording_owner', 'TEXT'],
  // Around the certificate (src/server/evidence.ts). disputed_at: the first time a person named on the envelope said
  // they did not sign it, or that it was not them. final_pages: how many pages the signed PDF has, counted once for
  // the lookup by envelope ID. copy_opened_at: when this person first opened or downloaded the completed copy.
  // visit_noted_at: the last later visit written to the audit trail (once a day at most).
  ['envelopes', 'disputed_at', 'TEXT'],
  ['envelopes', 'final_pages', 'INTEGER'],
  ['recipients', 'copy_opened_at', 'TEXT'],
  ['recipients', 'visit_noted_at', 'TEXT'],
  // disputes.closed_at/closed_how/closed_note: a person at GrowSigning closed it ('handled', or 'in_error' when it was
  // filed in error); until then the envelope cannot be deleted for good (src/server/evidence.ts).
  ['disputes', 'closed_at', 'TEXT'],
  ['disputes', 'closed_how', 'TEXT'],
  ['disputes', 'closed_note', 'TEXT'],
  // envelopes.opens_noted_from: for an envelope that was already completed when "Completed copy opened" began to be
  // written, the moment it began. Its first recorded open may not be the first, and its line says so (noteCopyOpened).
  ['envelopes', 'opens_noted_from', 'TEXT'],
  // When the timer last looked at a payment that is still not applied, so it takes the least recently looked at first.
  ['payments', 'checked_at', 'TEXT'],
  // payments.tax_cents: the tax the provider added on top of a monthly payment (taxOf in routes-billing.ts), so the
  // price an account is on can be told from what it paid. refunds.hand_parts: money that went back by hand at the
  // provider towards a refund we owe, while ours was still waiting, as a JSON list of {cents, at}. The refund is
  // settled when the parts add up to it, and the customer is told once, with each part.
  ['payments', 'tax_cents', 'INTEGER'],
  ['refunds', 'hand_parts', 'TEXT'],
  // Who each person_gen of a request was (a JSON map of gen to plain name and address, personGen in credits.ts), so a
  // request that comes back to someone it had before (renamed to somebody else and back) is theirs again, with the
  // signature they already paid for.
  ['recipients', 'person_gens', 'TEXT'],
  // Goes up each time the request passes to another person (another address, or another name at the same address
  // that is not a spelling of the old one). It is part of the signature's ledger line once above zero (sigRef in
  // src/server/credits.ts), so a second person never signs on what the first one paid for. 0 keeps every line from
  // before valid.
  ['recipients', 'person_gen', 'INTEGER NOT NULL DEFAULT 0'],
  // A visitor of a public form who pressed Finish while no signature was free: when they were told that what they
  // filled in is kept and that we email them, and when that email went (form_ready_at). While they wait, the timer
  // does not close their start for being idle.
  ['recipients', 'form_waits_at', 'TEXT'],
  ['recipients', 'form_ready_at', 'TEXT'],
  // Two-step login (src/server/twostep.ts). two_step_secret: the base32 secret the authenticator app shares, and
  // two_step_on_at when it was switched on (a code that matched first). two_step_last_step: the 30-second step of the
  // last code used, so no code works twice. two_step_codes: a JSON list of fingerprints of the recovery codes that are
  // left. two_step_new_secret: a secret being set up, not on until a code from it was typed. two_step_wrong counts
  // wrong codes in a row (two_step_wrong_known: how many of them came after the right password), and
  // two_step_paused_until is set when there were too many. two_step_reset_at: when a reset by email takes effect,
  // two_step_reset_noticed_at the last email about it. accounts.two_step_required_at: the owner asks every member.
  ['users', 'two_step_secret', 'TEXT'],
  ['users', 'two_step_on_at', 'TEXT'],
  ['users', 'two_step_last_step', 'INTEGER'],
  ['users', 'two_step_codes', 'TEXT'],
  ['users', 'two_step_new_secret', 'TEXT'],
  ['users', 'two_step_new_at', 'TEXT'],
  ['users', 'two_step_wrong', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'two_step_wrong_known', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'two_step_paused_until', 'TEXT'],
  ['users', 'two_step_reset_at', 'TEXT'],
  ['users', 'two_step_reset_noticed_at', 'TEXT'],
  ['accounts', 'two_step_required_at', 'TEXT'],
  // two_step_email_reset_off: when the person switched the reset by email off (NULL: it is allowed, the default).
  // two_step_reset_stopped_at: when a reset by email was last stopped other than by a sign-in with the second step; a
  // new one waits TWO_STEP_RESET_BLOCK_DAYS from then. two_step_paused_mail_at: the last email about a pause, at most
  // one a day. sessions.two_step_device: the remembered device that let this browser in or was remembered by it, so
  // withdrawing the device signs it out too.
  ['users', 'two_step_email_reset_off', 'TEXT'],
  ['users', 'two_step_reset_stopped_at', 'TEXT'],
  ['users', 'two_step_paused_mail_at', 'TEXT'],
  ['sessions', 'two_step_device', 'TEXT'],
  // The 6-digit code in the confirmation email, typed in the tab the person signed up in (src/server/confirmcode.ts):
  // a keyed hash of it, when it was sent, and the wrong codes typed in all (never reset).
  ['users', 'verify_code_hash', 'TEXT'],
  ['users', 'verify_code_at', 'TEXT'],
  ['users', 'verify_code_wrong', 'INTEGER NOT NULL DEFAULT 0'],
  // A witness for one signer (src/server/witness.ts, rules in src/lib/witness.ts). witness_for: the recipient they
  // witness. named_by_signer: that signer names them on the signing page. signer_named_at: when the signer named the
  // person who is in the place now (empty when the sender chose them), witness_names how often a name was given.
  // witness_said_at, witness_statement and witness_saw: when the witness ticked their statement, its words exactly as
  // ticked, and which signature it was about (the signer's completed_at then). witness_absent_at: they said "I was not
  // there". witness_marks: "address", "device" or "network" when they witnessed with the signer's email address, browser,
  // or internet address and browser. device_hash: a keyed fingerprint of the browser cookie a signer with a witness and
  // the witness finished in, kept only for that comparison.
  ['recipients', 'witness_for', 'TEXT'],
  ['recipients', 'named_by_signer', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'signer_named_at', 'TEXT'],
  ['recipients', 'witness_names', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'witness_said_at', 'TEXT'],
  ['recipients', 'witness_statement', 'TEXT'],
  ['recipients', 'witness_saw', 'TEXT'],
  ['recipients', 'witness_absent_at', 'TEXT'],
  ['recipients', 'witness_marks', 'TEXT'],
  ['recipients', 'device_hash', 'TEXT'],
  // Conditional fields and formulas (src/server/logic.ts). show_when: JSON {field, is, value}, the field of the same
  // person this one depends on, by its id. formula: the text of the formula with the fields it uses as {id}.
  ['fields', 'show_when', 'TEXT'],
  ['fields', 'formula', 'TEXT'],
  // Click-to-agree (src/server/clickwrap.ts). accounts.clickwrap_warned / clickwrap_full: the month (YYYY-MM) for which
  // the admins were told that acceptances reached 80 percent of the monthly limit, and the whole of it.
  // abuse_reports.clickwrap_id: a report made from the page of an agreement instead of about an envelope.
  ['accounts', 'clickwrap_warned', 'TEXT'],
  ['accounts', 'clickwrap_full', 'TEXT'],
  ['abuse_reports', 'clickwrap_id', 'TEXT'],
  // forgotten_codes.via_form: the code was the visitor's of a public form, who typed their own name and address. A
  // report with it never counts towards pausing the account, also after the start was deleted (reportAbuse).
  ['forgotten_codes', 'via_form', 'INTEGER NOT NULL DEFAULT 0'],
  // clickwrap_acceptances.view_hash: SHA-256 of the "view" the page was given, so only that page load gets the receipt
  // again (not part of the seal). view_match: whether the address and browser the terms were handed to are the ones
  // that pressed ('same', 'address', 'browser', 'both'), sealed. clickwrap_versions.account_name: the account's name
  // when the version was published, which the certificate prints. accounts.clickwrap_typed_*: as clickwrap_warned
  // and clickwrap_full, for acceptances typed in by visitors, which have a monthly limit of their own.
  ['clickwrap_acceptances', 'view_hash', 'TEXT'],
  ['clickwrap_acceptances', 'view_match', 'TEXT'],
  ['clickwrap_versions', 'account_name', 'TEXT'],
  ['accounts', 'clickwrap_typed_warned', 'TEXT'],
  ['accounts', 'clickwrap_typed_full', 'TEXT'],
  // recipients.witness_chosen: JSON {name, email} of the witness the sender chose, kept when the signer names another
  // one after "I was not there", so a copy of the envelope and a hand-over go back to the sender's own choice. Cleared
  // when the sender names a witness again (src/server/witness.ts).
  ['recipients', 'witness_chosen', 'TEXT'],
  // files.text_sealed, text_key: the text kept from an uploaded PDF, encrypted with FILE_ENCRYPTION_KEY, and the id of
  // the key (src/server/searchtext.ts). files.text then stays empty. envelopes.final_tries, final_due_at,
  // final_told_at: the timer's failed tries at the signed PDF of a completed envelope and when the next is due, so one
  // that cannot be built never holds up the others, and when the sender and the operators were told it is stuck
  // (src/server/finalretry.ts).
  ['files', 'text_sealed', 'TEXT'],
  ['files', 'text_key', 'TEXT'],
  ['envelopes', 'final_tries', 'INTEGER NOT NULL DEFAULT 0'],
  ['envelopes', 'final_due_at', 'TEXT'],
  ['envelopes', 'final_told_at', 'TEXT'],
  // A stamp field (src/server/stamps.ts): its value is the SHA-256 of the impression in stamp_images. stamp_id: the
  // account stamp it came from, when it did. stamp_meta: JSON with the stamp's name, ink, seed, tilt, texture,
  // where it came from, who put it on and when.
  ['fields', 'stamp_id', 'TEXT'],
  ['fields', 'stamp_meta', 'TEXT'],
  // fields.calc_num: what a calculated field worked out to, written plainly (1234.5, a dot before decimals, no
  // grouping), next to the value that shows it the way its inputs are written (1.234,50). Every later reader takes
  // the number from here, because a shown "1.233" alone could mean 1233 (src/lib/logic.ts canonOf).
  ['fields', 'calc_num', 'TEXT'],
  // recipients.seen_inputs: the key of the other people's answers this person's formulas counted when the server last
  // gave them the document ('-' for none), so a Finish that sends no key is held to that one, like seen_version
  // (formulaInputs and assertInputs in src/server/logic.ts).
  ['recipients', 'seen_inputs', 'TEXT'],
  // recipient_members.reported_at: this member of a signing group reported the document, so nothing more is emailed
  // to them about this envelope until they ask for it themselves (src/server/groups.ts). A spam mark needs no column
  // here: it is kept for the account in mail_complaints and read from there.
  ['recipient_members', 'reported_at', 'TEXT'],
  // recipient_members.code_fails, code_for: wrong access codes typed on the link of a member whose colleague has the
  // document, or who only reads a copy, counted for that member alone and for the code they were typed against
  // (a fingerprint of it), so they never freeze the code of the person who is signing (groups.ts memberWrongCode).
  ['recipient_members', 'code_fails', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipient_members', 'code_for', 'TEXT'],
  // comment_threads.settle_noted_at: when marking this conversation as settled or open again was last written into
  // the audit trail. At most once an hour, so the trail and the certificate cannot be filled by toggling (commentrules.ts).
  ['comment_threads', 'settle_noted_at', 'TEXT'],
  // The payment link (src/server/routes-paylink.ts). pay_set_by: whose payment page it is, so it goes when they leave
  // the team (paydrop.ts); a copy from a template keeps it. pay_gone_at and pay_gone_note: when and why it was taken
  // off without its sender doing it, for the envelope page. pay_told_at, on the envelope and on the account: when the
  // people who sent it were last emailed that a signer was not shown it, so they hear it once until it shows again.
  ['envelopes', 'pay_set_by', 'TEXT'],
  ['envelopes', 'pay_set_at', 'TEXT'],
  ['envelopes', 'pay_gone_at', 'TEXT'],
  ['envelopes', 'pay_gone_note', 'TEXT'],
  ['envelopes', 'pay_told_at', 'TEXT'],
  ['accounts', 'pay_told_at', 'TEXT'],
  // The help chat a person chose to send with a help request, as JSON lines (src/server/chat.ts attachedChat). It goes
  // with the request. Nothing else of any chat is ever stored.
  ['support_requests', 'chat', 'TEXT'],
  // The language the editor starts each new recipient in (src/server/locales.ts). NULL: each person's browser decides,
  // then English. recipients.locale, above, is the language set for one person.
  ['accounts', 'default_locale', 'TEXT'],
  // A file the sender uploaded as Word, Excel, PowerPoint, OpenDocument, RTF, text, HTML or TIFF and that was turned
  // into this PDF (src/server/converted.ts). original_sha256: the stored original, kept like any file. converted: JSON
  // with its name, kind, fingerprint, size, what made the PDF and the notes for the editor (src/lib/convert.ts).
  ['files', 'original_sha256', 'TEXT'],
  ['files', 'converted', 'TEXT'],
  // The security record (src/server/seclog.ts). security_alerts_off: the alerts an admin switched off, as a JSON list
  // of their names (src/lib/seclog.ts SECURITY_ALERTS); NULL is every alert on. security_log_emails: 1 when the API
  // and the webhook give a security system people's names and email addresses as well as their ids.
  ['accounts', 'security_alerts_off', 'TEXT'],
  ['accounts', 'security_log_emails', 'INTEGER NOT NULL DEFAULT 0'],
  // Alerts the hourly limit held back since the last email of that alert (seclog.ts sendHeldAlerts tells the admins).
  ['security_alerts_sent', 'held', 'INTEGER NOT NULL DEFAULT 0'],
  // Keeping closed envelopes for a set time (src/server/records.ts). accounts.retention_days: how long, counted from
  // when an envelope closed (NULL: off, the default); retention_level: what goes then (src/lib/retention.ts
  // PURGE_LEVELS); retention_name and retention_code: the schedule's own name and code, as the organisation writes them.
  // envelopes.retention_days on a template: its own period, used instead of the account's while the rule is on.
  // envelopes.purged_at, purged_level, purged_sha256: when a purge ran, at which level, and the fingerprint of the
  // signed PDF it removed. audit.redacted_at: the purge time on a line whose details it took out, so the chain says
  // which lines can no longer be recomputed instead of calling the record altered.
  ['accounts', 'retention_days', 'INTEGER'],
  ['accounts', 'retention_level', 'TEXT'],
  ['accounts', 'retention_name', 'TEXT'],
  ['accounts', 'retention_code', 'TEXT'],
  // retention_days counts for completed documents; retention_stopped_days for cancelled, declined and expired ones (NULL:
  // kept). retention_mailed_at: when the account last got the email that lists what is due (at most one a week).
  ['accounts', 'retention_stopped_days', 'INTEGER'],
  ['accounts', 'retention_mailed_at', 'TEXT'],
  // 'Trees on the signing record' switched off: the tree and paper lines are left off the certificate (impact.ts).
  ['accounts', 'cert_impact_off', 'INTEGER NOT NULL DEFAULT 0'],
  // What an account chose for itself (src/server/tenantpolicy.ts). impact_display: 'on' or 'off' for the tree lines on
  // screens and in emails; ai_helper: 'on' or 'off' for AI answers in the help chat. NULL in either: not chosen, which
  // reads as on under every profile. white_label is kept for a later feature and read by nothing yet.
  ['accounts', 'impact_display', 'TEXT'],
  ['accounts', 'ai_helper', 'TEXT'],
  ['accounts', 'white_label', 'INTEGER NOT NULL DEFAULT 0'],
  ['envelopes', 'retention_days', 'INTEGER'],
  ['envelopes', 'purged_at', 'TEXT'],
  ['envelopes', 'purged_level', 'TEXT'],
  ['envelopes', 'purged_sha256', 'TEXT'],
  ['audit', 'redacted_at', 'TEXT'],
  // The digital seal of the signed PDF (src/server/seal.ts): its level (B-B or B-T) and the SHA-256 of the
  // certificate it was made with. NULL for a file without a seal, such as every one completed before seals were set up.
  ['envelopes', 'seal_level', 'TEXT'],
  ['envelopes', 'seal_cert', 'TEXT'],
  // seal_tsa: for a seal with a time stamp, 'trusted' when the service's certificate led to TSA_TRUST, else 'unchecked'.
  ['envelopes', 'seal_tsa', 'TEXT'],
  // Archive copies (src/server/archivemail.ts). emails.archive_draft: on an email about a document, the copy for the
  // account's archive addresses (JSON, links and codes already taken out), until that email has left. archive_to: on
  // a copy, and on the email that asks an address to confirm, the archive_addresses row it goes to. archive_envelope:
  // on a copy, the envelope it is about. Its envelope_id stays empty, so a copy is never one of the envelope's emails.
  ['emails', 'archive_draft', 'TEXT'],
  ['emails', 'archive_to', 'TEXT'],
  ['emails', 'archive_envelope', 'TEXT'],
  // archive_account: on the email that asks an address to confirm, the account that asked, so a spam mark on it still
  // counts for that account after the address was removed (archiveNews in src/server/routes-archive.ts).
  ['emails', 'archive_account', 'TEXT'],
  // archive_refused.email_key: the inbox the address reaches, without a "+tag" (archiveKey in src/lib/archivemail.ts),
  // so the "no" holds for every spelling. why: 'spam' when the email that asked was marked as spam, else the button.
  ['archive_refused', 'email_key', 'TEXT'],
  ['archive_refused', 'why', 'TEXT'],
  // The account's own consent text (src/server/disclosure.ts). disclosure_now: which saved version is shown today, by
  // language, as JSON ({"en": "<version id>"}); empty when the account shows only our own words. disclosure_each_visit:
  // 1 when the consent screen is shown every time the link is opened, 0 for once for each document.
  ['accounts', 'disclosure_now', 'TEXT'],
  ['accounts', 'disclosure_each_visit', 'INTEGER NOT NULL DEFAULT 0'],
  // The sign-in rules of an account (src/server/secpolicy.ts). accounts.min_password_length: members choose a password
  // of at least this many characters (empty: 8). idle_minutes: a browser not used for this long is signed out (empty:
  // never), idle_since: when that rule was last set, so no clock starts before it. one_session: one browser at a time.
  // sessions.seen_at, seen_account: when the session last counted as used, and in which account that was counted.
  // users.pw_below: this person's password is shorter than a rule of this many characters, noticed when they signed
  // in with it. Never the length itself, and empty for everyone who breaks no rule.
  ['accounts', 'min_password_length', 'INTEGER'],
  ['accounts', 'idle_minutes', 'INTEGER'],
  ['accounts', 'idle_since', 'TEXT'],
  ['accounts', 'one_session', 'INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'seen_at', 'TEXT'],
  ['sessions', 'seen_account', 'TEXT'],
  ['users', 'pw_below', 'INTEGER'],
  // recipients.paper_at: when this person used "Sign on paper instead" (askForPaper). Set by that call only, so a
  // decline whose typed reason reads like a paper request is never taken for one.
  ['recipients', 'paper_at', 'TEXT'],
  // files.page_ops: a file made from another one by removing, turning or moving pages (src/server/pages.ts), as JSON
  // { from: the file it was made from, ops: what was done }. Read when a document's file is saved, for the audit line.
  ['files', 'page_ops', 'TEXT'],
  // accounts.list_days: a saved list for Send to many that nobody used for this many days is deleted (empty: 180,
  // src/lib/reports.ts LIST_DAYS_DEFAULT).
  ['accounts', 'list_days', 'INTEGER'],
  // recipients.page_locale: the language this person last read the signing page in, when it was switched on (set when
  // they agree, and when they choose one in the page's header menu). The certificate names it (src/server/signlang.ts).
  ['recipients', 'page_locale', 'TEXT'],
  // envelopes.starter_id: the ready-made template a template was made from (src/lib/starters/), and starter_note the
  // note as it stood that day ("A starting point written by GrowSigning, not legal advice. ..."), shown in the editor.
  // Kept as written then, so a later review of the starter never claims to cover an older copy (src/server/starters.ts).
  ['envelopes', 'starter_id', 'TEXT'],
  ['envelopes', 'starter_note', 'TEXT'],
  // The long-term step after the seal (src/server/ltv.ts). seal_ltv: 'B-LT' when the signed PDF carries what is needed
  // to check its seal after the certificate expired, 'B-LTA' with a document time stamp after that, 'missing' when it
  // could not be fetched (seal_ltv_note says why). NULL when nothing was tried: no seal with a time stamp, or no
  // certificate that names a place to check it.
  ['envelopes', 'seal_ltv', 'TEXT'],
  ['envelopes', 'seal_ltv_note', 'TEXT'],
  // fields.typed_num: what a signer typed into a number field, as a plain number (1234.5 for "1.234,50"), next to the
  // value kept exactly as typed. Written when they save or finish (src/server/fieldchecks.ts), for exports and the API.
  ['fields', 'typed_num', 'TEXT'],
  // accounts.org_id: the organisation an account (an agency) sits in, or NULL (src/server/orgs.ts). org_sending_off_at:
  // an admin of that organisation switched sending off for it, with org_sending_off_by the organisation's name.
  ['accounts', 'org_id', 'TEXT'],
  ['accounts', 'org_sending_off_at', 'TEXT'],
  ['accounts', 'org_sending_off_by', 'TEXT'],
  // accounts.org_raised: JSON { rule: { was, set } } of the rules an organisation brought this account up to, with
  // what the account had before. When the organisation takes the rule away, the account gets back what it had,
  // unless it changed that setting since (restoreBelow in src/server/orgs.ts).
  ['accounts', 'org_raised', 'TEXT'],
  // emails.locale: the language our own words in the email were written in (src/server/maillang.ts). NULL: English,
  // as every email was before languages. The sender's words in it are never translated.
  ['emails', 'locale', 'TEXT'],
  // How many parts a text message is sent as (src/lib/smsparts.ts): a text with one letter outside the GSM alphabet
  // is sent as UCS-2, 70 characters a part. SMS_DAILY_PER_ACCOUNT counts parts, as the provider bills them.
  ['sms_usage', 'parts', 'INTEGER NOT NULL DEFAULT 1'],
  ['texts', 'parts', 'INTEGER NOT NULL DEFAULT 1'],
  // The signing link also by WhatsApp (src/server/whatsapp.ts): wa_link the sender's choice, wa_agreed_at when the
  // sender ticked that the person agreed, wa_agreed_for a keyed fingerprint of the number they agreed for (another
  // number needs the tick again), wa_sent_at the last message, wa_sent_to the masked number the provider took it for.
  ['recipients', 'wa_link', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'wa_agreed_at', 'TEXT'],
  ['recipients', 'wa_agreed_for', 'TEXT'],
  ['recipients', 'wa_sent_at', 'TEXT'],
  ['recipients', 'wa_sent_to', 'TEXT'],
  // Archive format (src/server/pdfa.ts): the account's switch "Make completed files PDF/A", off by default; and per
  // envelope what came of it: 'passed' (veraPDF passed the stored file as PDF/A-2b, pdfa_checker names its version)
  // or 'not' (pdfa_note says why, in a few words). NULL when the switch was off at completion.
  ['accounts', 'pdfa_on', 'INTEGER NOT NULL DEFAULT 0'],
  ['envelopes', 'pdfa', 'TEXT'],
  ['envelopes', 'pdfa_note', 'TEXT'],
  ['envelopes', 'pdfa_checker', 'TEXT'],
  // With 'not': why as a code (font, cmyk, media, attached, failed, convert, slow, checker_down, busy), which picks
  // the next step the page shows under the reason (nextStep in pdfa.ts).
  ['envelopes', 'pdfa_code', 'TEXT'],
  // "Only when..." (src/server/routing.ts): the rule that decides, when this person's step is reached, whether they
  // are asked at all, as JSON ({"field","is","value"} or {"otherwise": recipient id}); NULL for everyone else. A
  // person whose rule was not met gets status 'skipped' ("Not asked"), and skipped_why says why in plain words.
  ['recipients', 'only_when', 'TEXT'],
  ['recipients', 'skipped_why', 'TEXT'],
  // The same for a person whose rule was met and who was asked, written once so the record says it once.
  ['recipients', 'asked_why', 'TEXT'],
  // A person "Not asked" who HAD been asked before a correction put someone earlier in the order back (routing.ts):
  // 1 when we emailed them that they are no longer needed, 2 when no email could go (no address, spam mark, paused).
  ['recipients', 'skipped_was_asked', 'INTEGER'],
  // AI help when sending and signing (src/server/aiassist.ts): the account's "Let the AI read document text", 'on'
  // or NULL (off, the default); and per envelope whether its sender offers signers a plain summary.
  ['accounts', 'ai_read_text', 'TEXT'],
  ['envelopes', 'ai_summary', 'INTEGER NOT NULL DEFAULT 0'],
  // Send later, pause and a wait before a person (timing.ts). send_at: when a draft goes out by itself. send_tried_at:
  // when the timer took it up; with send_error, why it did not go out. paused_at, paused_by: who paused an envelope
  // that is out, and when; paused_ms: how long it was paused in all, which the deadline moved on by.
  ['envelopes', 'send_at', 'TEXT'],
  ['envelopes', 'send_tried_at', 'TEXT'],
  ['envelopes', 'send_error', 'TEXT'],
  ['envelopes', 'paused_at', 'TEXT'],
  ['envelopes', 'paused_by', 'TEXT'],
  ['envelopes', 'paused_ms', 'INTEGER NOT NULL DEFAULT 0'],
  // Hours to wait after the step before this person finished, before they are asked (signing order only). wait_noted_at:
  // when the record said they wait, so it says it once.
  ['recipients', 'wait_hours', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'wait_noted_at', 'TEXT'],
  // The latest this browser stays signed in, however much it is used: set for people whose email domain signs in
  // through their organisation's own service (src/server/orgsso.ts), so leaving the organisation ends their access.
  ['sessions', 'ends_by', 'TEXT'],
  // A file that is given to read, not signed (src/server/supplements.ts): NULL is a file to sign; 'none', 'open' or
  // 'acknowledge' is the rule before Finish. supplemental_copy: 1 puts it after the signed pages of the completed copy.
  ['documents', 'supplemental', 'TEXT'],
  ['documents', 'supplemental_copy', 'INTEGER NOT NULL DEFAULT 1'],
  // Key dates (src/server/airepo.ts): the account's switch, 'on' or NULL (off, the default); when it was switched on
  // (the timer reads only documents completed after that); and 1 once an admin pressed "Look through older documents".
  ['accounts', 'ai_key_dates', 'TEXT'],
  ['accounts', 'ai_key_dates_at', 'TEXT'],
  ['accounts', 'ai_key_dates_older', 'INTEGER NOT NULL DEFAULT 0'],
  // People who change the envelope on their turn (src/server/agents.ts, rules in src/lib/recipienttypes.ts).
  // place_open: 1 while this place waits for the person before them who "Chooses who comes next" to name someone.
  // chosen_by: the name of whoever named or changed the person now in this place, and chosen_at when.
  ['recipients', 'place_open', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'chosen_by', 'TEXT'],
  ['recipients', 'chosen_at', 'TEXT'],
  // A file uploaded through the signing link of someone who "Can change the document": that recipient's id. Only such
  // a file, or one already on the envelope, can go into the envelope through their link (src/server/agents.ts).
  ['files', 'step_upload_by', 'TEXT'],
  // The name of the person who "Can change the document" whose change set this signature aside, or NULL when the
  // sender did: what the person asked to sign again is told (who changed it), in emails and on their pages.
  ['earlier_signatures', 'changed_by', 'TEXT'],
  // 1: the change was made by someone else who signs, in a field anyone on the document can fill in (collab.ts).
  ['earlier_signatures', 'changed_by_signer', 'INTEGER'],
  // A role an admin made (perm_profiles, src/server/perm.ts). NULL: the built-in role in memberships.role.
  ['memberships', 'profile_id', 'TEXT'],
  ['invites', 'profile_id', 'TEXT'],
  // Someone who signs for a person while they are away (src/server/delegation.ts). accounts.delegation: 1 when an
  // admin allowed it (off by default). envelopes.delegate_off: 1 when the sender said only the person named may
  // sign. On a recipient the delegate took on: which link (delegate_link_id), the person's name and address
  // (delegate_for, delegate_for_email) and when (delegate_at).
  ['accounts', 'delegation', 'INTEGER NOT NULL DEFAULT 0'],
  ['envelopes', 'delegate_off', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'delegate_link_id', 'TEXT'],
  ['recipients', 'delegate_for', 'TEXT'],
  ['recipients', 'delegate_for_email', 'TEXT'],
  ['recipients', 'delegate_at', 'TEXT'],
  // The check the sender chose for the person, kept while the delegate's one-time code stands in for it, so a
  // correction back to the person (or to anyone else) gives them the sender's choice again (delegateCorrected).
  ['recipients', 'delegate_verify_was', 'TEXT'],
  // Working for a colleague (src/server/shares.ts). sent_by_id: who pressed Send (or made the draft) for the person
  // the envelope belongs to, NULL when that person did it themselves. original_sender_id: who it belonged to before
  // it was first moved to another member, so the certificate keeps the first sender. NULL when it never moved.
  ['envelopes', 'sent_by_id', 'TEXT'],
  ['envelopes', 'original_sender_id', 'TEXT'],
  // made_for_by: the colleague who made a draft and handed it to its owner with "Send for" (shares.ts). Only they may
  // take it back, and it goes back to them when the share ends. Pressing Send on someone else's draft never sets it.
  ['envelopes', 'made_for_by', 'TEXT'],
  // sent_for_id: the person a colleague pressed Send for, kept at that moment, so the certificate's "Sent by ..., for
  // ..." still names them after the envelope is moved to someone else (sentfor.ts certSentBy). NULL when not sent for anyone.
  ['envelopes', 'sent_for_id', 'TEXT'],
  // "Each person sees only their files" (src/server/visibility.ts, rule in src/lib/owndocs.ts). envelopes.own_docs:
  // 1 when on. recipients.own_docs_extra: the files the sender ticked for that person beside those with their fields,
  // as a JSON list of document ids. accounts.own_docs_default: new envelopes and templates start with it on.
  ['envelopes', 'own_docs', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'own_docs_extra', 'TEXT'],
  ['accounts', 'own_docs_default', 'INTEGER NOT NULL DEFAULT 0'],
  // Several templates in one envelope (src/server/tplcombine.ts). envelopes.wording_parts: JSON list of the parts,
  // [{ "t": template id, "docs": [document ids], "people": [recipient ids], "l": 1 when locked }], written for every
  // combined envelope, so each lock and rule holds for its own part. accounts.tpl_match_percent: how alike an upload has to be to one of
  // the account's templates before the editor offers it (src/server/tplmatch.ts): 80, 90 or 95; NULL is 80.
  ['envelopes', 'wording_parts', 'TEXT'],
  ['accounts', 'tpl_match_percent', 'INTEGER'],
  // recipients.views_used: which ways of showing the document this person used while signing, "page", "easy" or
  // "page,easy" (src/lib/readview.ts). The first use of each is in the audit trail; the certificate says which.
  ['recipients', 'views_used', 'TEXT'],
  // users.seen_locale: the sender language this person's browser asked for when they last opened the app, for the
  // emails to them while they chose none under Settings, Profile (users.locale; src/server/senderlocale.ts). NULL:
  // English, and always NULL while English is the only sender language.
  ['users', 'seen_locale', 'TEXT'],
  // Which standard an account's own sign-in service speaks (src/server/orgsso.ts): 'oidc' (OpenID Connect) or 'saml'
  // (SAML 2.0, src/server/saml.ts; issuer is then the identity provider's entity id and there is no client secret).
  ['org_idps', 'kind', "TEXT NOT NULL DEFAULT 'oidc'"],
  // More kinds of field (src/server/fieldkinds.ts). fields.link: fields of one person with the same link share one
  // answer ("Same answer as"). fields.date_from: JSON {from, add, unit}, a date worked out from another date field
  // of the same person or from their date of signing. fields.look: JSON {font, size, color, bold}, how its text
  // prints. accounts.field_look: the text style new fields start with (the same JSON); NULL: as usual.
  ['fields', 'link', 'TEXT'],
  ['fields', 'date_from', 'TEXT'],
  ['fields', 'look', 'TEXT'],
  ['accounts', 'field_look', 'TEXT'],
  // files.undone_to: after "Undo cleanup" (routes-phoneapp.ts), the answer for the file made from the photos (JSON), so
  // asking again gives the same file back instead of making another one each time.
  ['files', 'undone_to', 'TEXT'],
  // Ask for a payment, taken here by card through the account's own Stripe account (src/server/collect.ts).
  // collect_amount: a fixed amount in the currency's smallest unit (cents); collect_field: or the id of the number or
  // calculated field that holds it. collect_currency: three lower-case letters. collect_for: what it is for, in the
  // sender's words. collect_when: 'before' (the person's part completes only once Stripe confirms) or 'after'.
  ['envelopes', 'collect_amount', 'INTEGER'],
  ['envelopes', 'collect_field', 'TEXT'],
  ['envelopes', 'collect_currency', 'TEXT'],
  ['envelopes', 'collect_for', 'TEXT'],
  ['envelopes', 'collect_when', 'TEXT'],
  // Switches for senders and admins (src/server/switches.ts). NULL on an envelope: as the account said when it was sent.
  ['accounts', 'sw_pass_on', 'INTEGER NOT NULL DEFAULT 1'],
  ['accounts', 'sw_pass_copy', 'INTEGER NOT NULL DEFAULT 0'],
  ['accounts', 'sw_comments', 'INTEGER NOT NULL DEFAULT 1'],
  ['accounts', 'sw_sign_ways', 'TEXT'],
  ['accounts', 'sw_stamps', 'INTEGER NOT NULL DEFAULT 1'],
  ['accounts', 'sw_mark_words', 'TEXT'],
  ['envelopes', 'sw_pass_on', 'INTEGER'],
  ['envelopes', 'sw_pass_copy', 'INTEGER'],
  ['envelopes', 'sw_comments', 'INTEGER'],
  // Written at send: the ways to make a signature ("type,draw,upload") and the mark words. NULL: sent before these
  // were kept, read from the account.
  ['envelopes', 'sw_sign_ways', 'TEXT'],
  ['envelopes', 'sw_mark_words', 'TEXT'],
  ['recipients', 'sig_how', 'TEXT'],
  ['recipients', 'ini_how', 'TEXT'],
  ['powerforms', 'max_signed', 'INTEGER'],
  ['powerforms', 'closes_at', 'TEXT'],
  // The person kept as a copy after passing it on: their old link, so it can say why it stopped (switches.ts).
  ['recipients', 'kept_from', 'TEXT'],
  // The last day a form takes signatures, as the admin chose it (closes_at is the moment it closes).
  ['powerforms', 'closes_day', 'TEXT'],
  // Signed on paper (src/server/paper.ts). accounts.paper_sign: the admins' switch "People may sign on paper" (off).
  // recipients.allow_paper: NULL is the default (allowed while the switch is on), 0 is "on screen only".
  // require_paper: "On paper only". paper_state: where their latest scan stands (waiting, asked_again, accepted).
  // paper_scan_id: the scan accepted as what they signed, set by the acceptance alone.
  ['accounts', 'paper_sign', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'allow_paper', 'INTEGER'],
  ['recipients', 'require_paper', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'paper_state', 'TEXT'],
  ['recipients', 'paper_scan_id', 'TEXT'],
  // paper_scans.person_gen and email: who the request was for when the scan came in. A scan is that person's only:
  // after a correction to someone else it is set aside (settlePaper), never accepted as the new person's.
  // state 'set_aside': it no longer counts (the person changed, or was asked to sign again), kept on record.
  ['paper_scans', 'person_gen', 'INTEGER'],
  ['paper_scans', 'email', 'TEXT'],
  // A field anyone on the document can fill in, instead of one person (src/server/collab.ts). shared_initials: whoever
  // changes it adds their initials. shared_after: the sender allows a change after someone finished, and then everyone
  // who finished is asked to sign again. recipients.shared_shown: what this person's screen was last given for those
  // fields, so a screen that is out of date never undoes someone else's change.
  ['fields', 'shared', 'INTEGER NOT NULL DEFAULT 0'],
  ['fields', 'shared_initials', 'INTEGER NOT NULL DEFAULT 0'],
  ['fields', 'shared_after', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'shared_shown', 'TEXT'],
];

// The monthly price each account is on, written down once when the server starts for every account that has none
// (accounts from before it was kept, and any made since that has not started a plan): what its last full-price plan
// payment was before its own tax, or, with none, the price for new customers at that moment. A full-price payment is
// one that bought the whole month of signatures: a month with a discount, a credit or part of a month bought fewer
// and says nothing about the price. Its tax is the tax of that payment (payments.tax_cents), never the tax the
// provider expects for the next renewal; a payment from before the tax was kept counts at most the price for new
// customers, so tax on it is never taken for price. A new subscription sets its own when it is taken up (adopt in
// routes-billing.ts), so a returning customer is never held to the price of a plan that ended.
export function fillPrices(d: any = db()): number {
  const plan = Math.round(PRICING.monthlyUsd * 100);
  return Number(d.prepare(`UPDATE accounts SET price_cents = COALESCE(
      (SELECT CASE WHEN p.tax_cents IS NOT NULL THEN p.amount_cents - p.tax_cents ELSE MIN(p.amount_cents, ?) END FROM payments p
        WHERE p.account_id = accounts.id AND p.kind = 'plan' AND p.applied_at IS NOT NULL AND p.credits >= ? AND p.currency = 'usd'
        ORDER BY p.at DESC, p.rowid DESC LIMIT 1),
      ?) WHERE price_cents IS NULL`).run(plan, PRICING.monthlySignatures, plan).changes);
}

// Help requests from before support_requests.came_by was kept (src/server/routes-support.ts), filled in once so the
// screens are right about them. Before `verified` was kept every row said 0, so a request its owner wrote while
// signed in under their own confirmed address looked like anyone's: it could be closed as "nobody at this address
// wrote this", and the operator was told it was not the owner. A request closed with the old one-click button has
// no closing time and no written answer: it is closed as of the time it was written (a reply long after starts a new
// request instead of reopening it with a new promise), and says it was closed before answers were kept with it.
export function fillOldSupport(d: any = db()): number {
  const alert = "(ref IS NULL AND user_id IS NULL AND COALESCE(name, '')='GrowSigning (automatic alert)')";
  d.prepare(`UPDATE support_requests SET verified=1 WHERE came_by IS NULL AND verified=0 AND user_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM users u WHERE u.id=support_requests.user_id AND u.email_verified=1 AND lower(u.email)=lower(support_requests.email))`).run();
  d.prepare(`UPDATE support_requests SET closed_at=COALESCE(updated_at, at), closed_how=COALESCE(closed_how, 'before') WHERE came_by IS NULL AND status='closed' AND closed_at IS NULL AND NOT ${alert}`).run();
  return Number(d.prepare(`UPDATE support_requests SET came_by=CASE WHEN ${alert} THEN 'software' WHEN verified=1 AND follows IS NOT NULL AND user_id IS NULL THEN 'link'
    WHEN verified=1 THEN 'signed_in' ELSE 'form' END WHERE came_by IS NULL`).run().changes);
}

/**
 * Once, for boxes made before a new "Your text" box started empty: the old editor put the word "Note" into every new
 * box, so a box nobody wrote in still holds it and would be shown to signers and printed. In drafts and templates
 * (nothing sent, nobody has seen it) a box holding exactly that word is emptied, and an empty box is shown to nobody
 * and never printed. Envelopes already sent are left as their signers saw them. After this one pass a box that says
 * "Note" was typed by its sender and is kept. Returns how many boxes were emptied.
 */
export function sweepLeftoverNotes(d: any): number {
  d.exec('CREATE TABLE IF NOT EXISTS once_done (name TEXT PRIMARY KEY, at TEXT NOT NULL)');
  if (d.prepare("SELECT 1 FROM once_done WHERE name='leftover_notes'").get()) return 0;
  // col_find reads a value that is kept encrypted (src/server/colcrypt.ts); one that cannot be read is left alone.
  const n = Number(d.prepare(`UPDATE fields SET value=NULL WHERE type='note' AND value IS NOT NULL AND trim(col_find(value), ' ' || char(9) || char(10) || char(13))='Note'
    AND envelope_id IN (SELECT id FROM envelopes WHERE status='draft')`).run().changes);
  d.prepare("INSERT INTO once_done (name, at) VALUES ('leftover_notes', ?)").run(new Date().toISOString());
  return n;
}

function migrate(d: any) {
  const hadPrefill = d.prepare('PRAGMA table_info(fields)').all().some((c: any) => c.name === 'prefill');
  const hadWelcomed = d.prepare('PRAGMA table_info(users)').all().some((c: any) => c.name === 'welcomed_at');
  const hadCameBy = d.prepare('PRAGMA table_info(support_requests)').all().some((c: any) => c.name === 'came_by');
  const hadBounceSaid = d.prepare('PRAGMA table_info(emails)').all().some((c: any) => c.name === 'bounce_said');
  const hadDisputeClose = d.prepare('PRAGMA table_info(disputes)').all().some((c: any) => c.name === 'closed_at');
  const hadOpensFrom = d.prepare('PRAGMA table_info(envelopes)').all().some((c: any) => c.name === 'opens_noted_from');
  for (const [table, column, definition] of COLUMNS) {
    const have = d.prepare(`PRAGMA table_info(${table})`).all().some((c: any) => c.name === column);
    if (!have) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  d.exec('CREATE INDEX IF NOT EXISTS recipients_check ON recipients(check_code)');
  d.exec('CREATE INDEX IF NOT EXISTS retired_tokens_check ON retired_tokens(check_code)');
  // A "Disputed" line once kept the disputer's browser, which the sender reads. It is not part of the line's hash, so
  // it can go without touching the chain; the disputes row keeps it for the operators (src/server/evidence.ts).
  if (!hadDisputeClose) d.exec("UPDATE audit SET user_agent=NULL WHERE action='Disputed' AND user_agent IS NOT NULL");
  // Envelopes completed before "Completed copy opened" was written for each person: their people may have opened the
  // copy already, so the first open recorded from now on is not called the first (noteCopyOpened in evidence.ts).
  if (!hadOpensFrom) d.prepare("UPDATE envelopes SET opens_noted_from=? WHERE status='completed' AND opens_noted_from IS NULL").run(new Date().toISOString());
  // News from the mail provider names an email by the Message-ID we gave it, or only by the address it went to.
  d.exec('CREATE INDEX IF NOT EXISTS emails_message ON emails(message_id)');
  d.exec('CREATE INDEX IF NOT EXISTS emails_to ON emails(to_email COLLATE NOCASE, id)');
  // "Could not be delivered" and "marked as spam" are facts about an address. Whichever way a recipient's address
  // changes (a correction, the editor, a hand-over), the marks go with the old address, so the new person is
  // reminded like anyone else and no path can forget to clear them. A complaint is the person's own word and is kept
  // for the account (mail_complaints): an address that complained has it again, whether it comes back by a correction
  // away and back, by the editor or on a new envelope. Only that person can take it away (routes-bounces.ts).
  const complaint = `(SELECT c.at FROM mail_complaints c JOIN envelopes e ON e.account_id=c.account_id WHERE e.id=new.envelope_id AND e.kind='envelope' AND c.email=new.email)`;
  d.exec(`DROP TRIGGER IF EXISTS recipients_address_changed; CREATE TRIGGER recipients_address_changed AFTER UPDATE OF email ON recipients WHEN lower(old.email) != lower(new.email) BEGIN
    UPDATE recipients SET bounced_at=NULL, bounce_reason=NULL, complained_at=${complaint} WHERE id=new.id;
  END`);
  d.exec(`CREATE TRIGGER IF NOT EXISTS recipients_complaint_kept AFTER INSERT ON recipients WHEN new.email IS NOT NULL AND new.complained_at IS NULL BEGIN
    UPDATE recipients SET complained_at=${complaint} WHERE id=new.id;
  END`);
  // Drafts and templates from before fields kept the sender's own wording apart: everything in them was typed by
  // the sender, so it is copied across once. Envelopes that are already out are left alone, because there a value
  // may be a signer's answer and nothing says which.
  if (!hadPrefill)
    d.exec(`UPDATE fields SET prefill=value WHERE value IS NOT NULL AND readonly=0 AND type IN ('text','number','date','company','title','checkbox','radio','dropdown')
      AND envelope_id IN (SELECT id FROM envelopes WHERE status='draft')`);
  // Everyone who signed up on their own before welcomed_at existed was given the welcome signatures at sign-up.
  // Someone who joined through an invitation (the invitation was accepted in the moment their login was made) was not.
  if (!hadWelcomed)
    d.exec('UPDATE users SET welcomed_at=created_at WHERE NOT EXISTS (SELECT 1 FROM invites i WHERE i.email=users.email AND i.accepted_at=users.created_at)');
  // Help requests from before came_by was kept (see fillOldSupport above).
  if (!hadCameBy) fillOldSupport(d);
  // Bounces from before bounce_said: the mail server's words, which were stored after our own in brackets, move to
  // where only the people who run the server see them. Complaints from before mail_complaints are kept for the account.
  if (!hadBounceSaid) {
    d.exec("UPDATE emails SET bounce_said=bounce_reason, bounce_reason=substr(bounce_reason, 1, instr(bounce_reason, ' (') - 1) WHERE bounce_reason LIKE '% (%'");
    d.exec("INSERT OR IGNORE INTO mail_complaints (account_id, email, at) SELECT e.account_id, lower(r.email), MIN(r.complained_at) FROM recipients r JOIN envelopes e ON e.id=r.envelope_id WHERE r.complained_at IS NOT NULL AND r.email IS NOT NULL GROUP BY e.account_id, lower(r.email)");
  }
  // One batch per person per Idempotency-Key, whatever else happens.
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS bulk_batches_idem ON bulk_batches(account_id, sender_id, idem_key) WHERE idem_key IS NOT NULL');
  // Every account has the monthly price it is on written down (src/server/routes-billing.ts, priceFor).
  fillPrices(d);
  // idempotency_keys used to be keyed by account alone and kept rows whose envelope had been deleted. The new shape
  // has a different primary key and a foreign key, which SQLite cannot add to a table that exists, so a table in the
  // old shape is made again once. Keys whose envelope still exists move to that envelope's sender; the rest pointed
  // at nothing and are dropped.
  if (!d.prepare('PRAGMA table_info(idempotency_keys)').all().some((c: any) => c.name === 'user_id')) {
    try {
      d.exec(`BEGIN;
        ALTER TABLE idempotency_keys RENAME TO idempotency_keys_v1;
        DROP INDEX IF EXISTS idempotency_keys_env;
        ${SCHEMA}
        INSERT OR IGNORE INTO idempotency_keys (account_id, user_id, key, envelope_id, at)
          SELECT k.account_id, e.sender_id, k.key, k.envelope_id, k.at FROM idempotency_keys_v1 k JOIN envelopes e ON e.id=k.envelope_id;
        DROP TABLE idempotency_keys_v1;
        COMMIT;`);
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  }
}

export function db(): any {
  if (!g.__tsdb) {
    const dir = dataDir();
    fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
    const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite');
    const d = new DatabaseSync(path.join(dir, 'sign.db'));
    d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    registerSql(d); // col_find and col_replace for values kept encrypted (src/server/colcrypt.ts)
    d.exec(SCHEMA);
    migrate(d);
    sweepLeftoverNotes(d);
    g.__tsdb = d;
  }
  return g.__tsdb;
}

const norm = (p: any[]) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
// Values kept encrypted (src/server/colcrypt.ts) are opened here, so every row read with all() or get() is readable.
export const all = (sql: string, ...p: any[]): any[] => db().prepare(sql).all(...norm(p)).map((r: any) => openRow({ ...r }));
export const get = (sql: string, ...p: any[]): any => {
  const r = db().prepare(sql).get(...norm(p));
  return r ? openRow({ ...r }) : null;
};
export const run = (sql: string, ...p: any[]) => db().prepare(sql).run(...norm(p));

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// Content-addressed blob store on disk. Each file is named by the SHA-256 of its readable contents, is encrypted when
// FILE_ENCRYPTION_KEY is set, and is checked every time it is read (src/server/filestore.ts).
export function saveBlob(buf: Uint8Array): string {
  db();
  return storeFile(path.join(dataDir(), 'blobs'), buf);
}
export function readBlob(sha: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('bad blob id');
  return readStored(path.join(dataDir(), 'blobs'), sha);
}

// Server secret used for HMACs. Set APP_SECRET in production; otherwise one is generated and kept in the data dir.
export function secret(): string {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  if (!g.__tssecret) {
    db();
    const f = path.join(dataDir(), 'secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    g.__tssecret = fs.readFileSync(f, 'utf8').trim();
  }
  return g.__tssecret;
}
