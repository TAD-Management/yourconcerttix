#!/usr/bin/env node
// Venue pages (Apache Junction, Lake Havasu, ...) — pulls each venue's upcoming
// shows and season bundles straight from FanGenie's public API and rebuilds
// /<dir>/index.html for every entry in VENUES below.
//
// FanGenie only allows browser calls to its API from app.fangenie.com, so the
// page can't fetch live in the visitor's browser. Instead the GitHub Action
// runs this script alongside scripts/sync.mjs every few hours and commits the
// result. No secrets are needed — the API is public.
//
// Posters: when AIRTABLE_PAT is set (it is in the GitHub Action) each show is
// matched to its CURRENT EVENTS row by venue + date and the 1:1 Poster/Portrait
// from BANDS-SHOWS is downloaded into <dir>/img/. Without the PAT, or when a
// band has no poster, FanGenie's own image is used instead.
//
// Usage:
//   node scripts/apache-junction.mjs                  # rebuild every venue page
//   node scripts/apache-junction.mjs --only lakehavasu # just one (by dir)
//   node scripts/apache-junction.mjs --dry-run        # just print a summary

import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1] : null; })();

const API = 'https://api.fangenie.com/api/v1';
const SITE_ORIGIN = 'https://yourconcerttix.com';

// Airtable (same base + fields as scripts/sync.mjs). Optional — see header.
const AIRTABLE_PAT = process.env.AIRTABLE_PAT || '';
const BASE_ID = 'appEy2dr1ecmzbEpb';
const EVENTS_TABLE = 'tblu9UIlpXChPdvOB';
const BANDS_TABLE = 'tblOsZIDmFHt01rJn';
const F_START_DATE = 'fld0VBiok50LzeKRZ';
const F_ARTIST_LINK = 'fldRZ99cnPxHyPL18';
const F_VENUE_LINK = 'fldWNKIABxBYUyX0A';
const F_NAME = 'fldLzk7pDCwNsBQob';
const F_WEB_IMG = 'fldmdmT8dvg45MLyn'; // Poster/Portrait (1:1)

