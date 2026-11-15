import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, EyeOff, PauseCircle, Shuffle, Users } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { RESERVED_SLUGS, newEventType } from '../../../shared/defaults';
import type { EventKind, EventType } from '../../../shared/types';
import { ApiFailure, createEventType, deleteEventType, errorMessage, updateEventType } from '../../lib/api';
import { Badge, ButtonLink, ConfirmDialog, CopyButton, EmptyState, TabPanel, Tabs, useToast } from '../../ui';
import type { TabItem } from '../../ui';
import { Notice, Page, PageHeader, SaveBar } from '../components/Page';
import { useUnsavedGuard } from '../components/UnsavedGuard';
import { rangesProblem, WEEKDAYS } from '../components/WeeklyHoursEditor';
import { AdvancedTab } from '../components/event/AdvancedTab';
import { BasicsTab } from '../components/event/BasicsTab';
import { ConfirmationTab } from '../components/event/ConfirmationTab';
import { HostsTab } from '../components/event/HostsTab';
import { QuestionsTab } from '../components/event/QuestionsTab';
import { RemindersTab, sortRules } from '../components/event/RemindersTab';
import { SchedulingTab } from '../components/event/SchedulingTab';
import { TAB_LABELS, TAB_ORDER, tabOfField } from '../components/event/shared';
import type { TabId } from '../components/event/shared';
import { brandIdOf, deleteText, shortLinkOf } from '../brands';
import { BrandChip, ShortChip } from '../components/BrandBits';
import { KIND_LABEL, sameJson, trimUrl } from '../format';
import { useAdmin } from '../state';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export default function EventTypeEditor() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { data, ownerHost } = useAdmin();
  const isNew = id === 'new';
  const existing = isNew ? undefined : data.eventTypes.find((e) => e.id === id);

  // The starting point is fixed when the page opens. Later bootstrap updates must not clobber a draft.
  const initial = useRef<{ key: string; value: EventType } | null>(null);
  if (!initial.current || initial.current.key !== id) {
    if (isNew) {
      const kindParam = params.get('kind');
      const kind: EventKind = kindParam === 'collective' || kindParam === 'round_robin' ? kindParam : 'solo';
      const others = data.hosts.filter((h) => h.id !== ownerHost.id).map((h) => h.id);
      const hostIds = kind === 'solo' ? [ownerHost.id] : [ownerHost.id, ...others].slice(0, kind === 'collective' ? 2 : 6);
      initial.current = {
        key: id,
        value: newEventType(new Date().toISOString(), { id: '', slug: '', title: '', kind, hostIds, position: data.eventTypes.length }),
      };
    } else if (existing) {
      initial.current = { key: id, value: existing };
    } else {
      initial.current = null;
    }
  }

  if (!initial.current) {
    return (
      <Page>
        <EmptyState
          as="h2"
          title="That event type is gone"
          description="It may have been deleted. Pick another one from the list."
          action={
            <ButtonLink variant="primary" to="/admin/event-types">
              Back to event types
            </ButtonLink>
          }
        />
      </Page>
    );
  }

  return <Editor key={id} initial={initial.current.value} isNew={isNew} />;
}

