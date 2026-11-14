/**
 * Validation of event types for POST and PUT /admin/event-types.
 *
 * The request body is a partial EventType. Whatever was sent is checked field by field and
 * laid over `base` (the stored event type, or a fresh one with the defaults when creating).
 * The server owns `id`, `position`, `createdAt` and `updatedAt`: those are never read from
 * the body. Field keys follow the editor: title, slug, durations, defaultDuration, hostIds,
 * kind, scheduling.<field>, questions.<n>.label, reminders.<n>.<field>, locations.<n>.value,
 * confirmation.redirectUrl.
 */
import { RESERVED_SLUGS } from '../../../shared/defaults';
import type { EventScheduling, EventType, Host, LocationConfig, LocationType, Question, QuestionType, ReminderRule } from '../../../shared/types';
import { randomId } from '../crypto';
import type { Ctx } from '../ctx';
import { cleanLine, FieldErrors, isHttpsUrl, isLocalDate, isPlainObject, isSlug, requireObject } from '../validate';
import { type AssetRef, type Bag, charCount, given, isClientId, readAssetId, readBool, readEnum, readHex, readInt, readObject, readText, verifyAssets } from './fields';
import { parseWeekly } from './schedules';
import { compactOverride, parseThemePatch, themeAssetIds } from './theme';

export const MAX_SLUG_LENGTH = 60;
export const MAX_TITLE_LENGTH = 80;
const MAX_DURATIONS = 12;
const MAX_LOCATIONS = 6;
const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 30;
const MAX_REMINDERS = 20;
const MAX_HOSTS_PER_EVENT = 20;
/** 30 days, in minutes. */
const MAX_OFFSET_MINUTES = 43_200;

const LOCATION_TYPES: LocationType[] = ['google_meet', 'phone_host_calls', 'phone_invitee_calls', 'in_person', 'custom_link', 'ask_invitee'];
const QUESTION_TYPES: QuestionType[] = ['text', 'textarea', 'select', 'radio', 'checkbox', 'url', 'number'];
const WEEKDAY_KEYS = [0, 1, 2, 3, 4, 5, 6] as const;

// ───────────────────────── slugs ─────────────────────────

/** "Intro call with Jimi!" → "intro-call-with-jimi" */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/** `root`, or `root-2`, `root-3`, … : the first one that is neither taken nor reserved. */
export function freeSlug(root: string, taken: Set<string>): string {
  const base = slugify(root) || 'meeting';
  const usable = (slug: string): boolean => !taken.has(slug) && !RESERVED_SLUGS.includes(slug);
  if (usable(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (usable(candidate)) return candidate;
  }
  return randomId('meeting').replace(/_/g, '-');
}

// ───────────────────────── pieces ─────────────────────────

function parseLocations(value: unknown, errors: FieldErrors): LocationConfig[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.add('locations', 'Add at least one place to meet.');
    return null;
  }
  if (value.length > MAX_LOCATIONS) {
    errors.add('locations', `Offer at most ${MAX_LOCATIONS} places to meet.`);
    return null;
  }
  const out: LocationConfig[] = [];
  value.forEach((item, i) => {
    if (!isPlainObject(item)) {
      errors.add(`locations.${i}`, 'This location is not readable.');
      return;
    }
    const type = readEnum(item, 'type', `locations.${i}`, LOCATION_TYPES, errors);
    if (type === undefined) {
      errors.add(`locations.${i}`, 'Choose how you will meet.');
      return;
    }
    const location: LocationConfig = { type };
    const label = readText(item, 'label', `locations.${i}.label`, 60, errors);
    if (label) location.label = label;
    const raw = typeof item.value === 'string' ? cleanLine(item.value, Number.MAX_SAFE_INTEGER) : '';
    if (type === 'in_person') {
      if (raw === '') errors.add(`locations.${i}.value`, 'Add the address.');
      else if (charCount(raw) > 300) errors.add(`locations.${i}.value`, 'Please keep the address to 300 characters or fewer.');
      else location.value = raw;
    } else if (type === 'phone_invitee_calls') {
      const digits = raw.replace(/\D/g, '');
      if (raw === '' || digits.length < 5 || digits.length > 18 || !/^[+\d][\d\s().-]*$/.test(raw)) errors.add(`locations.${i}.value`, 'Add the number people should call.');
      else location.value = raw;
    } else if (type === 'custom_link') {
      if (raw.length > 500 || !isHttpsUrl(raw)) errors.add(`locations.${i}.value`, 'Add the link, starting with https://');
      else location.value = raw;
    }
    out.push(location);
  });
  return out;
}

