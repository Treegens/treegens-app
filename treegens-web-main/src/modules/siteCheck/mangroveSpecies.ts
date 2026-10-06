/**
 * Mangrove species the Site Check can recommend, grouped by the tidal zone
 * they usually occupy and the region they are native to.
 *
 * MIRRORED FILE: an identical copy lives at
 * treegens-web-main/src/modules/siteCheck/mangroveSpecies.ts so the app can
 * show a verdict offline. Edit both together (siteVerdict.test.ts checks).
 *
 * Sources: the CBEMR workshop pack (Jean Yong's comparative ID chart, and
 * Ellison et al. 2012, "Manual for Mangrove Monitoring in the Pacific Islands
 * Region", Fig. 1 and Tables 1-2). Zones are typical, not absolute: local
 * zonation varies and should be confirmed by a mangrove specialist before
 * the list is used to gate anything. Local names need confirmation too.
 */

/** Position in the intertidal band, from the low (seaward) edge upward. */
export type PlantingZone = 'seaward' | 'middle' | 'landward'

export type MangroveRegion =
  | 'east_africa'
  | 'indo_west_pacific'
  | 'pacific_islands'
  | 'atlantic_east_pacific'

export interface MangroveSpecies {
  id: string
  scientificName: string
  /** Common or local names, keyed by language code. */
  localNames?: Record<string, string>
  zones: PlantingZone[]
  regions: MangroveRegion[]
  note?: string
}

export const MANGROVE_SPECIES: MangroveSpecies[] = [
  {
    id: 'sonneratia_alba',
    scientificName: 'Sonneratia alba',
    localNames: { sw: 'Mlilana' },
    zones: ['seaward'],
    regions: ['east_africa', 'indo_west_pacific', 'pacific_islands'],
    note: 'Pioneer on the open seaward fringe.',
  },
  {
    id: 'avicennia_marina',
    scientificName: 'Avicennia marina',
    localNames: { sw: 'Mchu' },
    zones: ['seaward', 'landward'],
    regions: ['east_africa', 'indo_west_pacific', 'pacific_islands'],
    note: 'Grows at the seaward edge and, stunted, on the landward salt flats.',
  },
  {
    id: 'avicennia_alba',
    scientificName: 'Avicennia alba',
    zones: ['seaward'],
    regions: ['indo_west_pacific'],
  },
  {
    id: 'avicennia_officinalis',
    scientificName: 'Avicennia officinalis',
    zones: ['seaward', 'middle'],
    regions: ['indo_west_pacific'],
  },
  {
    id: 'sonneratia_caseolaris',
    scientificName: 'Sonneratia caseolaris',
    zones: ['seaward'],
    regions: ['indo_west_pacific'],
    note: 'Prefers lower salinity, along river mouths.',
  },
  {
    id: 'rhizophora_mucronata',
    scientificName: 'Rhizophora mucronata',
    localNames: { sw: 'Mkoko' },
    zones: ['seaward', 'middle'],
    regions: ['east_africa', 'indo_west_pacific'],
  },
  {
    id: 'rhizophora_apiculata',
    scientificName: 'Rhizophora apiculata',
    zones: ['middle'],
    regions: ['indo_west_pacific'],
  },
  {
    id: 'rhizophora_stylosa',
    scientificName: 'Rhizophora stylosa',
    zones: ['seaward', 'middle'],
    regions: ['indo_west_pacific', 'pacific_islands'],
  },
  {
    id: 'rhizophora_samoensis',
    scientificName: 'Rhizophora samoensis',
    zones: ['seaward', 'middle'],
    regions: ['pacific_islands'],
  },
  {
    id: 'ceriops_tagal',
    scientificName: 'Ceriops tagal',
    localNames: { sw: 'Mkandaa' },
    zones: ['middle', 'landward'],
    regions: ['east_africa', 'indo_west_pacific'],
  },
  {
    id: 'bruguiera_gymnorhiza',
    scientificName: 'Bruguiera gymnorhiza',
    localNames: { sw: 'Mshinzi' },
    zones: ['middle', 'landward'],
    regions: ['east_africa', 'indo_west_pacific', 'pacific_islands'],
  },
  {
    id: 'bruguiera_parviflora',
    scientificName: 'Bruguiera parviflora',
    zones: ['middle'],
    regions: ['indo_west_pacific'],
  },
  {
    id: 'bruguiera_cylindrica',
    scientificName: 'Bruguiera cylindrica',
    zones: ['middle'],
    regions: ['indo_west_pacific'],
  },
  {
    id: 'kandelia_candel',
    scientificName: 'Kandelia candel',
    zones: ['middle'],
    regions: ['indo_west_pacific'],
  },
  {
    id: 'aegiceras_corniculatum',
    scientificName: 'Aegiceras corniculatum',
    zones: ['middle'],
    regions: ['indo_west_pacific'],
  },
  {
    id: 'xylocarpus_granatum',
    scientificName: 'Xylocarpus granatum',
    localNames: { sw: 'Mkomafi' },
    zones: ['landward'],
    regions: ['east_africa', 'indo_west_pacific', 'pacific_islands'],
  },
  {
    id: 'lumnitzera_racemosa',
    scientificName: 'Lumnitzera racemosa',
    zones: ['landward'],
    regions: ['east_africa', 'indo_west_pacific'],
  },
  {
    id: 'lumnitzera_littorea',
    scientificName: 'Lumnitzera littorea',
    zones: ['landward'],
    regions: ['indo_west_pacific', 'pacific_islands'],
  },
  {
    id: 'heritiera_littoralis',
    scientificName: 'Heritiera littoralis',
    zones: ['landward'],
    regions: ['east_africa', 'indo_west_pacific'],
    note: 'Back mangrove, needs some freshwater.',
  },
  {
    id: 'excoecaria_agallocha',
    scientificName: 'Excoecaria agallocha',
    zones: ['landward'],
    regions: ['indo_west_pacific', 'pacific_islands'],
  },
  {
    id: 'nypa_fruticans',
    scientificName: 'Nypa fruticans',
    zones: ['landward'],
    regions: ['indo_west_pacific'],
    note: 'Palm of brackish river banks.',
  },
  {
    id: 'rhizophora_mangle',
    scientificName: 'Rhizophora mangle',
    zones: ['seaward', 'middle'],
    regions: ['atlantic_east_pacific'],
  },
  {
    id: 'avicennia_germinans',
    scientificName: 'Avicennia germinans',
    zones: ['middle', 'landward'],
    regions: ['atlantic_east_pacific'],
  },
  {
    id: 'laguncularia_racemosa',
    scientificName: 'Laguncularia racemosa',
    zones: ['landward'],
    regions: ['atlantic_east_pacific'],
  },
]