/** Mirrors the server's checks so most mistakes are caught before a round trip. */
function validate(et: EventType, all: EventType[], hostIds: string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!et.title.trim()) errors.title = 'Give this event type a name.';
  if (!et.slug) errors.slug = 'Choose a link for this event.';
  else if (!SLUG_RE.test(et.slug)) errors.slug = 'Use lowercase letters, numbers and dashes, without a dash at either end.';
  // A link that became reserved stays usable for the event that already has it (as on the server).
  else if (RESERVED_SLUGS.includes(et.slug) && !all.some((e) => e.id === et.id && e.slug === et.slug)) errors.slug = 'That link is reserved. Please choose another.';
  else if (all.some((e) => e.slug === et.slug && e.id !== et.id)) errors.slug = 'Another event type already uses this link.';
  if (!et.durations.length) errors.durations = 'Offer at least one length.';
  else if (et.durations.some((d) => d < 5 || d > 480)) errors.durations = 'Lengths have to be between 5 minutes and 8 hours.';
  if (!et.locations.length) errors.locations = 'Add at least one place to meet.';
  et.locations.forEach((l, i) => {
    const v = l.value?.trim() ?? '';
    if (l.type === 'in_person' && !v) errors[`locations.${i}.value`] = 'Add the address.';
    if (l.type === 'phone_invitee_calls' && !v) errors[`locations.${i}.value`] = 'Add the number people should call.';
    if (l.type === 'custom_link' && !/^https:\/\/\S+$/.test(v)) errors[`locations.${i}.value`] = 'Add the link, starting with https://';
  });
  const valid = et.hostIds.filter((h) => hostIds.includes(h));
  if (!valid.length) errors.hostIds = 'Choose at least one host.';
  else if (et.kind !== 'solo' && valid.length < 2) errors.hostIds = 'Choose at least two hosts for this kind of meeting.';
  else if (et.kind === 'solo' && valid.length > 1) errors.hostIds = 'Choose one host, or switch to Together or Round robin.';
  const s = et.scheduling;
  if (s.dateRange && s.dateRange.end < s.dateRange.start) errors['scheduling.dateRange.end'] = 'The end date has to be on or after the start date.';
  if (s.restrictHours) {
    if (WEEKDAYS.every((d) => (s.restrictHours?.[d] ?? []).length === 0)) errors['scheduling.restrictHours'] = 'Turn on at least one day, or switch this limit off.';
    else if (WEEKDAYS.some((d) => rangesProblem(s.restrictHours?.[d] ?? []))) errors['scheduling.restrictHours'] = 'Fix the highlighted hours first.';
  }
  et.questions.forEach((q, i) => {
    if (!q.label.trim()) errors[`questions.${i}.label`] = 'Write the question, or remove it.';
    if ((q.type === 'select' || q.type === 'radio' || q.type === 'checkbox') && (q.options ?? []).filter((o) => o.trim()).length < 1) errors[`questions.${i}.options`] = 'Add at least one choice.';
  });
  et.reminders.forEach((r, i) => {
    if (r.offsetMinutes < 0 || r.offsetMinutes > 43200) errors[`reminders.${i}.offsetMinutes`] = 'Reminders can go out at most 30 days away from the meeting.';
  });
  const redirect = et.confirmation.redirectUrl?.trim();
  if (redirect && !/^https:\/\/\S+$/.test(redirect)) errors['confirmation.redirectUrl'] = 'The link has to start with https://';
  return errors;
}

function tidy(et: EventType): EventType {
  const durations = Array.from(new Set(et.durations)).sort((a, b) => a - b);
  return {
    ...et,
    title: et.title.trim(),
    description: et.description.trim(),
    emoji: et.emoji?.trim() ?? '',
    durations,
    defaultDuration: durations.includes(et.defaultDuration) ? et.defaultDuration : durations[0],
    locations: et.locations.map((l) => ({ ...l, value: l.value?.trim() || undefined })),
    questions: et.questions.map((q) => ({ ...q, label: q.label.trim(), options: q.options ? q.options.map((o) => o.trim()).filter(Boolean) : undefined, placeholder: q.placeholder?.trim() || undefined })),
    reminders: sortRules(et.reminders),
    confirmation: { message: et.confirmation.message?.trim() ?? '', redirectUrl: et.confirmation.redirectUrl?.trim() ?? '' },
  };
}

