import type { Starter } from './types.ts';

export const grant: Starter = {
  id: 'grant',
  title: 'Acknowledgement of grant terms',
  purpose: 'Confirms that a person or group receiving your grant has its terms and agrees to keep to them.',
  written: '2026-11-21',
  place: 'No particular country',
  reviewedBy: '',
  roles: [{ key: 'grantee', name: 'Person signing for the grant', order: 1 }],
  blocks: [
    { id: 'intro', kind: 'p', text: '{organisation} has awarded a grant to the person or group named below. By signing, you confirm that you have received the grant terms and agree to keep to them.' },
    { id: 'who-h', kind: 'h', text: 'The grant' },
    { id: 'who', kind: 'p', text: 'Who receives it, and which grant it is:' },
    { id: 'confirm-h', kind: 'h', text: 'You confirm that' },
    { id: 'confirm', kind: 'list', items: [
      'You have received and read the grant terms, and had the chance to ask questions about them.',
      'You will use the grant only for the purpose written in those terms.',
      'You will keep records of how the grant is used, and share them with us when we ask.',
      'You will tell us early when plans change, or when you cannot use all of the grant.',
      'If the grant is not used as agreed, we may ask for the unused part back, as the grant terms say.',
    ] },
    { id: 'differ-h', kind: 'h', text: 'If the terms and this page differ' },
    { id: 'differ', kind: 'p', text: 'The grant terms you received decide. This page only confirms that you have them and agree to them.' },
    { id: 'sign-h', kind: 'h', text: 'Signature' },
  ],
  fields: [
    { type: 'text', role: 'grantee', label: 'Name of the person or group receiving the grant', required: true, after: 'who' },
    { type: 'text', role: 'grantee', label: 'Grant name or reference', required: true, after: 'who' },
    { type: 'full_name', role: 'grantee', label: 'Full name', required: true, after: 'sign-h' },
    { type: 'signature', role: 'grantee', label: 'Signature', required: true, after: 'sign-h' },
    { type: 'date_signed', role: 'grantee', label: 'Date', required: true, after: 'sign-h' },
  ],
};
