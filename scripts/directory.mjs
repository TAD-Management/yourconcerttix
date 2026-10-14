#!/usr/bin/env node
// Venue + city directory — rebuilds /venues/ and /cities/ from what the other
// generators already wrote, so it needs no secrets and runs fine locally.
//
//   /venues/            a tile per venue, grouped by state
//   /venues/<slug>/     every upcoming show at one venue
//   /cities/            a tile per "City, ST", grouped by state
//   /cities/<slug>/     the venues in one city (only for cities with 2+ venues;
//                       a one-venue city's tile links straight to that venue)
//
// Sources:
//   index.html          the homepage's embedded `events` array (scripts/sync.mjs:
//                       Airtable bookings + /admin/ extra shows)
//   <dir>/index.html    the FanGenie venue pages' embedded DATA
//                       (scripts/apache-junction.mjs). A venue with one of these
//                       pages links to it instead of getting a /venues/<slug>/ page,
//                       and Apache Junction (no Airtable ticket links) only
//                       appears in the directory this way.
//
// The GitHub Action runs this after both of those scripts. Both folders are
// rebuilt from scratch so venues with no shows left drop off.
//
// Usage:
//   node scripts/directory.mjs            # rebuild venues/ and cities/
//   node scripts/directory.mjs --dry-run  # just print a summary

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FOLLOW_PITCH, followLinks } from '../lib/social.mjs';
import { FANGENIE_PAGES, STATES, byName, clean, cityFromAddress, fanGeniePage, groupVenues, slugify } from '../lib/directory.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Gradient fallback palette, same as scripts/sync.mjs.
const PALETTE = [
  'linear-gradient(135deg,#e94560,#f5a623)', 'linear-gradient(135deg,#6a11cb,#2575fc)',
  'linear-gradient(135deg,#ff512f,#dd2476)', 'linear-gradient(135deg,#11998e,#38ef7d)',
  'linear-gradient(135deg,#f12711,#f5af19)', 'linear-gradient(135deg,#8e2de2,#4a00e0)',
  'linear-gradient(135deg,#ee0979,#ff6a00)', 'linear-gradient(135deg,#4568dc,#b06ab3)',
  'linear-gradient(135deg,#c94b4b,#4b134f)', 'linear-gradient(135deg,#ff9966,#ff5e62)',
];
function gradFor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function htmlesc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const stateName = st => STATES[st] || st || 'Other';
function shortDate(ymd) {
  return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- Read the generated pages ----

function readHomepageEvents() {
  const html = readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const m = html.match(/const events = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error('no `const events = [...]` in index.html');
  return JSON.parse(m[1]);
}

// ---- Build the venue + city lists ----

function fanGenieShows(data) {
  return data.events.map(e => ({ artist: e.name, date: e.ymd, photo: e.poster }));
}

function buildVenues(events) {
  // A venue with a FanGenie page takes that page's name and show list, since its tile links there.
  const venues = groupVenues(events).map(v => v.fanGenie
    ? { ...v, name: clean(v.fanGenie.data.venue.name) || v.name, shows: fanGenieShows(v.fanGenie.data) }
    : { ...v, shows: v.events.map(e => ({
        artist: e.artist, date: e.date, showtime: e.showtime, ticket: e.ticket, id: e.id,
        slug: e.slug, photo: `/artist-photos/${e.photo || e.slug}.jpg`,
      })) });

  // FanGenie pages with no Airtable twin (Apache Junction) get a tile of their own.
  const claimed = new Set(venues.map(v => v.fanGenie && v.fanGenie.dir));
  for (const p of FANGENIE_PAGES) {
    const data = fanGeniePage(p.dir);
    if (!data || claimed.has(p.dir)) continue;
    const { city, state } = cityFromAddress(data.venue.address);
    venues.push({ name: clean(data.venue.name), city, state, address: clean(data.venue.address), href: `/${p.dir}/`, shows: fanGenieShows(data) });
  }

  for (const v of venues) v.shows.sort((a, b) => a.date.localeCompare(b.date));
  return venues.sort(byName);
}

function buildCities(venues) {
  const groups = new Map();
  for (const v of venues) {
    if (!v.city) continue;
    const key = `${v.city}|${v.state}`.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: v.city, state: v.state, venues: [] });
    groups.get(key).venues.push(v);
  }
  const cities = [...groups.values()].sort(byName);
  for (const c of cities) {
    c.slug = slugify(`${c.name} ${c.state}`);
    c.shows = c.venues.flatMap(v => v.shows).sort((a, b) => a.date.localeCompare(b.date));
    c.href = c.venues.length === 1 ? c.venues[0].href : `/cities/${c.slug}/`;
  }
  return cities;
}

