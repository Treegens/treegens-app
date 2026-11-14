import { Field, Input, Textarea } from '../../../ui';
import { useAdmin } from '../../state';
import { Notice, Section } from '../Page';
import type { TabProps } from './shared';

export function ConfirmationTab({ draft, update, errors }: TabProps) {
  const { data } = useAdmin();
  const c = draft.confirmation;
  const set = (patch: Partial<typeof c>) => update({ confirmation: { ...c, ...patch } });
  const redirecting = !!c.redirectUrl?.trim();

  return (
    <>
      <Section title="After they book" description="What people see once the booking goes through. They always get a confirmation email with the details and links to reschedule or cancel.">
        <Field label="Your message" optional hint={`Shown on the confirmation page, under "${data.site.theme.texts.confirmationTitle}".`} error={errors['confirmation.message']}>
          <Textarea
            rows={4}
            autoGrow
            maxLength={1500}
            value={c.message ?? ''}
            placeholder="Thanks for booking. I will send over a short agenda the day before."
            onChange={(e) => set({ message: e.target.value })}
          />
        </Field>
      </Section>

      <Section title="Send them somewhere else" description="Skip the built-in confirmation page and take people to a page of your own, like a thank-you or an intake form.">
        <Field label="Redirect link" optional hint="Has to start with https://. Leave it empty to show the built-in confirmation page." error={errors['confirmation.redirectUrl']}>
          <Input type="url" inputMode="url" value={c.redirectUrl ?? ''} placeholder="https://" autoCapitalize="none" spellCheck={false} onChange={(e) => set({ redirectUrl: e.target.value })} />
        </Field>
        {redirecting ? <Notice tone="info">People are sent to this link straight after booking, so they will not see your message above. The confirmation email still goes out.</Notice> : null}
      </Section>
    </>
  );
}
