import { Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Theme } from '../../../../shared/types';
import { Button, Field, RadioGroup, Select, Switch } from '../../../ui';
import { useAdmin } from '../../state';
import { Notice, Section } from '../Page';
import type { TabProps } from './shared';

type OverrideKey = 'layout' | 'calendarStyle' | 'slotStyle';

const LOOK: { key: OverrideKey; label: string; options: { value: string; label: string }[] }[] = [
  {
    key: 'layout',
    label: 'Layout',
    options: [
      { value: 'split', label: 'Side by side' },
      { value: 'stacked', label: 'Stacked' },
      { value: 'centered', label: 'Centered' },
    ],
  },
  {
    key: 'calendarStyle',
    label: 'Calendar',
    options: [
      { value: 'grid', label: 'Grid' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'bubbles', label: 'Bubbles' },
    ],
  },
  {
    key: 'slotStyle',
    label: 'Time slots',
    options: [
      { value: 'list', label: 'List' },
      { value: 'grid', label: 'Grid' },
      { value: 'chips', label: 'Chips' },
    ],
  },
];

export function AdvancedTab({ draft, update, errors, isNew, onDelete }: TabProps & { onDelete: () => void }) {
  const { data, ownerHost } = useAdmin();
  const override = draft.themeOverride ?? {};
  const theme = data.site.theme;

  const setLook = (key: OverrideKey, value: string) => {
    const next: Partial<Theme> = { ...override };
    if (value) (next as Record<string, unknown>)[key] = value;
    else delete next[key];
    update({ themeOverride: Object.keys(next).length ? next : null });
  };

  return (
    <>
      <Section title="Visibility" description="Whether this event shows on your booking page, and whether it can be booked at all.">
        <RadioGroup
          aria-label="Visibility"
          variant="cards"
          columns={2}
          value={draft.visibility}
          onChange={(visibility) => update({ visibility })}
          options={[
            { value: 'public', label: 'Listed', description: 'Shown on your booking page for anyone to pick.' },
            { value: 'unlisted', label: 'Unlisted', description: 'Hidden from your page. Only people you send the link to can book.' },
          ]}
        />
        <Switch labelSide="start" checked={draft.active} onChange={(active) => update({ active })} label="Accept bookings" description={draft.active ? 'People can book this event.' : 'Paused. The link shows that this event is not available right now.'} />
      </Section>

      <Section title="Google Calendar" description="Every booking is written to the hosts' calendars automatically.">
        {!ownerHost.google ? (
          <Notice
            tone="warning"
            action={
              <Link className="adm-textlink" to="/admin/integrations">
                Connect Google
              </Link>
            }
          >
            Your Google Calendar is not connected yet, so bookings are not added to it.
          </Notice>
        ) : null}
        <Switch
          labelSide="start"
          checked={draft.googleInvite}
          onChange={(googleInvite) => update({ googleInvite })}
          label="Invite the invitee on the calendar event"
          description="Google adds them and their guests as attendees and emails the invitation. Turn this off to keep the event on host calendars only."
        />
      </Section>

      <Section
        title="Look of this event"
        description="Use a different layout for this event's page. Its colour is on the Basics tab, and everything else follows your design."
        aside={
          <Link className="adm-textlink" to="/admin/design">
            Open Design
          </Link>
        }
      >
        <div className="adm-grid3">
          {LOOK.map((item) => {
            const pageValue = item.options.find((o) => o.value === theme[item.key])?.label ?? 'page setting';
            return (
              <Field key={item.key} label={item.label} hint={`Your page uses ${pageValue.toLowerCase()}.`} error={errors[`themeOverride.${item.key}`]}>
                <Select value={(override[item.key] as string | undefined) ?? ''} options={[{ value: '', label: 'Same as my page' }, ...item.options]} onChange={(e) => setLook(item.key, e.target.value)} />
              </Field>
            );
          })}
        </div>
      </Section>

      {!isNew ? (
        <Section title="Delete" description="Remove this event type for good.">
          <div className="adm-danger">
            <p>Its link stops working straight away. Meetings that are already booked stay on your calendar.</p>
            <Button variant="danger-soft" iconLeft={<Trash2 size={16} />} onClick={onDelete}>
              Delete this event type
            </Button>
          </div>
        </Section>
      ) : null}
    </>
  );
}