function parseScheduling(value: unknown, base: EventScheduling, errors: FieldErrors): EventScheduling {
  const next: EventScheduling = { ...base, scheduleIds: { ...(base.scheduleIds ?? {}) } };
  const bag = readObject(value, 'scheduling', errors);
  if (!bag) return next;
  const at = (key: string): string => `scheduling.${key}`;

  const notice = readInt(bag, 'minNoticeMinutes', at('minNoticeMinutes'), 0, MAX_OFFSET_MINUTES, errors, 'The minimum notice can be at most 30 days.');
  if (notice !== undefined) next.minNoticeMinutes = notice;
  const days = readInt(bag, 'maxDaysAhead', at('maxDaysAhead'), 1, 730, errors, 'Choose between 1 and 730 days.');
  if (days !== undefined) next.maxDaysAhead = days;
  const before = readInt(bag, 'bufferBeforeMin', at('bufferBeforeMin'), 0, 240, errors, 'A buffer can be from 0 to 240 minutes.');
  if (before !== undefined) next.bufferBeforeMin = before;
  const after = readInt(bag, 'bufferAfterMin', at('bufferAfterMin'), 0, 240, errors, 'A buffer can be from 0 to 240 minutes.');
  if (after !== undefined) next.bufferAfterMin = after;
  const increment = readInt(bag, 'slotIncrementMin', at('slotIncrementMin'), 5, 120, errors, 'Start times can be 5 to 120 minutes apart.');
  if (increment !== undefined) next.slotIncrementMin = increment;

  if (given(bag, 'maxPerDay')) {
    if (bag.maxPerDay === null) next.maxPerDay = null;
    else {
      const perDay = readInt(bag, 'maxPerDay', at('maxPerDay'), 1, 100, errors, 'The daily limit can be from 1 to 100.');
      if (perDay !== undefined) next.maxPerDay = perDay;
    }
  }

  if (given(bag, 'dateRange')) {
    const range = bag.dateRange;
    if (range === null) next.dateRange = null;
    else if (!isPlainObject(range)) errors.add(at('dateRange'), 'Choose a start and an end date.');
    else {
      const startOk = isLocalDate(range.start);
      const endOk = isLocalDate(range.end);
      if (!startOk) errors.add(at('dateRange.start'), 'Choose a start date.');
      if (!endOk) errors.add(at('dateRange.end'), 'Choose an end date.');
      if (startOk && endOk) {
        if ((range.end as string) < (range.start as string)) errors.add(at('dateRange.end'), 'The end date has to be on or after the start date.');
        else next.dateRange = { start: range.start as string, end: range.end as string };
      }
    }
  }

  if (given(bag, 'restrictHours')) {
    if (bag.restrictHours === null) next.restrictHours = null;
    else {
      const local = new FieldErrors();
      const weekly = parseWeekly(bag.restrictHours, at('restrictHours'), 'Limited hours', local);
      // The editor shows one message for the whole block.
      if (!weekly) errors.add(at('restrictHours'), Object.values(local.toJSON())[0] ?? 'Fix the highlighted hours first.');
      else if (WEEKDAY_KEYS.every((d) => weekly[d].length === 0)) errors.add(at('restrictHours'), 'Turn on at least one day, or switch this limit off.');
      else next.restrictHours = weekly;
    }
  }

  if (given(bag, 'scheduleIds')) {
    const ids = bag.scheduleIds;
    if (ids === null) next.scheduleIds = {};
    else if (!isPlainObject(ids)) errors.add(at('scheduleIds'), 'The schedule choice is not readable.');
    else {
      const picked: Record<string, string> = {};
      for (const [hostId, scheduleId] of Object.entries(ids)) {
        if (typeof scheduleId === 'string' && scheduleId !== '') picked[hostId] = scheduleId;
      }
      next.scheduleIds = picked;
    }
  }
  return next;
}

/** Keeps only choices that still point at a schedule of a host of this event. Everything else falls back to the host's default. */
function pruneScheduleIds(scheduleIds: Record<string, string>, hostIds: string[], hosts: Host[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const hostId of hostIds) {
    const wanted = scheduleIds[hostId];
    const host = hosts.find((h) => h.id === hostId);
    if (wanted && host && host.schedules.some((s) => s.id === wanted) && wanted !== host.defaultScheduleId) out[hostId] = wanted;
  }
  return out;
}

