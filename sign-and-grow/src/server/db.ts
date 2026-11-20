import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
CREATE TABLE IF NOT EXISTS retired_tokens (token TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, retired_at TEXT NOT NULL);
-- The security codes of emails about documents that were deleted since, as fingerprints only: no name, no address,
-- no subject. They let the check page say "that email was real, the document has been deleted" instead of "fake".
CREATE TABLE IF NOT EXISTS forgotten_codes (code_hash TEXT PRIMARY KEY, at TEXT NOT NULL);
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
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS never alters an existing table, so each
// one is added here if it is missing. Only ever append to this list.
const COLUMNS: [table: string, column: string, definition: string][] = [
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
];

function migrate(d: any) {
  const hadPrefill = d.prepare('PRAGMA table_info(fields)').all().some((c: any) => c.name === 'prefill');
  const hadWelcomed = d.prepare('PRAGMA table_info(users)').all().some((c: any) => c.name === 'welcomed_at');
  for (const [table, column, definition] of COLUMNS) {
    const have = d.prepare(`PRAGMA table_info(${table})`).all().some((c: any) => c.name === column);
    if (!have) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  d.exec('CREATE INDEX IF NOT EXISTS recipients_check ON recipients(check_code)');
  d.exec('CREATE INDEX IF NOT EXISTS retired_tokens_check ON retired_tokens(check_code)');
  // News from the mail provider names an email by the Message-ID we gave it, or only by the address it went to.
  d.exec('CREATE INDEX IF NOT EXISTS emails_message ON emails(message_id)');
  d.exec('CREATE INDEX IF NOT EXISTS emails_to ON emails(to_email COLLATE NOCASE, id)');
  // "Could not be delivered" and "marked as spam" are facts about an address. Whichever way a recipient's address
  // changes (a correction, the editor, a hand-over), the marks go with the old address, so the new person is
  // reminded like anyone else and no path can forget to clear them.
  d.exec(`CREATE TRIGGER IF NOT EXISTS recipients_address_changed AFTER UPDATE OF email ON recipients WHEN lower(old.email) != lower(new.email) BEGIN
    UPDATE recipients SET bounced_at=NULL, bounce_reason=NULL, complained_at=NULL WHERE id=new.id;
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
  // One batch per person per Idempotency-Key, whatever else happens.
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS bulk_batches_idem ON bulk_batches(account_id, sender_id, idem_key) WHERE idem_key IS NOT NULL');
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
    d.exec(SCHEMA);
    migrate(d);
    g.__tsdb = d;
  }
  return g.__tsdb;
}

const norm = (p: any[]) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
export const all = (sql: string, ...p: any[]): any[] => db().prepare(sql).all(...norm(p)).map((r: any) => ({ ...r }));
export const get = (sql: string, ...p: any[]): any => {
  const r = db().prepare(sql).get(...norm(p));
  return r ? { ...r } : null;
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

// Content-addressed blob store on disk.
const blobPath = (sha: string) => path.join(dataDir(), 'blobs', sha);
export function saveBlob(buf: Uint8Array): string {
  db();
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (!fs.existsSync(blobPath(sha))) fs.writeFileSync(blobPath(sha), buf);
  return sha;
}
export function readBlob(sha: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('bad blob id');
  return fs.readFileSync(blobPath(sha));
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
