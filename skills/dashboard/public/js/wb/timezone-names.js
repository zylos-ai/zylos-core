// Renamed locations in IANA tzdb 2026e backward/backzone, keeping zone.tab
// country locations (rather than merging locations with equal post-1970 clocks).
// https://data.iana.org/time-zones/tzdb-2026e/backward
// https://data.iana.org/time-zones/tzdb-2026e/backzone
// Asmera/Ponape/Truk use backward's #= country-location targets, also in backzone.
// Coral_Harbour uses backzone's PACKRATLIST zone.tab link to Atikokan.
const renamedLocations = new Map([
  ['Africa/Asmera', 'Africa/Asmara'],
  ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ['America/Catamarca', 'America/Argentina/Catamarca'],
  ['America/Coral_Harbour', 'America/Atikokan'],
  ['America/Cordoba', 'America/Argentina/Cordoba'],
  ['America/Godthab', 'America/Nuuk'],
  ['America/Indianapolis', 'America/Indiana/Indianapolis'],
  ['America/Jujuy', 'America/Argentina/Jujuy'],
  ['America/Louisville', 'America/Kentucky/Louisville'],
  ['America/Mendoza', 'America/Argentina/Mendoza'],
  ['Asia/Calcutta', 'Asia/Kolkata'],
  ['Asia/Katmandu', 'Asia/Kathmandu'],
  ['Asia/Rangoon', 'Asia/Yangon'],
  ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
  ['Atlantic/Faeroe', 'Atlantic/Faroe'],
  ['Europe/Kiev', 'Europe/Kyiv'],
  ['Pacific/Enderbury', 'Pacific/Kanton'],
  ['Pacific/Ponape', 'Pacific/Pohnpei'],
  ['Pacific/Truk', 'Pacific/Chuuk'],
]);

// Exact names only: callers must validate recognition and case separately.
export const canonicalTimezoneName = value => renamedLocations.get(value) ?? value;
export function timezoneOptions(supported = Intl.supportedValuesOf('timeZone')) {
  return [...new Set(['UTC', ...supported.map(canonicalTimezoneName)])].sort();
}
