/**
 * Phone number helpers. libphonenumber-js (min metadata) is loaded on demand: it never
 * ships in the first paint, only when the details form opens.
 */
type PhoneLib = typeof import('libphonenumber-js/min');

let libPromise: Promise<PhoneLib> | null = null;
let libNow: PhoneLib | null = null;

export function loadPhoneLib(): Promise<PhoneLib> {
  if (!libPromise) {
    libPromise = import('libphonenumber-js/min').then(
      (lib) => {
        libNow = lib;
        return lib;
      },
      (e) => {
        libPromise = null;
        throw e;
      },
    );
  }
  return libPromise;
}

/** The library when it has already arrived, without waiting. */
export function phoneLibIfLoaded(): PhoneLib | null {
  return libNow;
}

// Zone → ISO country, for the zones most visitors come from. Everything else falls back to the locale.
const ZONE_COUNTRY_SOURCE =
  'Africa/Nairobi:KE,Africa/Kampala:UG,Africa/Dar_es_Salaam:TZ,Africa/Addis_Ababa:ET,Africa/Kigali:RW,Africa/Bujumbura:BI,Africa/Mogadishu:SO,' +
  'Africa/Juba:SS,Africa/Khartoum:SD,Africa/Lagos:NG,Africa/Accra:GH,Africa/Abidjan:CI,Africa/Dakar:SN,Africa/Douala:CM,Africa/Kinshasa:CD,' +
  'Africa/Lubumbashi:CD,Africa/Luanda:AO,Africa/Johannesburg:ZA,Africa/Harare:ZW,Africa/Lusaka:ZM,Africa/Maputo:MZ,Africa/Gaborone:BW,' +
  'Africa/Windhoek:NA,Africa/Blantyre:MW,Africa/Cairo:EG,Africa/Casablanca:MA,Africa/Tunis:TN,Africa/Algiers:DZ,Africa/Tripoli:LY,' +
  'America/New_York:US,America/Chicago:US,America/Denver:US,America/Phoenix:US,America/Los_Angeles:US,America/Anchorage:US,America/Detroit:US,' +
  'America/Boise:US,Pacific/Honolulu:US,America/Toronto:CA,America/Vancouver:CA,America/Edmonton:CA,America/Winnipeg:CA,America/Halifax:CA,' +
  'America/Regina:CA,America/St_Johns:CA,America/Mexico_City:MX,America/Monterrey:MX,America/Tijuana:MX,America/Cancun:MX,America/Bogota:CO,' +
  'America/Lima:PE,America/Santiago:CL,America/Caracas:VE,America/Guayaquil:EC,America/La_Paz:BO,America/Asuncion:PY,America/Montevideo:UY,' +
  'America/Sao_Paulo:BR,America/Bahia:BR,America/Fortaleza:BR,America/Manaus:BR,America/Recife:BR,America/Buenos_Aires:AR,' +
  'America/Argentina/Buenos_Aires:AR,America/Argentina/Cordoba:AR,America/Panama:PA,America/Costa_Rica:CR,America/Guatemala:GT,' +
  'America/Havana:CU,America/Santo_Domingo:DO,America/Puerto_Rico:PR,America/Jamaica:JM,' +
  'Europe/London:GB,Europe/Dublin:IE,Europe/Lisbon:PT,Europe/Madrid:ES,Europe/Paris:FR,Europe/Brussels:BE,Europe/Amsterdam:NL,' +
  'Europe/Luxembourg:LU,Europe/Berlin:DE,Europe/Zurich:CH,Europe/Rome:IT,Europe/Vienna:AT,Europe/Stockholm:SE,Europe/Oslo:NO,' +
  'Europe/Copenhagen:DK,Europe/Helsinki:FI,Europe/Warsaw:PL,Europe/Prague:CZ,Europe/Bratislava:SK,Europe/Budapest:HU,Europe/Bucharest:RO,' +
  'Europe/Sofia:BG,Europe/Athens:GR,Europe/Istanbul:TR,Europe/Kiev:UA,Europe/Kyiv:UA,Europe/Moscow:RU,Europe/Belgrade:RS,Europe/Zagreb:HR,' +
  'Europe/Ljubljana:SI,Europe/Vilnius:LT,Europe/Riga:LV,Europe/Tallinn:EE,Europe/Malta:MT,Atlantic/Reykjavik:IS,' +
  'Asia/Jerusalem:IL,Asia/Tel_Aviv:IL,Asia/Dubai:AE,Asia/Riyadh:SA,Asia/Qatar:QA,Asia/Kuwait:KW,Asia/Bahrain:BH,Asia/Muscat:OM,Asia/Amman:JO,' +
  'Asia/Beirut:LB,Asia/Baghdad:IQ,Asia/Tehran:IR,Asia/Karachi:PK,Asia/Calcutta:IN,Asia/Kolkata:IN,Asia/Colombo:LK,Asia/Dhaka:BD,' +
  'Asia/Kathmandu:NP,Asia/Katmandu:NP,Asia/Bangkok:TH,Asia/Jakarta:ID,Asia/Makassar:ID,Asia/Singapore:SG,Asia/Kuala_Lumpur:MY,Asia/Manila:PH,' +
  'Asia/Ho_Chi_Minh:VN,Asia/Saigon:VN,Asia/Hong_Kong:HK,Asia/Shanghai:CN,Asia/Taipei:TW,Asia/Seoul:KR,Asia/Tokyo:JP,Asia/Almaty:KZ,' +
  'Asia/Tashkent:UZ,Asia/Tbilisi:GE,Asia/Yerevan:AM,Asia/Baku:AZ,Asia/Yangon:MM,Asia/Phnom_Penh:KH,' +
  'Australia/Sydney:AU,Australia/Melbourne:AU,Australia/Brisbane:AU,Australia/Perth:AU,Australia/Adelaide:AU,Australia/Hobart:AU,' +
  'Australia/Darwin:AU,Pacific/Auckland:NZ,Pacific/Fiji:FJ';