function parseQuestions(value: unknown, errors: FieldErrors): Question[] | null {
  if (!Array.isArray(value)) {
    errors.add('questions', 'The questions are not readable.');
    return null;
  }
  if (value.length > MAX_QUESTIONS) {
    errors.add('questions', `Ask at most ${MAX_QUESTIONS} questions.`);
    return null;
  }
  const ids = new Set<string>();
  const out: Question[] = [];
  value.forEach((item, i) => {
    if (!isPlainObject(item)) {
      errors.add(`questions.${i}.label`, 'This question is not readable.');
      return;
    }
    const label = readText(item, 'label', `questions.${i}.label`, 200, errors);
    if (!label) errors.add(`questions.${i}.label`, 'Write the question, or remove it.');
    const type = given(item, 'type') ? readEnum(item, 'type', `questions.${i}.type`, QUESTION_TYPES, errors) : 'text';
    const required = given(item, 'required') ? readBool(item, 'required', `questions.${i}.required`, errors) : false;
    const id = isClientId(item.id) && !ids.has(item.id) ? item.id : randomId('q');
    ids.add(id);
    const question: Question = { id, label: label ?? '', type: type ?? 'text', required: required ?? false };

    if (question.type === 'select' || question.type === 'radio' || question.type === 'checkbox') {
      const raw = Array.isArray(item.options) ? item.options : [];
      const options = [...new Set(raw.map((o) => cleanLine(o, Number.MAX_SAFE_INTEGER)).filter((o) => o !== ''))];
      if (options.length === 0) errors.add(`questions.${i}.options`, 'Add at least one choice.');
      else if (options.length > MAX_OPTIONS) errors.add(`questions.${i}.options`, `Offer at most ${MAX_OPTIONS} choices.`);
      else if (options.some((o) => charCount(o) > 120)) errors.add(`questions.${i}.options`, 'Please keep each choice to 120 characters or fewer.');
      else question.options = options;
    } else {
      const placeholder = readText(item, 'placeholder', `questions.${i}.placeholder`, 120, errors);
      if (placeholder) question.placeholder = placeholder;
    }
    out.push(question);
  });
  return out;
}

function parseReminders(value: unknown, errors: FieldErrors): ReminderRule[] | null {
  if (!Array.isArray(value)) {
    errors.add('reminders', 'The reminders are not readable.');
    return null;
  }
  if (value.length > MAX_REMINDERS) {
    errors.add('reminders', `Set up at most ${MAX_REMINDERS} reminders.`);
    return null;
  }
  const ids = new Set<string>();
  const out: ReminderRule[] = [];
  value.forEach((item, i) => {
    const at = (key: string): string => `reminders.${i}.${key}`;
    if (!isPlainObject(item)) {
      errors.add(at('channel'), 'This reminder is not readable.');
      return;
    }
    const channel = readEnum(item, 'channel', at('channel'), ['email', 'sms', 'call'] as const, errors);
    const audience = readEnum(item, 'audience', at('audience'), ['invitee', 'host'] as const, errors);
    const trigger = readEnum(item, 'trigger', at('trigger'), ['before_start', 'after_end'] as const, errors);
    const offset = readInt(item, 'offsetMinutes', at('offsetMinutes'), 0, MAX_OFFSET_MINUTES, errors, 'Reminders can go out at most 30 days away from the meeting.');
    const enabled = given(item, 'enabled') ? readBool(item, 'enabled', at('enabled'), errors) : true;
    if (channel === undefined && !given(item, 'channel')) errors.add(at('channel'), 'Choose how this reminder is sent.');
    if (audience === undefined && !given(item, 'audience')) errors.add(at('audience'), 'Choose who gets this reminder.');
    if (trigger === undefined && !given(item, 'trigger')) errors.add(at('trigger'), 'Choose when this reminder goes out.');
    if (offset === undefined && !given(item, 'offsetMinutes')) errors.add(at('offsetMinutes'), 'Choose when this reminder goes out.');
    if (channel === undefined || audience === undefined || trigger === undefined || offset === undefined) return;

    if (channel === 'call') {
      // The assistant only ever phones the invitee, and only ahead of the meeting.
      if (audience !== 'invitee') errors.add(at('audience'), 'Reminder calls only go to the invitee.');
      if (trigger !== 'before_start') errors.add(at('trigger'), 'Reminder calls are made before the meeting.');
    }
    const id = isClientId(item.id) && !ids.has(item.id) ? item.id : randomId('rem');
    ids.add(id);
    const rule: ReminderRule = { id, enabled: enabled ?? true, channel, audience, trigger, offsetMinutes: offset };
    if (channel === 'email') {
      const subject = readText(item, 'subject', at('subject'), 200, errors);
      if (subject) rule.subject = subject;
    }
    if (channel !== 'call') {
      const body = readText(item, 'body', at('body'), channel === 'sms' ? 600 : 4000, errors, { multiline: true });
      if (body) rule.body = body;
    }
    out.push(rule);
  });
  return out;
}