// One entry per venue page. `slug` is the venue code in FanGenie's URL
// (app.fangenie.com/venue/<name>/<slug>), `dir` is the folder under the site
// root, `headline` fills "<headline> Live" and `tagline` opens the intro line.
// Adding a venue here is all it takes; the workflow commits every dir listed.
const VENUES = [
  { slug: 'LbyXyoyVFS', dir: 'apachejunction', headline: 'Apache Junction',
    tagline: "TAD Management presents Arizona's #1 live concert series",
    airtableVenue: 'rec0tRFvep0mbHE1p' },  // VENUES "Apache Junction PAC"
  { slug: 'AqIHEi8XOu', dir: 'lakehavasu', headline: 'Lake Havasu',
    tagline: 'The TAD Management concert series roars back to life',
    airtableVenue: 'receYZwNa6cnwQQrU' },  // VENUES "Lake Havasu Aquatic Center"
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ---- FanGenie API ----

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchVenue(slug) {
  const v = await getJson(`${API}/venue/slug/${slug}`);
  return v.data || v.venue || v;
}

// Season bundles ("season tickets") sold for the venue, if any.
async function fetchBundles(slug) {
  try {
    const r = await getJson(`${API}/season-tickets/venue/${slug}`);
    return (r.data || []).filter(b => b && !b.isDeleted);
  } catch (err) {
    console.warn(`  WARN season bundles failed: ${err.message}`);
    return [];
  }
}

async function fetchEventList(venueId) {
  const all = [];
  let page = 1, totalPages = 1;
  do {
    const q = `params[page]=${page}&params[limit]=50&params[featured]=false&params[venueId]=${venueId}`;
    const data = await getJson(`${API}/event?${q}`);
    all.push(...(data.events || []));
    totalPages = data.totalPages || 1;
    page++;
  } while (page <= totalPages);
  return all;
}

// The list endpoint omits on-sale date, video and category, so pull each
// event's detail record (a few at a time).
async function fetchDetails(events) {
  const out = {};
  const queue = [...events];
  async function worker() {
    while (queue.length) {
      const e = queue.shift();
      try {
        const d = await getJson(`${API}/event/slug/${e.slug}`);
        out[e.slug] = (d.data && d.data.event) || {};
      } catch (err) {
        console.warn(`  WARN detail failed for ${e.slug}: ${err.message}`);
        out[e.slug] = {};
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return out;
}

// ---- Airtable posters (optional) ----

async function airtableListAll(tableId, { fields = [], filterByFormula = null } = {}) {
  const records = [];
  let offset = null;
  do {
    const params = new URLSearchParams();
    for (const f of fields) params.append('fields[]', f);
    if (filterByFormula) params.set('filterByFormula', filterByFormula);
    params.set('returnFieldsByFieldId', 'true');
    params.set('pageSize', '100');
    if (offset) params.set('offset', offset);
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}?${params}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    if (!res.ok) throw new Error(`Airtable ${tableId} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

// Upcoming CURRENT EVENTS rows for one venue: [{ ymd, bandId }]
async function fetchAirtableShows(venueRecordId) {
  const rows = await airtableListAll(EVENTS_TABLE, {
    fields: [F_START_DATE, F_ARTIST_LINK, F_VENUE_LINK],
    filterByFormula: `IS_AFTER({Start Date}, DATEADD(TODAY(), -2, 'days'))`,
  });
  return rows
    .filter(r => (r.fields[F_VENUE_LINK] || []).includes(venueRecordId))
    .map(r => ({ ymd: r.fields[F_START_DATE], bandId: (r.fields[F_ARTIST_LINK] || [])[0] || null }))
    .filter(r => r.ymd && r.bandId);
}

// BANDS-SHOWS name + Poster/Portrait URL for a set of record ids.
async function fetchAirtableBands(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const byId = {};
  for (let i = 0; i < unique.length; i += 80) {
    const chunk = unique.slice(i, i + 80);
    const rows = await airtableListAll(BANDS_TABLE, {
      fields: [F_NAME, F_WEB_IMG],
      filterByFormula: `OR(${chunk.map(id => `RECORD_ID()='${id}'`).join(',')})`,
    });
    for (const r of rows) {
      const att = r.fields[F_WEB_IMG];
      byId[r.id] = {
        name: (r.fields[F_NAME] || '').trim(),
        url: att && att[0] ? att[0].url : null,
        // Attachment id + byte size identify the upload, so an unchanged
        // poster is not re-downloaded and re-encoded on every run.
        key: att && att[0] ? `${att[0].id}:${att[0].size || 0}` : null,
      };
    }
  }
  return byId;
}

function nameTokens(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t && !['the', 'a', 'an', 'of', 'to', 'and'].includes(t));
}

// How much of the band name appears in the FanGenie show name (0..1).
function nameScore(bandName, showName) {
  const b = nameTokens(bandName), n = new Set(nameTokens(showName));
  if (!b.length) return 0;
  return b.filter(t => n.has(t)).length / b.length;
}

// Pick the Airtable band for a FanGenie show: same local date and the band name
// must be recognisable in the show title, so two shows on one day can't swap
// posters. Falls back to a strong name match within a day either side (the two
// systems occasionally disagree on the date by one).
function matchShow(event, shows, bandsById) {
  const dayMs = 86400 * 1000;
  const t = new Date(event.ymd + 'T12:00:00Z').getTime();
  let best = null;
  for (const s of shows) {
    const band = bandsById[s.bandId];
    if (!band || !band.name) continue;
    const dist = Math.abs(new Date(s.ymd + 'T12:00:00Z').getTime() - t) / dayMs;
    if (dist > 1) continue;
    const score = nameScore(band.name, event.name);
    if (dist === 0 ? score < 0.5 : score < 0.8) continue;
    const rank = score - dist * 0.25;
    if (!best || rank > best.rank) best = { rank, band, score, dist };
  }
  return best;
}

// Downscale a poster to a web-sized JPEG (max 900px, ~100KB) with whatever
// image tool the machine has. Source files from Airtable run to 2-3MB each.
const POSTER_MAX = 900;
let resizeTool; // resolved once: 'magick' | 'convert' | 'sips' | null
function findResizeTool() {
  if (resizeTool !== undefined) return resizeTool;
  resizeTool = null;
  for (const t of ['magick', 'convert', 'sips']) {
    try { execFileSync(t, t === 'sips' ? ['--help'] : ['-version'], { stdio: 'ignore' }); resizeTool = t; break; } catch {}
  }
  return resizeTool;
}
function resizePoster(buf, target) {
  const tool = findResizeTool();
  const src = path.join(tmpdir(), `yct-poster-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(src, buf);
  try {
    if (tool === 'magick' || tool === 'convert') {
      execFileSync(tool, [src, '-auto-orient', '-resize', `${POSTER_MAX}x${POSTER_MAX}>`, '-strip', '-interlace', 'Plane', '-quality', '82', `jpg:${target}`], { stdio: 'ignore' });
    } else if (tool === 'sips') {
      const tmpOut = `${target}.tmp.jpg`;
      execFileSync('sips', ['--resampleHeightWidthMax', String(POSTER_MAX), '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', src, '--out', tmpOut], { stdio: 'ignore' });
      renameSync(tmpOut, target);
    } else {
      writeFileSync(target, buf);
      return 'original';
    }
    return tool;
  } catch (err) {
    writeFileSync(target, buf); // never lose the poster over a tooling problem
    return `original (${tool} failed: ${err.message.split('\n')[0]})`;
  } finally {
    try { unlinkSync(src); } catch {}
  }
}

async function applyAirtablePosters(cfg, events) {
  if (!AIRTABLE_PAT) { console.log('  AIRTABLE_PAT not set: using FanGenie images'); return; }
  if (!cfg.airtableVenue) return;
  const shows = await fetchAirtableShows(cfg.airtableVenue);
  const bandsById = await fetchAirtableBands(shows.map(s => s.bandId));
  const imgDir = path.join(repoRoot, cfg.dir, 'img');
  if (!DRY_RUN) mkdirSync(imgDir, { recursive: true });
  const manifestPath = path.join(imgDir, 'manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {}
  const nextManifest = {};
  const keep = new Set(['manifest.json']);
  let matched = 0, noPoster = 0, unmatched = 0, failed = 0, downloaded = 0, reused = 0;
  const tools = new Set();
  for (const e of events) {
    const m = matchShow(e, shows, bandsById);
    if (!m) { unmatched++; console.log(`  no Airtable match: ${e.ymd} ${e.name}`); continue; }
    if (!m.band.url) { noPoster++; console.log(`  no Poster/Portrait: ${m.band.name} (${e.ymd})`); continue; }
    const file = `${slugify(m.band.name).replace(/-+/g, '-').replace(/^-|-$/g, '')}.jpg`;
    const target = path.join(imgDir, file);
    try {
      if (!keep.has(file)) {
        // Reuse the stored file when the upload is unchanged, unless it was
        // saved unresized and a resize tool is available now.
        const prev = manifest[file] || {};
        const canResize = !!findResizeTool();
        if (prev.key === m.band.key && existsSync(target) && (prev.resized || !canResize)) {
          reused++;
          nextManifest[file] = prev;
        } else {
          const res = await fetch(m.band.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const tool = DRY_RUN ? 'dry-run' : resizePoster(buf, target);
          tools.add(tool);
          nextManifest[file] = { key: m.band.key, resized: !/^original/.test(tool) };
          downloaded++;
        }
      }
      keep.add(file);
      e.poster = `img/${file}`;
      e.posterSource = 'airtable';
      matched++;
    } catch (err) {
      failed++;
      console.log(`  poster download failed for ${m.band.name}: ${err.message}`);
    }
  }
  // Drop posters for shows that are no longer listed.
  if (!DRY_RUN && existsSync(imgDir)) {
    for (const f of readdirSync(imgDir)) if (!keep.has(f)) unlinkSync(path.join(imgDir, f));
    writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 1) + '\n');
  }
  console.log(`  posters: ${matched} from Airtable (${downloaded} downloaded, ${reused} unchanged), ${noPoster} without Poster/Portrait, ${unmatched} unmatched, ${failed} failed${tools.size ? `; resized with ${[...tools].join(', ')}` : ''}`);
}

// ---- Helpers ----

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

// FanGenie descriptions arrive as editor HTML. Reduce them to plain paragraphs
// so nothing from a third-party field is ever injected into our page as markup.
function htmlToParagraphs(html) {
  const text = String(html ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|h[1-6]|li|div|blockquote)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isPromoLine(p) {
  return /discount code/i.test(p) || /code expires/i.test(p) || /enter the code/i.test(p);
}

// Detect a discount code shared across the listings (the venue puts the same
// note at the top of every show). Returned as null when nothing is found.
function detectDiscount(descriptions) {
  const counts = new Map();
  let amount = null, expiresText = null, note = null;
  for (const d of descriptions) {
    const text = htmlToParagraphs(d).join(' ');
    const m = text.match(/discount code\s*[-\u2013:]?\s*([A-Z0-9]{4,})/i);
    if (m) counts.set(m[1].toUpperCase(), (counts.get(m[1].toUpperCase()) || 0) + 1);
    const a = text.match(/\$(\d+(?:\.\d+)?)\s+off/i);
    if (a && !amount) amount = a[1];
    // "expires at midnight on November 11th, 2026" or "before October 31st"
    const x = text.match(/(?:expires\s+(?:at\s+midnight\s+)?on|before)\s+([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?)(?:,?\s+(\d{4}))?/i);
    if (x && !expiresText) expiresText = x[1] + (x[2] ? `, ${x[2]}` : '');
    const n = text.match(/not (?:valid|applicable) (?:on|for) ([A-Za-z' ]+?)(?:\s*[*.]|$)/i);
    if (n && !note) note = `Not valid on ${n[1].trim()}.`;
  }
  if (!counts.size) return null;
  const [code] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  let expiresIso = null;
  if (expiresText) {
    let clean = expiresText.replace(/(\d)(st|nd|rd|th)/, '$1');
    if (!/\d{4}/.test(clean)) {
      // No year given: the first year that puts the deadline in the future.
      const y = new Date().getFullYear();
      const guess = new Date(`${clean}, ${y} 23:59:59 GMT-0700`);
      clean = `${clean}, ${!isNaN(guess) && guess.getTime() < Date.now() ? y + 1 : y}`;
      expiresText = clean;
    }
    const d = new Date(`${clean} 23:59:59 GMT-0700`); // midnight, Arizona time
    if (!isNaN(d)) expiresIso = d.toISOString();
  }
  if (expiresText) expiresText = expiresText.replace(/^[a-z]+/i, m => m[0].toUpperCase() + m.slice(1).toLowerCase());
  return { code, amount, expiresText, expiresIso, note };
}

function youtubeId(url) {
  if (!url) return '';
  const m = String(url).match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

function fmt(date, tz, opts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(date);
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '-');
}

// ---- Build ----

function buildEvents(list, details, venue) {
  const tz = venue.timezone || 'America/Phoenix';
  const now = Date.now();
  const events = [];
  for (const e of list) {
    const d = details[e.slug] || {};
    const when = new Date(e.date);
    if (isNaN(when)) continue;
    if (when.getTime() < now - 6 * 3600 * 1000) continue; // already happened
    const paragraphs = htmlToParagraphs(e.description || d.description || '').filter(p => !isPromoLine(p));
    const venueSlug = slugify(venue.name || 'venue').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const url = d.website || `https://app.fangenie.com/${venueSlug}/${slugify(e.name)}/${e.slug}`;
    // Square poster first; some venues only upload a landscape gallery image.
    const gallery = (e.galleryImages || []).filter(Boolean);
    const poster = e.heroBannerImageMobile || gallery[0] || e.heroBannerImage || '';
    events.push({
      name: e.name,
      slug: e.slug,
      url,
      iso: when.toISOString(),
      ymd: fmt(when, tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2'),
      dow: fmt(when, tz, { weekday: 'short' }),
      dowLong: fmt(when, tz, { weekday: 'long' }),
      day: fmt(when, tz, { day: 'numeric' }),
      mon: fmt(when, tz, { month: 'short' }),
      monLong: fmt(when, tz, { month: 'long' }),
      year: fmt(when, tz, { year: 'numeric' }),
      time: fmt(when, tz, { hour: 'numeric', minute: '2-digit' }),
      poster,
      banner: e.heroBannerImage || '',
      category: (d.category && d.category[0] && d.category[0].name) || '',
      video: youtubeId(d.video),
      onSale: d.onSaleDate || null,
      paragraphs,
      excerpt: (paragraphs[0] || '').slice(0, 170).replace(/\s+\S*$/, '') + ((paragraphs[0] || '').length > 170 ? '…' : ''),
    });
  }
  events.sort((a, b) => a.iso.localeCompare(b.iso));
  return events;
}

function buildBundles(raw) {
  return raw.map(b => {
    const paragraphs = htmlToParagraphs(b.description || '');
    const shows = (b.eventIds || []).map(x => (x && x.name) || '').filter(Boolean);
    const seating = (b.name.match(/reserved/i) && 'Reserved seating') || (b.name.match(/general admission/i) && 'General admission') || '';
    const cleanName = b.name.replace(/\s*[()]\s*(reserved seating|general admission)\s*[()]?\s*$/i, '').trim();
    return {
      name: cleanName || b.name,
      seating,
      url: `https://app.fangenie.com/season-ticket/${slugify(b.name).replace(/-+/g, '-').replace(/^-|-$/g, '')}/${b.slug}`,
      price: typeof b.price === 'number' ? b.price : null,
      count: shows.length || ((b.eventIds || []).length),
      shows,
      image: b.heroBannerImageMobile || (b.images && b.images[0] && (b.images[0].url || b.images[0])) || '',
      blurb: paragraphs.find(p => !/^(this season ticket|six shows|one great price)/i.test(p)) || '',
    };
  }).sort((a, b) => (b.price || 0) - (a.price || 0) || a.name.localeCompare(b.name));
}

function jsonLd(events, venue, cfg) {
  return JSON.stringify(events.map(e => ({
    '@context': 'https://schema.org',
    '@type': 'MusicEvent',
    name: e.name,
    startDate: e.iso,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    image: e.poster ? (e.poster.startsWith('http') ? e.poster : `${SITE_ORIGIN}/${cfg.dir}/${e.poster}`) : undefined,
    description: e.excerpt || undefined,
    url: e.url,
    location: {
      '@type': 'PerformingArtsTheater',
      name: venue.name,
      address: { '@type': 'PostalAddress', streetAddress: venue.address, addressLocality: venue.city, addressRegion: venue.state, postalCode: venue.zipcode, addressCountry: 'US' },
    },
    offers: { '@type': 'Offer', url: e.url, availability: 'https://schema.org/InStock', validFrom: e.onSale || undefined },
    organizer: { '@type': 'Organization', name: 'TAD Management', url: SITE_ORIGIN },
  })));
}

function renderPage({ cfg, venue, events, discount, bundles }) {
  const PAGE_PATH = `/${cfg.dir}/`;
  const VENUE_PAGE = venue.website || `https://app.fangenie.com/venue/${slugify(venue.name).replace(/-+/g, '-')}/${cfg.slug}`;
  const seasons = [...new Set(events.map(e => e.year))];
  const seasonLabel = seasons.length ? `${seasons[0]}${seasons.length > 1 ? '–' + seasons[seasons.length - 1] : ''} Season` : 'Upcoming Shows';
  const first = events[0], last = events[events.length - 1];
  const range = first && last ? (first.mon === last.mon && first.year === last.year
    ? `${first.monLong} ${first.year}`
    : `${first.mon} ${first.year === last.year ? '' : first.year + ' '}– ${last.mon} ${last.year}`) : '';
  const months = [];
  for (const e of events) {
    const key = `${e.year}-${e.mon}`;
    if (!months.find(m => m.key === key)) months.push({ key, label: `${e.mon} ${e.year}`, count: 0 });
    months.find(m => m.key === key).count++;
  }
  const onSaleDates = events.map(e => e.onSale).filter(Boolean).sort();
  const firstOnSale = onSaleDates[0] || null;
  const hero = events.find(e => e.banner) || first;
  const ogImage = (hero && hero.banner) || (first && first.poster) || '';
  const fullAddress = [venue.address, venue.city, `${venue.state} ${venue.zipcode || ''}`.trim()].filter(Boolean).join(', ');
  const times = [...new Set(events.map(e => e.time))];
  const timeNote = times.length === 1 ? ` &middot; all at ${esc(times[0])}` : '';
  const descLine = `${events.length} upcoming shows at ${venue.name}, ${venue.city}, AZ. Tribute concerts and live music, ${range}. Tickets on FanGenie.`;

  const dataJs = JSON.stringify({
    venue: { name: venue.name, address: fullAddress, phone: venue.phone || '', page: VENUE_PAGE, tz: venue.timezone || 'America/Phoenix' },
    bundles: bundles.length,
    discount,
    firstOnSale,
    events: events.map(e => ({
      name: e.name, url: e.url, iso: e.iso, ymd: e.ymd, dow: e.dow, dowLong: e.dowLong, day: e.day, mon: e.mon, monLong: e.monLong, year: e.year,
      time: e.time, poster: e.poster, banner: e.banner, category: e.category, video: e.video, onSale: e.onSale, paragraphs: e.paragraphs, excerpt: e.excerpt,
      key: `${e.year}-${e.mon}`,
    })),
    generatedAt: new Date().toISOString(),
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(venue.name)} — ${esc(seasonLabel)} | YourConcertTix</title>
<meta name="description" content="${esc(descLine)}">
<link rel="canonical" href="${SITE_ORIGIN}${PAGE_PATH}">
<meta property="og:title" content="${esc(venue.name)} — ${esc(seasonLabel)}">
<meta property="og:description" content="${esc(descLine)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE_ORIGIN}${PAGE_PATH}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://fangenie.s3.eu-north-1.amazonaws.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@700;800;900&display=swap" rel="stylesheet">
<script type="application/ld+json">${jsonLd(events, venue, cfg).replace(/</g, '\\u003c')}</script>
<style>
:root{
  --bg:#0f0f23; --bg2:#1a1a2e; --card:#16213e; --line:#26264a;
  --accent:#e94560; --gold:#f5a623; --violet:#8e2de2; --blue:#2575fc; --teal:#11998e;
  --text:#e8e8f0; --muted:#9a9ab8;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;overflow-x:hidden}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);line-height:1.5;overflow-x:hidden;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}

/* ---------- ambient stage lighting ---------- */
.stage{position:fixed;inset:0;z-index:-2;overflow:hidden;background:
  radial-gradient(60% 45% at 15% 0%, rgba(233,69,96,.35), transparent 70%),
  radial-gradient(55% 45% at 85% 10%, rgba(142,45,226,.35), transparent 70%),
  radial-gradient(70% 40% at 50% 100%, rgba(245,166,35,.18), transparent 70%),
  var(--bg);}
.stage::before,.stage::after{content:"";position:absolute;width:140vmax;height:140vmax;left:50%;top:50%;
  background:conic-gradient(from 0deg, transparent 0 40%, rgba(255,255,255,.05) 42%, transparent 44%, transparent 60%, rgba(255,255,255,.04) 62%, transparent 64%);
  transform:translate(-50%,-50%);animation:beams 40s linear infinite;opacity:.9}
.stage::after{animation-duration:65s;animation-direction:reverse;opacity:.6}
@keyframes beams{to{transform:translate(-50%,-50%) rotate(360deg)}}
.grain{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.06;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}

/* ---------- top bar ---------- */
.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 24px;max-width:1240px;margin:0 auto}
.bar .brand{font-family:'Montserrat',sans-serif;font-weight:800;font-size:18px;letter-spacing:-.3px}
.bar .brand span{color:var(--accent)}
.bar .fg{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;font-weight:500}
.bar .fg img{height:16px}

/* ---------- hero ---------- */
.hero{position:relative;text-align:center;padding:48px 20px 24px;max-width:1000px;margin:0 auto}
.hero-bg{position:absolute;inset:-120px -40vw 0;z-index:-1;pointer-events:none;background:var(--hero-img) center 30%/cover no-repeat;opacity:.28;filter:blur(22px) saturate(.7);
  -webkit-mask-image:linear-gradient(#000 30%,transparent 100%);mask-image:linear-gradient(#000 30%,transparent 100%)}
.kicker{display:inline-flex;align-items:center;gap:10px;font-size:12px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);
  border:1px solid rgba(245,166,35,.35);background:rgba(245,166,35,.08);padding:8px 16px;border-radius:999px;animation:rise .7s ease both}
.kicker i{width:8px;height:8px;border-radius:50%;background:var(--gold);box-shadow:0 0 0 0 rgba(245,166,35,.7);animation:pulse 1.8s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 10px rgba(245,166,35,0)}100%{box-shadow:0 0 0 0 rgba(245,166,35,0)}}
.hero h1{font-family:'Montserrat',sans-serif;font-weight:900;font-size:clamp(34px,6.4vw,76px);line-height:.98;letter-spacing:-.04em;margin:22px auto 14px;animation:rise .8s .1s ease both}
.hero h1 em{font-style:normal;background:linear-gradient(90deg,var(--accent),var(--gold));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .sub{font-size:clamp(16px,2.2vw,21px);color:var(--muted);max-width:640px;margin:0 auto;animation:rise .8s .2s ease both}
.hero .sub strong{color:var(--text)}
.facts{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:26px;animation:rise .8s .3s ease both}
.facts span,.facts a{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);font-size:14px;font-weight:600;backdrop-filter:blur(8px)}
.facts a:hover{border-color:rgba(245,166,35,.5)}
.facts svg{width:16px;height:16px;stroke:var(--gold);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
@keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}

/* ---------- on-sale countdown + discount ---------- */
.strip{max-width:1200px;margin:30px auto 0;padding:0 20px;display:grid;grid-template-columns:1fr 1fr;gap:16px;animation:rise .8s .35s ease both}
.strip>div{border-radius:18px;padding:20px 22px;border:1px solid rgba(255,255,255,.1);background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02));position:relative;overflow:hidden}
.strip .lbl{font-size:11px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.count{display:flex;gap:10px;align-items:stretch}
.count b{display:flex;flex-direction:column;align-items:center;min-width:64px;padding:10px 8px;border-radius:12px;background:rgba(10,10,30,.6);border:1px solid rgba(255,255,255,.1);font-family:'Montserrat',sans-serif;font-weight:900;font-size:28px;line-height:1;letter-spacing:-.02em}
.count b small{font-family:'Inter',sans-serif;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:6px}
.count .sep{align-self:center;font-weight:900;color:var(--muted)}
.strip .when{color:var(--muted);font-size:13px;margin-top:10px}
.strip .when strong{color:var(--text)}
.onsale-now{display:flex;align-items:center;gap:12px;font-family:'Montserrat',sans-serif;font-weight:800;font-size:22px}
.onsale-now i{width:12px;height:12px;border-radius:50%;background:#38ef7d;box-shadow:0 0 0 0 rgba(56,239,125,.7);animation:pulse 1.8s infinite}
.deal{--c1:var(--accent);--c2:var(--gold)}
.deal::before{content:"";position:absolute;inset:0;border-radius:18px;padding:1px;background:linear-gradient(140deg,var(--c1),var(--c2));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
.deal .big{font-family:'Montserrat',sans-serif;font-weight:900;font-size:clamp(22px,3vw,30px);letter-spacing:-.02em;line-height:1.1}
.deal .big em{font-style:normal;background:linear-gradient(90deg,var(--accent),var(--gold));-webkit-background-clip:text;background-clip:text;color:transparent}
.code{display:inline-flex;align-items:center;gap:10px;margin-top:12px;padding:8px 8px 8px 16px;border-radius:12px;background:rgba(10,10,30,.65);border:1px dashed rgba(245,166,35,.6);font-family:'Montserrat',sans-serif;font-weight:800;font-size:18px;letter-spacing:.12em}
.code button{padding:8px 12px;border-radius:8px;background:linear-gradient(90deg,var(--accent),var(--gold));font-family:'Inter',sans-serif;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#fff;transition:filter .2s}
.code button:hover{filter:brightness(1.1)}
.deal .fine{color:var(--muted);font-size:12px;margin-top:10px}

/* ---------- filters ---------- */
.filters{max-width:1240px;margin:38px auto 0;padding:0 20px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;animation:rise .8s .4s ease both}
.filters .title{font-family:'Montserrat',sans-serif;font-weight:800;font-size:clamp(20px,3vw,28px);letter-spacing:-.02em;margin-right:auto}
.filters .title span{color:var(--muted);font-family:'Inter',sans-serif;font-weight:500;font-size:14px;margin-left:8px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:9px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);font-size:13px;font-weight:600;color:var(--muted);transition:all .2s}
.chip:hover{color:var(--text);border-color:rgba(255,255,255,.3)}
.chip.on{color:#fff;background:linear-gradient(90deg,var(--accent),var(--gold));border-color:transparent;box-shadow:0 8px 24px -10px var(--accent)}
.chip small{opacity:.7;margin-left:4px}
.search{position:relative;flex:0 1 260px;min-width:180px}
.search input{width:100%;padding:10px 14px 10px 38px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:var(--text);font:inherit;font-size:14px;outline:0}
.search input:focus{border-color:rgba(245,166,35,.6)}
.search input::placeholder{color:var(--muted)}
.search svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);width:16px;height:16px;stroke:var(--muted);fill:none;stroke-width:2;stroke-linecap:round}

/* ---------- event grid ---------- */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:22px;max-width:1240px;margin:20px auto 0;padding:0 20px}
.card{position:relative;display:flex;flex-direction:column;border-radius:20px;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02));
  border:1px solid rgba(255,255,255,.1);overflow:hidden;transition:transform .35s cubic-bezier(.2,.8,.2,1),box-shadow .35s,border-color .35s;animation:rise .6s ease both}
.card::before{content:"";position:absolute;inset:0;border-radius:20px;padding:1px;pointer-events:none;z-index:3;
  background:linear-gradient(140deg,var(--c1),var(--c2));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:0;transition:opacity .35s}
.card:hover{transform:translateY(-8px);box-shadow:0 30px 60px -20px rgba(0,0,0,.7),0 0 60px -20px var(--c1);border-color:transparent}
.card:hover::before{opacity:1}
.card.hide{display:none}
.art{display:block;position:relative;aspect-ratio:1/1;overflow:hidden;background:radial-gradient(80% 80% at 50% 30%,rgba(255,255,255,.10),transparent 70%),linear-gradient(135deg,var(--c1),var(--c2))}
.artwrap{position:relative}
.art img{position:relative;z-index:1;width:100%;height:100%;object-fit:cover;transition:transform .7s cubic-bezier(.2,.8,.2,1)}
.card:hover .art img{transform:scale(1.06)}
.art .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;
  font-family:'Montserrat',sans-serif;font-weight:900;font-size:26px;text-transform:uppercase;letter-spacing:-.02em;color:#fff;text-shadow:0 4px 20px rgba(0,0,0,.4)}
.art::after{content:"";position:absolute;z-index:2;inset:auto 0 0 0;height:45%;background:linear-gradient(transparent,rgba(10,10,30,.75));pointer-events:none}
.date{position:absolute;top:12px;left:12px;z-index:3;display:flex;flex-direction:column;align-items:center;min-width:58px;padding:8px 8px 7px;border-radius:12px;
  background:rgba(10,10,30,.78);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(6px);font-family:'Montserrat',sans-serif;line-height:1}
.date b{font-size:24px;font-weight:900;letter-spacing:-.02em}
.date small{font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);margin-top:3px}
.date i{font-style:normal;font-family:'Inter',sans-serif;font-size:10px;font-weight:600;color:var(--muted);margin-top:4px;letter-spacing:.06em;text-transform:uppercase}
.tag{position:absolute;top:12px;right:12px;z-index:3;font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;padding:6px 10px;border-radius:8px;
  background:rgba(10,10,30,.75);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(6px);max-width:55%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag.hot{background:linear-gradient(90deg,var(--accent),var(--gold));border-color:transparent;color:#fff}
.play{position:absolute;right:12px;bottom:12px;z-index:3;display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  padding:7px 10px;border-radius:8px;background:rgba(10,10,30,.75);border:1px solid rgba(255,255,255,.18);color:#fff;backdrop-filter:blur(6px);transition:background .2s}
.play:hover{background:rgba(233,69,96,.85)}
.play svg{width:12px;height:12px;fill:#fff}
.body{display:flex;flex-direction:column;gap:10px;padding:16px 16px 18px;flex:1}
.body h3{font-family:'Montserrat',sans-serif;font-weight:800;font-size:19px;line-height:1.15;letter-spacing:-.01em}
.body h3 small{display:block;font-family:'Inter',sans-serif;font-weight:600;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.body p{color:#c6c6dd;font-size:13.5px;line-height:1.5;flex:1}
.body .more{align-self:flex-start;font-size:13px;font-weight:700;color:var(--gold);border-bottom:1px solid transparent;transition:border-color .2s}
.body .more:hover{border-color:var(--gold)}
.cta{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:4px;padding:13px;border-radius:12px;font-family:'Montserrat',sans-serif;font-weight:800;font-size:15px;letter-spacing:.02em;color:#fff;
  background:linear-gradient(90deg,var(--c1),var(--c2));box-shadow:0 10px 30px -10px var(--c1);transition:transform .2s,box-shadow .2s,filter .2s}
.cta svg{width:16px;height:16px;stroke:#fff;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s}
.cta:hover{transform:translateY(-2px);filter:brightness(1.08);box-shadow:0 16px 36px -10px var(--c1)}
.cta:hover svg{transform:translateX(3px)}
.empty{grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted)}
.c0{--c1:#e94560;--c2:#f5a623}.c1{--c1:#6a11cb;--c2:#2575fc}.c2{--c1:#ff512f;--c2:#dd2476}.c3{--c1:#11998e;--c2:#38ef7d}.c4{--c1:#f12711;--c2:#f5af19}
.c5{--c1:#8e2de2;--c2:#4a00e0}.c6{--c1:#ee0979;--c2:#ff6a00}.c7{--c1:#4568dc;--c2:#b06ab3}.c8{--c1:#c94b4b;--c2:#4b134f}.c9{--c1:#ff9966;--c2:#ff5e62}

/* ---------- season bundles ---------- */
.bundles{max-width:1240px;margin:56px auto 0;padding:0 20px}
.section-head{text-align:center;padding:0 0 18px}
.section-head h2{font-family:'Montserrat',sans-serif;font-weight:900;font-size:clamp(26px,4vw,40px);letter-spacing:-.03em;margin-top:16px}
.section-head p{color:var(--muted);margin-top:8px;max-width:560px;margin-left:auto;margin-right:auto}
.bgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:18px}
.bundle{position:relative;display:flex;flex-direction:column;border-radius:18px;overflow:hidden;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.1);transition:transform .3s cubic-bezier(.2,.8,.2,1),box-shadow .3s}
.bundle:hover{transform:translateY(-6px);box-shadow:0 26px 50px -20px rgba(0,0,0,.7),0 0 50px -20px var(--c1)}
.bart{position:relative;aspect-ratio:16/10;overflow:hidden;background:radial-gradient(80% 80% at 50% 30%,rgba(255,255,255,.10),transparent 70%),linear-gradient(135deg,var(--c1),var(--c2))}
.bart img{position:relative;z-index:1;width:100%;height:100%;object-fit:cover}
.bart .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:16px;font-family:'Montserrat',sans-serif;font-weight:900;font-size:20px;text-transform:uppercase;color:#fff;text-shadow:0 4px 20px rgba(0,0,0,.4)}
.bart .tag{top:10px;right:10px;max-width:70%}
.bbody{display:flex;flex-direction:column;gap:10px;padding:14px 14px 16px;flex:1}
.bbody h3{font-family:'Montserrat',sans-serif;font-weight:800;font-size:17px;line-height:1.15}
.bbody ul{list-style:none;display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:#c6c6dd;flex:1}
.bbody li{position:relative;padding-left:14px}
.bbody li::before{content:"";position:absolute;left:0;top:7px;width:6px;height:6px;border-radius:50%;background:linear-gradient(135deg,var(--c1),var(--c2))}
.bbody p{font-size:13px;color:#c6c6dd;flex:1}
.bfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)}
.bprice{font-size:12px;color:var(--muted)}
.bprice b{font-family:'Montserrat',sans-serif;font-size:22px;font-weight:900;letter-spacing:-.02em;color:var(--text);margin-right:4px;background:linear-gradient(90deg,var(--c1),var(--c2));-webkit-background-clip:text;background-clip:text;color:transparent}
.bcta{display:inline-flex;align-items:center;gap:6px;padding:9px 12px;border-radius:10px;font-family:'Montserrat',sans-serif;font-weight:800;font-size:13px;color:#fff;background:linear-gradient(90deg,var(--c1),var(--c2));white-space:nowrap}
.bcta svg{width:14px;height:14px;stroke:#fff;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}

/* ---------- trust / footer ---------- */
.trust{max-width:1000px;margin:52px auto 0;padding:0 20px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.trust div{padding:18px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);text-align:center}
.trust b{display:block;font-family:'Montserrat',sans-serif;font-size:15px;margin-bottom:4px}
.trust p{color:var(--muted);font-size:13px}
.trust a{color:var(--gold)}
footer{text-align:center;padding:40px 20px 100px;color:var(--muted);font-size:13px}
footer a{color:var(--text);font-weight:600}
footer a:hover{color:var(--accent)}
footer .stamp{margin-top:8px;font-size:11px;opacity:.7}

/* ---------- mobile sticky CTA ---------- */
.sticky{position:fixed;left:0;right:0;bottom:0;z-index:20;padding:12px 16px calc(12px + env(safe-area-inset-bottom));
  background:linear-gradient(transparent,rgba(15,15,35,.95) 30%);display:none;transition:transform .3s,opacity .3s}
.sticky.off{transform:translateY(110%);opacity:0;pointer-events:none}
.sticky a{display:flex;align-items:center;justify-content:center;gap:8px;padding:15px;border-radius:14px;background:linear-gradient(90deg,var(--accent),var(--gold));
  color:#fff;font-family:'Montserrat',sans-serif;font-weight:800;font-size:16px;box-shadow:0 12px 30px -8px rgba(233,69,96,.6)}

/* ---------- details modal ---------- */
.modal{position:fixed;inset:0;z-index:50;background:rgba(6,6,18,.9);display:none;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto;backdrop-filter:blur(8px)}
.modal.open{display:flex;animation:fade .2s ease}
@keyframes fade{from{opacity:0}to{opacity:1}}
.sheet{position:relative;width:min(880px,100%);margin:auto;border-radius:22px;overflow:hidden;background:#141430;border:1px solid rgba(255,255,255,.12);box-shadow:0 40px 100px rgba(0,0,0,.8);animation:rise .3s ease}
.sheet .x{position:absolute;top:14px;right:14px;z-index:5;width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(10,10,30,.7);color:#fff;font-size:22px;line-height:1;backdrop-filter:blur(6px)}
.sheet .media{position:relative;aspect-ratio:16/9;background:#000}
.sheet .media img{width:100%;height:100%;object-fit:cover}
.sheet .media iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.sheet .media .playbig{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(transparent,rgba(10,10,30,.5))}
.sheet .media .playbig span{display:inline-flex;align-items:center;gap:10px;padding:14px 22px;border-radius:999px;background:rgba(10,10,30,.75);border:1px solid rgba(255,255,255,.25);font-family:'Montserrat',sans-serif;font-weight:800;color:#fff;backdrop-filter:blur(6px);transition:transform .2s,background .2s}
.sheet .media .playbig:hover span{transform:scale(1.05);background:rgba(233,69,96,.9)}
.sheet .media .playbig svg{width:18px;height:18px;fill:#fff}
.sheet .inner{padding:24px 26px 28px}
.sheet .meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.sheet .meta span{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);font-size:13px;font-weight:600}
.sheet .meta svg{width:14px;height:14px;stroke:var(--gold);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.sheet h2{font-family:'Montserrat',sans-serif;font-weight:900;font-size:clamp(22px,3.4vw,32px);letter-spacing:-.02em;line-height:1.1;margin-bottom:14px;padding-right:40px}
.sheet .desc p{color:#c6c6dd;font-size:15px;line-height:1.6;margin-bottom:12px}
.sheet .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.sheet .actions .cta{flex:1;min-width:220px;--c1:var(--accent);--c2:var(--gold)}
.sheet .actions .ghost{display:inline-flex;align-items:center;justify-content:center;padding:13px 18px;border-radius:12px;border:1px solid rgba(255,255,255,.18);font-weight:700;font-size:14px}
.sheet .actions .ghost:hover{border-color:rgba(255,255,255,.4)}

@media (max-width:820px){.strip{grid-template-columns:1fr}.trust{grid-template-columns:1fr}}
@media (max-width:640px){
  .hero{padding-top:34px}.hero h1{margin-top:18px}
  .grid{gap:14px;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));padding:0 14px}
  .body{padding:12px 12px 14px;gap:8px}.body h3{font-size:15px}.body h3 small{font-size:10.5px;letter-spacing:.04em}.body p{display:none}.body .more{font-size:12px}
  .cta{padding:11px;font-size:13px}.date{min-width:48px;padding:6px 6px 5px}.date b{font-size:19px}.tag{display:none}.play{font-size:0;gap:0;padding:8px}.play svg{width:14px;height:14px}
  .sticky{display:block}footer{padding-bottom:110px}
  .bar .fg span{display:none}
  .kicker{font-size:10px;letter-spacing:.14em;padding:7px 12px}
  .count b{min-width:54px;font-size:22px;padding:8px 6px}
  .filters .title{width:100%}.search{flex:1 1 100%}
  .sheet .inner{padding:18px 16px 22px}
  .bgrid{grid-template-columns:1fr 1fr;gap:12px}.bbody{padding:10px 10px 12px}.bbody h3{font-size:14px}.bbody ul{display:none}.bbody p{display:none}
  .bfoot{flex-direction:column;align-items:stretch;text-align:center}.bcta{justify-content:center}.bart .tag{display:inline-block;font-size:9px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="stage"></div><div class="grain"></div>

<nav class="bar">
  <a class="brand" href="/">Your<span>Concert</span>Tix</a>
  <a class="fg" href="${esc(VENUE_PAGE)}" target="_blank" rel="noopener"><span>Tickets powered by</span><img src="https://app.fangenie.com/assets/images/newlogo.png" alt="FanGenie"></a>
</nav>

<section class="hero" ${ogImage ? `style="--hero-img:url('${esc(ogImage)}')"` : ''}>
  <div class="hero-bg" aria-hidden="true"></div>
  <div class="kicker"><i></i> ${esc(venue.city)}, Arizona &middot; ${esc(seasonLabel)}</div>
  <h1>${esc(cfg.headline)} <em>Live</em></h1>
  <p class="sub"><strong>${esc(cfg.tagline)}</strong> at the ${esc(venue.name)}. ${events.length} nights of tribute concerts and live music. Pick your shows and grab tickets straight from FanGenie${bundles.length ? ', or save with a season bundle' : ''}.</p>
  <div class="facts">
    <span><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${esc(range)}</span>
    <span><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>${events.length} shows${timeNote}</span>
    <a href="https://maps.google.com/?q=${encodeURIComponent(`${venue.name}, ${fullAddress}`)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 12-9 12S3 17 3 10a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>${esc(venue.address)}, ${esc(venue.city)}</a>
    ${bundles.length ? `<a href="#bundles"><svg viewBox="0 0 24 24"><path d="M3 9a2 2 0 002-2 2 2 0 012-2h10a2 2 0 012 2 2 2 0 002 2v6a2 2 0 00-2 2 2 2 0 01-2 2H7a2 2 0 01-2-2 2 2 0 00-2-2z"/><path d="M13 5v14"/></svg>${bundles.length} season bundles</a>` : ''}
  </div>
</section>

<section class="strip" id="strip">
  <div id="onsale">
    <div class="lbl">Public on-sale</div>
    <div id="onsale-body"></div>
  </div>
  ${discount ? `<div class="deal" id="deal">
    <div class="lbl">Season discount</div>
    <div class="big">${discount.amount ? `<em>$${esc(discount.amount)} off</em> every ticket, every show` : `<em>Discount</em> on every ticket`}</div>
    <div class="code"><span id="code-text">${esc(discount.code)}</span><button type="button" id="copy">Copy</button></div>
    <div class="fine">Enter the code at checkout on FanGenie, once per show.${discount.expiresText ? ` Expires ${esc(discount.expiresText)}.` : ''}${discount.note ? ` ${esc(discount.note)}` : ''}</div>
  </div>` : ''}
</section>

<div class="filters">
  <div class="title">All Shows <span id="shown"></span></div>
  <div class="chips" id="chips"></div>
  <label class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="q" type="search" placeholder="Search a show or artist" aria-label="Search shows"></label>
</div>

<div class="grid" id="grid"></div>

${bundles.length ? `<section class="bundles" id="bundles">
  <div class="section-head">
    <div class="kicker"><i></i> Season bundles</div>
    <h2>${esc(String(bundles[0].count || 6))} shows. One price.</h2>
    <p>Pick a themed bundle and lock in every night${bundles.some(b => b.seating) ? ' with reserved or general admission seating' : ''}. Bundles are sold on FanGenie.</p>
  </div>
  <div class="bgrid">
    ${bundles.map((b, i) => `<a class="bundle c${(i + 3) % 10}" href="${esc(b.url)}" target="_blank" rel="noopener">
      <div class="bart">${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}<div class="ph" aria-hidden="true">${esc(b.name)}</div>${b.seating ? `<span class="tag">${esc(b.seating)}</span>` : ''}</div>
      <div class="bbody">
        <h3>${esc(b.name)}</h3>
        ${b.shows.length ? `<ul>${b.shows.map(sh => `<li>${esc(sh)}</li>`).join('')}</ul>` : (b.blurb ? `<p>${esc(b.blurb)}</p>` : '')}
        <div class="bfoot">${b.price != null ? `<span class="bprice"><b>$${esc(b.price)}</b> for ${esc(String(b.count))} shows</span>` : `<span class="bprice">${esc(String(b.count))} shows</span>`}<span class="bcta">Get Bundle ${'<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'}</span></div>
      </div>
    </a>`).join('')}
  </div>
</section>` : ''}

<div class="trust">
  <div><b>Official tickets</b><p>Every link goes straight to the show's page on FanGenie, the venue's official ticketing partner.</p></div>
  <div><b>Open seating</b><p>General admission at the ${esc(venue.name)}, ${esc(venue.address)}, ${esc(venue.city)}, AZ${venue.zipcode ? ' ' + esc(venue.zipcode) : ''}.</p></div>
  <div><b>Questions?</b><p>${venue.phone ? `Call <a href="tel:${esc(venue.phone.replace(/[^\d+]/g, ''))}">${esc(venue.phone)}</a> or ` : ''}see the <a href="${esc(VENUE_PAGE)}" target="_blank" rel="noopener">venue page on FanGenie</a>.</p></div>
</div>

<footer>
  <a href="/">YourConcertTix</a> &middot; Tickets by <a href="https://fangenie.com" target="_blank" rel="noopener">FanGenie</a> &middot; Presented by TAD Management
  <div class="stamp">Listings refresh automatically from FanGenie.</div>
</footer>

<div class="sticky" id="sticky"><a href="#grid">See all ${events.length} shows &amp; get tickets</a></div>

<div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
  <div class="sheet">
    <button class="x" type="button" id="m-close" aria-label="Close">&times;</button>
    <div class="media" id="m-media"></div>
    <div class="inner">
      <div class="meta" id="m-meta"></div>
      <h2 id="m-title"></h2>
      <div class="desc" id="m-desc"></div>
      <div class="actions" id="m-actions"></div>
    </div>
  </div>
</div>

<script>
const DATA = ${dataJs};
const $ = s => document.querySelector(s);
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function hash(s){let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h;}
const ARROW='<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const PLAY='<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';

// Drop anything that has already happened, so the page stays right between refreshes.
const now = Date.now();
const events = DATA.events.filter(e => new Date(e.iso).getTime() > now - 6*3600*1000);
const nextUp = events[0] ? events[0].iso : null;

// ---- on-sale countdown ----
const onsaleEl = $('#onsale-body');
const onSaleAt = DATA.firstOnSale ? new Date(DATA.firstOnSale) : null;
function fmtWhen(d){return d.toLocaleString('en-US',{timeZone:DATA.venue.tz,weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});}
function tickOnSale(){
  if(!onSaleAt || isNaN(onSaleAt) || onSaleAt.getTime() <= Date.now()){
    onsaleEl.innerHTML='<div class="onsale-now"><i></i> Tickets are on sale now</div><div class="when">Choose a show below and buy on FanGenie'+(DATA.discount?' with code <strong>'+esc(DATA.discount.code)+'</strong>':'')+'.</div>';
    return false;
  }
  let s=Math.max(0,Math.floor((onSaleAt.getTime()-Date.now())/1000));
  const d=Math.floor(s/86400); s-=d*86400; const h=Math.floor(s/3600); s-=h*3600; const m=Math.floor(s/60); s-=m*60;
  const p=n=>String(n).padStart(2,'0');
  onsaleEl.innerHTML='<div class="count"><b>'+d+'<small>Days</small></b><span class="sep">:</span><b>'+p(h)+'<small>Hrs</small></b><span class="sep">:</span><b>'+p(m)+'<small>Min</small></b><span class="sep">:</span><b>'+p(s)+'<small>Sec</small></b></div>'+
    '<div class="when">Tickets go on sale <strong>'+esc(fmtWhen(onSaleAt))+'</strong>. Get on the list now and be first in line.</div>';
  return true;
}
if(tickOnSale()){const t=setInterval(()=>{if(!tickOnSale())clearInterval(t);},1000);}

// ---- discount code ----
if(DATA.discount){
  if(DATA.discount.expiresIso && new Date(DATA.discount.expiresIso).getTime() < Date.now()){ const d=$('#deal'); if(d) d.remove(); }
  const btn=$('#copy');
  if(btn) btn.addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(DATA.discount.code);btn.textContent='Copied!';}
    catch(e){const r=document.createRange();r.selectNodeContents($('#code-text'));const sel=getSelection();sel.removeAllRanges();sel.addRange(r);btn.textContent='Selected';}
    setTimeout(()=>btn.textContent='Copy',1800);
  });
}

// ---- filters ----
const months=[];
for(const e of events){let m=months.find(x=>x.key===e.key);if(!m){m={key:e.key,label:e.mon+' '+e.year,count:0};months.push(m);}m.count++;}
let month='', q='';
const chips=$('#chips');
function renderChips(){
  chips.innerHTML=['<button class="chip'+(month?'':' on')+'" data-m="">All <small>'+events.length+'</small></button>']
    .concat(months.map(m=>'<button class="chip'+(month===m.key?' on':'')+'" data-m="'+esc(m.key)+'">'+esc(m.label)+' <small>'+m.count+'</small></button>')).join('');
}
chips.addEventListener('click',ev=>{const b=ev.target.closest('.chip');if(!b)return;month=b.dataset.m;renderChips();applyFilter();});
$('#q').addEventListener('input',ev=>{q=ev.target.value.trim().toLowerCase();applyFilter();});
renderChips();

// ---- grid ----
const grid=$('#grid');
grid.innerHTML=events.map((e,i)=>{
  const c='c'+(hash(e.name)%10);
  const hot=e.iso===nextUp;
  return '<article class="card '+c+'" data-i="'+i+'" data-k="'+esc(e.key)+'" data-s="'+esc((e.name+' '+e.category+' '+e.monLong).toLowerCase())+'" style="animation-delay:'+(0.05*Math.min(i,12))+'s">'+
    '<div class="artwrap"><a class="art" href="'+esc(e.url)+'" target="_blank" rel="noopener" aria-label="Tickets for '+esc(e.name)+'">'+
      (e.poster?'<img src="'+esc(e.poster)+'" alt="'+esc(e.name)+'" loading="'+(i<4?'eager':'lazy')+'" decoding="async" onerror="this.remove()">':'')+
      '<div class="ph" aria-hidden="true">'+esc(e.name)+'</div>'+
      '<div class="date"><b>'+esc(e.day)+'</b><small>'+esc(e.mon)+'</small><i>'+esc(e.dow)+'</i></div>'+
      (hot?'<span class="tag hot">Next up</span>':(e.category?'<span class="tag">'+esc(e.category)+'</span>':''))+
    '</a>'+
    (e.video?'<button class="play" type="button" data-video="'+i+'">'+PLAY+' Promo</button>':'')+'</div>'+
    '<div class="body">'+
      '<h3><small>'+esc(e.dowLong)+', '+esc(e.monLong)+' '+esc(e.day)+' &middot; '+esc(e.time)+'</small>'+esc(e.name)+'</h3>'+
      (e.excerpt?'<p>'+esc(e.excerpt)+'</p>':'')+
      '<button class="more" type="button" data-open="'+i+'">Show details</button>'+
      '<a class="cta" href="'+esc(e.url)+'" target="_blank" rel="noopener">Get Tickets '+ARROW+'</a>'+
    '</div></article>';
}).join('') || '<div class="empty">No upcoming shows listed right now. Check back soon.</div>';

function applyFilter(){
  let n=0;
  for(const c of grid.querySelectorAll('.card')){
    const ok=(!month||c.dataset.k===month)&&(!q||c.dataset.s.includes(q));
    c.classList.toggle('hide',!ok); if(ok)n++;
  }
  $('#shown').textContent=(month||q)?(n+' of '+events.length):(events.length+' shows');
  let empty=grid.querySelector('.empty');
  if(!n&&events.length){if(!empty){empty=document.createElement('div');empty.className='empty';empty.textContent='No shows match. Try another month or search.';grid.appendChild(empty);}}
  else if(empty&&events.length)empty.remove();
}
applyFilter();

// ---- mobile sticky: only while the show grid is off screen ----
if('IntersectionObserver' in window){
  const st=$('#sticky');
  new IntersectionObserver(en=>{st.classList.toggle('off',en.some(x=>x.isIntersecting));},{rootMargin:'0px 0px -40% 0px'}).observe(grid);
}

// ---- modal ----
const modal=$('#modal');
function openModal(i,autoplay){
  const e=events[i]; if(!e) return;
  const art=e.banner||e.poster;
  $('#m-media').innerHTML = (e.video&&autoplay)
    ? '<iframe src="https://www.youtube-nocookie.com/embed/'+esc(e.video)+'?autoplay=1&rel=0" title="Promo video" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>'
    : (art?'<img src="'+esc(art)+'" alt="">':'')+(e.video?'<button class="playbig" type="button" data-video="'+i+'"><span>'+PLAY+' Watch the promo</span></button>':'');
  $('#m-meta').innerHTML='<span><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>'+esc(e.dowLong)+', '+esc(e.monLong)+' '+esc(e.day)+', '+esc(e.year)+'</span>'+
    '<span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'+esc(e.time)+'</span>'+
    (e.category?'<span>'+esc(e.category)+'</span>':'');
  $('#m-title').textContent=e.name;
  $('#m-desc').innerHTML=(e.paragraphs.length?e.paragraphs:['Details coming soon.']).map(p=>'<p>'+esc(p)+'</p>').join('');
  $('#m-actions').innerHTML='<a class="cta" href="'+esc(e.url)+'" target="_blank" rel="noopener">Get Tickets on FanGenie '+ARROW+'</a><a class="ghost" href="https://maps.google.com/?q='+encodeURIComponent(DATA.venue.name+', '+DATA.venue.address)+'" target="_blank" rel="noopener">Directions</a>';
  modal.classList.add('open'); document.body.style.overflow='hidden';
}
function closeModal(){modal.classList.remove('open');document.body.style.overflow='';$('#m-media').innerHTML='';}
document.addEventListener('click',ev=>{
  const o=ev.target.closest('[data-open]'); if(o){openModal(+o.dataset.open,false);return;}
  const v=ev.target.closest('[data-video]'); if(v){openModal(+v.dataset.video,true);return;}
  if(ev.target===modal||ev.target.closest('#m-close'))closeModal();
});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape')closeModal();});
</script>
</body>
</html>
`;
}

// ---- Main ----

async function buildVenue(cfg) {
  const tag = cfg.headline;
  console.log(`${tag}: pulling venue from FanGenie...`);
  const venue = await fetchVenue(cfg.slug);
  console.log(`  ${venue.name} (${venue._id})`);

  console.log(`${tag}: pulling events...`);
  const list = await fetchEventList(venue._id);
  console.log(`  ${list.length} events listed`);

  console.log(`${tag}: pulling event details + season bundles...`);
  const [details, rawBundles] = await Promise.all([fetchDetails(list), fetchBundles(cfg.slug)]);

  const events = buildEvents(list, details, venue);
  try {
    await applyAirtablePosters(cfg, events);
  } catch (err) {
    console.warn(`  WARN Airtable posters skipped: ${err.message}`);
  }
  const bundles = buildBundles(rawBundles);
  const discount = detectDiscount(list.map(e => e.description || ''));
  console.log(`  ${events.length} upcoming events kept; ${bundles.length} bundles${discount ? `; discount code ${discount.code}` : ''}`);
  for (const e of events) console.log(`  ${e.ymd} ${e.time.padEnd(8)} ${e.name}  -> ${e.url}`);
  for (const b of bundles) console.log(`  BUNDLE $${b.price} ${b.name} (${b.seating || 'n/a'})  -> ${b.url}`);

  if (events.length === 0) {
    // Never blank the page because of a transient API hiccup — keep the last good build.
    console.warn(`WARNING: ${tag}: no upcoming events returned; leaving the existing page untouched.`);
    return false;
  }

  const outDir = path.join(repoRoot, cfg.dir);
  const outPath = path.join(outDir, 'index.html');
  const html = renderPage({ cfg, venue, events, discount, bundles });
  if (DRY_RUN) {
    console.log(`[DRY RUN] would write ${outPath} (${html.length} bytes)`);
    return true;
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, html);
  console.log(`Wrote ${outPath} (${html.length} bytes)`);
  return true;
}

async function main() {
  const targets = VENUES.filter(v => !ONLY || v.dir === ONLY);
  if (!targets.length) throw new Error(`no venue with dir "${ONLY}"`);
  let failures = 0;
  for (const cfg of targets) {
    try {
      await buildVenue(cfg);
    } catch (err) {
      // One venue failing must not stop the others from rebuilding.
      failures++;
      console.error(`ERROR: ${cfg.headline}: ${err.message}`);
    }
    console.log('');
  }
  if (failures === targets.length) process.exit(1);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