function Editor({ initial, isNew }: { initial: EventType; isNew: boolean }) {
  const { data, setData } = useAdmin();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const latest = useRef(data);
  latest.current = data;

  const tabParam = params.get('tab') as TabId | null;
  const tab: TabId = tabParam && TAB_ORDER.includes(tabParam) ? tabParam : 'basics';
  const setTab = useCallback(
    (next: TabId) => {
      const p = new URLSearchParams(params);
      if (next === 'basics') p.delete('tab');
      else p.set('tab', next);
      setParams(p, { replace: true });
    },
    [params, setParams],
  );

  const dirty = !sameJson(draft, base);
  const guard = useUnsavedGuard(dirty);

  // On a phone the tab row scrolls sideways: keep the open tab in view.
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = tabsRef.current?.querySelector<HTMLElement>('[role="tablist"]');
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    const target = selected.offsetLeft - (list.clientWidth - selected.offsetWidth) / 2;
    list.scrollLeft = Math.max(0, target);
  }, [tab]);

  const update = useCallback((patch: Partial<EventType>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors((prev) => {
      const keys = Object.keys(prev);
      if (!keys.length) return prev;
      const changed = Object.keys(patch);
      const next: Record<string, string> = {};
      for (const k of keys) {
        if (!changed.some((c) => k === c || k.startsWith(`${c}.`) || k.startsWith(`${c}[`))) next[k] = prev[k];
      }
      return Object.keys(next).length === keys.length ? prev : next;
    });
  }, []);

  const showErrors = (found: Record<string, string>) => {
    setErrors(found);
    const firstTab = TAB_ORDER.find((t) => Object.keys(found).some((k) => tabOfField(k) === t));
    if (firstTab && !Object.keys(found).some((k) => tabOfField(k) === tab)) setTab(firstTab);
  };

  const save = async () => {
    if (saving) return;
    const clean = tidy(draft);
    const found = validate(clean, latest.current.eventTypes, latest.current.hosts.map((h) => h.id));
    if (Object.keys(found).length) {
      showErrors(found);
      toast.error('A few things need fixing', 'Check the highlighted fields and save again.');
      return;
    }
    setSaving(true);
    try {
      let saved: EventType;
      if (isNew) {
        const { id: _id, createdAt: _c, updatedAt: _u, ...body } = clean;
        saved = await createEventType(body);
      } else {
        saved = await updateEventType(clean.id, clean);
      }
      const now = latest.current;
      const exists = now.eventTypes.some((e) => e.id === saved.id);
      setData({ ...now, eventTypes: exists ? now.eventTypes.map((e) => (e.id === saved.id ? saved : e)) : [...now.eventTypes, saved] });
      setBase(saved);
      setDraft(saved);
      setErrors({});
      if (isNew) {
        toast.success(`"${saved.title}" is ready to share`, 'Copy its link from the top of the page.');
        guard.allowNext();
        navigate(`/admin/event-types/${saved.id}${tab === 'basics' ? '' : `?tab=${tab}`}`, { replace: true });
      } else {
        toast.success('Saved');
      }
    } catch (e) {
      const failure = e instanceof ApiFailure ? e : null;
      if (failure?.fields && Object.keys(failure.fields).length) {
        showErrors(failure.fields);
        toast.error('A few things need fixing', failure.message);
      } else {
        toast.error('Your changes were not saved', errorMessage(e));
      }
    } finally {
      setSaving(false);
    }
  };

  // Ctrl/Cmd+S saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const remove = async () => {
    try {
      await deleteEventType(base.id);
      const now = latest.current;
      setData({ ...now, eventTypes: now.eventTypes.filter((e) => e.id !== base.id) });
      toast.success(`Deleted "${base.title}"`);
      guard.allowNext();
      navigate('/admin/event-types', { replace: true });
    } catch (e) {
      toast.error('Could not delete it', errorMessage(e));
      throw e;
    }
  };

  const tabs = useMemo<TabItem<TabId>[]>(
    () =>
      TAB_ORDER.map((t) => {
        const count = Object.keys(errors).filter((k) => tabOfField(k) === t).length;
        const extra = t === 'reminders' ? draft.reminders.filter((r) => r.enabled).length : t === 'questions' ? draft.questions.length : t === 'hosts' && draft.hostIds.length > 1 ? draft.hostIds.length : 0;
        return {
          id: t,
          label: TAB_LABELS[t],
          badge: count ? <span className="adm-tab-error">{count}</span> : extra ? extra : undefined,
        };
      }),
    [errors, draft.reminders, draft.questions.length, draft.hostIds.length],
  );

  const orphanErrors = Object.entries(errors).filter(([k]) => tabOfField(k) === null);
  // The short link that opens this event is the one to copy and open.
  const short = isNew ? null : shortLinkOf(data, base.id);
  const link = short?.url ?? `${trimUrl(data.publicUrl)}/${base.slug}`;
  const brand = brandIdOf(draft);
  const tabProps = { draft, update, errors, isNew };

  return (
    <Page className="adm-editor">
      <PageHeader
        back={{ to: '/admin/event-types', label: 'Event types' }}
        title={draft.title.trim() || (isNew ? 'New event type' : 'Untitled')}
        meta={
          <>
            {draft.kind !== 'solo' ? (
              <Badge tone="primary" icon={draft.kind === 'collective' ? <Users size={12} /> : <Shuffle size={12} />}>
                {KIND_LABEL[draft.kind]}
              </Badge>
            ) : null}
            {draft.visibility === 'unlisted' ? <Badge icon={<EyeOff size={12} />}>Unlisted</Badge> : null}
            {!draft.active ? (
              <Badge tone="warning" icon={<PauseCircle size={12} />}>
                Paused
              </Badge>
            ) : null}
            {brand ? <BrandChip id={brand} /> : null}
            {short ? <ShortChip label={short.label} /> : null}
          </>
        }
        actions={
          isNew ? undefined : (
            <>
              <CopyButton value={link} label="Copy link" />
              <ButtonLink variant="secondary" href={link} external iconRight={<ArrowUpRight size={16} />}>
                Open page
              </ButtonLink>
            </>
          )
        }
      />

      {orphanErrors.length ? (
        <Notice tone="danger" title="This could not be saved">
          <ul className="adm-plainlist">
            {orphanErrors.map(([k, message]) => (
              <li key={k}>{message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="adm-editor__tabs" ref={tabsRef}>
        <Tabs label="Event type settings" tabs={tabs} value={tab} onChange={setTab}>
          <TabPanel id="basics" className="adm-tabpanel">
            <BasicsTab {...tabProps} slugTouched={slugTouched} onSlugTouched={() => setSlugTouched(true)} />
          </TabPanel>
          <TabPanel id="hosts" className="adm-tabpanel">
            <HostsTab {...tabProps} />
          </TabPanel>
          <TabPanel id="scheduling" className="adm-tabpanel">
            <SchedulingTab {...tabProps} />
          </TabPanel>
          <TabPanel id="questions" className="adm-tabpanel">
            <QuestionsTab {...tabProps} />
          </TabPanel>
          <TabPanel id="reminders" className="adm-tabpanel">
            <RemindersTab {...tabProps} />
          </TabPanel>
          <TabPanel id="confirmation" className="adm-tabpanel">
            <ConfirmationTab {...tabProps} />
          </TabPanel>
          <TabPanel id="advanced" className="adm-tabpanel">
            <AdvancedTab {...tabProps} onDelete={() => setConfirmDelete(true)} />
          </TabPanel>
        </Tabs>
      </div>

      <SaveBar
        dirty={dirty || isNew}
        saving={saving}
        saveLabel={isNew ? 'Create event type' : 'Save changes'}
        idleText={isNew && !dirty ? 'Name it, then create it. You can change everything later.' : undefined}
        onSave={() => void save()}
        onDiscard={() => {
          if (isNew) {
            navigate('/admin/event-types');
            return;
          }
          setDraft(base);
          setErrors({});
        }}
        discardLabel={isNew ? 'Cancel' : 'Discard'}
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        tone="danger"
        title={`Delete "${base.title}"?`}
        description={deleteText(short?.label)}
        confirmLabel="Delete event type"
      />
    </Page>
  );
}
