/**
 * PUT /admin/site: a partial SiteSettings is validated field by field and laid over the stored
 * settings. Keys we do not know are ignored, `ownerHostId` and `updatedAt` cannot be set, and
 * every problem is reported under the dotted path of its field ("profile.name",
 * "theme.colors.primary", "assistant.callWindowStartHour").
 */
import type { SiteSettings } from '../../../shared/types';
import type { Ctx } from '../ctx';
import { FieldErrors, isEmail, isHttpsUrl, isPlainObject, requireObject } from '../validate';
import { type AssetRef, given, isWebUrl, readAssetId, readBool, readEnum, readInt, readObject, readText, verifyAssets } from './fields';
import { mergeTheme, parseThemePatch, themeAssetIds } from './theme';

export const MAX_PROFILE_LINKS = 6;
/** Claude model ids: letters, digits and a few separators. Nothing that could be mistaken for a URL or a path. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,80}$/;
const VOICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

function readLinks(value: unknown, errors: FieldErrors): SiteSettings['profile']['links'] | undefined {
  if (!Array.isArray(value)) {
    errors.add('profile.links', 'Expected a list of links.');
    return undefined;
  }
  if (value.length > MAX_PROFILE_LINKS) {
    errors.add('profile.links', `You can show up to ${MAX_PROFILE_LINKS} links.`);
    return undefined;
  }
  const out: SiteSettings['profile']['links'] = [];
  value.forEach((item, i) => {
    if (!isPlainObject(item)) {
      errors.add(`profile.links.${i}`, 'This link is not readable.');
      return;
    }
    const label = readText(item, 'label', `profile.links.${i}.label`, 40, errors);
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const urlOk = isWebUrl(url, 300);
    // The first message recorded for a field wins, so a "too long" message from readText is kept.
    if (!label) errors.add(`profile.links.${i}.label`, 'Give every link a label.');
    if (!urlOk) errors.add(`profile.links.${i}.url`, `The link "${label || `number ${i + 1}`}" needs a full address that starts with https://`);
    if (label && urlOk) out.push({ label, url });
  });
  return out;
}

/** An address field that may be left empty. */
function readOptionalEmail(bag: Record<string, unknown>, key: string, path: string, message: string, errors: FieldErrors): string | undefined {
  if (!given(bag, key)) return undefined;
  const raw = bag[key];
  if (typeof raw !== 'string') {
    errors.add(path, message);
    return undefined;
  }
  const value = raw.trim();
  if (value === '' || isEmail(value)) return value;
  errors.add(path, message);
  return undefined;
}

/**
 * Returns the settings as they should be stored (not saved yet). Throws HttpError(422) listing
 * every invalid field.
 */
