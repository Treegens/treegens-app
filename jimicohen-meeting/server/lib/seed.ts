/**
 * The one-time setup of the short links on the live data (docs: README, "Short links").
 *
 *   jimicohen.com/meet  opens a meeting with the owner alone: the starter "Meeting" (renamed "Meeting with
 *                       Jimi" while it still has its starter title), or another solo meeting of theirs. The
 *                       name reads in a sentence ("Your Meeting with Jimi is confirmed"); the link's own
 *                       preview says "Meet with Jimi" (shared/shortLinks.ts).
 *   jimicohen.com/pod   opens the Eco Champions conversation: a joint meeting of the owner and every
 *                       co-host, in the Eco Champions look. A joint meeting the owner made whose name
 *                       already says Eco Champions or podcast is used; otherwise a new, unlisted one is made.
 *
 * Who runs it: only the scheduled function of the published deploy (netlify/functions/cron.mts passes
 * `oneTimeMoves`), and locally the dev route POST /dev/one-time-moves. Never a page view, the dashboard,
 * a draft deploy, the dev server's timer or POST /dev/run-jobs.
 *
 * Safe to run twice and at the same time: each step only fills in what is missing (a key absent from the
 * map, an event with a fixed id, a brand on an event that has none), so a second run finds everything in
 * place and writes nothing. A permanent marker (`migrations/short-links-v1`, never pruned) is written last.
 * It never edits the profile, the site's look, the welcome text, or any event's description, lengths,
 * hosts or hours; it renames only the untouched starter title.
 */
import { ECO_CHAMPIONS_BRAND_ID, isBrandId } from '../../shared/brands';
import { newEventType } from '../../shared/defaults';
import type { EventType, Host, ShortName, SiteSettings } from '../../shared/types';
import { freeSlug } from './admin/event-types';
import type { Ctx, KV } from './ctx';
import { KEYS, listHosts, getSite, updateEventTypes, updateSite } from './repo';
import { firstName } from './templates';

export const MOVE_MARKER = `${KEYS.migrationPrefix}short-links-v1`;

export const MEET_EVENT_ID = 'evt_meet_with_jimi';
export const POD_EVENT_ID = 'evt_eco_champions';
export const POD_TITLE = 'Eco Champions conversation';
export const POD_DESCRIPTION =
  'A conversation with the hosts of Eco Champions, the podcast interviewing the forces of nature on climate and sustainability. Guests, partners and fellow champions of the living earth are all welcome. Pick a time that suits you and it goes straight into our calendars.';
/** The starter event's title, the only title the setup ever changes. */
const STARTER_TITLE = 'Meeting';
const MAX_HOSTS = 20;
/** A joint meeting with one of these in its title or link is taken over for /pod. */
const POD_WORDS = ['eco', 'champion', 'pod'];

export interface LinkReport {
  eventTypeId: string;
  created?: boolean;
  renamed?: boolean;
  branded?: boolean;
  takenOver?: boolean;
}

export interface SeedReport {
  meet?: LinkReport | 'kept';
  pod?: LinkReport | 'kept';
}

export interface Plan {
  /** the next event type list; unchanged when nothing needs doing */
  list: EventType[];
  changed: boolean;
  /** the event type each missing link should open */
  targets: Partial<Record<ShortName, string>>;
  report: SeedReport;
}

