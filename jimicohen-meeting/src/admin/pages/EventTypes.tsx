import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, CalendarRange, ChevronRight, CopyPlus, EyeOff, GripVertical, MoreHorizontal, Pencil, Plus, Share2, Shuffle, Trash2, User, Users } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { EventKind, EventType } from '../../../shared/types';
import { deleteEventType, duplicateEventType, errorMessage, reorderEventTypes, updateEventType } from '../../lib/api';
import { Badge, Button, ButtonLink, ConfirmDialog, CopyButton, EmptyState, IconButton, Menu, Modal, Switch, cx, useToast } from '../../ui';
import { brandIdOf, deleteText, shortLinkOf } from '../brands';
import { BrandChip, ShortChip, ShortLinksCard } from '../components/BrandBits';
import { Page, PageHeader } from '../components/Page';
import { SharePanel } from '../components/SharePanel';
import { KIND_LABEL, eventMeta, trimUrl } from '../format';
import { useAdmin } from '../state';

const KIND_CHOICES: { kind: EventKind; icon: typeof User; title: string; text: string }[] = [
  { kind: 'solo', icon: User, title: 'Just me', text: 'People book time with you alone.' },
  { kind: 'collective', icon: Users, title: 'Together', text: 'Book into two or more calendars at once. Only times when everyone is free are offered.' },
  { kind: 'round_robin', icon: Shuffle, title: 'Round robin', text: 'Whoever is free takes the meeting. Bookings are shared out evenly between hosts.' },
];

export function EventGlyph({ et, size = 40 }: { et: Pick<EventType, 'emoji' | 'color' | 'title'>; size?: number }) {
  const letter = Array.from(et.title.trim())[0]?.toUpperCase() ?? '?';
  return (
    <span className="adm-glyph" style={{ '--_c': et.color || 'var(--a-primary)', '--_s': `${size}px` } as CSSProperties} aria-hidden="true">
      {et.emoji ? <span className="adm-glyph__emoji">{et.emoji}</span> : letter}
    </span>
  );
}

