'use client';
import { newId } from '../ui';
import type { History } from './history';
import type { KeptForPerson } from '../../lib/tplroles';

// [type, label, width, height] with sizes as a fraction of the page. Height 0 means "make it square".
export const TYPES: [string, string, number, number][] = [
  ['signature', 'Signature', 0.22, 0.055], ['initials', 'Initials', 0.08, 0.045], ['date_signed', 'Date signed', 0.14, 0.026], ['full_name', 'Name', 0.2, 0.026],
  ['email', 'Email', 0.24, 0.026], ['company', 'Company', 0.2, 0.026], ['title', 'Title', 0.2, 0.026], ['text', 'Text', 0.22, 0.026],
  ['number', 'Number', 0.12, 0.026], ['date', 'Date', 0.14, 0.026], ['checkbox', 'Checkbox', 0.024, 0], ['radio', 'Radio', 0.024, 0],
  ['dropdown', 'Dropdown', 0.2, 0.026], ['attachment', 'Attachment', 0.2, 0.03], ['note', 'Note', 0.25, 0.026],
  // The sender's line through wording printed on the page (src/lib/strike.ts). Like a note, it belongs to nobody.
  ['strike', 'Strike out', 0.3, 0.02],
  // A company stamp or seal (src/server/stamps.ts). It starts at 40 mm across: see add() in StepFields.tsx.
  ['stamp', 'Stamp', 0.18, 0],
];
/** Marks the sender puts on a page that belong to no recipient: words added (a note) and words struck out. */
export const SENDER_MARK = (type: string) => type === 'note' || type === 'strike';
export const TLABEL: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t[0], t[1]]));
export const PREFILL = ['text', 'number', 'date', 'company', 'title', 'note'];
export const MIN_W = 0.012;
export const MIN_H = 0.008;
// The server keeps at most this many of each and drops the rest without a word, so the editor stops earlier.
export const MAX_DOCS = 30;
export const MAX_RECIPIENTS = 50;
export const MAX_FIELDS = 2000;

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
// A witness signs too, in a block of their own (editor/WitnessChoice.tsx), and never uses a signature.
export const SIGNS = (r: any) => r.role === 'signer' || r.role === 'inperson' || r.role === 'witness';
export const who = (r: any) => r?.name || r?.role_name || r?.email || 'Unnamed';
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Box = { x: number; y: number; w: number; h: number };

export function makeField(type: string, documentId: string, page: number, recipientId: string | null, box: Box, over: any = {}) {
  return {
    id: newId('fld'), document_id: documentId, recipient_id: SENDER_MARK(type) ? null : recipientId, type, page, ...box,
    required: !['checkbox', 'company', 'title', 'attachment', 'strike'].includes(type), label: '', value: type === 'note' ? 'Note' : '',
    options: type === 'dropdown' ? ['Option 1', 'Option 2'] : [], group_name: type === 'radio' ? 'Group 1' : '', validation: '', readonly: SENDER_MARK(type),
    ...over,
  };
}

// 'preparing': a photo is being made smaller in the browser before it is uploaded (photos.ts).
export type Upload = { key: string; name: string; size: number; progress: number; state: 'waiting' | 'preparing' | 'uploading' | 'checking' | 'error'; error?: string };
export type Confirm = { title: string; body: string; yes: string; no?: string; danger?: boolean; onYes: () => void };

// Everything the three steps share. The Editor owns the state; the steps only draw it and ask for changes.
export type Ed = {
  env: any;
  base: any;
  isTpl: boolean;
  correcting: boolean;
  /** People who have finished. Their rows and fields cannot change. */
  lockedIds: Set<string>;
  lockedNames: string;
  anyLocked: boolean;
  isLockedField: (f: any) => boolean;
  /** Set when the envelope was started from a template whose wording is locked for this person (src/server/tplroles.ts). */
  wording?: { template_id: string; template: string | null; ask: string; fixed: string[]; people?: Record<string, KeptForPerson> } | null;
  docs: any[];
  rcps: any[];
  fields: History<any[]>;
  contacts: any[];
  uploads: Upload[];
  color: (recipientId: string | null) => string;
  patchEnv: (p: any) => void;
  addFiles: (list: FileList | File[] | null) => void;
  dismissUpload: (key: string) => void;
  renameDoc: (id: string, name: string) => void;
  removeDoc: (id: string) => void;
  replaceDoc: (id: string, file: File | null | undefined) => void;
  moveDoc: (index: number, by: number) => void;
  /** Pages removed, turned or moved (PageTools.tsx): the document takes the new file and its fields go with their pages. */
  pagesChanged: (id: string, file: any, plan: { from: number; turn: number }[]) => void;
  /** A document written in the app (WriteDoc.tsx): added, or put in the place of `replaceId`, with the fields its tags make. */
  addWritten: (file: any, found: { type: string; signer: number; label: string; required: boolean; page: number; x: number; y: number; w: number; h: number }[], replaceId?: string) => void;
  addRcp: (p?: any) => void;
  /** "Add me": the sender as someone who signs. */
  addMe: () => void;
  /** An empty row nobody typed into: on screen in step 1, and neither saved, sent nor listed (Editor.tsx). */
  isIdle: (r: any) => boolean;
  /** What step 1 was asked for when Next was pressed too early: a file or a person. Said in place (StepAdd.tsx). */
  nudge?: '' | 'file' | 'person';
  /** The only person on a new document is the sender, so the main button reads "Sign now" (src/lib/editorux.ts). */
  signNow: boolean;
  patchRcp: (id: string, p: any) => void;
  removeRcp: (id: string) => void;
  /** The person just removed with the cross, and where they stood, until Undo or the next removal (RemovedLine.tsx). */
  removed?: { r: any; at: number } | null;
  undoRemove?: () => void;
  /** Changes the fields and remembers the step so it can be undone. */
  setFields: History<any[]>['set'];
  undo: () => void;
  redo: () => void;
  modalOpen: boolean;
  go: (step: number) => void;
  /** Opens step 2 with this field selected and the cursor in its Label box (from the review step's list). */
  showField: (fieldId: string) => void;
  /** The field step 2 is asked to open on, until it has done so. */
  jump: string | null;
  clearJump: () => void;
};