export async function applySitePatch(ctx: Ctx, current: SiteSettings, body: unknown): Promise<SiteSettings> {
  const patch = requireObject(body);
  const errors = new FieldErrors();
  const refs: AssetRef[] = [];
  const next: SiteSettings = structuredClone(current);

  if (given(patch, 'profile')) {
    const p = readObject(patch.profile, 'profile', errors);
    if (p) {
      const name = readText(p, 'name', 'profile.name', 80, errors, { required: 'Your name cannot be empty.' });
      if (name !== undefined) next.profile.name = name;
      const headline = readText(p, 'headline', 'profile.headline', 120, errors);
      if (headline !== undefined) next.profile.headline = headline;
      const welcome = readText(p, 'welcome', 'profile.welcome', 600, errors, { multiline: true });
      if (welcome !== undefined) next.profile.welcome = welcome;
      const avatar = readAssetId(p, 'avatarAssetId', 'profile.avatarAssetId', current.profile.avatarAssetId, refs, errors);
      if (avatar !== undefined) next.profile.avatarAssetId = avatar;
      if (given(p, 'links')) {
        const links = readLinks(p.links, errors);
        if (links) next.profile.links = links;
      }
    }
  }

  if (given(patch, 'assistant')) {
    const a = readObject(patch.assistant, 'assistant', errors);
    if (a) {
      const name = readText(a, 'name', 'assistant.name', 40, errors, { required: 'Your assistant needs a name.' });
      if (name !== undefined) next.assistant.name = name;
      const voice = readText(a, 'voice', 'assistant.voice', 80, errors, { required: 'Choose a voice for your assistant.' });
      if (voice !== undefined) {
        if (VOICE_PATTERN.test(voice)) next.assistant.voice = voice;
        else errors.add('assistant.voice', 'That does not look like a voice name. Use one like Polly.Joanna-Neural.');
      }
      const language = readText(a, 'language', 'assistant.language', 20, errors, { required: 'Choose a language.' });
      if (language !== undefined) {
        if (LANGUAGE_PATTERN.test(language)) next.assistant.language = language;
        else errors.add('assistant.language', 'Use a language code like en-US.');
      }
      const persona = readText(a, 'persona', 'assistant.persona', 500, errors, { multiline: true });
      if (persona !== undefined) next.assistant.persona = persona;
      const model = readText(a, 'model', 'assistant.model', 81, errors, { required: 'Choose a model.' });
      if (model !== undefined) {
        if (MODEL_ID_PATTERN.test(model)) next.assistant.model = model;
        else errors.add('assistant.model', 'That does not look like a model ID.');
      }
      const start = readInt(a, 'callWindowStartHour', 'assistant.callWindowStartHour', 0, 23, errors, 'Choose an hour from 0 to 23.');
      if (start !== undefined) next.assistant.callWindowStartHour = start;
      const end = readInt(a, 'callWindowEndHour', 'assistant.callWindowEndHour', 1, 24, errors, 'Choose an hour from 1 to 24.');
      if (end !== undefined) next.assistant.callWindowEndHour = end;
      if ((start !== undefined || end !== undefined) && next.assistant.callWindowStartHour >= next.assistant.callWindowEndHour) {
        errors.add(end !== undefined ? 'assistant.callWindowEndHour' : 'assistant.callWindowStartHour', 'Calls must start before they end.');
      }
    }
  }

  if (given(patch, 'booking')) {
    const b = readObject(patch.booking, 'booking', errors);
    if (b) {
      const optIn = readBool(b, 'reminderOptInDefault', 'booking.reminderOptInDefault', errors);
      if (optIn !== undefined) next.booking.reminderOptInDefault = optIn;
      const consent = readText(b, 'consentText', 'booking.consentText', 600, errors, { multiline: true, required: 'The consent wording cannot be empty.' });
      if (consent !== undefined) next.booking.consentText = consent;
      if (given(b, 'privacyUrl')) {
        const raw = typeof b.privacyUrl === 'string' ? b.privacyUrl.trim() : null;
        if (raw === '') next.booking.privacyUrl = '';
        else if (raw !== null && raw.length <= 300 && isHttpsUrl(raw)) next.booking.privacyUrl = raw;
        else errors.add('booking.privacyUrl', 'The privacy link must start with https://');
      }
    }
  }

  if (given(patch, 'email')) {
    const e = readObject(patch.email, 'email', errors);
    if (e) {
      const provider = readEnum(e, 'provider', 'email.provider', ['auto', 'resend', 'gmail', 'none'] as const, errors);
      if (provider !== undefined) next.email.provider = provider;
      const fromName = readText(e, 'fromName', 'email.fromName', 80, errors);
      if (fromName !== undefined) next.email.fromName = fromName;
      const fromEmail = readOptionalEmail(e, 'fromEmail', 'email.fromEmail', 'The from address is not a full email address.', errors);
      if (fromEmail !== undefined) next.email.fromEmail = fromEmail;
      const replyTo = readOptionalEmail(e, 'replyTo', 'email.replyTo', 'The reply-to address is not a full email address.', errors);
      if (replyTo !== undefined) next.email.replyTo = replyTo;
    }
  }

  if (given(patch, 'theme')) {
    const themePatch = parseThemePatch(patch.theme, 'theme', themeAssetIds(current.theme), refs, errors);
    if (themePatch) next.theme = mergeTheme(current.theme, themePatch);
  }

  await verifyAssets(ctx, refs, errors);
  errors.throwIfAny();
  // Never taken from the request.
  next.ownerHostId = current.ownerHostId;
  next.updatedAt = current.updatedAt;
  return next;
}
