import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { LocationConfig, LocationType } from '../../../../shared/types';
import { assetUrl } from '../../../lib/api';
import { Button, ColorInput, Field, IconButton, Input, Select, Textarea, cx } from '../../../ui';
import { LOCATION_LABEL, displayUrl, slugify } from '../../format';
import { useAdmin } from '../../state';
import { NumberField } from '../Fields';
import { FieldGroup, Notice, Section } from '../Page';
import { ImageField } from '../x/bits';
import { errorFor } from './shared';
import type { TabProps } from './shared';

const PRESET_DURATIONS = [15, 20, 30, 45, 60, 90, 120];
const EMOJI_PICKS = ['👋', '☕', '🌱', '💬', '📞', '🎯', '🤝', '✨'];
const COLOR_PICKS = ['#1b6b43', '#5ede8e', '#e0b04e', '#d9643a', '#3b6fd4', '#7a5cd6', '#c2417a', '#1f2a24'];
const LOCATION_TYPES: LocationType[] = ['google_meet', 'phone_host_calls', 'phone_invitee_calls', 'in_person', 'custom_link', 'ask_invitee'];

const LOCATION_VALUE: Partial<Record<LocationType, { label: string; placeholder: string; inputMode?: 'tel' | 'url' }>> = {
  in_person: { label: 'Address', placeholder: 'Street, city' },
  custom_link: { label: 'Link', placeholder: 'https://', inputMode: 'url' },
  phone_invitee_calls: { label: 'Number they call', placeholder: '+1 555 010 0000', inputMode: 'tel' },
};

const LOCATION_NOTE: Partial<Record<LocationType, string>> = {
  google_meet: 'A Meet link is created for each booking and added to the calendar event.',
  phone_host_calls: 'The form asks for their phone number so you can call them.',
  ask_invitee: 'The invitee types where they would like to meet.',
};

