/**
 * Reminders for one event type: a list of rules ("Email the invitee 24 hours before",
 * "AI assistant calls the invitee 2 hours before", "Text the invitee 15 minutes before"),
 * each with a channel, an audience, a time and optional custom wording.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { BellPlus, BellRing, ChevronRight, Mail, MessageSquareText, Pencil, PhoneCall, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReminderChannel, ReminderRule } from '../../../../shared/types';
import { Badge, Button, ButtonLink, EmptyState, Field, IconButton, Input, Menu, Modal, RadioGroup, SegmentedControl, Select, Switch, Textarea, Tooltip, cx } from '../../../ui';
import { CHANNEL_LABEL, TEMPLATE_VARIABLES_FALLBACK, localId, reminderSentence } from '../../format';
import { useAdmin } from '../../state';
import { OffsetInput } from '../Fields';
import { FieldGroup, Notice, Section } from '../Page';
import type { TabProps } from './shared';

const MAX_OFFSET = 43200;

/** Shown first in the cheat sheet. The rest sit behind "Show all". */
const COMMON_VARIABLES = ['invitee_first_name', 'invitee_name', 'host_name', 'host_names', 'event_name', 'date', 'time', 'datetime', 'duration', 'location', 'join_url', 'manage_url', 'reschedule_url', 'cancel_url', 'confirm_url'];

const CHANNEL_ICON: Record<ReminderChannel, ReactNode> = {
  email: <Mail size={18} />,
  sms: <MessageSquareText size={18} />,
  call: <PhoneCall size={18} />,
};

export function sortRules(rules: ReminderRule[]): ReminderRule[] {
  const rank = (r: ReminderRule) => (r.trigger === 'before_start' ? -r.offsetMinutes : 100000 + r.offsetMinutes);
  return rules.slice().sort((a, b) => rank(a) - rank(b));
}

interface ChannelState {
  ready: boolean;
  /** one short line under the channel name */
  detail: string;
}

function hourLabel(h: number): string {
  const d = new Date(Date.UTC(2023, 0, 1, h % 24, 0));
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(d).replace(/ /g, ' ');
}

