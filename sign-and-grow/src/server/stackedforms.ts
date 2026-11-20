// Public forms and the rule about fields that cover each other (src/lib/stacked.ts). A new form is not made from a
// template whose fields cover each other, and such a template cannot be saved any more (saveDraft). A form made
// before the rule keeps taking visitors: turning all of them away (it used to answer "This form cannot take new
// signatures right now" to everyone) helps nobody, and Text view on the signing page reaches every field. Its
// owner is told what to move instead, once a day at most.
import { get, run } from './db.ts';
import { bad, now, baseUrl } from './util.ts';
import { sendMail } from './mail.ts';
import { loadEnvelope } from './envelopes.ts';
import { stackedFields } from '../lib/stacked.ts';

const problemsOf = (templateId: string): string[] => {
  const t = loadEnvelope(templateId);
  return t ? stackedFields(t.fields, t.recipients, t.documents) : [];
};

/** POST /powerforms: refused, with what to move, before anyone can open the form. */
export function assertFormNotStacked(templateId: string) {
  const st = problemsOf(templateId);
  if (st.length) throw bad(`${st.join(' ')} Change the template first. The form was not made.`);
}

/** After a visitor started a form whose template still has fields that cover each other. */
export async function tellStackedForm(p: any, ownerId: string) {
  if (p.stacked_told_at && Date.parse(p.stacked_told_at) >= Date.now() - 864e5) return;
  const st = problemsOf(p.template_id);
  if (!st.length) return;
  run('UPDATE powerforms SET stacked_told_at=? WHERE id=?', now(), p.id);
  const owner = get('SELECT email FROM users WHERE id=?', ownerId);
  if (owner)
    await sendMail({
      to: owner.email, subject: `Two fields on your form "${p.name}" cover each other`, heading: 'One field on your form is hard to reach',
      lines: [`Someone just started your form "${p.name}". ${st.join(' ')}`,
        'They can still fill it in: the covered field can be reached in Text view on the signing page, and the page points them there when they get stuck. On a phone it is easy to miss. Open the template, move one of the two fields, and save it.'],
      cta: { label: 'Open your templates', url: `${baseUrl()}/app/templates` },
    });
}
