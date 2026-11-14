import { describe, expect, it } from 'vitest';
import { HttpError } from '../../server/lib/http';
import {
  clampInt,
  cleanLine,
  cleanText,
  FieldErrors,
  invalid,
  isEmail,
  isHHMM,
  isHexColor,
  isHttpsUrl,
  isIsoInstant,
  isLocalDate,
  isOneOf,
  isPlainObject,
  isSlug,
  isZone,
  requireObject,
} from '../../server/lib/validate';

// Built from code points so this file stays plain ASCII.
const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const C1 = String.fromCharCode(0x85);
const RLO = String.fromCharCode(0x202e); // right-to-left override
const LSEP = String.fromCharCode(0x2028);
const PSEP = String.fromCharCode(0x2029);
const BOM = String.fromCharCode(0xfeff);
const ZWJ = String.fromCharCode(0x200d);

describe('isEmail', () => {
  it('accepts ordinary addresses', () => {
    for (const ok of ['ada@example.com', 'first.last+tag@sub.example.co.uk', "o'brien@example.ie", 'a_b-c@ex-ample.io', 'x@y.zw', 'user@xn--bcher-kva.example']) {
      expect(isEmail(ok)).toBe(true);
    }
  });

  it('rejects malformed or dangerous input', () => {
    const tooLong = `${'a'.repeat(65)}@example.com`;
    for (const bad of [
      '',
      'plain',
      '@example.com',
      'ada@',
      'ada@localhost',
      'ada@@example.com',
      'ada@example..com',
      '.ada@example.com',
      'ada.@example.com',
      'a..b@example.com',
      'ada @example.com',
      'ada@exa mple.com',
      'ada@-example.com',
      'ada@example.c',
      'ada@example.123',
      'ada@example.com\r\nBcc: victim@example.com',
      'Ada <ada@example.com>',
      'ada@example.com,eve@example.com',
      tooLong,
      `ada@${'a'.repeat(250)}.com`,
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isEmail(bad)).toBe(false);
    }
  });
});

describe('isSlug', () => {
  it('accepts lower case words joined by single hyphens', () => {
    for (const ok of ['intro', 'intro-call', 'a', '30-min', 'x1-y2-z3', 'a'.repeat(64)]) expect(isSlug(ok)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const bad of ['', 'Intro', 'intro call', '-intro', 'intro-', 'in--tro', 'intro_call', 'intro/call', 'intro.js', 'café', 'a'.repeat(65), null, 5]) {
      expect(isSlug(bad)).toBe(false);
    }
  });
});

describe('cleanText', () => {
  it('trims and returns an empty string for non-strings', () => {
    expect(cleanText('  hello  ', 100)).toBe('hello');
    for (const v of [null, undefined, 42, {}, [], true]) expect(cleanText(v, 100)).toBe('');
  });

  it('strips control characters but keeps line breaks and tabs', () => {
    expect(cleanText(`a${NUL}b${BELL}c${ESC}[31md${DEL}e${C1}f`, 100)).toBe('abc[31mdef');
    expect(cleanText('line one\r\nline two\rline three\n\tindented', 100)).toBe('line one\nline two\nline three\n\tindented');
    expect(cleanText(`a${LSEP}b${PSEP}c`, 100)).toBe('a\nb\nc');
  });

  it('removes direction overrides and byte order marks, keeps emoji joiners', () => {
    expect(cleanText(`${BOM}invoice${RLO}fdp.exe`, 100)).toBe('invoicefdp.exe');
    const family = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`;
    expect(cleanText(family, 100)).toBe(family);
  });

  it('cuts to max characters without splitting a surrogate pair', () => {
    expect(cleanText('abcdef', 3)).toBe('abc');
    expect(cleanText('ab \u{1F331}\u{1F331}\u{1F331}', 4)).toBe('ab \u{1F331}');
    expect(cleanText('abc   def', 5)).toBe('abc');
    expect(cleanText('anything', 0)).toBe('');
  });

  it('normalises to NFC so equal-looking text compares equal', () => {
    expect(cleanText('Café', 100)).toBe('Café');
  });
});

describe('cleanLine', () => {
  it('collapses all whitespace, including line breaks, to single spaces', () => {
    expect(cleanLine('  Ada \r\n Lovelace\t\tPhD ', 100)).toBe('Ada Lovelace PhD');
    expect(cleanLine('Subject\r\nBcc: victim@example.com', 100)).toBe('Subject Bcc: victim@example.com');
    expect(cleanLine('one two three', 7)).toBe('one two');
    expect(cleanLine(null, 10)).toBe('');
  });
});

describe('isHexColor', () => {
  it('accepts #rgb and #rrggbb only', () => {
    for (const ok of ['#fff', '#5ede8e', '#0B1D14', '#ABC']) expect(isHexColor(ok)).toBe(true);
    for (const bad of ['', 'fff', '#ffff', '#fffff', '#gggggg', '#5ede8e80', 'red', 'rgb(0,0,0)', '#fff;background:url(x)', null, 0xffffff]) {
      expect(isHexColor(bad)).toBe(false);
    }
  });
});

describe('isZone', () => {
  it('accepts named IANA zones', () => {
    for (const ok of ['UTC', 'Africa/Nairobi', 'America/New_York', 'America/Argentina/Buenos_Aires', 'Asia/Kolkata', 'Asia/Kathmandu', 'Europe/London', 'Etc/GMT+5']) {
      expect(isZone(ok)).toBe(true);
    }
  });

  it('rejects offsets, invented names and non-strings', () => {
    for (const bad of ['', 'Mars/Olympus_Mons', '+03:00', 'UTC+3', '03:00', 'Africa/', '/Nairobi', 'Africa/Nairobi ', 'Africa\\Nairobi', 'x'.repeat(100), null, undefined, 3]) {
      expect(isZone(bad)).toBe(false);
    }
  });
});

describe('isHttpsUrl', () => {
  it('accepts absolute https URLs', () => {
    for (const ok of ['https://example.com', 'https://example.com/thanks?ref=meeting#top', 'https://zoom.us/j/123456789', 'https://xn--bcher-kva.example/pfad']) {
      expect(isHttpsUrl(ok)).toBe(true);
    }
  });

  it('rejects other schemes, credentials, relative and malformed values', () => {
    for (const bad of [
      '',
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//example.com/x',
      '/meeting/admin',
      'example.com',
      'https://',
      'https://user:pass@example.com',
      'https://user@example.com',
      'https://example.com/a b',
      'https://example.com/\nSet-Cookie: x=1',
      ` https://example.com`,
      `https://${'a'.repeat(3000)}.com`,
      null,
      {},
    ]) {
      expect(isHttpsUrl(bad)).toBe(false);
    }
  });
});