// ───────────────────────── the whole event type ─────────────────────────

export interface EventTypeEnv {
  /** everyone on the team */
  hosts: Host[];
  /** every other event type (for the unique link check) */
  others: EventType[];
  creating: boolean;
}

/**
 * Returns the event type as it should be stored (not saved yet). Throws HttpError(422) with
 * every invalid field.
 */
export async function buildEventType(ctx: Ctx, body: unknown, base: EventType, env: EventTypeEnv): Promise<EventType> {
  const b: Bag = requireObject(body);
  const errors = new FieldErrors();
  const refs: AssetRef[] = [];
  const next: EventType = structuredClone(base);

  // title
  const title = readText(b, 'title', 'title', MAX_TITLE_LENGTH, errors, { required: 'Give this event type a name.' });
  if (title !== undefined) next.title = title;
  if (env.creating && next.title === '') errors.add('title', 'Give this event type a name.');

  // slug
  const taken = new Set(env.others.map((e) => e.slug.toLowerCase()));
  const slugSent = given(b, 'slug') && !(env.creating && typeof b.slug === 'string' && b.slug.trim() === '');
  if (slugSent) {
    const raw = typeof b.slug === 'string' ? b.slug.trim() : '';
    if (raw === '') errors.add('slug', 'Choose a link for this event.');
    else if (raw.length > MAX_SLUG_LENGTH || !isSlug(raw)) errors.add('slug', 'Use lowercase letters, numbers and dashes, without a dash at either end.');
    else if (RESERVED_SLUGS.includes(raw)) errors.add('slug', 'That link is reserved. Please choose another.');
    else if (taken.has(raw)) errors.add('slug', 'Another event type already uses this link.');
    else next.slug = raw;
  } else if (env.creating) {
    next.slug = freeSlug(next.title, taken);
  }

  // basics
  const description = readText(b, 'description', 'description', 1200, errors, { multiline: true });
  if (description !== undefined) next.description = description;
  const emoji = readText(b, 'emoji', 'emoji', 8, errors);
  if (emoji !== undefined) next.emoji = emoji;
  if (given(b, 'color')) {
    if (b.color === '' || b.color === null) next.color = '';
    else {
      const hex = readHex(b, 'color', 'color', errors);
      if (hex !== undefined) next.color = hex;
    }
  }
  const cover = readAssetId(b, 'coverAssetId', 'coverAssetId', base.coverAssetId, refs, errors);
  if (cover !== undefined) next.coverAssetId = cover;

  // who hosts
  const kind = readEnum(b, 'kind', 'kind', ['solo', 'collective', 'round_robin'] as const, errors);
  if (kind !== undefined) next.kind = kind;
  if (given(b, 'hostIds')) {
    const raw = b.hostIds;
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) errors.add('hostIds', 'Choose at least one host.');
    else next.hostIds = [...new Set(raw as string[])];
  }
  if (env.creating || given(b, 'kind') || given(b, 'hostIds')) {
    const known = new Set(env.hosts.map((h) => h.id));
    if (next.hostIds.length === 0) errors.add('hostIds', 'Choose at least one host.');
    else if (next.hostIds.some((id) => !known.has(id))) errors.add('hostIds', 'One of the chosen hosts is no longer on the team. Choose again.');
    else if (next.hostIds.length > MAX_HOSTS_PER_EVENT) errors.add('hostIds', `An event can have at most ${MAX_HOSTS_PER_EVENT} hosts.`);
    else if (next.kind !== 'solo' && next.hostIds.length < 2) errors.add('hostIds', 'Choose at least two hosts for this kind of meeting.');
    else if (next.kind === 'solo' && next.hostIds.length > 1) errors.add('hostIds', 'Choose one host, or switch to Together or Round robin.');
  }

  // lengths
  if (given(b, 'durations')) {
    const raw = b.durations;
    if (!Array.isArray(raw) || raw.length === 0) errors.add('durations', 'Offer at least one length.');
    else if (raw.some((d) => typeof d !== 'number' || !Number.isInteger(d) || d < 5 || d > 480)) errors.add('durations', 'Lengths have to be whole minutes, between 5 minutes and 8 hours.');
    else if (new Set(raw).size > MAX_DURATIONS) errors.add('durations', `Offer at most ${MAX_DURATIONS} lengths.`);
    else next.durations = [...new Set(raw as number[])].sort((x, y) => x - y);
  }
  if (given(b, 'defaultDuration')) {
    if (typeof b.defaultDuration === 'number' && next.durations.includes(b.defaultDuration)) next.defaultDuration = b.defaultDuration;
    else errors.add('defaultDuration', 'Choose one of the lengths on offer.');
  } else if (!next.durations.includes(next.defaultDuration)) {
    next.defaultDuration = next.durations[0];
  }

  // where
  if (given(b, 'locations')) {
    const locations = parseLocations(b.locations, errors);
    if (locations) next.locations = locations;
  }

  // visibility
  const visibility = readEnum(b, 'visibility', 'visibility', ['public', 'unlisted'] as const, errors);
  if (visibility !== undefined) next.visibility = visibility;
  const active = readBool(b, 'active', 'active', errors);
  if (active !== undefined) next.active = active;

  // scheduling
  if (given(b, 'scheduling')) next.scheduling = parseScheduling(b.scheduling, base.scheduling, errors);
  next.scheduling = { ...next.scheduling, scheduleIds: pruneScheduleIds(next.scheduling.scheduleIds ?? {}, next.hostIds, env.hosts) };

  // the form
  if (given(b, 'questions')) {
    const questions = parseQuestions(b.questions, errors);
    if (questions) next.questions = questions;
  }
  const allowGuests = readBool(b, 'allowGuests', 'allowGuests', errors);
  if (allowGuests !== undefined) next.allowGuests = allowGuests;
  const maxGuests = readInt(b, 'maxGuests', 'maxGuests', 0, 20, errors, 'Guests per booking can be from 0 to 20.');
  if (maxGuests !== undefined) next.maxGuests = maxGuests;
  const phone = readEnum(b, 'phone', 'phone', ['hidden', 'optional', 'required'] as const, errors);
  if (phone !== undefined) next.phone = phone;

  // reminders
  if (given(b, 'reminders')) {
    const reminders = parseReminders(b.reminders, errors);
    if (reminders) next.reminders = reminders;
  }

  // after booking
  if (given(b, 'confirmation')) {
    const c = readObject(b.confirmation, 'confirmation', errors);
    if (c) {
      const confirmation = { ...(base.confirmation ?? {}) };
      const message = readText(c, 'message', 'confirmation.message', 1000, errors, { multiline: true });
      if (message !== undefined) confirmation.message = message;
      if (given(c, 'redirectUrl')) {
        const raw = typeof c.redirectUrl === 'string' ? c.redirectUrl.trim() : null;
        if (raw === '' || c.redirectUrl === null) confirmation.redirectUrl = '';
        else if (raw !== null && raw.length <= 500 && isHttpsUrl(raw)) confirmation.redirectUrl = raw;
        else errors.add('confirmation.redirectUrl', 'The link has to start with https://');
      }
      next.confirmation = confirmation;
    }
  }
  const googleInvite = readBool(b, 'googleInvite', 'googleInvite', errors);
  if (googleInvite !== undefined) next.googleInvite = googleInvite;

  // look
  if (given(b, 'themeOverride')) {
    if (b.themeOverride === null) next.themeOverride = null;
    else {
      const patch = parseThemePatch(b.themeOverride, 'themeOverride', themeAssetIds(base.themeOverride), refs, errors);
      if (patch) next.themeOverride = compactOverride(patch);
    }
  }

  await verifyAssets(ctx, refs, errors);
  errors.throwIfAny();

  // Owned by the server, whatever the body said.
  next.id = base.id;
  next.position = base.position;
  next.createdAt = base.createdAt;
  next.updatedAt = base.updatedAt;
  return next;
}

/** True when the two rule lists would plan different reminders. */
export function remindersChanged(before: ReminderRule[], after: ReminderRule[]): boolean {
  return JSON.stringify(before ?? []) !== JSON.stringify(after ?? []);
}