function byPosition(a: EventType, b: EventType): number {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function nextPosition(list: EventType[]): number {
  return list.reduce((max, e) => Math.max(max, Number.isFinite(e.position) ? e.position : 0), -1) + 1;
}

/**
 * What to do to the event types and the link map, worked out from what is stored. Pure: tested on its own,
 * and run again inside the compare-and-swap on the freshest list (it ends the same way on its own output).
 */
export function planShortLinks(input: EventType[], hosts: Host[], site: SiteSettings, nowIso: string): Plan {
  const list = structuredClone(input).sort(byPosition);
  const ownerId = site.ownerHostId;
  const owner = hosts.find((h) => h.id === ownerId) ?? hosts.find((h) => h.role === 'owner') ?? null;
  const links = site.shortLinks ?? {};
  const targets: Plan['targets'] = {};
  const report: SeedReport = {};
  let changed = false;
  const taken = (): Set<string> => new Set(list.map((e) => e.slug.toLowerCase()));

  // ── /meet: a meeting with the owner alone, in their own look ──
  if (!('meet' in links)) {
    const solo = (e: EventType): boolean => e.kind === 'solo' && e.hostIds.length === 1 && e.hostIds[0] === ownerId && !isBrandId(e.brandId);
    const publicFirst = (a: EventType, b: EventType): number => Number(a.visibility !== 'public') - Number(b.visibility !== 'public');
    const pick = (active: boolean): EventType | undefined => {
      const starter = list.find((e) => e.id === 'evt_meeting' && solo(e) && e.active === active);
      return starter ?? list.filter((e) => solo(e) && e.active === active).sort((a, b) => publicFirst(a, b) || byPosition(a, b))[0];
    };
    // An active one first: a paused one only when there is nothing else, so /meet does not start out closed.
    let target = pick(true) ?? pick(false);
    const who = firstName(owner?.name ?? '') || firstName(site.profile?.name ?? '') || 'me';
    let created = false;
    let renamed = false;
    if (!target) {
      const existing = list.find((e) => e.id === MEET_EVENT_ID);
      if (existing) target = existing;
      else {
        target = newEventType(nowIso, {
          id: MEET_EVENT_ID,
          slug: freeSlug(`meet-with-${who}`, taken()),
          title: `Meeting with ${who}`,
          description: 'Partnerships, speaking, press or a deeper conversation.',
          emoji: '🌱',
          hostIds: [ownerId],
          durations: [30, 45, 60],
          defaultDuration: 30,
          position: nextPosition(list),
        });
        list.push(target);
        created = true;
        changed = true;
      }
    }
    if (target.title === STARTER_TITLE) {
      target.title = `Meeting with ${who}`;
      renamed = true;
      changed = true;
    }
    targets.meet = target.id;
    report.meet = { eventTypeId: target.id, ...(created ? { created } : {}), ...(renamed ? { renamed } : {}) };
  } else {
    report.meet = 'kept';
  }

  // ── /pod: the Eco Champions conversation, the owner and every co-host ──
  if (!('pod' in links)) {
    let target: EventType | undefined =
      list.find((e) => e.id === POD_EVENT_ID && e.brandId === ECO_CHAMPIONS_BRAND_ID) ?? list.find((e) => e.brandId === ECO_CHAMPIONS_BRAND_ID);
    let entry: LinkReport | null = target ? { eventTypeId: target.id } : null;
    if (!target) {
      const says = (e: EventType): boolean => {
        const text = `${e.title} ${e.slug}`.toLowerCase();
        return POD_WORDS.some((w) => text.includes(w));
      };
      const joint = list
        .filter((e) => e.active === true && e.kind === 'collective' && e.hostIds.length >= 2 && e.hostIds.includes(ownerId) && !isBrandId(e.brandId) && says(e))
        .sort((a, b) => b.hostIds.length - a.hostIds.length || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      if (joint[0]) {
        target = joint[0];
        target.brandId = ECO_CHAMPIONS_BRAND_ID;
        changed = true;
        entry = { eventTypeId: target.id, takenOver: true, branded: true };
      }
    }
    if (!target) {
      const existing = list.find((e) => e.id === POD_EVENT_ID);
      if (existing) {
        // Made by an earlier run that did not finish, and changed since: it is used as it is.
        target = existing;
        entry = { eventTypeId: existing.id };
      } else {
        const members = hosts
          .filter((h) => h.role === 'member' && h.id !== ownerId)
          .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
        const hostIds = [ownerId, ...members.map((h) => h.id)].slice(0, MAX_HOSTS);
        target = newEventType(nowIso, {
          id: POD_EVENT_ID,
          slug: freeSlug('eco-champions', taken()),
          title: POD_TITLE,
          description: POD_DESCRIPTION,
          emoji: '🌿',
          color: '',
          kind: hostIds.length > 1 ? 'collective' : 'solo',
          hostIds,
          durations: [30, 60],
          defaultDuration: 30,
          locations: [{ type: 'google_meet' }],
          visibility: 'unlisted',
          active: true,
          brandId: ECO_CHAMPIONS_BRAND_ID,
          position: nextPosition(list),
        });
        list.push(target);
        changed = true;
        entry = { eventTypeId: target.id, created: true, branded: true };
      }
    }
    targets.pod = target.id;
    report.pod = entry ?? { eventTypeId: target.id };
  } else {
    report.pod = 'kept';
  }

  return { list, changed, targets, report };
}

/** Stores that have seen the marker. Each production request opens its own store, so there it is one read per run. */
const DONE = new WeakSet<KV>();

/**
 * Runs the setup once. Returns what it did, or 'already_done' when the marker is there. Throws when the
 * store fails (the scheduled run wraps it, so the reminders still go out).
 */
export async function runShortLinkMove(ctx: Ctx, opts?: { readMarker?: boolean }): Promise<SeedReport | 'already_done'> {
  // The dev route always reads the marker: a local store can be wiped (POST /dev/reset) under a live server.
  if (!opts?.readMarker && DONE.has(ctx.kv)) return 'already_done';
  if (await ctx.kv.getJSON(MOVE_MARKER)) {
    DONE.add(ctx.kv);
    return 'already_done';
  }
  const now = ctx.now().toISOString();
  const [site, hosts] = await Promise.all([getSite(ctx), listHosts(ctx)]);

  // Step 1: the event types, in one swap of the list.
  const plan = await updateEventTypes<Plan>(ctx, (list) => {
    const p = planShortLinks(list, hosts, site, now);
    return p.changed ? { next: p.list, result: p } : { keep: p };
  });

  // Step 2: the link map, each key only while it is still missing. A choice made in the meantime wins.
  await updateSite(ctx, (fresh) => {
    const current = fresh.shortLinks ?? {};
    const next = { ...current };
    for (const [name, id] of Object.entries(plan.targets) as [ShortName, string][]) {
      if (!(name in next)) next[name] = id;
    }
    return { ...fresh, shortLinks: next };
  });

  // Step 3: the marker, last, so a run that stopped half way is finished by the next one.
  await ctx.kv.setJSON(MOVE_MARKER, { at: now, report: plan.report }, { onlyIfNew: true });
  DONE.add(ctx.kv);
  ctx.log('info', 'short links: one-time setup done', plan.report);
  return plan.report;
}
