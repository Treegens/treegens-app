import type { Starter } from './types.ts';

export const event: Starter = {
  id: 'event',
  title: 'Event participation and risk acknowledgement',
  purpose: 'Tells someone taking part in an event about its risks, and asks for an emergency contact.',
  written: '2026-11-21',
  place: 'No particular country',
  reviewedBy: '',
  asks: [{ key: 'event', label: 'The event, with its date', max: 150, example: 'the beach clean-up on 14 March' }],
  roles: [{ key: 'person', name: 'Participant', order: 1 }],
  blocks: [
    { id: 'intro', kind: 'p', text: 'You are taking part in {event}, organised by {organisation}. This form makes sure you know about the risks, and that we know how to help you if something goes wrong.' },
    { id: 'risks-h', kind: 'h', text: 'The risks' },
    { id: 'risks', kind: 'p', text: 'Activities like this one carry some risk. The organisers explain the risks of the day at the start. Common ones are slips, trips and falls, cuts from tools, insect bites and stings, and the weather: heat, cold, sun and rain.' },
    { id: 'we-h', kind: 'h', text: 'What we do' },
    { id: 'we', kind: 'list', items: [
      'Explain how to stay safe at the start, and answer your questions.',
      'Have a first aid kit, and someone who knows how to use it.',
      'Stop an activity when it becomes unsafe.',
    ] },
    { id: 'you-h', kind: 'h', text: 'What you do' },
    { id: 'you', kind: 'list', items: [
      'Follow the instructions of the organisers, and use the safety equipment you are given.',
      'Tell us about any health condition we need to know about to keep you safe: below, or in private to an organiser.',
      'Stop, and tell someone, when you feel unwell or unsafe.',
    ] },
    { id: 'means-h', kind: 'h', text: 'What signing means' },
    { id: 'means', kind: 'p', text: 'By signing, you confirm that you have read this form, that you take part of your own choice, and that you understand the risks it describes. It does not take away any rights you have by law, and it does not excuse anyone from taking proper care.' },
  ],
  fields: [
    { type: 'text', role: 'person', label: 'Health conditions or allergies we should know about (optional)', required: false, after: 'you' },
    { type: 'text', role: 'person', label: 'Emergency contact: name and phone number', required: true, after: 'you' },
    { type: 'full_name', role: 'person', label: 'Full name', required: true, after: 'means' },
    { type: 'signature', role: 'person', label: 'Signature', required: true, after: 'means' },
    { type: 'date_signed', role: 'person', label: 'Date', required: true, after: 'means' },
  ],
};