// ---- HTML ----

const CSS = `
:root{--primary:#1a1a2e;--accent:#e94560;--accent2:#f5a623;--bg:#0f0f23;--card-bg:#16213e;--card-border:#1a1a3e;--text:#e8e8f0;--text-muted:#8888aa;}
*{box-sizing:border-box;margin:0;padding:0;}
[hidden]{display:none!important;}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);line-height:1.5;min-height:100vh;display:flex;flex-direction:column;}
a{color:inherit;text-decoration:none;}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--card-border);}
.brand{font-family:'Montserrat',sans-serif;font-weight:800;font-size:20px;letter-spacing:-.3px;}
.brand span{color:var(--accent);}
.top nav{display:flex;gap:8px;}
.top nav a{padding:7px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:var(--card-bg);color:var(--text-muted);font-size:13px;font-weight:600;}
.top nav a:hover,.top nav a.on{border-color:var(--accent);color:var(--accent);}
main{flex:1;width:100%;max-width:1200px;margin:0 auto;padding:0 20px 20px;}
.crumbs{color:var(--text-muted);font-size:14px;padding:18px 0 0;}
.crumbs a:hover{color:var(--accent);}
.head{padding:22px 0 8px;}
.head .kicker{font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--accent2);}
.head h1{font-family:'Montserrat',sans-serif;font-size:36px;line-height:1.1;letter-spacing:-.5px;margin-top:4px;}
.head p{color:var(--text-muted);margin-top:6px;}
.tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:16px 0 4px;}
.tools input{flex:1 1 260px;font:inherit;padding:12px 16px;border-radius:10px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--text);}
.jump{display:flex;flex-wrap:wrap;gap:6px;}
.jump a{padding:6px 11px;border-radius:999px;background:var(--card-bg);border:1px solid var(--card-border);color:var(--text-muted);font-size:13px;font-weight:600;}
.jump a:hover{border-color:var(--accent);color:var(--accent);}
.state{scroll-margin-top:12px;}
.state h2{font-family:'Montserrat',sans-serif;font-size:20px;margin:30px 0 12px;display:flex;align-items:baseline;gap:10px;}
.state h2 small{font-family:'Inter',sans-serif;font-size:13px;font-weight:500;color:var(--text-muted);}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:18px;}
.tile{background:var(--card-bg);border:1px solid var(--card-border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:transform .15s ease,box-shadow .15s ease,border-color .15s;}
.tile:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(0,0,0,.35);border-color:rgba(233,69,96,.5);}
.art{position:relative;aspect-ratio:3/1;overflow:hidden;display:flex;justify-content:center;}
.art .blur{position:absolute;inset:-20px;width:calc(100% + 40px);height:calc(100% + 40px);object-fit:cover;filter:blur(18px) brightness(.55);}
.art .p{position:relative;height:100%;aspect-ratio:1/1;object-fit:cover;display:block;}
.tile-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:2px;flex:1;}
.tile-body h3{font-family:'Montserrat',sans-serif;font-size:18px;line-height:1.25;}
.tile-body .where{color:var(--text-muted);font-size:14px;}
.tile-foot{margin-top:auto;padding-top:12px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;font-size:13px;}
.tile-foot .count{padding:4px 10px;border-radius:999px;background:rgba(233,69,96,.15);color:#ff8095;font-weight:700;}
.tile-foot .next{color:var(--text-muted);}
.tile-foot .go{color:var(--accent);font-weight:700;}
.none{color:var(--text-muted);padding:40px 0;text-align:center;}
.info{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--text-muted);font-size:14px;margin-top:8px;}
.info a{color:var(--text);border-bottom:1px solid rgba(255,255,255,.2);}
.info a:hover{color:var(--accent);border-color:var(--accent);}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px;margin-top:22px;}
.card{background:var(--card-bg);border:1px solid var(--card-border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:transform .15s ease,box-shadow .15s ease;}
.card:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(0,0,0,.3);}
.card-photo-wrap{display:block;position:relative;aspect-ratio:1/1;overflow:hidden;background:var(--primary);}
.card-photo-wrap img{width:100%;height:100%;object-fit:cover;display:block;}
.card-photo-fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:'Montserrat',sans-serif;font-weight:700;color:#fff;text-align:center;padding:16px;font-size:18px;}
.card-body{padding:16px;display:flex;flex-direction:column;gap:8px;flex:1;}
.card-body h3{font-family:'Montserrat',sans-serif;font-size:18px;}
.card-body .meta{color:var(--text-muted);font-size:14px;}
.card-body .meta strong{color:var(--text);}
.card-body .cta{margin-top:auto;padding-top:12px;display:flex;gap:8px;}
.card-body .cta a{flex:1;text-align:center;padding:10px;border-radius:8px;font-weight:600;}
.card-body .cta a.get{background:var(--accent);color:#fff;}
.card-body .cta a.get:hover{background:#ff5872;}
.card-body .cta a.details{border:1px solid var(--card-border);}
.card-body .cta a.details:hover{border-color:var(--accent);color:var(--accent);}
footer{text-align:center;padding:24px;color:var(--text-muted);font-size:13px;border-top:1px solid var(--card-border);margin-top:40px;}
footer a:hover{color:var(--accent);}
.follow{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 12px;margin-bottom:14px;}
.follow-pitch{font-weight:600;color:var(--accent2);}
.follow-links{display:inline-flex;gap:8px;}
.follow-btn{display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.16);color:var(--text);font-weight:600;}
.follow-btn:hover{border-color:var(--accent);}
.follow-btn svg{width:16px;height:16px;flex:0 0 auto;}
@media (max-width:600px){
  .top{padding:12px 16px;} .brand{font-size:17px;} .top nav a{padding:6px 11px;}
  main{padding:0 16px 16px;} .head h1{font-size:28px;}
  .tiles,.grid{grid-template-columns:1fr;gap:12px;}
}`;

