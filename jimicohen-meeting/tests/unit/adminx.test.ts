import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, defaultSchedule, defaultSite, newEventType, starterEventTypes } from '../../shared/defaults';
import { THEME_PRESETS } from '../../shared/presets';
import { contrastRatio } from '../../shared/theme';
import type { AdminBootstrap, AdminHost } from '../../shared/types';
import { contrastChecks, contrastProblems, formatRatio } from '../../src/admin/components/x/contrast';
import { previewEventTypes, sampleEventType, toPreviewSite, toPublicEventType } from '../../src/admin/components/x/previewData';

const NOW = '2026-11-14T10:00:00.000Z';

function host(id: string, name: string, role: AdminHost['role'] = 'member'): AdminHost {
  return {
    id,
    role,
    name,
    email: `${id}@example.com`,
    title: role === 'owner' ? 'Founder' : '',
    avatarAssetId: null,
    avatarUrl: role === 'owner' ? '/meeting/api/assets/asset_me' : null,
    timezone: role === 'owner' ? 'Africa/Nairobi' : 'Europe/London',
    timezoneMode: 'device',
    schedules: [defaultSchedule()],
    defaultScheduleId: 'sch_default',
    google: null,
    icsFeeds: [],
    hasInviteLink: false,
    notify: { email: true, sms: false },
    calendarHealth: null,
  };
}

function bootstrap(): AdminBootstrap {
  const owner = host('host_owner', 'Jimi Cohen', 'owner');
  const alex = host('host_alex', 'Alex Rivera');
  return {
    site: defaultSite(NOW),
    hosts: [owner, alex],
    eventTypes: [
      ...starterEventTypes(NOW),
      newEventType(NOW, {
        id: 'evt_both',
        slug: 'both',
        title: 'Both of us',
        kind: 'collective',
        hostIds: ['host_owner', 'host_alex'],
        color: '#3355ff',
        visibility: 'unlisted',
        locations: [{ type: 'phone_host_calls' }, { type: 'in_person', value: '12 Leaf Lane' }, { type: 'custom_link', value: 'https://zoom.example/room', label: 'Zoom' }],
        position: 2,
      }),
      newEventType(NOW, { id: 'evt_off', slug: 'off', title: 'Switched off', active: false, position: 3 }),
    ],
    integrations: {
      baseUrl: 'https://jimicohen.com/meeting',
      google: { configured: false, redirectUri: 'https://jimicohen.com/meeting/api/google/callback', ownerConnected: false },
      twilio: { configured: true },
      anthropic: { configured: false, model: 'claude-opus-5-5' },
      email: { setting: 'auto', resolved: 'none', resendConfigured: false, gmailAvailable: false, fromEmail: '' },
    },
    publicUrl: 'https://jimicohen.com/meeting',
  };
}

describe('contrast checks', () => {
  it('passes every shipped preset, in both palettes', () => {
    for (const preset of THEME_PRESETS) {
      expect(contrastProblems(preset.theme.colors), `${preset.key} light`).toBe(0);
      if (preset.theme.darkColors) expect(contrastProblems(preset.theme.darkColors), `${preset.key} dark`).toBe(0);
    }
  });

  it('flags text that melts into the card and offers a fix that reaches AA', () => {
    const colors = { ...DEFAULT_THEME.colors, text: '#1d3a2a' };
    const checks = contrastChecks(colors);
    const text = checks.find((c) => c.id === 'text')!;
    expect(text.level).toBe('poor');
    expect(text.problem).toBeTruthy();
    expect(text.fixed).not.toBeNull();
    expect(contrastRatio(text.fixed!.text, colors.surface)).toBeGreaterThanOrEqual(4.5);
    // only the offending colour changes
    expect({ ...text.fixed!, text: colors.text }).toEqual(colors);
    expect(contrastProblems(text.fixed!)).toBe(0);
  });

  it('judges the brand colour as a shape, not as text (3:1)', () => {
    const colors = { ...DEFAULT_THEME.colors, primary: '#1f4a33' };
    const primary = contrastChecks(colors).find((c) => c.id === 'primary')!;
    expect(primary.level).not.toBe('good');
    expect(contrastRatio(primary.fixed!.primary, colors.surface)).toBeGreaterThanOrEqual(3);
  });

  it('survives values that are not colours', () => {
    const colors = { ...DEFAULT_THEME.colors, text: 'not-a-colour' };
    const text = contrastChecks(colors).find((c) => c.id === 'text')!;
    expect(text.level).toBe('good');
    expect(text.fixed).toBeNull();
  });

  it('formats ratios the way people read them', () => {
    expect(formatRatio(4.53)).toBe('4.5:1');
    expect(formatRatio(12.6)).toBe('13:1');
    expect(formatRatio(1)).toBe('1:1');
  });
});

describe('preview data built from the dashboard bootstrap', () => {
  it('maps an event type to what the booking page receives', () => {
    const data = bootstrap();
    const both = toPublicEventType(data.eventTypes.find((e) => e.id === 'evt_both')!, data.hosts);
    expect(both.hosts.map((h) => h.name)).toEqual(['Jimi Cohen', 'Alex Rivera']);
    expect(both.hosts[0].avatarUrl).toBe('/meeting/api/assets/asset_me');
    expect(both.kind).toBe('collective');
    expect(both.color).toBe('#3355ff');
    expect(both.locations).toEqual([
      { type: 'phone_host_calls', label: 'Phone call', detail: 'Jimi calls you' },
      { type: 'in_person', label: 'In person', detail: '12 Leaf Lane' },
      { type: 'custom_link', label: 'Zoom', detail: 'https://zoom.example/room' },
    ]);
    expect(both.minNoticeMinutes).toBe(240);
  });

  it('never leaks host details that are not public', () => {
    const data = bootstrap();
    const et = toPublicEventType(data.eventTypes[0], data.hosts);
    expect(Object.keys(et.hosts[0]).sort()).toEqual(['avatarUrl', 'id', 'name', 'title']);
  });

  it('lists active events, public ones first, and skips switched-off ones', () => {
    const data = bootstrap();
    const list = previewEventTypes(data, data.hosts[0]);
    expect(list.map((e) => e.slug)).toEqual(['intro', 'meeting', 'both']);
  });

  it('falls back to a sample event so the preview is never empty', () => {
    const data = { ...bootstrap(), eventTypes: [] };
    const list = previewEventTypes(data, data.hosts[0]);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(sampleEventType(data.hosts[0]).id);
  });

  it('builds the site with the draft theme and live feature flags', () => {
    const data = bootstrap();
    const owner = data.hosts[0];
    const draft = { ...DEFAULT_THEME, radius: 4 };
    const assets = { coverUrl: 'data:image/png;base64,AAAA', logoUrl: null, backgroundUrl: null };
    const events = previewEventTypes(data, owner);
    const site = toPreviewSite(data, owner, draft, assets, events);
    expect(site.theme.radius).toBe(4);
    expect(site.themeAssets).toBe(assets);
    expect(site.profile.avatarUrl).toBe(owner.avatarUrl);
    expect(site.features).toEqual({ sms: true, calls: true });
    expect(site.ownerTimezone).toBe('Africa/Nairobi');
    expect(site.assistantName).toBe(data.site.assistant.name);
    expect(site.eventTypes.map((e) => e.slug)).toEqual(['intro', 'meeting', 'both']);
  });
});