describe('clampInt', () => {
  it('rounds and clamps numbers and numeric strings', () => {
    expect(clampInt(30, 5, 480, 30)).toBe(30);
    expect(clampInt(3, 5, 480, 30)).toBe(5);
    expect(clampInt(9999, 5, 480, 30)).toBe(480);
    expect(clampInt(29.6, 5, 480, 30)).toBe(30);
    expect(clampInt('45', 5, 480, 30)).toBe(45);
    expect(clampInt(' 15 ', 5, 480, 30)).toBe(15);
    expect(clampInt(-0, 0, 10, 5)).toBe(0);
  });

  it('falls back to the default for anything that is not a finite number', () => {
    for (const v of [undefined, null, '', '   ', 'abc', '12abc', Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) {
      expect(clampInt(v, 5, 480, 30)).toBe(30);
    }
  });
});

describe('small predicates', () => {
  it('isLocalDate accepts only real calendar days', () => {
    for (const ok of ['2026-11-17', '2028-02-29', '2026-12-31']) expect(isLocalDate(ok)).toBe(true);
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-1-7', '17-11-2026', '2026-11-17T00:00', '', null]) {
      expect(isLocalDate(bad)).toBe(false);
    }
  });

  it('isHHMM accepts 00:00 to 23:59, and 24:00 only when asked', () => {
    for (const ok of ['00:00', '09:30', '23:59']) expect(isHHMM(ok)).toBe(true);
    for (const bad of ['24:00', '9:30', '09:60', '25:00', '0930', '09:30:00', '', null]) expect(isHHMM(bad)).toBe(false);
    expect(isHHMM('24:00', true)).toBe(true);
    expect(isHHMM('24:01', true)).toBe(false);
  });

  it('isIsoInstant needs a full instant with an offset', () => {
    for (const ok of ['2026-11-17T12:00:00.000Z', '2026-11-17T12:00:00Z', '2026-11-17T15:00:00+03:00', '2026-11-17T12:00Z']) expect(isIsoInstant(ok)).toBe(true);
    for (const bad of ['2026-11-17', '2026-11-17T12:00:00', '2026-11-17 12:00:00Z', '2026-13-40T12:00:00Z', 'yesterday', '', null, 1763380800000]) {
      expect(isIsoInstant(bad)).toBe(false);
    }
  });

  it('isOneOf and isPlainObject', () => {
    const kinds = ['solo', 'collective', 'round_robin'] as const;
    expect(isOneOf('collective', kinds)).toBe(true);
    expect(isOneOf('group', kinds)).toBe(false);
    expect(isOneOf(1, kinds)).toBe(false);
    expect(isPlainObject({})).toBe(true);
    for (const bad of [null, [], 'x', 1, undefined]) expect(isPlainObject(bad)).toBe(false);
  });
});

describe('throwing helpers', () => {
  it('invalid() throws the standard 422', () => {
    try {
      invalid({ email: 'Enter a valid email address.' });
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status: 422, code: 'invalid', fields: { email: 'Enter a valid email address.' } });
    }
  });

  it('FieldErrors collects every problem and throws once', () => {
    const errors = new FieldErrors();
    expect(errors.has()).toBe(false);
    errors.throwIfAny();

    expect(errors.check(isEmail('nope'), 'email', 'Enter a valid email address.')).toBe(false);
    expect(errors.check(isSlug('fine'), 'slug', 'Use lower case letters, digits and hyphens.')).toBe(true);
    errors.add('name', 'Enter your name.').add('name', 'A second message for the same field is ignored.');
    expect(errors.has('email')).toBe(true);
    expect(errors.has('slug')).toBe(false);
    expect(errors.toJSON()).toEqual({ email: 'Enter a valid email address.', name: 'Enter your name.' });

    expect(() => errors.throwIfAny('Could not save.')).toThrowError(HttpError);
    try {
      errors.throwIfAny('Could not save.');
    } catch (err) {
      expect(err).toMatchObject({ status: 422, code: 'invalid', message: 'Could not save.', fields: { email: expect.any(String), name: expect.any(String) } });
    }
  });

  it('requireObject returns objects and rejects the rest', () => {
    expect(requireObject({ a: 1 })).toEqual({ a: 1 });
    for (const bad of [null, [], 'x', 3]) expect(() => requireObject(bad)).toThrowError(HttpError);
  });
});
