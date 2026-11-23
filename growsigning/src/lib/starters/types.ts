// The shape of a ready-made template (a "starter"): one file per starter in this folder, listed in index.ts.
// No environment and no side effects, so pages and the server read the same files. The server turns one into a
// PDF with its fields (src/server/starters.ts); the Templates page lists them.

/** A piece of the text: a heading, a paragraph, or a list of points. `id` is what a field's `after` points at. */
export type Block = { id: string; kind: 'h' | 'p' | 'list'; text?: string; items?: string[] };

/** Who fills it in. `key` is what a field's `role` names; `name` is the role's name in the template. */
export type StarterRole = { key: string; name: string; order: number };

/** The field types a starter may use: the ones the editor offers for a signer. */
export type StarterFieldType = 'signature' | 'initials' | 'full_name' | 'date_signed' | 'text' | 'date' | 'checkbox' | 'email';

/** One field, placed under the block named by `after`, for the role named by `role`. */
export type StarterField = { type: StarterFieldType; role: string; label: string; required: boolean; after: string };

/**
 * Something the sender writes in once, when they pick the starter: their organisation's name always, and for a few
 * starters a partner, an event or what is shared. It is printed into the text wherever `{key}` stands.
 */
export type StarterAsk = { key: string; label: string; max: number; example?: string };

export type Starter = {
  id: string;
  title: string;
  /** One line: what it is for. */
  purpose: string;
  blocks: Block[];
  roles: StarterRole[];
  fields: StarterField[];
  /** Words asked for when it is picked, besides the organisation's name. */
  asks?: StarterAsk[];
  /** The day it was written, year-month-day. */
  written: string;
  /** The place it is written for: 'No particular country' unless a lawyer of a country reviewed it. */
  place: string;
  /** Who reviewed it (a lawyer, by name and where they practise). Empty until a lawyer has. */
  reviewedBy: string;
};
