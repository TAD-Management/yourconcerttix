// Venue grouping + page URLs, shared by scripts/sync.mjs (links the venue name
// on each event page) and scripts/directory.mjs (builds /venues/ and /cities/),
// so both always agree on where a venue's page is.
//
// A venue is the cleaned venue name + city + state of the homepage events. Its
// page is its FanGenie venue page (/<dir>/) when it has one, otherwise
// /venues/<slug>/.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The FanGenie venue pages (scripts/apache-junction.mjs VENUES). `match` picks
// out the same venue among the Airtable venue names, which differ slightly
// ("The Historic Paramount Theater (AZ)" vs FanGenie's "...Theatre"); the city
// must match too.
export const FANGENIE_PAGES = [
  { dir: 'apachejunction', match: /apache junction/i },
  { dir: 'lakehavasu',     match: /havasu aquatic/i },
  { dir: 'paramount',      match: /paramount/i },
  { dir: 'cocopah',        match: /cocopah/i },
];

export const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'Washington, D.C.', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const STATE_ABBR = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v.toLowerCase(), k]));

export function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
export function slugify(s) {
  return String(s || '').toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
// "The Historic Paramount" files under P.
function sortKey(s) {
  return s.toLowerCase().replace(/^the\s+/, '');
}
export const byName = (a, b) => sortKey(a.name).localeCompare(sortKey(b.name));

// A FanGenie page's embedded DATA, or null when the page is missing or has no shows.
const pageCache = new Map();
export function fanGeniePage(dir) {
  if (!pageCache.has(dir)) {
    const file = path.join(repoRoot, dir, 'index.html');
    const m = existsSync(file) && readFileSync(file, 'utf8').match(/const DATA = (\{.*?\});\n/s);
    const data = m ? JSON.parse(m[1]) : null;
    pageCache.set(dir, data && data.venue && data.events && data.events.length ? data : null);
  }
  return pageCache.get(dir);
}

// "2525 South Ironwood Drive, Apache Junction, Arizona 85120" -> Apache Junction, AZ
export function cityFromAddress(address) {
  const parts = String(address || '').split(',').map(clean).filter(Boolean);
  if (parts.length < 3) return { city: '', state: '' };
  const st = parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, '').trim();
  return {
    city: parts[parts.length - 2],
    state: st.length === 2 ? st.toUpperCase() : (STATE_ABBR[st.toLowerCase()] || st),
  };
}

// Group events ({ venue, city, state, address }) into venues, sorted by name:
// { name, city, state, address, events, href, slug | fanGenie: { dir, data } }.
// Events with no venue name are left out.
export function groupVenues(events) {
  const groups = new Map();
  for (const e of events) {
    const city = clean(e.city), state = clean(e.state).toUpperCase();
    let name = clean(e.venue);
    if (!name) continue;
    // Drop a disambiguating "(Laughlin)" / "(AZ)" when the city and state are shown anyway.
    name = name.replace(/\s*\(([^)]*)\)$/, (all, inner) =>
      [city.toLowerCase(), state.toLowerCase()].includes(inner.trim().toLowerCase()) ? '' : all);
    const key = `${name}|${city}|${state}`.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, city, state, address: clean(e.address), events: [] });
    groups.get(key).events.push(e);
  }
  const venues = [...groups.values()].sort(byName);

  const claimed = new Set();
  const slugsSeen = new Set();
  for (const v of venues) {
    const page = FANGENIE_PAGES.find(p => {
      if (claimed.has(p.dir) || !p.match.test(v.name)) return false;
      const data = fanGeniePage(p.dir);
      return data && cityFromAddress(data.venue.address).city.toLowerCase() === v.city.toLowerCase();
    });
    if (page) {
      claimed.add(page.dir);
      v.fanGenie = { dir: page.dir, data: fanGeniePage(page.dir) };
      v.href = `/${page.dir}/`;
      continue;
    }
    let slug = slugify(v.name);
    if (slugsSeen.has(slug)) slug = `${slug}-${slugify(`${v.city} ${v.state}`)}`;
    slugsSeen.add(slug);
    v.slug = slug;
    v.href = `/venues/${slug}/`;
  }
  return venues;
}