export default function EventTypes() {
  const { data, setData } = useAdmin();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const publicUrl = trimUrl(data.publicUrl);
  const sorted = useMemo(() => data.eventTypes.slice().sort((a, b) => a.position - b.position), [data.eventTypes]);
  const [order, setOrder] = useState<string[]>(() => sorted.map((e) => e.id));
  const [dragId, setDragId] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<EventType | null>(null);
  const [toShare, setToShare] = useState<EventType | null>(null);
  const orderAtDragStart = useRef<string[]>([]);
  const latest = useRef(data);
  latest.current = data;

  const picking = params.get('new') === '1';
  const setPicking = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set('new', '1');
    else next.delete('new');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (!dragId) setOrder(sorted.map((e) => e.id));
  }, [sorted, dragId]);

  const byId = useMemo(() => new Map(data.eventTypes.map((e) => [e.id, e])), [data.eventTypes]);
  const rows = order.map((id) => byId.get(id)).filter((e): e is EventType => !!e);
  const hostName = (id: string) => data.hosts.find((h) => h.id === id)?.name ?? 'Someone';
  const multiHost = data.hosts.length > 1;

  const commitOrder = async (ids: string[], before: string[]) => {
    if (ids.join() === before.join()) return;
    const current = latest.current;
    setData({ ...current, eventTypes: current.eventTypes.map((e) => ({ ...e, position: Math.max(0, ids.indexOf(e.id)) })) });
    try {
      await reorderEventTypes(ids);
    } catch (e) {
      const now = latest.current;
      setData({ ...now, eventTypes: now.eventTypes.map((x) => ({ ...x, position: Math.max(0, before.indexOf(x.id)) })) });
      toast.error('The new order was not saved', errorMessage(e));
    }
  };

  const move = (id: string, dir: -1 | 1) => {
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
    void commitOrder(next, order);
  };

  const onDragOver = (e: DragEvent<HTMLLIElement>, overId: string) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (overId === dragId) return;
    setOrder((prev) => {
      const from = prev.indexOf(dragId);
      const to = prev.indexOf(overId);
      if (from < 0 || to < 0) return prev;
      const next = prev.slice();
      next.splice(from, 1);
      next.splice(to, 0, dragId);
      return next;
    });
  };

  const toggleActive = async (et: EventType, active: boolean) => {
    setBusyId(et.id);
    try {
      const saved = await updateEventType(et.id, { active });
      const now = latest.current;
      setData({ ...now, eventTypes: now.eventTypes.map((x) => (x.id === saved.id ? saved : x)) });
      toast.success(active ? `${saved.title} is taking bookings` : `${saved.title} is paused`, active ? undefined : 'Nobody can book it until you turn it back on.');
    } catch (e) {
      toast.error('That did not save', errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = async (et: EventType) => {
    setBusyId(et.id);
    try {
      const copy = await duplicateEventType(et.id);
      const now = latest.current;
      setData({ ...now, eventTypes: [...now.eventTypes, copy] });
      toast.success(`Copied as "${copy.title}"`);
      navigate(`/admin/event-types/${copy.id}`);
    } catch (e) {
      toast.error('Could not duplicate it', errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!toDelete) return;
    try {
      await deleteEventType(toDelete.id);
      const now = latest.current;
      setData({ ...now, eventTypes: now.eventTypes.filter((x) => x.id !== toDelete.id) });
      toast.success(`Deleted "${toDelete.title}"`);
    } catch (e) {
      toast.error('Could not delete it', errorMessage(e));
      throw e;
    }
  };

  return (
    <Page>
      <PageHeader
        title="Event types"
        description="The kinds of meeting people can book with you. Each one has its own link, length, hosts and reminders."
        actions={
          <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setPicking(true)}>
            New event type
          </Button>
        }
      />

      {/* jimicohen.com/meet and /pod: what each opens, changed here. */}
      <ShortLinksCard />

      {rows.length === 0 ? (
        <div className="adm-panel">
          <EmptyState
            icon={<CalendarRange />}
            title="No event types yet"
            description="Create one, share its link, and people can start booking time with you."
            action={
              <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setPicking(true)}>
                New event type
              </Button>
            }
          />
        </div>
      ) : (
        <ul role="list" className="adm-events">
          {rows.map((et, i) => {
            const full = `${publicUrl}/${et.slug}`;
            // A short link that opens this event is the one to share.
            const short = shortLinkOf(data, et.id);
            const link = short?.url ?? full;
            const brand = brandIdOf(et);
            return (
              <li
                key={et.id}
                className={cx('adm-event', !et.active && 'is-off', dragId === et.id && 'is-dragging')}
                draggable={armed === et.id}
                onDragStart={(e) => {
                  orderAtDragStart.current = order;
                  setDragId(et.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', et.title);
                }}
                onDragOver={(e) => onDragOver(e, et.id)}
                onDrop={(e) => e.preventDefault()}
                onDragEnd={() => {
                  const before = orderAtDragStart.current;
                  setDragId(null);
                  setArmed(null);
                  void commitOrder(order, before);
                }}
              >
                <span className="adm-event__grip" onPointerDown={() => setArmed(et.id)} onPointerUp={() => setArmed(null)} aria-hidden="true" title="Drag to reorder">
                  <GripVertical size={16} />
                </span>
                <EventGlyph et={et} />
                <div className="adm-event__main">
                  <div className="adm-event__titlerow">
                    <Link to={`/admin/event-types/${et.id}`} className="adm-event__title">
                      {et.title}
                    </Link>
                    {et.kind !== 'solo' ? (
                      <Badge tone="primary" size="sm" icon={et.kind === 'collective' ? <Users size={12} /> : <Shuffle size={12} />}>
                        {KIND_LABEL[et.kind]}
                      </Badge>
                    ) : null}
                    {et.visibility === 'unlisted' ? (
                      <Badge size="sm" icon={<EyeOff size={12} />}>
                        Unlisted
                      </Badge>
                    ) : null}
                    {brand ? <BrandChip id={brand} /> : null}
                    {short ? <ShortChip label={short.label} /> : null}
                  </div>
                  <p className="adm-event__meta">{eventMeta(et, hostName)}</p>
                  <a className="adm-event__link u-truncate" href={link} target="_blank" rel="noopener noreferrer">
                    {short ? short.label : `/${et.slug}`}
                    <ArrowUpRight size={13} aria-hidden="true" />
                  </a>
                </div>
                <div className="adm-event__actions">
                  <Switch checked={et.active} disabled={busyId === et.id} onChange={(on) => void toggleActive(et, on)} aria-label={`${et.title}: accept bookings`} />
                  <span className="adm-event__state" aria-hidden="true">
                    {et.active ? 'Live' : 'Paused'}
                  </span>
                  <CopyButton value={link} label="Copy link" size="sm" />
                  <Menu
                    label={`Actions for ${et.title}`}
                    trigger={<IconButton label={`More actions for ${et.title}`} icon={<MoreHorizontal />} size="sm" loading={busyId === et.id} />}
                    items={[
                      { label: 'Edit', icon: <Pencil size={16} />, onSelect: () => navigate(`/admin/event-types/${et.id}`) },
                      { label: 'Share and embed', icon: <Share2 size={16} />, onSelect: () => setToShare(et) },
                      { label: 'Open booking page', icon: <ArrowUpRight size={16} />, href: link, external: true },
                      { label: 'Duplicate', icon: <CopyPlus size={16} />, onSelect: () => void duplicate(et) },
                      { type: 'separator' },
                      { label: 'Move up', icon: <ArrowUp size={16} />, disabled: i === 0, onSelect: () => move(et.id, -1) },
                      { label: 'Move down', icon: <ArrowDown size={16} />, disabled: i === rows.length - 1, onSelect: () => move(et.id, 1) },
                      { type: 'separator' },
                      { label: 'Delete', icon: <Trash2 size={16} />, danger: true, onSelect: () => setToDelete(et) },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length > 0 && !multiHost ? (
        <div className="adm-hintcard">
          <Users size={18} aria-hidden="true" />
          <div>
            <p className="adm-hintcard__title">Want people to book you and a colleague at the same time?</p>
            <p className="adm-hintcard__text">Add a co-host, then create a Together event. Only times when you are both free will be offered, and the meeting lands on both calendars.</p>
          </div>
          <ButtonLink variant="secondary" size="sm" to="/admin/team" iconRight={<ChevronRight size={15} />}>
            Add a co-host
          </ButtonLink>
        </div>
      ) : null}

      <Modal open={picking} onClose={() => setPicking(false)} title="What kind of meeting?" description="You can change this later on the Hosts tab." size="md">
        <div className="adm-kinds">
          {KIND_CHOICES.map((c) => {
            const blocked = c.kind !== 'solo' && !multiHost;
            return (
              <button
                key={c.kind}
                type="button"
                className="adm-kind"
                disabled={blocked}
                onClick={() => navigate(`/admin/event-types/new?kind=${c.kind}`)}
                {...(c.kind === 'solo' ? { 'data-autofocus': '' } : null)}
              >
                <span className="adm-kind__icon" aria-hidden="true">
                  <c.icon size={20} />
                </span>
                <span className="adm-kind__text">
                  <span className="adm-kind__title">{c.title}</span>
                  <span className="adm-kind__desc">{c.text}</span>
                  {blocked ? <span className="adm-kind__note">Needs a co-host first.</span> : null}
                </span>
                <ChevronRight size={18} aria-hidden="true" className="adm-kind__chev" />
              </button>
            );
          })}
        </div>
        {!multiHost ? (
          <p className="adm-kinds__foot">
            Together and round robin meetings need at least two hosts. <Link to="/admin/team">Add a co-host on the Team page</Link>.
          </p>
        ) : null}
      </Modal>

      <Modal open={toShare !== null} onClose={() => setToShare(null)} title={toShare ? `Share ${toShare.title}` : 'Share'} size="lg">
        {toShare ? <SharePanel url={`${publicUrl}/${toShare.slug}`} title={toShare.title} shortUrl={shortLinkOf(data, toShare.id)?.url} /> : null}
      </Modal>

      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={remove}
        tone="danger"
        title={toDelete ? `Delete "${toDelete.title}"?` : 'Delete?'}
        description={deleteText(toDelete ? shortLinkOf(data, toDelete.id)?.label : undefined)}
        confirmLabel="Delete event type"
      />
    </Page>
  );
}
