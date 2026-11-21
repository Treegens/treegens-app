import type { Starter } from './types.ts';

export const gift: Starter = {
  id: 'gift',
  title: 'Donation or gift declaration',
  purpose: 'Records what a donor gives your organisation, and that they give it freely.',
  written: '2026-11-21',
  place: 'No particular country',
  reviewedBy: '',
  roles: [{ key: 'donor', name: 'Donor', order: 1 }],
  blocks: [
    { id: 'intro', kind: 'p', text: 'This form records a donation or a gift that you, the donor, give to {organisation} of your own free will.' },
    { id: 'what-h', kind: 'h', text: 'What is given' },
    { id: 'what', kind: 'p', text: 'Write what you are giving: an amount of money, or a description of the item. If you have a wish about how it is used, write that too.' },
    { id: 'confirm-h', kind: 'h', text: 'What you confirm' },
    { id: 'confirm', kind: 'list', items: [
      'It is yours to give, and nobody is pressing you to give it.',
      'You expect nothing in return for it: no goods, services or favours.',
      'If you wrote a wish, we will follow it where we can. Without one, we may use the gift wherever it is needed most in our work.',
    ] },
    { id: 'we-h', kind: 'h', text: 'What we do' },
    { id: 'we', kind: 'p', text: 'We keep a record of the gift and use it for our work. If we cannot accept it, or cannot follow your wish, we will tell you before we use it, and give it back if you ask.' },
    { id: 'sign-h', kind: 'h', text: 'Signature' },
  ],
  fields: [
    { type: 'text', role: 'donor', label: 'What you are giving', required: true, after: 'what' },
    { type: 'text', role: 'donor', label: 'Your wish about how it is used (leave empty if none)', required: false, after: 'what' },
    { type: 'full_name', role: 'donor', label: 'Full name', required: true, after: 'sign-h' },
    { type: 'signature', role: 'donor', label: 'Signature', required: true, after: 'sign-h' },
    { type: 'date_signed', role: 'donor', label: 'Date', required: true, after: 'sign-h' },
  ],
};