export function RemindersTab({ draft, update, errors }: TabProps) {
  const { data } = useAdmin();
  const integ = data.integrations;
  const assistant = data.site.assistant;
  const [editing, setEditing] = useState<{ rule: ReminderRule; isNew: boolean } | null>(null);
  const rules = useMemo(() => sortRules(draft.reminders), [draft.reminders]);
  const hostCount = draft.hostIds.length;

  const channels: Record<ReminderChannel, ChannelState> = {
    email: {
      ready: integ.email.resolved !== 'none',
      detail: integ.email.resolved === 'gmail' ? 'Sent from your Gmail' : integ.email.resolved === 'resend' ? `Sent from ${integ.email.fromEmail || 'your domain'}` : 'Not connected yet',
    },
    sms: { ready: integ.twilio.configured, detail: integ.twilio.configured ? `Sent from ${integ.twilio.fromNumber || 'your Twilio number'}` : 'Not connected yet' },
    call: {
      ready: integ.twilio.configured,
      detail: !integ.twilio.configured
        ? 'Not connected yet'
        : integ.anthropic.configured
          ? `${assistant.name} calls between ${hourLabel(assistant.callWindowStartHour)} and ${hourLabel(assistant.callWindowEndHour)}, their time`
          : 'Uses a simple script until you add an Anthropic key',
    },
  };

  const setRules = (next: ReminderRule[]) => update({ reminders: sortRules(next) });
  const needsPhone = draft.phone === 'hidden' && draft.reminders.some((r) => r.enabled && r.audience === 'invitee' && r.channel !== 'email');

  const startNew = (channel: ReminderChannel) =>
    setEditing({
      isNew: true,
      rule: { id: localId('rem'), enabled: true, channel, audience: 'invitee', trigger: 'before_start', offsetMinutes: channel === 'email' ? 1440 : channel === 'call' ? 120 : 15 },
    });

  return (
    <>
      <Section
        title="Channels"
        description="Three ways to make sure people show up. Each one works as soon as it is connected."
        aside={
          <Link className="adm-textlink" to="/admin/integrations">
            Open Integrations
          </Link>
        }
      >
        <ul role="list" className="adm-channels">
          {(['email', 'sms', 'call'] as ReminderChannel[]).map((c) => (
            <li key={c} className={cx('adm-channel', !channels[c].ready && 'is-off')}>
              <span className="adm-channel__icon" aria-hidden="true">
                {CHANNEL_ICON[c]}
              </span>
              <div className="adm-channel__text">
                <p className="adm-channel__name">{CHANNEL_LABEL[c]}</p>
                <p className="adm-channel__detail">{channels[c].detail}</p>
              </div>
              {channels[c].ready ? (
                <Badge tone="success" size="sm" dot>
                  Ready
                </Badge>
              ) : (
                <ButtonLink variant="secondary" size="sm" to="/admin/integrations" iconRight={<ChevronRight size={14} />}>
                  Connect
                </ButtonLink>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Reminders"
        description="Sent automatically for every booking of this event type. Texts and calls only go to invitees who gave a number and agreed to them."
      >
        {needsPhone ? (
          <Notice
            tone="warning"
            action={
              <Button variant="secondary" size="sm" onClick={() => update({ phone: 'optional' })}>
                Ask for a number
              </Button>
            }
          >
            Texts and calls need a phone number, but this event's form does not ask for one.
          </Notice>
        ) : null}

        {rules.length === 0 ? (
          <div className="adm-well">
            <EmptyState compact align="start" icon={<BellRing />} title="No reminders" description="People only get the confirmation. Add a reminder so nobody forgets." />
          </div>
        ) : (
          <ul role="list" className="adm-rules">
            {rules.map((rule) => {
              const state = channels[rule.channel];
              const index = draft.reminders.findIndex((r) => r.id === rule.id);
              const err = Object.keys(errors).find((k) => k.startsWith(`reminders.${index}.`));
              const custom = !!rule.body?.trim() || !!rule.subject?.trim();
              return (
                <li key={rule.id} className={cx('adm-rule', !rule.enabled && 'is-off')}>
                  <span className={cx('adm-rule__icon', `adm-rule__icon--${rule.channel}`)} aria-hidden="true">
                    {CHANNEL_ICON[rule.channel]}
                  </span>
                  <div className="adm-rule__text">
                    <p className="adm-rule__sentence">{reminderSentence(rule, hostCount)}</p>
                    <p className="adm-rule__meta">
                      {rule.channel === 'call' ? `${assistant.name} confirms they are coming and can send a reschedule link` : custom ? 'Your own wording' : 'Standard wording'}
                      {!state.ready ? (
                        <>
                          {' · '}
                          <Link className="adm-rule__warn" to="/admin/integrations">
                            {CHANNEL_LABEL[rule.channel]} is not connected yet
                          </Link>
                        </>
                      ) : null}
                    </p>
                    {err ? (
                      <p className="adm-fielderror" role="alert">
                        {errors[err]}
                      </p>
                    ) : null}
                  </div>
                  <div className="adm-rule__actions">
                    <Switch size="sm" checked={rule.enabled} onChange={(enabled) => setRules(draft.reminders.map((r) => (r.id === rule.id ? { ...r, enabled } : r)))} aria-label={`${reminderSentence(rule, hostCount)}: on`} />
                    <IconButton size="sm" label="Edit this reminder" icon={<Pencil />} onClick={() => setEditing({ rule, isNew: false })} />
                    <IconButton size="sm" variant="danger" label="Remove this reminder" icon={<Trash2 />} onClick={() => setRules(draft.reminders.filter((r) => r.id !== rule.id))} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div>
          <Menu
            label="Add a reminder"
            align="start"
            trigger={
              <Button variant="secondary" iconLeft={<BellPlus size={16} />}>
                Add a reminder
              </Button>
            }
            items={[
              { label: 'Email', icon: <Mail size={16} />, hint: channels.email.ready ? undefined : 'Not connected', onSelect: () => startNew('email') },
              { label: 'Text message', icon: <MessageSquareText size={16} />, hint: channels.sms.ready ? undefined : 'Not connected', onSelect: () => startNew('sms') },
              { label: 'AI phone call', icon: <PhoneCall size={16} />, hint: channels.call.ready ? undefined : 'Not connected', onSelect: () => startNew('call') },
            ]}
          />
        </div>
      </Section>

      <RuleDialog
        editing={editing}
        channels={channels}
        hostCount={hostCount}
        assistantName={assistant.name}
        variables={data.templateVariables?.length ? data.templateVariables : TEMPLATE_VARIABLES_FALLBACK}
        onClose={() => setEditing(null)}
        onSave={(rule) => {
          const exists = draft.reminders.some((r) => r.id === rule.id);
          setRules(exists ? draft.reminders.map((r) => (r.id === rule.id ? rule : r)) : [...draft.reminders, rule]);
          setEditing(null);
        }}
      />
    </>
  );
}

interface RuleDialogProps {
  editing: { rule: ReminderRule; isNew: boolean } | null;
  channels: Record<ReminderChannel, ChannelState>;
  hostCount: number;
  assistantName: string;
  variables: { key: string; description: string }[];
  onClose: () => void;
  onSave: (rule: ReminderRule) => void;
}

function RuleDialog({ editing, channels, hostCount, assistantName, variables, onClose, onSave }: RuleDialogProps) {
  const [rule, setRule] = useState<ReminderRule | null>(editing?.rule ?? null);
  const [custom, setCustom] = useState(false);
  const [allVars, setAllVars] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<'subject' | 'body'>('body');

  useEffect(() => {
    if (!editing) return;
    setRule(editing.rule);
    setCustom(!!editing.rule.body?.trim() || !!editing.rule.subject?.trim());
    setAllVars(false);
    lastField.current = 'body';
  }, [editing]);

  if (!rule) return null;

  const common = variables.filter((v) => COMMON_VARIABLES.includes(v.key));
  const shownVars = allVars || common.length < 4 ? variables : common;

  const patch = (p: Partial<ReminderRule>) => setRule((r) => (r ? { ...r, ...p } : r));
  const isCall = rule.channel === 'call';
  const state = channels[rule.channel];
  const tooFar = rule.offsetMinutes > MAX_OFFSET;

  const setChannel = (channel: ReminderChannel) => {
    if (channel === 'call') patch({ channel, audience: 'invitee', trigger: 'before_start' });
    else patch({ channel });
  };

  const insert = (key: string) => {
    const token = `{{${key}}}`;
    const useSubject = lastField.current === 'subject' && rule.channel === 'email';
    const el = useSubject ? subjectRef.current : bodyRef.current;
    const current = (useSubject ? rule.subject : rule.body) ?? '';
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    patch(useSubject ? { subject: next } : { body: next });
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = () => {
    const keepWording = custom && !isCall;
    const subject = keepWording && rule.channel === 'email' ? rule.subject?.trim() || undefined : undefined;
    const body = keepWording ? rule.body?.trim() || undefined : undefined;
    onSave({ ...rule, subject, body });
  };

  return (
    <Modal
      open={editing !== null}
      onClose={onClose}
      size="md"
      title={editing?.isNew ? 'Add a reminder' : 'Edit reminder'}
      description={reminderSentence(rule, hostCount)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={tooFar} onClick={save}>
            {editing?.isNew ? 'Add reminder' : 'Done'}
          </Button>
        </>
      }
    >
      <div className="adm-ruleform">
        <RadioGroup<ReminderChannel>
          label="How"
          variant="cards"
          columns={3}
          value={rule.channel}
          onChange={setChannel}
          options={[
            { value: 'email', icon: <Mail size={18} />, label: 'Email' },
            { value: 'sms', icon: <MessageSquareText size={18} />, label: 'Text' },
            { value: 'call', icon: <PhoneCall size={18} />, label: 'AI phone call' },
          ]}
        />

        {!state.ready ? (
          <Notice
            tone="warning"
            action={
              <Link className="adm-textlink" to="/admin/integrations">
                Set it up
              </Link>
            }
          >
            {CHANNEL_LABEL[rule.channel]} is not connected yet. You can add this reminder now and it starts working once you connect it.
          </Notice>
        ) : null}

        <FieldGroup label="Who gets it">
          <SegmentedControl
            aria-label="Who gets it"
            value={rule.audience}
            onChange={(audience) => patch({ audience })}
            options={[
              { value: 'invitee', label: 'The invitee' },
              { value: 'host', label: hostCount > 1 ? 'The hosts' : 'You, the host', disabled: isCall },
            ]}
          />
        </FieldGroup>

        <div className="adm-grid2">
          <FieldGroup label="When" error={tooFar ? 'At most 30 days away from the meeting.' : undefined}>
            <OffsetInput label="When" value={rule.offsetMinutes} maxMinutes={MAX_OFFSET} invalid={tooFar} onChange={(offsetMinutes) => patch({ offsetMinutes })} />
          </FieldGroup>
          <Field label="Before or after">
            <Select
              value={rule.trigger}
              disabled={isCall}
              options={[
                { value: 'before_start', label: 'before it starts' },
                { value: 'after_end', label: 'after it ends' },
              ]}
              onChange={(e) => patch({ trigger: e.target.value as ReminderRule['trigger'] })}
            />
          </Field>
        </div>

        {isCall ? (
          <div className="adm-callnote">
            <PhoneCall size={18} aria-hidden="true" />
            <div>
              <p className="adm-callnote__title">{assistantName} makes the call</p>
              <p>
                It says straight away that it is an AI assistant calling for you, reminds them of the meeting, and asks if they can still make it. They can confirm, ask for a link to reschedule, or cancel. Calls only go to people who gave a number and agreed to calls, and only
                during daytime in their own time zone.
              </p>
              <p>
                Change the name, voice and tone under <Link to="/admin/settings">Settings</Link>.
              </p>
            </div>
          </div>
        ) : (
          <div className="adm-wording">
            <Switch
              labelSide="start"
              checked={custom}
              onChange={setCustom}
              label="Write my own wording"
              description={custom ? 'Leave a box empty to use the standard text for it.' : 'The standard wording is friendly, short, and has the meeting details and links.'}
            />
            {custom ? (
              <>
                {rule.channel === 'email' ? (
                  <Field label="Subject" optional>
                    <Input ref={subjectRef} value={rule.subject ?? ''} maxLength={200} placeholder="Reminder: {{event_name}} on {{date}}" onFocus={() => (lastField.current = 'subject')} onChange={(e) => patch({ subject: e.target.value })} />
                  </Field>
                ) : null}
                <Field label="Message" hint={rule.channel === 'sms' ? 'Keep it short: texts are cut at 300 characters.' : undefined}>
                  <Textarea
                    ref={bodyRef}
                    rows={rule.channel === 'sms' ? 3 : 5}
                    autoGrow
                    maxLength={rule.channel === 'sms' ? 600 : 4000}
                    value={rule.body ?? ''}
                    placeholder={rule.channel === 'sms' ? 'Hi {{invitee_first_name}}, see you {{date}} at {{time}}. Need to change it? {{manage_url}}' : 'Hi {{invitee_first_name}},\n\nJust a reminder about {{event_name}} on {{datetime}}.'}
                    onFocus={() => (lastField.current = 'body')}
                    onChange={(e) => patch({ body: e.target.value })}
                  />
                </Field>
                <div className="adm-vars">
                  <p className="adm-vars__title">Click to insert. Each one is filled in for every booking.</p>
                  <div className="adm-vars__list">
                    {shownVars.map((v) => (
                      <Tooltip key={v.key} content={v.description}>
                        <button type="button" className="adm-var" onClick={() => insert(v.key)}>
                          {`{{${v.key}}}`}
                        </button>
                      </Tooltip>
                    ))}
                    {shownVars.length < variables.length ? (
                      <button type="button" className="adm-textbtn" onClick={() => setAllVars(true)}>
                        Show all {variables.length}
                      </button>
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}
