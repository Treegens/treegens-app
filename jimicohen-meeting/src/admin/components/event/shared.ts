import type { EventType } from '../../../../shared/types';

export type TabId = 'basics' | 'hosts' | 'scheduling' | 'questions' | 'reminders' | 'confirmation' | 'advanced';

export const TAB_LABELS: Record<TabId, string> = {
  basics: 'Basics',
  hosts: 'Hosts',
  scheduling: 'Scheduling',
  questions: 'Questions',
  reminders: 'Reminders',
  confirmation: 'Confirmation',
  advanced: 'Advanced',
};

export const TAB_ORDER: TabId[] = ['basics', 'hosts', 'scheduling', 'questions', 'reminders', 'confirmation', 'advanced'];

/** Which tab shows the field a validation key points at ("scheduling.maxDaysAhead" → scheduling). */
const TAB_OF: [RegExp, TabId][] = [
  [/^(title|slug|emoji|color|description|durations|defaultDuration|locations)\b/, 'basics'],
  [/^(kind|hostIds)\b/, 'hosts'],
  [/^scheduling\b/, 'scheduling'],
  [/^(questions|phone|allowGuests|maxGuests)\b/, 'questions'],
  [/^reminders\b/, 'reminders'],
  [/^confirmation\b/, 'confirmation'],
  [/^(visibility|active|googleInvite|themeOverride)\b/, 'advanced'],
];

export function tabOfField(key: string): TabId | null {
  for (const [re, tab] of TAB_OF) if (re.test(key)) return tab;
  return null;
}

export interface TabProps {
  draft: EventType;
  /** shallow-merge a change into the draft; clears validation messages for the changed keys */
  update: (patch: Partial<EventType>) => void;
  /** validation messages keyed like the API's `fields` ("slug", "confirmation.redirectUrl", "reminders.2.offsetMinutes") */
  errors: Record<string, string>;
  isNew: boolean;
}

/** First message whose key is `key` or sits under it ("locations" matches "locations.1.value"). */
export function errorFor(errors: Record<string, string>, key: string): string | undefined {
  if (errors[key]) return errors[key];
  const hit = Object.keys(errors).find((k) => k.startsWith(`${key}.`) || k.startsWith(`${key}[`));
  return hit ? errors[hit] : undefined;
}