const REGION_BY_COUNTRY: Record<string, MangroveRegion> = {}
const COUNTRIES: Record<MangroveRegion, string[]> = {
  east_africa: ['KE', 'TZ', 'MZ', 'MG', 'SO', 'ZA', 'SC', 'KM', 'MU', 'YT'],
  indo_west_pacific: [
    'ID',
    'MY',
    'PH',
    'TH',
    'VN',
    'MM',
    'KH',
    'SG',
    'BN',
    'TL',
    'IN',
    'BD',
    'LK',
    'PK',
    'CN',
    'TW',
    'JP',
    'AU',
    'PG',
  ],
  pacific_islands: [
    'FJ',
    'TO',
    'WS',
    'AS',
    'VU',
    'NC',
    'SB',
    'FM',
    'PW',
    'GU',
    'MP',
    'MH',
    'KI',
    'TV',
    'NR',
    'WF',
  ],
  atlantic_east_pacific: [
    'US',
    'MX',
    'BZ',
    'GT',
    'HN',
    'NI',
    'CR',
    'PA',
    'CO',
    'VE',
    'EC',
    'PE',
    'BR',
    'GY',
    'SR',
    'CU',
    'BS',
    'JM',
    'HT',
    'DO',
    'PR',
    'NG',
    'GH',
    'SN',
    'GM',
    'GN',
    'GW',
    'SL',
    'LR',
    'CI',
    'CM',
    'GA',
    'CG',
    'CD',
    'AO',
    'BJ',
    'TG',
  ],
}
for (const [region, codes] of Object.entries(COUNTRIES)) {
  for (const code of codes) REGION_BY_COUNTRY[code] = region as MangroveRegion
}

/**
 * Places where mangroves are not native: people brought them in, and they
 * spread (the manual: "introduced to Hawaii and possibly to Tahiti").
 */
const NOT_NATIVE = new Set(['PF'])

/**
 * Hawaii shares 'US' with Florida, so it is told apart by longitude: no US
 * coast west of 150 W has native mangroves (Hawaii lies west of 154 W).
 */
const US_PACIFIC_WEST_OF = -150

/**
 * False where mangroves are not native, so none should be planted. Pass the
 * site's longitude so Hawaii is caught too.
 */
export function mangrovesNative(
  countryCode?: string | null,
  longitude?: number | null,
): boolean {
  const code = countryCode?.trim().toUpperCase()
  if (!code) return true
  if (NOT_NATIVE.has(code)) return false
  return !(code === 'US' && longitude != null && longitude < US_PACIFIC_WEST_OF)
}

/** Region for an ISO 3166-1 alpha-2 country code, or null when unknown. */
export function regionForCountry(
  countryCode?: string | null,
): MangroveRegion | null {
  if (!countryCode) return null
  return REGION_BY_COUNTRY[countryCode.trim().toUpperCase()] ?? null
}

/**
 * Species suited to a zone, limited to the country's region when it is
 * known. With no zone, every species of the region is returned. None where
 * mangroves are not native (see mangrovesNative).
 */
export function speciesFor(
  zone: PlantingZone | null,
  countryCode?: string | null,
  longitude?: number | null,
): MangroveSpecies[] {
  if (!mangrovesNative(countryCode, longitude)) return []
  const region = regionForCountry(countryCode)
  return MANGROVE_SPECIES.filter(
    s =>
      (!zone || s.zones.includes(zone)) &&
      (!region || s.regions.includes(region)),
  )
}

export function findSpecies(id: string): MangroveSpecies | undefined {
  return MANGROVE_SPECIES.find(s => s.id === id)
}