let zoneCountry: Map<string, string> | null = null;

function zoneCountryMap(): Map<string, string> {
  if (!zoneCountry) {
    zoneCountry = new Map(ZONE_COUNTRY_SOURCE.split(',').map((pair) => pair.split(':') as [string, string]));
  }
  return zoneCountry;
}

/** Best guess at the visitor's country (ISO 3166 alpha-2): their zone first, then their locale. */
export function guessCountry(zone: string, locale: string): string {
  const byZone = zoneCountryMap().get(zone);
  if (byZone) return byZone;
  try {
    const region = new Intl.Locale(locale).maximize().region;
    if (region && /^[A-Z]{2}$/.test(region)) return region;
  } catch {
    // ignore
  }
  return 'US';
}

export interface CountryOption {
  code: string;
  name: string;
  callingCode: string;
}

let countryCache: { locale: string; list: CountryOption[] } | null = null;

/** Every country the library knows, with a localised name, sorted by name. */
export function listCountries(lib: PhoneLib, locale: string): CountryOption[] {
  if (countryCache && countryCache.locale === locale) return countryCache.list;
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale, 'en'], { type: 'region' });
  } catch {
    names = null;
  }
  const list = lib
    .getCountries()
    .map((code) => {
      let name: string = code;
      try {
        name = names?.of(code) ?? code;
      } catch {
        name = code;
      }
      return { code: code as string, name, callingCode: String(lib.getCountryCallingCode(code)) };
    })
    .filter((c) => c.name !== c.code || c.code.length === 2)
    .sort((a, b) => a.name.localeCompare(b.name, locale));
  countryCache = { locale, list };
  return list;
}

export interface PhoneCheck {
  ok: boolean;
  /** E.164, e.g. +254712345678 */
  e164?: string;
  country?: string;
}

const LOOSE_PHONE = /^\+?[\d\s().-]{7,22}$/;

function looseCheck(raw: string): PhoneCheck {
  const text = raw.trim();
  if (!LOOSE_PHONE.test(text)) return { ok: false };
  const digits = text.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return { ok: false };
  // Without the library we can only pass the digits on: the server normalises them again.
  return { ok: true, e164: text.startsWith('+') ? `+${digits}` : digits };
}

/** Validates and normalises a number synchronously, using the library when it has loaded. */
export function checkPhoneNow(raw: string, country: string): PhoneCheck {
  const text = raw.trim();
  if (!text) return { ok: false };
  const lib = libNow;
  if (!lib) return looseCheck(text);
  try {
    const parsed = lib.parsePhoneNumberFromString(text, lib.isSupportedCountry(country) ? country : undefined);
    if (parsed && parsed.isValid()) return { ok: true, e164: parsed.number, country: parsed.country };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Same as checkPhoneNow, but waits for the library first (falls back to a loose check offline). */
export async function checkPhone(raw: string, country: string): Promise<PhoneCheck> {
  try {
    await loadPhoneLib();
  } catch {
    return looseCheck(raw);
  }
  return checkPhoneNow(raw, country);
}

/** Formats what has been typed so far, e.g. "0712 345678". Returns the input when the library is missing. */
export function formatAsYouType(raw: string, country: string): { text: string; country?: string } {
  const lib = libNow;
  if (!lib) return { text: raw };
  try {
    const typer = new lib.AsYouType(lib.isSupportedCountry(country) ? country : undefined);
    const text = typer.input(raw);
    return { text: text || raw, country: typer.getCountry() };
  } catch {
    return { text: raw };
  }
}
