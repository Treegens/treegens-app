import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSISTANT } from '../../shared/defaults';
import { insideCallHours } from '../../server/lib/jobs';
import { withinCallWindow } from '../../server/lib/voice';

// jobs.ts plans reminder calls inside calling hours, and voice.ts checks them again when the call is
// placed. The two must agree on every hour, or a planned call would be refused at the last moment.
describe('calling hours: planning and placing agree', () => {
  it('gives the same answer for every hour, window and zone', () => {
    const zones = ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Africa/Nairobi', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Nowhere/None'];
    const windows = [
      [8, 21],
      [21, 6],
      [0, 24],
      [9, 9],
      [12, 13],
      [23, 0],
      [-3, 30],
      [Number.NaN, 20],
    ];
    const from = Date.parse('2027-03-12T00:00:00Z'); // across the March change in the US and the April one in Australia
    for (const tz of zones) {
      for (const [start, end] of windows) {
        const hours = { ...DEFAULT_ASSISTANT, callWindowStartHour: start, callWindowEndHour: end };
        for (let step = 0; step < 24 * 4 * 4; step++) {
          const ms = from + step * 15 * 60_000;
          expect(insideCallHours(ms, tz, hours), `${tz} ${start}-${end} ${new Date(ms).toISOString()}`).toBe(withinCallWindow(ms, tz, hours));
        }
      }
    }
  });
});
