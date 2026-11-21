import type { Starter } from './types.ts';

export const confidential: Starter = {
  id: 'confidential',
  title: 'Simple confidentiality agreement',
  purpose: 'Asks someone who works with you to keep private what they learn through that work.',
  written: '2026-11-21',
  place: 'No particular country',
  reviewedBy: '',
  roles: [{ key: 'person', name: 'Person keeping it private', order: 1 }, { key: 'org', name: 'For the organisation', order: 2 }],
  blocks: [
    { id: 'intro', kind: 'p', text: 'This agreement is between {organisation} ("we") and the person who signs below ("you"). While you work with us, as staff, a volunteer, a contractor or a partner, you may learn things that are not public. This agreement says how to treat them.' },
    { id: 'what-h', kind: 'h', text: 'What is confidential' },
    { id: 'what', kind: 'p', text: 'Information that is not public and that you learn through your work with us, in any form: about the people we work with and their personal details, our plans, our money matters and our partners. It does not cover information that is already public, that you knew before, or that you get from someone else who is free to share it.' },
    { id: 'agree-h', kind: 'h', text: 'What you agree to' },
    { id: 'agree', kind: 'list', items: [
      'Use it only for your work with us.',
      'Do not share it with anyone who does not need it for that work.',
      'Keep papers and devices that hold it safe, and tell us straight away when something is lost or seen by someone who should not see it.',
      'When your work with us ends, give back or delete what you hold, if we ask.',
    ] },
    { id: 'may-h', kind: 'h', text: 'When you may share it' },
    { id: 'may', kind: 'p', text: 'When the law requires it, or a court or an authority orders it. Where you can, tell us first.' },
    { id: 'long-h', kind: 'h', text: 'How long' },
    { id: 'long', kind: 'p', text: 'This lasts while you work with us and for three years after. For personal details about other people, it lasts for as long as you hold them.' },
    { id: 'sign-h', kind: 'h', text: 'Signatures' },
  ],
  fields: [
    { type: 'full_name', role: 'person', label: 'Full name', required: true, after: 'sign-h' },
    { type: 'signature', role: 'person', label: 'Signature', required: true, after: 'sign-h' },
    { type: 'date_signed', role: 'person', label: 'Date', required: true, after: 'sign-h' },
    { type: 'full_name', role: 'org', label: 'For the organisation: full name', required: true, after: 'sign-h' },
    { type: 'signature', role: 'org', label: 'For the organisation: signature', required: true, after: 'sign-h' },
    { type: 'date_signed', role: 'org', label: 'Date', required: true, after: 'sign-h' },
  ],
};
