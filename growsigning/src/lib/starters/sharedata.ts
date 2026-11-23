import type { Starter } from './types.ts';

export const sharedata: Starter = {
  id: 'share-data',
  title: 'Consent to share personal data with a partner',
  purpose: 'Asks a person whether you may share named details about them with one partner, for one purpose.',
  written: '2026-11-21',
  place: 'No particular country',
  reviewedBy: '',
  asks: [
    { key: 'partner', label: "The partner's name", max: 100, example: 'Riverside Health Clinic' },
    { key: 'data', label: 'What you would share', max: 300, example: 'your name, phone number and the language you speak' },
    { key: 'purpose', label: 'What the partner will use it for', max: 300, example: 'to offer you an appointment' },
  ],
  roles: [{ key: 'person', name: 'Person giving consent', order: 1 }],
  blocks: [
    { id: 'intro', kind: 'p', text: '{organisation} would like to share some of your personal details with {partner}. We will only do so if you agree. Saying no changes nothing about how we treat you.' },
    { id: 'what-h', kind: 'h', text: 'What we would share' },
    { id: 'what', kind: 'p', text: 'Only this, and nothing else: {data}.' },
    { id: 'why-h', kind: 'h', text: 'What it is for' },
    { id: 'why', kind: 'p', text: '{partner} may use it for this purpose only: {purpose}. They may not pass it on to anyone else, or use it for anything else, without asking you.' },
    { id: 'choices-h', kind: 'h', text: 'Your choices' },
    { id: 'choices', kind: 'list', items: [
      'You can withdraw this consent at any time by telling {organisation}. An email is enough, and you do not have to give a reason.',
      'When you do, we stop sharing your details and ask {partner} to stop using them. What was shared before cannot be unshared.',
      'You can ask us at any time what we shared, with whom and when.',
    ] },
    { id: 'sign-h', kind: 'h', text: 'Your answer' },
  ],
  fields: [
    { type: 'checkbox', role: 'person', label: 'I agree to the sharing described above', required: true, after: 'sign-h' },
    { type: 'full_name', role: 'person', label: 'Full name', required: true, after: 'sign-h' },
    { type: 'signature', role: 'person', label: 'Signature', required: true, after: 'sign-h' },
    { type: 'date_signed', role: 'person', label: 'Date', required: true, after: 'sign-h' },
  ],
};
