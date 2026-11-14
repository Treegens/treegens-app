/**
 * DEV ONLY: /meeting/__kit. Every UI kit component, once inside a themed public scope and once
 * inside the dashboard scope. URL parameters make it scriptable for screenshots:
 *   ?preset=forest|meadow|...   theme preset for the public pane
 *   ?scope=both|m|a             which pane(s) to show
 *   ?admin=auto|light|dark      dashboard palette
 *   ?open=modal|drawer|confirm|menu|zones|toast|tooltip   open an overlay on load (in the pane given by ?scope, m by default)
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, Bell, CalendarDays, Copy, Globe, Mail, MoreHorizontal, Pencil, Phone, Plus, Search, Trash2, Users, Video } from 'lucide-react';
import { THEME_PRESETS, presetByKey } from '../../shared/presets';
import { NO_ASSETS } from '../../shared/theme';
import { AdminScope, ThemeScope } from '../lib/theme';
import { detectZone } from '../lib/tz';
import {
  Avatar,
  AvatarGroup,
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  ColorInput,
  ConfirmDialog,
  CopyButton,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingBlock,
  Menu,
  Modal,
  RadioGroup,
  SegmentedControl,
  Select,
  Skeleton,
  Slider,
  Spinner,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  TimezoneDialog,
  TimezoneSelect,
  Tooltip,
  useToast,
} from '../ui';
import { OWNER_AVATAR } from './fixtures';
import './kit.css';

type OpenKey = 'modal' | 'drawer' | 'confirm' | 'menu' | 'zones' | 'toast' | 'tooltip' | null;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="kit-section" title={title} titleAs="h3">
      <div className="kit-stack">{children}</div>
    </Card>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="kit-row">
      {label ? <span className="kit-row__label">{label}</span> : null}
      <div className="kit-row__items">{children}</div>
    </div>
  );
}

function Gallery({ autoOpen }: { autoOpen: OpenKey }) {
  const toast = useToast();
  const [text, setText] = useState('Amina Wanjiru');
  const [email, setEmail] = useState('amina@');
  const [notes, setNotes] = useState('');
  const [topic, setTopic] = useState('');
  const [sms, setSms] = useState(true);
  const [calls, setCalls] = useState(false);
  const [agree, setAgree] = useState(true);
  const [some, setSome] = useState(false);
  const [kind, setKind] = useState<'solo' | 'collective' | 'round_robin'>('collective');
  const [where, setWhere] = useState('meet');
  const [view, setView] = useState<'month' | 'week' | 'list'>('month');
  const [format, setFormat] = useState<'12' | '24'>('12');
  const [radius, setRadius] = useState(18);
  const [color, setColor] = useState('#5ede8e');
  const [zone, setZone] = useState(detectZone());
  const [tab, setTab] = useState<'basics' | 'hosts' | 'reminders' | 'advanced'>('basics');
  const [filter, setFilter] = useState<'upcoming' | 'past' | 'cancelled'>('upcoming');
  const [modal, setModal] = useState(autoOpen === 'modal');
  const [drawer, setDrawer] = useState(autoOpen === 'drawer');
  const [confirm, setConfirm] = useState(autoOpen === 'confirm');
  const [zones, setZones] = useState(autoOpen === 'zones');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (autoOpen === 'toast') {
      toast.success('Booking confirmed', 'A calendar invitation is on its way.');
      toast.error('That time was just taken', 'Please pick another one.');
      toast.show({ title: 'Event type deleted', tone: 'info', duration: 0, action: { label: 'Undo', onClick: () => undefined } });
    }
    if (autoOpen === 'menu') window.setTimeout(() => document.querySelector<HTMLElement>('[data-kit-menu]')?.click(), 300);
    if (autoOpen === 'tooltip') window.setTimeout(() => document.querySelector<HTMLElement>('[data-kit-tooltip]')?.focus(), 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="kit-grid">
      <Section title="Buttons">
        <Row label="Variants">
          <Button variant="primary">Confirm booking</Button>
          <Button variant="secondary">Reschedule</Button>
          <Button variant="ghost">Back</Button>
          <Button variant="danger">Cancel meeting</Button>
          <Button variant="danger-soft">Remove</Button>
          <Button variant="link">Change time zone</Button>
        </Row>
        <Row label="Sizes">
          <Button variant="primary" size="sm">
            Small
          </Button>
          <Button variant="primary">Medium</Button>
          <Button variant="primary" size="lg" iconRight={<ArrowRight />}>
            Large
          </Button>
        </Row>
        <Row label="States">
          <Button variant="primary" iconLeft={<Plus />}>
            New event type
          </Button>
          <Button
            variant="primary"
            loading={loading}
            onClick={() => {
              setLoading(true);
              window.setTimeout(() => setLoading(false), 1600);
            }}
          >
            Click to load
          </Button>
          <Button variant="primary" loading>
            Saving
          </Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
          <ButtonLink href="https://jimicohen.com" external variant="secondary" iconLeft={<Globe />}>
            Link button
          </ButtonLink>
        </Row>
        <Row label="Icon buttons">
          <IconButton label="Edit" icon={<Pencil />} />
          <IconButton label="Duplicate" icon={<Copy />} variant="secondary" />
          <IconButton label="Add" icon={<Plus />} variant="primary" />
          <IconButton label="Delete" icon={<Trash2 />} variant="danger" data-kit-tooltip="" />
          <IconButton label="Notifications on" icon={<Bell />} pressed />
          <IconButton label="Small" icon={<Pencil />} size="sm" variant="secondary" />
          <IconButton label="Busy" icon={<Pencil />} loading />
          <CopyButton value="https://jimicohen.com/meeting/intro" label="Copy link" />
          <CopyButton value="https://jimicohen.com/meeting/intro" iconOnly />
        </Row>
        <Button variant="primary" block size="lg">
          Full width call to action
        </Button>
      </Section>

      <Section title="Text fields">
        <div className="kit-two">
          <Field label="Your name" required>
            <Input value={text} onChange={(e) => setText(e.target.value)} autoComplete="name" />
          </Field>
          <Field label="Email" required error={email.includes('.') ? undefined : 'Please enter a valid email address.'}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} leading={<Mail size={16} />} />
          </Field>
          <Field label="Phone" optional hint="Add a number to get a text or a reminder call.">
            <Input type="tel" placeholder="+254 700 000 000" leading={<Phone size={16} />} />
          </Field>
          <Field label="Link" hint="The public address of this event type.">
            <Input defaultValue="intro" leading={<span>jimicohen.com/meeting/</span>} />
          </Field>
          <Field label="Search" hideLabel>
            <Input type="search" placeholder="Search bookings" leading={<Search size={16} />} size="sm" />
          </Field>
          <Field label="Disabled">
            <Input value="Cannot be changed" disabled readOnly />
          </Field>
        </div>
        <Field label="What would you like to talk about?" optional action={<span>{notes.length} / 500</span>}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} placeholder="A sentence or two is plenty" autoGrow />
        </Field>
        <div className="kit-two">
          <Field label="Where are you right now?">
            <Select value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Choose one" options={[{ value: 'explore', label: 'Just exploring' }, { value: 'plan', label: 'Planning a project' }, { value: 'go', label: 'Already underway' }]} />
          </Field>
          <Field label="Time zone">
            <TimezoneSelect value={zone} onChange={setZone} hour12={format === '12'} />
          </Field>
        </div>
        <Row label="Inline zone">
          <span className="u-muted">Times are in</span>
          <TimezoneSelect value={zone} onChange={setZone} variant="inline" hour12={format === '12'} />
        </Row>
      </Section>

      <Section title="Choices">
        <Switch checked={sms} onChange={setSms} label="Text me reminders" description="We only text you about this meeting." />
        <Switch checked={calls} onChange={setCalls} label="Reminder call from Ava, Jimi's AI assistant" description="A short call two hours before, so you can confirm or reschedule by voice." />
        <Switch checked={sms} onChange={setSms} labelSide="start" label="Show on the public page" />
        <Row label="Bare">
          <Switch checked={sms} onChange={setSms} aria-label="Enabled" />
          <Switch checked={calls} onChange={setCalls} aria-label="Enabled" size="sm" />
          <Switch checked onChange={() => undefined} aria-label="Disabled on" disabled />
        </Row>
        <Checkbox checked={agree} onChange={setAgree} label="Add the invitee to the Google Calendar event" description="Google emails them the invitation." />
        <Checkbox checked={some} onChange={setSome} indeterminate={!some} label="Select all bookings" />
        <Checkbox checked={false} onChange={() => undefined} label="Disabled option" disabled />
        <RadioGroup
          label="How would you like to meet?"
          value={where}
          onChange={setWhere}
          options={[
            { value: 'meet', label: 'Google Meet', description: 'You get the link when you book' },
            { value: 'phone', label: 'Phone call', description: 'Jimi calls you' },
            { value: 'person', label: 'In person', description: 'Java House, Kimathi Street, Nairobi' },
          ]}
        />
        <RadioGroup
          label="Who hosts this meeting?"
          variant="cards"
          columns={3}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'solo', label: 'One host', description: 'Only your calendar is checked.', icon: <CalendarDays size={18} /> },
            { value: 'collective', label: 'Everyone together', description: 'Only times when all hosts are free.', icon: <Users size={18} /> },
            { value: 'round_robin', label: 'Round robin', description: 'Whoever is free takes it.', icon: <Video size={18} /> },
          ]}
        />
        <Row label="Segmented">
          <SegmentedControl aria-label="Calendar view" value={view} onChange={setView} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'list', label: 'List' }]} />
          <SegmentedControl aria-label="Time format" size="sm" value={format} onChange={setFormat} options={[{ value: '12', label: '12h' }, { value: '24', label: '24h' }]} />
        </Row>
        <SegmentedControl aria-label="Calendar view" block value={view} onChange={setView} options={[{ value: 'month', label: 'Month', icon: <CalendarDays /> }, { value: 'week', label: 'Week' }, { value: 'list', label: 'List' }]} />
        <div className="kit-two">
          <Slider label="Corner radius" min={0} max={28} value={radius} onChange={setRadius} formatValue={(v) => `${v}px`} />
          <ColorInput label="Brand colour" value={color} onChange={setColor} presets={['#5ede8e', '#e0b04e', '#2450e0', '#c2371f', '#111111']} />
        </div>
      </Section>

      <Section title="Status">
        <Row label="Soft">
          <Badge>Unlisted</Badge>
          <Badge tone="primary" dot>
            Upcoming
          </Badge>
          <Badge tone="success" dot>
            Confirmed
          </Badge>
          <Badge tone="warning">Needs reconnect</Badge>
          <Badge tone="danger">Cancelled</Badge>
          <Badge tone="accent">Collective</Badge>
        </Row>
        <Row label="Outline / solid">
          <Badge variant="outline">30 min</Badge>
          <Badge variant="outline" tone="primary">
            Google Meet
          </Badge>
          <Badge variant="solid" tone="primary">
            New
          </Badge>
          <Badge variant="solid" tone="danger" size="sm">
            3
          </Badge>
          <Badge size="sm" icon={<Phone />}>
            Call
          </Badge>
        </Row>
        <Row label="People">
          <Avatar name="Jimi Cohen" src={OWNER_AVATAR} size="xs" />
          <Avatar name="Jimi Cohen" src={OWNER_AVATAR} size="sm" />
          <Avatar name="Jimi Cohen" src={OWNER_AVATAR} />
          <Avatar name="Alex Rivera" size="lg" />
          <Avatar name="Jimi Cohen" src={OWNER_AVATAR} size="xl" />
          <AvatarGroup people={[{ name: 'Jimi Cohen', avatarUrl: OWNER_AVATAR }, { name: 'Alex Rivera' }]} size="lg" />
          <AvatarGroup people={[{ name: 'Jimi Cohen', avatarUrl: OWNER_AVATAR }, { name: 'Alex Rivera' }, { name: 'Grace Mwangi' }, { name: 'Omar Haddad' }, { name: 'Priya Nair' }]} max={3} />
        </Row>
        <Row label="Loading">
          <Spinner />
          <Spinner size={28} />
          <div className="kit-skeleton">
            <Skeleton circle width={40} height={40} />
            <div style={{ flex: 1 }}>
              <Skeleton lines={3} />
            </div>
          </div>
        </Row>
        <div className="kit-two">
          <Skeleton height={48} radius={12} />
          <Skeleton height={48} radius={12} />
        </div>
        <LoadingBlock label="Finding open times" minHeight={96} />
      </Section>

      <Section title="Navigation">
        <Tabs
          label="Event type settings"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'basics', label: 'Basics' },
            { id: 'hosts', label: 'Hosts', badge: 2 },
            { id: 'reminders', label: 'Reminders', icon: <Bell /> },
            { id: 'advanced', label: 'Advanced', disabled: true },
          ]}
        >
          <TabPanel id="basics" className="kit-panel">
            Title, link, durations and location.
          </TabPanel>
          <TabPanel id="hosts" className="kit-panel">
            Jimi and Alex host this together.
          </TabPanel>
          <TabPanel id="reminders" className="kit-panel">
            Email a day before, a call two hours before, a text 15 minutes before.
          </TabPanel>
        </Tabs>
        <Tabs
          label="Bookings filter"
          variant="pills"
          value={filter}
          onChange={setFilter}
          tabs={[
            { id: 'upcoming', label: 'Upcoming', badge: 9 },
            { id: 'past', label: 'Past' },
            { id: 'cancelled', label: 'Cancelled' },
          ]}
        />
        <Row label="Menu and tooltip">
          <Menu
            label="Event type actions"
            trigger={<IconButton label="More actions" icon={<MoreHorizontal />} variant="secondary" data-kit-menu="" />}
            items={[
              { type: 'label', label: 'Intro call' },
              { label: 'Edit', icon: <Pencil />, onSelect: () => toast.info('Edit') },
              { label: 'Duplicate', icon: <Copy />, hint: 'Ctrl D', onSelect: () => toast.success('Duplicated') },
              { label: 'Copy link', icon: <Globe />, checked: false, onSelect: () => toast.success('Link copied') },
              { label: 'Unavailable', disabled: true },
              { type: 'separator' },
              { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setConfirm(true) },
            ]}
          />
          <Menu align="start" trigger={<Button variant="secondary">Add to calendar</Button>} items={[{ label: 'Google Calendar' }, { label: 'Outlook' }, { label: 'Download .ics' }]} />
          <Tooltip content="Only times when both hosts are free are offered.">
            <Button variant="ghost" size="sm">
              Hover or focus me
            </Button>
          </Tooltip>
        </Row>
      </Section>

      <Section title="Overlays and feedback">
        <Row>
          <Button variant="secondary" onClick={() => setModal(true)}>
            Open modal
          </Button>
          <Button variant="secondary" onClick={() => setDrawer(true)}>
            Open drawer
          </Button>
          <Button variant="secondary" onClick={() => setConfirm(true)}>
            Confirm dialog
          </Button>
          <Button variant="secondary" onClick={() => setZones(true)}>
            Time zones
          </Button>
        </Row>
        <Row label="Toasts">
          <Button variant="ghost" onClick={() => toast.success('Saved', 'Your changes are live.')}>
            Success
          </Button>
          <Button variant="ghost" onClick={() => toast.error('Could not save', 'Check your connection and try again.')}>
            Error
          </Button>
          <Button variant="ghost" onClick={() => toast.warning('Calendar needs attention')}>
            Warning
          </Button>
          <Button variant="ghost" onClick={() => toast.show({ title: 'Event type deleted', action: { label: 'Undo', onClick: () => toast.info('Restored') } })}>
            With action
          </Button>
        </Row>
        <div className="kit-two">
          <Card variant="outline" padding="sm">
            <EmptyState compact icon={<CalendarDays />} title="No upcoming meetings" description="New bookings will show up here." action={<Button variant="primary">Copy your link</Button>} />
          </Card>
          <Card variant="outline" padding="sm">
            <EmptyState compact tone="danger" icon={<Bell />} title="Times could not load" description="We could not reach the calendar. Please try again." action={<Button variant="secondary">Try again</Button>} />
          </Card>
        </div>
      </Section>

      <Section title="Cards">
        <div className="kit-two">
          <Card title="Themed" description="Follows the theme's card style." actions={<Badge tone="primary">Default</Badge>}>
            <p className="u-muted">Flat, bordered, elevated or glass on public pages. A quiet bordered panel in the dashboard.</p>
          </Card>
          <Card variant="raised" title="Raised">
            <p className="u-muted">Always lifted with a shadow.</p>
          </Card>
          <Card variant="outline" interactive tabIndex={0} title="Interactive" description="Hover or focus me.">
            <p className="u-muted">For cards that are links or buttons.</p>
          </Card>
          <Card variant="sunken" title="Sunken" selected>
            <p className="u-muted">A recessed, selected panel.</p>
          </Card>
        </div>
      </Section>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Add a co-host"
        description="They get a private link to connect their own calendar. You never see their events, only when they are busy."
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setModal(false)}>
              Create invite link
            </Button>
          </>
        }
      >
        <div className="kit-stack">
          <Field label="Name" required>
            <Input placeholder="Alex Rivera" data-autofocus="" />
          </Field>
          <Field label="Email" required hint="Used for booking notifications.">
            <Input type="email" placeholder="alex@example.com" />
          </Field>
        </div>
      </Modal>

      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="Intro call with Amina Wanjiru"
        description="Thursday, 10:00 to 10:30 AM"
        headerActions={<IconButton label="Copy manage link" icon={<Copy />} />}
        footer={
          <>
            <Button variant="danger-soft" onClick={() => setDrawer(false)}>
              Cancel meeting
            </Button>
            <Button variant="secondary" onClick={() => setDrawer(false)}>
              Reschedule
            </Button>
          </>
        }
      >
        <div className="kit-stack">
          <Row>
            <Badge tone="success" dot>
              Confirmed on the reminder call
            </Badge>
            <Badge variant="outline">Google Meet</Badge>
          </Row>
          <p className="u-muted">A possible partnership for next season.</p>
          <Skeleton lines={4} />
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => new Promise((resolve) => window.setTimeout(resolve, 900))}
        tone="danger"
        title="Delete this event type?"
        description="People with the link will no longer be able to book it. Existing bookings stay on your calendar."
        confirmLabel="Delete event type"
        cancelLabel="Keep it"
      />

      <TimezoneDialog open={zones} onClose={() => setZones(false)} value={zone} onChange={setZone} hour12={format === '12'} />
    </div>
  );
}

function param<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[], fallback: T): T {
  const v = params.get(key) as T | null;
  return v && allowed.includes(v) ? v : fallback;
}

export default function Kit() {
  const params = new URLSearchParams(window.location.search);
  const [preset, setPreset] = useState(presetByKey(params.get('preset') ?? '')?.key ?? 'forest');
  const [admin, setAdmin] = useState(param(params, 'admin', ['auto', 'light', 'dark'] as const, 'auto'));
  const [scope, setScope] = useState(param(params, 'scope', ['both', 'm', 'a'] as const, 'both'));
  const open = param(params, 'open', ['modal', 'drawer', 'confirm', 'menu', 'zones', 'toast', 'tooltip'] as const, 'modal');
  const autoOpen: OpenKey = params.has('open') ? open : null;
  const openIn = scope === 'a' ? 'a' : 'm';
  const theme = presetByKey(preset)?.theme ?? THEME_PRESETS[0].theme;

  return (
    <AdminScope colorScheme={admin}>
      <div className="kit">
        <header className="kit-header">
          <div>
            <h1>UI kit</h1>
            <p className="u-muted">Every component, in the themed public scope and in the dashboard scope.</p>
          </div>
          <div className="kit-controls">
            <Field label="Public preset">
              <Select size="sm" value={preset} onChange={(e) => setPreset(e.target.value)} options={THEME_PRESETS.map((p) => ({ value: p.key, label: p.label }))} />
            </Field>
            <Field label="Dashboard palette" htmlFor="kit-admin">
              <SegmentedControl aria-label="Dashboard palette" size="sm" value={admin} onChange={setAdmin} options={[{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
            </Field>
            <Field label="Show" htmlFor="kit-scope">
              <SegmentedControl aria-label="Scopes shown" size="sm" value={scope} onChange={setScope} options={[{ value: 'both', label: 'Both' }, { value: 'm', label: 'Public' }, { value: 'a', label: 'Dashboard' }]} />
            </Field>
          </div>
        </header>

        {scope !== 'a' ? (
          <section className="kit-pane-wrap" aria-label="Public scope">
            <h2 className="kit-pane-title">Public scope: {presetByKey(preset)?.label}</h2>
            <ThemeScope theme={theme} assets={NO_ASSETS} mode="contained" className="kit-pane">
              <Gallery autoOpen={openIn === 'm' ? autoOpen : null} />
            </ThemeScope>
          </section>
        ) : null}

        {scope !== 'm' ? (
          <section className="kit-pane-wrap" aria-label="Dashboard scope">
            <h2 className="kit-pane-title">Dashboard scope</h2>
            <div className="kit-pane kit-pane--admin">
              <Gallery autoOpen={openIn === 'a' ? autoOpen : null} />
            </div>
          </section>
        ) : null}
      </div>
    </AdminScope>
  );
}
