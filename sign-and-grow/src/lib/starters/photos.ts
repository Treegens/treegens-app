import type { Starter } from './types.ts';

export const photos: Starter = {
  id: 'photos',
  title: 'Consent to photos, video and stories',
  purpose: 'Asks a person whether you may use photos, video and their story, and says how to withdraw it.',
  written: '2026-11-21',
  place: 'No particular country',
  reviewedBy: '',
  roles: [{ key: 'person', name: 'Person giving consent', order: 1 }],
  blocks: [
    { id: 'intro', kind: 'p', text: '{organisation} would like to use photos, video and words about you in its work. This form asks what you agree to. Tick only what you are happy with. Saying no changes nothing about how we treat you.' },
    { id: 'what-h', kind: 'h', text: 'What we would like to use' },
    { id: 'what', kind: 'list', items: [
      'Photos and video in which you can be recognised.',
      'Your words or your story, as you told them to us, possibly shortened.',
      'Your first name, or your full name if you tick that box below.',
    ] },
    { id: 'where-h', kind: 'h', text: 'Where it may appear' },
    { id: 'where', kind: 'p', text: 'In our reports, newsletters, website and social media, and in material we give to the people who fund our work. Once something is printed or shared online, we cannot take every copy back, and other people may copy it.' },
    { id: 'agree-h', kind: 'h', text: 'What you agree to' },
    { id: 'agree', kind: 'p', text: 'Tick each one you agree to. You may tick none.' },
    { id: 'withdraw-h', kind: 'h', text: 'How to withdraw your consent' },
    { id: 'withdraw', kind: 'p', text: 'You can withdraw your consent at any time, for all of it or for part of it, by telling {organisation} in writing. An email is enough, and you do not have to give a reason. From then on we will not use it in anything new, and we will take it off our own website and social media where we can. We cannot call back what was already printed, or what other people have shared. Withdrawing costs you nothing.' },
    { id: 'long-h', kind: 'h', text: 'How long it lasts' },
    { id: 'long', kind: 'p', text: 'Unless you withdraw it sooner, this consent lasts for three years from the day you sign.' },
    { id: 'sign-h', kind: 'h', text: 'Signature' },
  ],
  fields: [
    { type: 'checkbox', role: 'person', label: 'I agree to photos and video of me being used', required: false, after: 'agree' },
    { type: 'checkbox', role: 'person', label: 'I agree to my words or my story being used', required: false, after: 'agree' },
    { type: 'checkbox', role: 'person', label: 'You may use my full name. Without a tick, only my first name.', required: false, after: 'agree' },
    { type: 'full_name', role: 'person', label: 'Full name', required: true, after: 'sign-h' },
    { type: 'signature', role: 'person', label: 'Signature', required: true, after: 'sign-h' },
    { type: 'date_signed', role: 'person', label: 'Date', required: true, after: 'sign-h' },
  ],
};