function page({ title, description, nav, body, script = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${htmlesc(title)} | YourConcertTix</title>
<meta name="description" content="${htmlesc(description)}">
<meta property="og:title" content="${htmlesc(title)}">
<meta property="og:description" content="${htmlesc(description)}">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@700;800&display=swap" rel="stylesheet">
<style>${CSS}
</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/">Your<span>Concert</span>Tix</a>
  <nav><a href="/venues/"${nav === 'venues' ? ' class="on"' : ''}>Venues</a><a href="/cities/"${nav === 'cities' ? ' class="on"' : ''}>Cities</a></nav>
</header>
<main>
${body}
</main>
<footer>
  <div class="follow"><span class="follow-pitch">${FOLLOW_PITCH}</span><span class="follow-links">${followLinks('follow-btn')}</span></div>
  <a href="/">YourConcertTix</a> &middot; Powered by <a href="https://fangenie.com" target="_blank" rel="noopener">FanGenie</a>
</footer>${script}
</body>
</html>
`;
}

// Acts with no Poster/Portrait have no file in artist-photos/; leave them out of the strip.
function hasPhoto(src) {
  return !!src && (!src.startsWith('/') || existsSync(path.join(repoRoot, src)));
}

// Up to three posters of upcoming shows (one per act), over a blurred copy of the first.
function art(shows, seed) {
  const seen = new Set(), photos = [];
  for (const s of shows) {
    if (!hasPhoto(s.photo) || seen.has(s.photo)) continue;
    seen.add(s.photo);
    photos.push(s);
    if (photos.length === 3) break;
  }
  const hide = `onerror="this.style.display='none'"`;
  return `<div class="art" style="background:${gradFor(seed)}">${photos.length ? `<img class="blur" src="${htmlesc(photos[0].photo)}" alt="" loading="lazy" ${hide}>` : ''}${photos.map(s => `<img class="p" src="${htmlesc(s.photo)}" alt="${htmlesc(s.artist)}" loading="lazy" ${hide}>`).join('')}</div>`;
}

function venueTile(v, { showCity = true } = {}) {
  const next = v.shows[0];
  return `<a class="tile" href="${htmlesc(v.href)}" data-q="${htmlesc(`${v.name} ${v.city} ${v.state} ${stateName(v.state)}`.toLowerCase())}">
      ${art(v.shows, v.name)}
      <div class="tile-body">
        <h3>${htmlesc(v.name)}</h3>
        ${showCity ? `<div class="where">${htmlesc([v.city, v.state].filter(Boolean).join(', '))}</div>` : ''}
        <div class="tile-foot"><span class="count">${plural(v.shows.length, 'show')}</span>${next ? `<span class="next">Next: ${shortDate(next.date)}</span>` : ''}</div>
      </div>
    </a>`;
}

function cityTile(c) {
  return `<a class="tile" href="${htmlesc(c.href)}" data-q="${htmlesc(`${c.name} ${c.state} ${stateName(c.state)} ${c.venues.map(v => v.name).join(' ')}`.toLowerCase())}">
      ${art(c.shows, c.name)}
      <div class="tile-body">
        <h3>${htmlesc(c.name)}, ${htmlesc(c.state)}</h3>
        <div class="where">${c.venues.length === 1 ? htmlesc(c.venues[0].name) : plural(c.venues.length, 'venue')}</div>
        <div class="tile-foot"><span class="count">${plural(c.shows.length, 'show')}</span><span class="go">${c.venues.length === 1 ? 'See the shows' : 'See the venues'} &rarr;</span></div>
      </div>
    </a>`;
}

// Tiles grouped under a heading per state, with jump links and a filter box.
function directoryBody({ kicker, title, intro, items, tile, placeholder }) {
  const states = [...new Set(items.map(i => i.state))].sort((a, b) => stateName(a).localeCompare(stateName(b)));
  const sections = states.map(st => {
    const list = items.filter(i => i.state === st);
    return `<section class="state" id="${htmlesc(st.toLowerCase())}">
  <h2>${htmlesc(stateName(st))} <small>${plural(list.length, title === 'Venues' ? 'venue' : 'city', title === 'Venues' ? 'venues' : 'cities')}</small></h2>
  <div class="tiles">
    ${list.map(tile).join('\n    ')}
  </div>
</section>`;
  }).join('\n');
  return `<div class="head">
  <div class="kicker">${kicker}</div>
  <h1>${title}</h1>
  <p>${intro}</p>
</div>
<div class="tools">
  <input id="filter" type="search" placeholder="${htmlesc(placeholder)}" aria-label="${htmlesc(placeholder)}">
  <nav class="jump" aria-label="Jump to a state">${states.map(st => `<a href="#${htmlesc(st.toLowerCase())}">${htmlesc(st)}</a>`).join('')}</nav>
</div>
${sections}
<p class="none" id="none" hidden>Nothing matches that search.</p>`;
}

const FILTER_SCRIPT = `
<script>
(function(){
  var f=document.getElementById('filter');
  function run(){
    var q=f.value.trim().toLowerCase(),any=false;
    document.querySelectorAll('.state').forEach(function(s){
      var shown=0;
      s.querySelectorAll('.tile').forEach(function(t){var ok=!q||t.dataset.q.indexOf(q)>-1;t.hidden=!ok;if(ok)shown++;});
      s.hidden=!shown;if(shown)any=true;
    });
    document.getElementById('none').hidden=any;
  }
  f.addEventListener('input',run);
})();
</script>`;

function renderVenuesIndex(venues, cities) {
  const states = new Set(venues.map(v => v.state));
  return page({
    title: 'Venues',
    description: `Upcoming concerts at ${venues.length} venues. Pick a venue to see every show there.`,
    nav: 'venues',
    body: directoryBody({
      kicker: 'Browse by venue',
      title: 'Venues',
      intro: `${plural(venues.length, 'venue')} in ${plural(cities.length, 'city', 'cities')} across ${plural(states.size, 'state')}. Pick one to see every upcoming show there.`,
      items: venues,
      tile: v => venueTile(v),
      placeholder: 'Search venue, city or state...',
    }),
    script: FILTER_SCRIPT,
  });
}

function renderCitiesIndex(cities) {
  const states = new Set(cities.map(c => c.state));
  return page({
    title: 'Cities',
    description: `Upcoming concerts in ${cities.length} cities. Pick a city to see its venues and shows.`,
    nav: 'cities',
    body: directoryBody({
      kicker: 'Browse by city, state',
      title: 'Cities',
      intro: `${plural(cities.length, 'city', 'cities')} across ${plural(states.size, 'state')}. Pick one to see its venues and shows.`,
      items: cities,
      tile: cityTile,
      placeholder: 'Search city, state or venue...',
    }),
    script: FILTER_SCRIPT,
  });
}

// Same card as the homepage grid.
function showCard(s) {
  const eventUrl = `/events/${s.id}/`;
  const ticket = s.ticket ? `<a class="get" href="${htmlesc(s.ticket)}" target="_blank" rel="noopener">Get Tickets</a>` : '';
  const dateStr = new Date(s.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `<div class="card">
    <a class="card-photo-wrap" href="${eventUrl}">
      <img src="${htmlesc(s.photo)}" alt="${htmlesc(s.artist)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="card-photo-fallback" style="display:none;background:${gradFor(s.slug || s.artist)}">${htmlesc(s.artist)}</div>
    </a>
    <div class="card-body">
      <h3><a href="${eventUrl}">${htmlesc(s.artist)}</a></h3>
      <div class="meta"><strong>${dateStr}</strong>${s.showtime ? ' &middot; ' + htmlesc(s.showtime) : ''}</div>
      <div class="cta">${ticket}<a class="details" href="${eventUrl}">Details</a></div>
    </div>
  </div>`;
}

function renderVenuePage(v, city) {
  const where = [v.city, v.state].filter(Boolean).join(', ');
  const cityLink = city ? `<a href="${htmlesc(city.href === v.href ? '/cities/#' + v.state.toLowerCase() : city.href)}">${htmlesc(where)}</a>` : htmlesc(where);
  return page({
    title: `${v.name}${where ? ', ' + where : ''}`,
    description: `${plural(v.shows.length, 'upcoming show')} at ${v.name}${where ? ' in ' + where : ''}. Get tickets on YourConcertTix.`,
    nav: 'venues',
    body: `<div class="crumbs"><a href="/venues/">&larr; All venues</a></div>
<div class="head">
  <div class="kicker">Venue</div>
  <h1>${htmlesc(v.name)}</h1>
  <div class="info"><span>${cityLink}</span>${v.address ? `<span>${htmlesc(v.address)}</span>` : ''}<span>${plural(v.shows.length, 'upcoming show')}</span></div>
</div>
<div class="grid">
  ${v.shows.map(showCard).join('\n  ')}
</div>`,
  });
}

function renderCityPage(c) {
  return page({
    title: `${c.name}, ${c.state}`,
    description: `${plural(c.venues.length, 'venue')} with ${plural(c.shows.length, 'upcoming show')} in ${c.name}, ${c.state}.`,
    nav: 'cities',
    body: `<div class="crumbs"><a href="/cities/">&larr; All cities</a></div>
<div class="head">
  <div class="kicker">${htmlesc(stateName(c.state))}</div>
  <h1>${htmlesc(c.name)}, ${htmlesc(c.state)}</h1>
  <p>${plural(c.venues.length, 'venue')} &middot; ${plural(c.shows.length, 'upcoming show')}. Pick a venue to see its shows.</p>
</div>
<div class="tiles" style="margin-top:22px">
  ${c.venues.map(v => venueTile(v, { showCity: false })).join('\n  ')}
</div>`,
  });
}

// ---- Main ----

function main() {
  const events = readHomepageEvents();
  const venues = buildVenues(events);
  const cities = buildCities(venues);
  // Never blank the directory because an upstream build came back empty.
  if (!venues.length) throw new Error('no venues found; leaving venues/ and cities/ untouched');

  const files = new Map();
  files.set('venues/index.html', renderVenuesIndex(venues, cities));
  files.set('cities/index.html', renderCitiesIndex(cities));
  const cityOf = new Map(cities.flatMap(c => c.venues.map(v => [v, c])));
  for (const v of venues) {
    if (v.href === `/venues/${v.slug}/`) files.set(`venues/${v.slug}/index.html`, renderVenuePage(v, cityOf.get(v)));
  }
  for (const c of cities) {
    if (c.href === `/cities/${c.slug}/`) files.set(`cities/${c.slug}/index.html`, renderCityPage(c));
  }

  console.log(`${venues.length} venues, ${cities.length} cities (${cities.filter(c => c.venues.length > 1).length} with 2+ venues)`);
  for (const v of venues) console.log(`  ${String(v.shows.length).padStart(3)}  ${v.name} (${v.city}, ${v.state}) -> ${v.href}`);
  if (DRY_RUN) {
    console.log(`[DRY RUN] would write ${files.size} pages under venues/ and cities/`);
    return;
  }
  rmSync(path.join(repoRoot, 'venues'), { recursive: true, force: true });
  rmSync(path.join(repoRoot, 'cities'), { recursive: true, force: true });
  for (const [rel, html] of files) {
    const out = path.join(repoRoot, rel);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, html);
  }
  console.log(`Wrote ${files.size} pages under venues/ and cities/`);
}

try {
  main();
} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
}