export function BasicsTab({ draft, update, errors, isNew, slugTouched, onSlugTouched }: TabProps & { slugTouched: boolean; onSlugTouched: () => void }) {
  const { data, ownerHost } = useAdmin();
  const [custom, setCustom] = useState(25);
  // A picture just uploaded is shown from the file itself, so it appears at once.
  const [justUploaded, setJustUploaded] = useState<Record<string, string>>({});
  const coverUrl = draft.coverAssetId ? (justUploaded[draft.coverAssetId] ?? assetUrl(draft.coverAssetId)) : null;
  const base = displayUrl(data.publicUrl);
  const durations = draft.durations.slice().sort((a, b) => a - b);
  const chips = Array.from(new Set([...PRESET_DURATIONS, ...durations])).sort((a, b) => a - b);

  const setDurations = (next: number[]) => {
    const sorted = Array.from(new Set(next)).sort((a, b) => a - b);
    update({ durations: sorted, defaultDuration: sorted.includes(draft.defaultDuration) ? draft.defaultDuration : sorted[0] ?? draft.defaultDuration });
  };

  const setLocation = (i: number, patch: Partial<LocationConfig>) => update({ locations: draft.locations.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const needsGoogle = draft.locations.some((l) => l.type === 'google_meet') && !ownerHost.google;

  return (
    <>
      <Section title="Name and link" description="What people see on your booking page, and the address they book at.">
        <Field label="Name" error={errors.title} required>
          <Input
            value={draft.title}
            maxLength={80}
            placeholder="Intro call"
            autoFocus={isNew}
            onChange={(e) => {
              const title = e.target.value;
              update(isNew && !slugTouched ? { title, slug: slugify(title) } : { title });
            }}
          />
        </Field>
        <Field label="Link" error={errors.slug} hint={`People book at ${base}/${draft.slug || 'your-link'}`} required>
          <Input
            value={draft.slug}
            maxLength={60}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            leading={<span className="adm-prefix">/</span>}
            onChange={(e) => {
              onSlugTouched();
              update({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-') });
            }}
          />
        </Field>
        <Field label="Description" optional error={errors.description} hint="A sentence or two about what this meeting is for.">
          <Textarea value={draft.description} rows={3} autoGrow maxLength={1200} onChange={(e) => update({ description: e.target.value })} />
        </Field>
        <div className="adm-grid2">
          <Field label="Emoji" optional error={errors.emoji}>
            <div className="adm-emoji">
              <Input value={draft.emoji ?? ''} maxLength={8} wrapperClassName="adm-emoji__input" onChange={(e) => update({ emoji: e.target.value })} />
              <div className="adm-emoji__picks" role="group" aria-label="Suggestions">
                {EMOJI_PICKS.map((em) => (
                  <button key={em} type="button" className={cx('adm-emoji__pick', draft.emoji === em && 'is-on')} aria-label={`Use ${em}`} aria-pressed={draft.emoji === em} onClick={() => update({ emoji: draft.emoji === em ? '' : em })}>
                    {em}
                  </button>
                ))}
              </div>
            </div>
          </Field>
          <FieldGroup
            label="Colour"
            optional
            error={errors.color}
            hint={draft.color ? 'Used for buttons and highlights on this event.' : 'Using your page colour. Pick one to give this event its own.'}
            action={
              draft.color ? (
                <button type="button" className="adm-textbtn" onClick={() => update({ color: '' })}>
                  Use page colour
                </button>
              ) : undefined
            }
          >
            <ColorInput aria-label="Event colour" value={draft.color || data.site.theme.colors.primary} presets={COLOR_PICKS} onChange={(color) => update({ color })} />
          </FieldGroup>
        </div>
        <ImageField
          label="Cover image"
          shape="wide"
          purpose="event-cover"
          url={coverUrl}
          hint={
            <>
              A banner across the top of this event's page. Without one, the cover from{' '}
              <Link className="adm-textlink" to="/admin/design">
                Design
              </Link>{' '}
              is used. Up to 3 MB.
            </>
          }
          uploadLabel={coverUrl ? 'Replace cover' : 'Upload a cover'}
          onUploaded={(asset) => {
            setJustUploaded((prev) => ({ ...prev, [asset.id]: asset.dataUrl || asset.url }));
            update({ coverAssetId: asset.id });
          }}
          onRemove={() => update({ coverAssetId: null })}
        />
        {errors.coverAssetId ? (
          <p className="adm-fielderror" role="alert">
            {errors.coverAssetId}
          </p>
        ) : null}
      </Section>

      <Section title="Length" description="Offer one length, or several and let people choose.">
        <FieldGroup label="Lengths on offer" error={errorFor(errors, 'durations')}>
          <div className="adm-chips">
            {chips.map((d) => {
              const on = durations.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  className={cx('adm-chip', on && 'is-on')}
                  aria-pressed={on}
                  onClick={() => {
                    if (on && durations.length === 1) return;
                    setDurations(on ? durations.filter((x) => x !== d) : [...durations, d]);
                  }}
                >
                  {d} min
                </button>
              );
            })}
          </div>
          <div className="adm-inline">
            <NumberField aria-label="Another length in minutes" value={custom} min={5} max={480} suffix="min" onChange={setCustom} className="adm-w-sm" />
            <Button variant="secondary" iconLeft={<Plus size={15} />} disabled={durations.includes(custom)} onClick={() => setDurations([...durations, custom])}>
              Add this length
            </Button>
          </div>
        </FieldGroup>
        {durations.length > 1 ? (
          <Field label="Chosen by default" error={errors.defaultDuration}>
            <Select
              wrapperClassName="adm-w-md"
              value={String(draft.defaultDuration)}
              options={durations.map((d) => ({ value: String(d), label: `${d} minutes` }))}
              onChange={(e) => update({ defaultDuration: Number(e.target.value) })}
            />
          </Field>
        ) : null}
      </Section>

      <Section title="Where" description="How you will meet. Add more than one and the invitee picks.">
        {needsGoogle ? (
          <Notice
            tone="warning"
            action={
              <Link className="adm-textlink" to="/admin/integrations">
                Connect Google
              </Link>
            }
          >
            Google Meet links need your Google Calendar to be connected.
          </Notice>
        ) : null}
        <div className="adm-stack">
          {draft.locations.map((loc, i) => {
            const valueField = LOCATION_VALUE[loc.type];
            const err = errors[`locations.${i}.value`] ?? errors[`locations.${i}`];
            return (
              <div className="adm-loc" key={i}>
                <div className="adm-loc__row">
                  <Select
                    aria-label={`Location ${i + 1}`}
                    value={loc.type}
                    wrapperClassName="adm-loc__type"
                    options={LOCATION_TYPES.map((t) => ({ value: t, label: LOCATION_LABEL[t] }))}
                    onChange={(e) => setLocation(i, { type: e.target.value as LocationType, value: undefined })}
                  />
                  {valueField ? (
                    <Input
                      aria-label={valueField.label}
                      placeholder={valueField.placeholder}
                      inputMode={valueField.inputMode}
                      value={loc.value ?? ''}
                      invalid={!!err}
                      wrapperClassName="adm-loc__value"
                      onChange={(e) => setLocation(i, { value: e.target.value })}
                    />
                  ) : (
                    <p className="adm-loc__note">{LOCATION_NOTE[loc.type]}</p>
                  )}
                  <IconButton label={`Remove location ${i + 1}`} icon={<Trash2 />} variant="danger" disabled={draft.locations.length <= 1} onClick={() => update({ locations: draft.locations.filter((_, j) => j !== i) })} />
                </div>
                {err ? (
                  <p className="adm-fielderror" role="alert">
                    {err}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
        {errors.locations ? (
          <p className="adm-fielderror" role="alert">
            {errors.locations}
          </p>
        ) : null}
        <div>
          <Button variant="secondary" size="sm" iconLeft={<Plus size={15} />} disabled={draft.locations.length >= 6} onClick={() => update({ locations: [...draft.locations, { type: nextLocationType(draft.locations) }] })}>
            Add another place
          </Button>
        </div>
      </Section>
    </>
  );
}

function nextLocationType(existing: LocationConfig[]): LocationType {
  return LOCATION_TYPES.find((t) => !existing.some((l) => l.type === t)) ?? 'custom_link';
}
