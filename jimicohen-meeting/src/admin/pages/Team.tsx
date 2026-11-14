/**
 * Team: the people who host meetings. Adding a co-host is meant to take a minute:
 * add the person, copy their private link, they open it and connect a calendar. After that
 * one click creates a joint meeting type that only offers times when both are free.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, CalendarCheck, CalendarX2, ChevronRight, Clock, Globe, Link2, Mail, MoreHorizontal, Pencil, RefreshCw, Trash2, Unplug, UserPlus, Users } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { RESERVED_SLUGS } from '../../../shared/defaults';
import type { AdminBootstrap, AdminHost, EventType } from '../../../shared/types';
import { ApiFailure, createEventType, createHost, deleteHost, disconnectGoogle, errorMessage, regenerateInvite, updateHost } from '../../lib/api';
import { formatTime, zoneLabel } from '../../lib/tz';
import { Avatar, Badge, Button, ButtonLink, ConfirmDialog, Field, IconButton, Input, Menu, Modal, useToast } from '../../ui';
import type { BadgeTone, MenuItem } from '../../ui';
import { Page, PageHeader } from '../components/Page';
import { CopyField } from '../components/x/bits';
import { firstName, slugify } from '../format';
import { useAdmin } from '../state';
import '../../styles/adminx.css';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

interface CalendarState {
  tone: BadgeTone;
  label: string;
  detail: string;
  connected: boolean;
}

function calendarState(host: AdminHost, self: boolean): CalendarState {
  const who = self ? 'your' : `${firstName(host.name)}'s`;
  if (host.google?.status === 'needs_reconnect') return { tone: 'warning', label: 'Needs reconnecting', detail: `Google asked ${self ? 'you' : firstName(host.name)} to sign in again.`, connected: false };
  if (host.calendarHealth && !host.calendarHealth.ok) return { tone: 'danger', label: 'Calendar problem', detail: host.calendarHealth.message || `We could not read ${who} calendar.`, connected: !!host.google };
  if (host.google) return { tone: 'success', label: 'Calendar connected', detail: host.google.email, connected: true };
  if (host.icsFeeds.length) return { tone: 'success', label: 'Calendar feed linked', detail: host.icsFeeds.map((f) => f.label).join(', '), connected: true };
  return { tone: 'neutral', label: 'No calendar yet', detail: self ? 'Only your weekly hours are used.' : `Only ${who} weekly hours are used until a calendar is connected.`, connected: false };
}

const ZONE_MODE: Record<AdminHost['timezoneMode'], string> = {
  google: 'follows Google Calendar',
  device: 'follows their device',
  fixed: 'fixed',
};

function uniqueSlug(base: string, taken: Set<string>): string {
  const root = slugify(base) || 'together';
  let slug = root;
  for (let n = 2; taken.has(slug) || RESERVED_SLUGS.includes(slug); n++) slug = `${root}-${n}`;
  return slug;
}

function inviteMailto(host: AdminHost, url: string, ownerName: string): string {
  const subject = `Your scheduling link from ${ownerName}`;
  const body = `Hi ${firstName(host.name)},\n\nI added you as a co-host for my meetings. Open this private link to connect your calendar and set your hours. It takes about a minute:\n\n${url}\n\nPlease keep the link to yourself.\n\n${firstName(ownerName)}`;
  return `mailto:${encodeURIComponent(host.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ───────────── dialogs ─────────────

interface AddDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: (host: AdminHost, inviteUrl: string) => void;
}

function AddDialog({ open, onClose, onAdded }: AddDialogProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setEmail('');
      setFields({});
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Please enter their name.';
    if (!EMAIL.test(email.trim())) next.email = 'Please enter a full email address.';
    setFields(next);
    setError(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const res = await createHost({ name: name.trim(), email: email.trim() });
      onAdded(res.host, res.inviteUrl);
    } catch (err) {
      const failure = err instanceof ApiFailure ? err : null;
      if (failure?.fields && Object.keys(failure.fields).length) setFields(failure.fields);
      else setError(errorMessage(err, 'They could not be added. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Add a co-host"
      description="They get a private link to connect their calendar and set their hours. They never see your dashboard."
      size="sm"
      initialFocusRef={nameRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="tm-add-form" loading={busy} loadingLabel="Adding">
            Add and get their link
          </Button>
        </>
      }
    >
      <form id="tm-add-form" className="tm-form" onSubmit={submit} noValidate>
        <Field label="Name" error={fields.name}>
          <Input ref={nameRef} value={name} autoComplete="off" placeholder="Alex Rivera" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" error={fields.email} hint="Used for booking notifications. We do not email them the link, you send it.">
          <Input type="email" inputMode="email" value={email} autoComplete="off" placeholder="alex@example.com" onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {error ? (
          <p className="adm-fielderror" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

interface LinkDialogProps {
  /** the co-host and their fresh link, or null when closed */
  invite: { host: AdminHost; url: string; fresh: boolean } | null;
  ownerName: string;
  onClose: () => void;
  onCreateJoint: (host: AdminHost) => void;
  jointBusy: boolean;
  hasJoint: boolean;
}

