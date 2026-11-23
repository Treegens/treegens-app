import type { Starter } from './types.ts';

export const equipment: Starter = {
  id: 'equipment',
  title: 'Equipment loan',
  purpose: 'Records what you lend, when it comes back, and what happens if it is lost or damaged.',
  written: '2026-11-21',
  place: 'No particular country',
  reviewedBy: '',
  // The organisation writes in what it lends and by when it comes back, then the borrower reads it all and signs.
  roles: [{ key: 'org', name: 'For the organisation', order: 1 }, { key: 'borrower', name: 'Borrower', order: 2 }],
  blocks: [
    { id: 'intro', kind: 'p', text: '{organisation} lends the equipment written below to the borrower who signs this form.' },
    { id: 'what-h', kind: 'h', text: 'What is lent' },
    { id: 'what', kind: 'p', text: 'The equipment, its condition, and the day it comes back:' },
    { id: 'agree-h', kind: 'h', text: 'The borrower agrees to' },
    { id: 'agree', kind: 'list', items: [
      'Use the equipment with care, only for what it was lent for, and follow any instructions that come with it.',
      'Not lend it to anyone else without asking us first.',
      'Tell us straight away when it is lost, stolen or damaged.',
      'Bring it back by the day written above, or earlier if we ask, in the same condition apart from normal wear.',
    ] },
    { id: 'wrong-h', kind: 'h', text: 'If something goes wrong' },
    { id: 'wrong', kind: 'p', text: 'If the equipment is lost or damaged through carelessness, we may ask the borrower to pay for its repair or to replace it. We talk to the borrower first, and we never ask for more than the repair costs or than a fair value of what was lost.' },
    { id: 'sign-h', kind: 'h', text: 'Signatures' },
  ],
  fields: [
    { type: 'text', role: 'org', label: 'What is lent (with serial numbers, if any)', required: true, after: 'what' },
    { type: 'text', role: 'org', label: 'Its condition when lent', required: false, after: 'what' },
    { type: 'date', role: 'org', label: 'Back by', required: true, after: 'what' },
    { type: 'full_name', role: 'borrower', label: 'Borrower: full name', required: true, after: 'sign-h' },
    { type: 'signature', role: 'borrower', label: 'Borrower: signature', required: true, after: 'sign-h' },
    { type: 'date_signed', role: 'borrower', label: 'Date', required: true, after: 'sign-h' },
    { type: 'full_name', role: 'org', label: 'For the organisation: full name', required: true, after: 'sign-h' },
    { type: 'signature', role: 'org', label: 'For the organisation: signature', required: true, after: 'sign-h' },
    { type: 'date_signed', role: 'org', label: 'Date', required: true, after: 'sign-h' },
  ],
};