function LinkDialog({ invite, ownerName, onClose, onCreateJoint, jointBusy, hasJoint }: LinkDialogProps) {
  // Keep the last invite while the dialog animates out.
  const last = useRef(invite);
  if (invite) last.current = invite;
  const shown = invite ?? last.current;
  if (!shown) return null;
  const { host, url, fresh } = shown;
  const first = firstName(host.name);
  return (
    <Modal
      open={invite !== null}
      onClose={onClose}
      title={fresh ? `${first} is on the team` : `New private link for ${first}`}
      description={fresh ? `Send ${first} this private link. It opens their own page, no password needed.` : `The old link has stopped working. Send ${first} this one.`}
      size="md"
      footer={
        <>
          {!hasJoint ? (
            <Button variant="secondary" iconLeft={<Users size={16} />} loading={jointBusy} loadingLabel="Creating" onClick={() => onCreateJoint(host)}>
              Create a joint meeting
            </Button>
          ) : null}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="tm-invite">
        <CopyField value={url} label={`Private link for ${host.name}`} copyLabel="Copy link" />
        <div className="tm-invite__row">
          <ButtonLink href={inviteMailto(host, url, ownerName)} variant="ghost" size="sm" iconLeft={<Mail size={15} />}>
            Email it to {first}
          </ButtonLink>
          <span className="tm-invite__once">Shown once. You can always make a new one.</span>
        </div>
        <ol className="tm-invite__steps">
          <li>
            <span>1</span>
            {first} opens the link
          </li>
          <li>
            <span>2</span>
            Presses Connect Google Calendar
          </li>
          <li>
            <span>3</span>
            Checks their hours. Done.
          </li>
        </ol>
      </div>
    </Modal>
  );
}

interface EditDialogProps {
  host: AdminHost | null;
  onClose: () => void;
  onSaved: (host: AdminHost) => void;
}

function EditDialog({ host, onClose, onSaved }: EditDialogProps) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (host) {
      setName(host.name);
      setTitle(host.title ?? '');
      setEmail(host.email);
      setFields({});
      setError(null);
      setBusy(false);
    }
  }, [host]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!host || busy) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Please enter a name.';
    if (!EMAIL.test(email.trim())) next.email = 'Please enter a full email address.';
    setFields(next);
    setError(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      onSaved(await updateHost(host.id, { name: name.trim(), title: title.trim(), email: email.trim() }));
    } catch (err) {
      const failure = err instanceof ApiFailure ? err : null;
      if (failure?.fields && Object.keys(failure.fields).length) setFields(failure.fields);
      else setError(errorMessage(err, 'The changes could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={host !== null}
      onClose={busy ? () => undefined : onClose}
      title="Edit details"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="tm-edit-form" loading={busy} loadingLabel="Saving">
            Save
          </Button>
        </>
      }
    >
      <form id="tm-edit-form" className="tm-form" onSubmit={submit} noValidate>
        <Field label="Name" error={fields.name}>
          <Input value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role or title" optional hint="Shown under their name on booking pages.">
          <Input value={title} autoComplete="off" maxLength={80} placeholder="Head of Partnerships" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Email" error={fields.email}>
          <Input type="email" inputMode="email" value={email} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {error ? (
          <p className="adm-fielderror" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

// ───────────── page ─────────────

export default function TeamPage() {
  const { data, setData, refresh, ownerHost } = useAdmin();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow(30000);
  const latest = useRef(data);
  latest.current = data;

  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState<{ host: AdminHost; url: string; fresh: boolean } | null>(null);
  /** links created in this session, so "Copy link" keeps working until the page is reloaded */
  const [links, setLinks] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<AdminHost | null>(null);
  const [removing, setRemoving] = useState<AdminHost | null>(null);
  const [renewing, setRenewing] = useState<AdminHost | null>(null);
  const [disconnecting, setDisconnecting] = useState<AdminHost | null>(null);
  const [jointBusy, setJointBusy] = useState<string | null>(null);
  const [busyLink, setBusyLink] = useState<string | null>(null);

  const coHosts = useMemo(() => data.hosts.filter((h) => h.id !== ownerHost.id), [data.hosts, ownerHost.id]);
  const patch = (fn: (prev: AdminBootstrap) => AdminBootstrap) => setData(fn(latest.current));
  const upsertHost = (host: AdminHost) => patch((p) => ({ ...p, hosts: p.hosts.some((h) => h.id === host.id) ? p.hosts.map((h) => (h.id === host.id ? host : h)) : [...p.hosts, host] }));

  const jointOf = (host: AdminHost): EventType[] => data.eventTypes.filter((e) => e.kind !== 'solo' && e.hostIds.includes(host.id));

  const createJoint = async (host: AdminHost) => {
    if (jointBusy) return;
    setJointBusy(host.id);
    const mine = firstName(ownerHost.name);
    const theirs = firstName(host.name);
    try {
      const taken = new Set(latest.current.eventTypes.map((e) => e.slug));
      const eventType = await createEventType({
        title: `Meet ${mine} and ${theirs}`,
        slug: uniqueSlug(`${mine}-and-${theirs}`, taken),
        description: `A meeting with both ${mine} and ${theirs}. You only see times when we are both free.`,
        kind: 'collective',
        hostIds: [ownerHost.id, host.id],
        durations: [30],
        defaultDuration: 30,
      });
      patch((p) => ({ ...p, eventTypes: [...p.eventTypes.filter((e) => e.id !== eventType.id), eventType].sort((a, b) => a.position - b.position) }));
      setInvite(null);
      toast.show({
        tone: 'success',
        title: 'Joint meeting created',
        description: `"${eventType.title}" only offers times when you are both free.`,
        action: { label: 'Open it', onClick: () => navigate(`/admin/event-types/${eventType.id}`) },
        duration: 9000,
      });
    } catch (e) {
      toast.error('The joint meeting was not created', errorMessage(e));
    } finally {
      setJointBusy(null);
    }
  };

  const renewLink = async (host: AdminHost) => {
    setBusyLink(host.id);
    try {
      const res = await regenerateInvite(host.id);
      if (res.host) upsertHost(res.host);
      else upsertHost({ ...host, hasInviteLink: true });
      setLinks((prev) => ({ ...prev, [host.id]: res.inviteUrl }));
      setInvite({ host: res.host ?? host, url: res.inviteUrl, fresh: false });
    } catch (e) {
      toast.error('A new link could not be made', errorMessage(e));
      throw e;
    } finally {
      setBusyLink(null);
    }
  };

  const remove = async () => {
    const host = removing;
    if (!host) return;
    try {
      await deleteHost(host.id);
      patch((p) => ({ ...p, hosts: p.hosts.filter((h) => h.id !== host.id) }));
      toast.success(`${host.name} was removed`, 'Their private link no longer works.');
    } catch (e) {
      toast.error(`${firstName(host.name)} was not removed`, errorMessage(e));
      throw e;
    }
  };

  const disconnect = async () => {
    const host = disconnecting;
    if (!host) return;
    try {
      await disconnectGoogle(host.id);
      await refresh();
      toast.success(`${firstName(host.name)}'s calendar was disconnected`);
    } catch (e) {
      toast.error('Could not disconnect', errorMessage(e));
      throw e;
    }
  };

  const renderHost = (host: AdminHost) => {
    const self = host.id === ownerHost.id;
    const first = firstName(host.name);
    const cal = calendarState(host, self);
    const joint = self ? [] : jointOf(host);
    const link = links[host.id];
    const waiting = !self && !cal.connected;

    const items: MenuItem[] = [
      { label: 'Edit details', icon: <Pencil size={15} />, onSelect: () => setEditing(host) },
      { label: host.hasInviteLink ? 'Make a new private link' : 'Make a private link', icon: <RefreshCw size={15} />, onSelect: () => (host.hasInviteLink ? setRenewing(host) : void renewLink(host).catch(() => undefined)) },
      ...(host.google ? ([{ label: 'Disconnect their calendar', icon: <Unplug size={15} />, onSelect: () => setDisconnecting(host) }] as MenuItem[]) : []),
      { type: 'separator' },
      { label: 'Remove from team', icon: <Trash2 size={15} />, danger: true, onSelect: () => setRemoving(host) },
    ];

    return (
      <li key={host.id} className="tm-host">
        <div className="tm-host__top">
          <Avatar name={host.name} src={host.avatarUrl} size={48} decorative />
          <div className="tm-host__who">
            <p className="tm-host__name">
              <span>{host.name}</span>
              {self ? (
                <Badge size="sm" tone="primary">
                  You
                </Badge>
              ) : null}
            </p>
            <p className="tm-host__sub">{[host.title, host.email].filter(Boolean).join(' · ') || 'No email yet'}</p>
          </div>
          {self ? null : <Menu label={`Actions for ${host.name}`} trigger={<IconButton label={`More actions for ${host.name}`} icon={<MoreHorizontal size={18} />} />} items={items} />}
        </div>

        <dl className="tm-facts">
          <div className="tm-fact">
            <dt>
              {cal.connected ? <CalendarCheck size={15} aria-hidden="true" /> : <CalendarX2 size={15} aria-hidden="true" />}
              <span className="u-vh">Calendar</span>
            </dt>
            <dd>
              <Badge tone={cal.tone} dot>
                {cal.label}
              </Badge>
              <span className="tm-fact__detail">{cal.detail}</span>
            </dd>
          </div>
          <div className="tm-fact">
            <dt>
              <Globe size={15} aria-hidden="true" />
              <span className="u-vh">Time zone</span>
            </dt>
            <dd>
              <span className="tm-fact__main">{zoneLabel(host.timezone)}</span>
              <span className="tm-fact__detail">
                {self ? (host.timezoneMode === 'device' ? 'follows your device' : host.timezoneMode === 'google' ? 'follows Google Calendar' : 'fixed') : ZONE_MODE[host.timezoneMode]}
              </span>
            </dd>
          </div>
          <div className="tm-fact">
            <dt>
              <Clock size={15} aria-hidden="true" />
              <span className="u-vh">Local time</span>
            </dt>
            <dd>
              <span className="tm-fact__main u-tabular">{formatTime(now, host.timezone)}</span>
              <span className="tm-fact__detail">{self ? 'for you right now' : `for ${first} right now`}</span>
            </dd>
          </div>
        </dl>

        {self ? (
          <div className="tm-host__foot">
            <ButtonLink to="/admin/integrations#google" variant="secondary" size="sm">
              {cal.connected ? 'Manage calendar' : 'Connect your calendar'}
            </ButtonLink>
            <ButtonLink to="/admin/availability" variant="ghost" size="sm" iconRight={<ChevronRight size={14} />}>
              Your hours
            </ButtonLink>
          </div>
        ) : (
          <div className="tm-host__foot">
            {waiting ? (
              <div className="tm-wait">
                <p className="tm-wait__text">
                  {host.google?.status === 'needs_reconnect' ? `${first} needs to open their private link and reconnect Google Calendar.` : `Waiting for ${first} to open their private link and connect a calendar.`}
                </p>
                {link ? (
                  <CopyField value={link} label={`Private link for ${host.name}`} copyLabel="Copy link" className="tm-wait__link" />
                ) : (
                  <Button size="sm" variant="secondary" iconLeft={<Link2 size={15} />} loading={busyLink === host.id} loadingLabel="Making a link" onClick={() => (host.hasInviteLink ? setRenewing(host) : void renewLink(host).catch(() => undefined))}>
                    {host.hasInviteLink ? 'Make a new link to send' : 'Get their private link'}
                  </Button>
                )}
              </div>
            ) : null}
            <div className="tm-joint">
              {joint.length ? (
                <>
                  <span className="tm-joint__label">Meetings together</span>
                  <ul role="list" className="tm-joint__list">
                    {joint.map((e) => (
                      <li key={e.id}>
                        <Link to={`/admin/event-types/${e.id}`} className="tm-joint__link">
                          <span className="adm-dot" style={{ background: e.color || 'var(--a-primary)' }} aria-hidden="true" />
                          {e.title}
                          <ArrowRight size={14} aria-hidden="true" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <Button size="sm" variant={waiting ? 'secondary' : 'primary'} iconLeft={<Users size={15} />} loading={jointBusy === host.id} loadingLabel="Creating" onClick={() => void createJoint(host)}>
                    Create a joint meeting
                  </Button>
                  <span className="tm-joint__hint">People book you and {first} in one go, at times you are both free.</span>
                </>
              )}
              {link && !waiting ? (
                <span className="tm-joint__copy">
                  <CopyField value={link} label={`Private link for ${host.name}`} copyLabel="Copy link" />
                </span>
              ) : null}
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <Page>
      <PageHeader
        title="Team"
        description="People who host meetings with you. Everyone connects their own calendar, so a joint meeting only offers times that suit you all."
        actions={
          <Button variant="primary" iconLeft={<UserPlus size={16} />} onClick={() => setAdding(true)}>
            Add a co-host
          </Button>
        }
      />

      <ul role="list" className="tm-list">
        {renderHost(ownerHost)}
        {coHosts.map(renderHost)}
      </ul>

      {coHosts.length === 0 ? (
        <section className="tm-empty" aria-labelledby="tm-empty-title">
          <div className="tm-empty__text">
            <h2 className="tm-empty__title" id="tm-empty-title">
              Host meetings with someone else
            </h2>
            <p className="tm-empty__desc">Add a co-founder, an assistant or a colleague. People can then book a time when you are both free, or whoever is available first.</p>
            <Button variant="primary" iconLeft={<UserPlus size={16} />} onClick={() => setAdding(true)}>
              Add a co-host
            </Button>
          </div>
          <ol className="tm-empty__steps">
            <li>
              <span className="tm-empty__num">1</span>
              <div>
                <p className="tm-empty__step">Add their name and email</p>
                <p className="tm-empty__hint">Ten seconds.</p>
              </div>
            </li>
            <li>
              <span className="tm-empty__num">2</span>
              <div>
                <p className="tm-empty__step">Send them their private link</p>
                <p className="tm-empty__hint">Copy it, or email it straight from here.</p>
              </div>
            </li>
            <li>
              <span className="tm-empty__num">3</span>
              <div>
                <p className="tm-empty__step">They connect Google Calendar</p>
                <p className="tm-empty__hint">One button on their page. No account, no password.</p>
              </div>
            </li>
          </ol>
        </section>
      ) : null}

      <AddDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(host, url) => {
          upsertHost(host);
          setLinks((prev) => ({ ...prev, [host.id]: url }));
          setAdding(false);
          setInvite({ host, url, fresh: true });
        }}
      />
      <LinkDialog
        invite={invite}
        ownerName={ownerHost.name}
        onClose={() => setInvite(null)}
        onCreateJoint={(host) => void createJoint(host)}
        jointBusy={jointBusy !== null}
        hasJoint={invite ? jointOf(invite.host).length > 0 : false}
      />
      <EditDialog
        host={editing}
        onClose={() => setEditing(null)}
        onSaved={(host) => {
          upsertHost(host);
          setEditing(null);
          toast.success('Details saved');
        }}
      />
      <ConfirmDialog
        open={renewing !== null}
        onClose={() => setRenewing(null)}
        onConfirm={() => (renewing ? renewLink(renewing) : undefined)}
        title={renewing ? `Make a new link for ${firstName(renewing.name)}?` : 'Make a new link?'}
        description="Their current link stops working straight away, so send them the new one."
        confirmLabel="Make a new link"
      />
      <ConfirmDialog
        open={disconnecting !== null}
        onClose={() => setDisconnecting(null)}
        onConfirm={disconnect}
        tone="danger"
        title={disconnecting ? `Disconnect ${firstName(disconnecting.name)}'s calendar?` : 'Disconnect?'}
        description="Their busy times will no longer be checked and joint meetings will not appear on their calendar. They can connect again from their private link."
        confirmLabel="Disconnect"
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        tone="danger"
        title={removing ? `Remove ${removing.name}?` : 'Remove?'}
        description="Their private link stops working and their calendar is disconnected. Meetings that are already booked stay as they are."
        confirmLabel="Remove from team"
      />
    </Page>
  );
}
