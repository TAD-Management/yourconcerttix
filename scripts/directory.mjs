#!/usr/bin/env node
// Venue, city + artist directory — rebuilds /venues/, /cities/ and /artists/
// from what the other generators already wrote, so it needs no secrets and runs
// fine locally.
//
//   /venues/            a tile per venue, grouped by state
//   /venues/<slug>/     every upcoming show at one venue
//   /cities/            a tile per "City, ST", grouped by state
//   /cities/<slug>/     the venues in one city (only for cities with 2+ venues;
//                       a one-venue city's tile links straight to that venue)
//   /artists/           a search box only: type a name (or who they pay tribute
//                       to) and pick the act. Deliberately not a list of every act.
//   /artists/<slug>/    every upcoming date for one act, to share when promoting
//                       its tour (grouping in lib/artists.mjs)
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
//   events/<id>/        an act's tagline, bio and promo video for its artist page
//
// The GitHub Action runs this after both of those scripts. All three folders are
// rebuilt from scratch so venues and acts with no shows left drop off.
//
// Usage:
//   node scripts/directory.mjs            # rebuild venues/, cities/ and artists/
//   node scripts/directory.mjs --dry-run  # just print a summary

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { followLinks } from '../lib/social.mjs';
import { FANGENIE_PAGES, STATES, byName, clean, cityFromAddress, fanGeniePage, groupVenues, slugify } from '../lib/directory.mjs';
import { groupArtists } from '../lib/artists.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const SITE_ORIGIN = 'https://yourconcerttix.com';
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
.follow-links{display:inline-flex;gap:8px;}
.follow-btn{display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.16);color:var(--text);font-weight:600;}
.follow-btn:hover{border-color:var(--accent);}
.follow-btn svg{width:16px;height:16px;flex:0 0 auto;}
.finder{max-width:680px;margin:0 auto;padding:44px 0 10px;text-align:center;}
.finder .kicker{font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--accent2);}
.finder h1{font-family:'Montserrat',sans-serif;font-size:36px;line-height:1.1;letter-spacing:-.5px;margin-top:4px;}
.finder>p{color:var(--text-muted);margin-top:8px;}
.find-box{position:relative;margin-top:24px;}
.find-box svg{position:absolute;left:18px;top:50%;transform:translateY(-50%);width:20px;height:20px;color:var(--text-muted);pointer-events:none;}
.find-box input{width:100%;font:inherit;font-size:18px;padding:17px 18px 17px 50px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:var(--card-bg);color:var(--text);}
.find-box input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(233,69,96,.22);}
.results{list-style:none;margin-top:12px;text-align:left;display:flex;flex-direction:column;gap:8px;}
.results a{display:flex;align-items:center;gap:14px;padding:10px 16px 10px 10px;border-radius:12px;background:var(--card-bg);border:1px solid var(--card-border);transition:border-color .15s;}
.results a:hover,.results a.on{border-color:var(--accent);}
.results .ph{width:56px;height:56px;border-radius:8px;flex:0 0 auto;overflow:hidden;display:flex;align-items:center;justify-content:center;font-family:'Montserrat',sans-serif;font-weight:800;font-size:20px;color:#fff;}
.results .ph img{width:100%;height:100%;object-fit:cover;display:block;}
.results .t{flex:1;min-width:0;}
.results .n,.results .s{display:block;}
.results .n{font-family:'Montserrat',sans-serif;font-weight:700;font-size:17px;line-height:1.25;}
.results .s{color:var(--text-muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.results .c{flex:0 0 auto;padding:4px 10px;border-radius:999px;background:rgba(233,69,96,.15);color:#ff8095;font-size:13px;font-weight:700;}
.hint{color:var(--text-muted);font-size:14px;margin-top:16px;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:8px;}
.hint button{font:inherit;font-size:13px;font-weight:600;padding:6px 12px;border-radius:999px;border:1px solid var(--card-border);background:var(--card-bg);color:var(--text);cursor:pointer;}
.hint button:hover{border-color:var(--accent);color:var(--accent);}
.finder .none{padding:24px 0 0;}
.finder .none a,.alt a{color:var(--text);border-bottom:1px solid rgba(255,255,255,.25);}
.finder .none a:hover,.alt a:hover{color:var(--accent);border-color:var(--accent);}
.alt{color:var(--text-muted);font-size:14px;margin-top:28px;}
.artist{display:grid;grid-template-columns:minmax(0,340px) minmax(0,1fr);gap:36px;align-items:start;padding:20px 0 6px;}
.poster{position:relative;aspect-ratio:1/1;border-radius:16px;overflow:hidden;background:var(--primary);box-shadow:0 24px 60px -24px rgba(0,0,0,.7);}
.poster img{width:100%;height:100%;object-fit:cover;display:block;}
.poster .fb{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font-family:'Montserrat',sans-serif;font-weight:800;font-size:28px;color:#fff;}
.artist .kicker{font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--accent2);}
.artist h1{font-family:'Montserrat',sans-serif;font-size:42px;line-height:1.08;letter-spacing:-.5px;margin-top:6px;}
.artist .tagline{color:var(--text-muted);font-size:17px;font-style:italic;margin-top:6px;}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;}
.stats span{padding:5px 12px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid var(--card-border);font-size:13px;font-weight:600;}
.stats span.hot{background:rgba(233,69,96,.15);border-color:transparent;color:#ff8095;}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px;}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;border-radius:10px;font:inherit;font-weight:700;font-size:15px;cursor:pointer;border:1px solid transparent;}
.btn.primary{background:var(--accent);color:#fff;}
.btn.primary:hover{background:#ff5872;}
.btn.ghost{background:transparent;border-color:rgba(255,255,255,.2);color:var(--text);}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent);}
.btn svg{width:17px;height:17px;}
.bio{color:var(--text-muted);font-size:15px;margin-top:20px;}
.bio p+p{margin-top:10px;}
.bio.clamp{max-height:9em;overflow:hidden;position:relative;}
.bio.clamp::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2.6em;background:linear-gradient(transparent,var(--bg));}
.bio.clamp.open{max-height:none;}
.bio.clamp.open::after{display:none;}
.more{background:none;border:0;color:var(--accent);font:inherit;font-weight:600;cursor:pointer;padding:6px 0;}
.more:hover{text-decoration:underline;}
.section-title{font-family:'Montserrat',sans-serif;font-size:24px;margin:36px 0 14px;scroll-margin-top:14px;}
.dates{display:flex;flex-direction:column;gap:10px;}
.date{display:grid;grid-template-columns:70px minmax(0,1fr) auto;gap:18px;align-items:center;padding:14px 16px;background:var(--card-bg);border:1px solid var(--card-border);border-radius:14px;}
.cal{text-align:center;border-radius:10px;background:rgba(233,69,96,.13);padding:7px 0 6px;line-height:1.1;}
.cal b{display:block;font-family:'Montserrat',sans-serif;font-size:26px;font-weight:800;}
.cal span{display:block;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#ff8095;}
.cal small{display:block;font-size:11px;color:var(--text-muted);margin-top:2px;}
.date .v{font-family:'Montserrat',sans-serif;font-weight:700;font-size:17px;line-height:1.3;}
.date .v a{border-bottom:1px solid rgba(255,255,255,.2);}
.date .v a:hover{color:var(--accent);border-color:var(--accent);}
.date .sub{color:var(--text-muted);font-size:14px;margin-top:2px;}
.date .go{display:flex;gap:8px;}
.date .go a{padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px;text-align:center;white-space:nowrap;}
.date .go a.get{background:var(--accent);color:#fff;}
.date .go a.get:hover{background:#ff5872;}
.date .go a.details{border:1px solid rgba(255,255,255,.14);}
.date .go a.details:hover{border-color:var(--accent);color:var(--accent);}
.video{max-width:760px;position:relative;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:#000;}
.video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;}
@media (max-width:760px){
  .artist{grid-template-columns:1fr;gap:20px;}
  .poster{max-width:420px;width:100%;}
  .artist h1{font-size:32px;}
  .date{grid-template-columns:60px minmax(0,1fr);gap:12px 14px;}
  .date .go{grid-column:1/-1;}
  .date .go a{flex:1;}
}
@media (max-width:600px){
  .top{padding:12px 16px;} .brand{font-size:17px;} .top nav{gap:6px;} .top nav a{padding:6px 10px;font-size:12px;}
  main{padding:0 16px 16px;} .head h1,.finder h1{font-size:28px;}
  .finder{padding-top:28px;} .find-box input{font-size:16px;}
  .tiles,.grid{grid-template-columns:1fr;gap:12px;}
}`;

function page({ title, description, nav, body, script = '', head = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${htmlesc(title)} | YourConcertTix</title>
<meta name="description" content="${htmlesc(description)}">
<meta property="og:title" content="${htmlesc(title)}">
<meta property="og:description" content="${htmlesc(description)}">
<meta property="og:type" content="website">${head}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@700;800&display=swap" rel="stylesheet">
<style>${CSS}
</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/">Your<span>Concert</span>Tix</a>
  <nav><a href="/venues/"${nav === 'venues' ? ' class="on"' : ''}>Venues</a><a href="/cities/"${nav === 'cities' ? ' class="on"' : ''}>Cities</a><a href="/artists/"${nav === 'artists' ? ' class="on"' : ''}>Artists</a></nav>
</header>
<main>
${body}
</main>
<footer>
  <div class="follow"><span class="follow-links">${followLinks('follow-btn')}</span></div>
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

// ---- Artists ----

const unesc = s => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[c]));
const plainText = html => unesc(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const ytEmbed = id => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;

// Tagline, bio and promo video for an artist page, as HTML that is already
// escaped. Airtable acts take them from one of their event pages (scripts/sync.mjs
// writes them there); FanGenie-only acts from the FanGenie show.
function artistExtras(a) {
  if (a.fanGenie) {
    const fg = a.fanGenie;
    return {
      // FanGenie text sometimes still carries an entity ("70s &amp; 80s").
      tagline: htmlesc(unesc(fg.subtitle)),
      bio: fg.paragraphs.map(p => `<p>${htmlesc(unesc(p))}</p>`).join(''),
      video: fg.video ? ytEmbed(fg.video) : '',
    };
  }
  for (const s of a.shows) {
    const file = path.join(repoRoot, s.href, 'index.html');
    if (!s.href.startsWith('/events/') || !existsSync(file)) continue;
    const html = readFileSync(file, 'utf8');
    const grab = re => (html.match(re) || [])[1] || '';
    // A FanGenie title's subtitle stands in for a missing tagline ("Neil Diamond Tribute").
    const sub = (a.shows.find(x => x.title && / - /.test(x.title)) || { title: '' }).title.split(' - ').slice(1).join(' - ');
    return {
      tagline: grab(/<p class="tagline">([\s\S]*?)<\/p>/) || htmlesc(sub),
      bio: grab(/<div class="desc clamp">([\s\S]*?)<\/div>/),
      video: grab(/<div class="promo-video">\s*<iframe src="([^"]+)"/),
      videoLink: grab(/<a class="watch-promo" href="([^"]+)"/),
    };
  }
  return {};
}

function cityCount(a) {
  return new Set(a.shows.map(s => `${s.city}|${s.state}`.toLowerCase())).size;
}

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// The finder: one search box, results only once something is typed. The acts
// ride along as JSON (name, tagline and FanGenie titles are searchable, so
// "Neil Diamond" finds Hot August Night).
function renderArtistsIndex(artists) {
  const index = artists.map(a => {
    const x = a.extras;
    const tagline = plainText(x.tagline || '');
    return {
      n: a.name, u: a.href, t: tagline, c: a.shows.length, x: shortDate(a.shows[0].date),
      p: hasPhoto(a.photo) ? a.photo : '', g: gradFor(a.slug),
      k: [a.name, tagline, ...a.shows.map(s => s.title || '')].join(' '),
    };
  });
  const top = [...artists].sort((a, b) => b.shows.length - a.shows.length).slice(0, 3);
  return page({
    title: 'Find an artist',
    description: 'Type an artist or the star they pay tribute to and see every upcoming date.',
    nav: 'artists',
    body: `<div class="finder">
  <div class="kicker">Search by artist</div>
  <h1>Who do you want to see?</h1>
  <p>Type an act, or the star they pay tribute to, and see every upcoming date.</p>
  <div class="find-box">${SEARCH_ICON}<input id="q" type="search" placeholder="e.g. Garth, Eagles, Neil Diamond..." aria-label="Search for an artist" autocomplete="off" autofocus></div>
  <ul class="results" id="results"></ul>
  <div class="hint" id="hint"><span>Popular:</span>${top.map(a => `<button type="button" data-q="${htmlesc(a.name)}">${htmlesc(a.name)}</button>`).join('')}</div>
  <p class="none" id="none" hidden>No upcoming shows for that artist. Try <a href="/venues/">venues</a> or <a href="/cities/">cities</a> instead.</p>
  <p class="alt">Or browse by <a href="/venues/">venue</a> or <a href="/cities/">city</a>.</p>
</div>`,
    script: `
<script>
(function(){
  var A=${JSON.stringify(index).replace(/</g, '\\u003c')};
  var q=document.getElementById('q'),out=document.getElementById('results'),hint=document.getElementById('hint'),none=document.getElementById('none'),sel=0,hits=[];
  function norm(s){return String(s).toLowerCase().replace(/&/g,' and ').replace(/['\\u2019]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  A.forEach(function(a){a.nn=norm(a.n);a.kk=' '+norm(a.k)+' ';});
  // Name starts with the query > a word of the name does > name contains it > only the tagline/titles match.
  function score(a,qn){
    if(!qn.split(' ').every(function(w){return a.kk.indexOf(w)>-1;}))return -1;
    var n=a.nn.replace(/^the /,'');
    if(n.indexOf(qn)===0||a.nn.indexOf(qn)===0)return 3;
    if((' '+a.nn).indexOf(' '+qn)>-1)return 2;
    return a.nn.indexOf(qn)>-1?1:0;
  }
  function paint(){
    out.innerHTML=hits.map(function(a,i){
      return '<li><a href="'+esc(a.u)+'"'+(i===sel?' class="on"':'')+'><span class="ph" style="background:'+a.g+'">'+(a.p?'<img src="'+esc(a.p)+'" alt="" loading="lazy" onerror="this.remove()">':'')+'</span>'+
        '<span class="t"><span class="n">'+esc(a.n)+'</span><span class="s">'+esc(a.t?a.t+' \\u00b7 ':'')+'Next: '+esc(a.x)+'</span></span>'+
        '<span class="c">'+a.c+(a.c===1?' show':' shows')+'</span></a></li>';
    }).join('');
  }
  function run(){
    var qn=norm(q.value);
    hint.hidden=!!qn;
    sel=0;
    hits=qn?A.map(function(a){return {a:a,s:score(a,qn)};}).filter(function(h){return h.s>=0;})
      .sort(function(x,y){return y.s-x.s||y.a.c-x.a.c;}).slice(0,8).map(function(h){return h.a;}):[];
    none.hidden=!qn||hits.length>0;
    paint();
  }
  q.addEventListener('input',run);
  q.addEventListener('keydown',function(e){
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){if(!hits.length)return;e.preventDefault();sel=(sel+(e.key==='ArrowDown'?1:hits.length-1))%hits.length;paint();}
    else if(e.key==='Enter'&&hits[sel]){e.preventDefault();location.href=hits[sel].u;}
  });
  hint.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;q.value=b.dataset.q;run();q.focus();});
  // /artists/?q=garth arrives pre-filled.
  var q0=new URLSearchParams(location.search).get('q');if(q0){q.value=q0;}
  run();
})();
</script>`,
  });
}

function dateRow(s) {
  const d = new Date(s.date + 'T12:00:00Z');
  const part = opts => d.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
  const where = [s.city, s.state].filter(Boolean).join(', ');
  const venue = s.venueHref ? `<a href="${htmlesc(s.venueHref)}">${htmlesc(s.venue)}</a>` : htmlesc(s.venue || where);
  const sub = [part({ weekday: 'long' }), s.showtime, s.venue ? where : ''].filter(Boolean).map(htmlesc).join(' &middot; ');
  return `<div class="date">
    <div class="cal"><span>${part({ month: 'short' })}</span><b>${part({ day: 'numeric' })}</b><small>${part({ year: 'numeric' })}</small></div>
    <div><div class="v">${venue}</div><div class="sub">${sub}</div></div>
    <div class="go">${s.ticket ? `<a class="get" href="${htmlesc(s.ticket)}" target="_blank" rel="noopener">Get Tickets</a>` : ''}<a class="details" href="${htmlesc(s.href)}">Details</a></div>
  </div>`;
}

function renderArtistPage(a) {
  const x = a.extras;
  const n = a.shows.length, cities = cityCount(a);
  const url = `${SITE_ORIGIN}${a.href}`;
  const photo = hasPhoto(a.photo) ? a.photo : '';
  const states = [...new Set(a.shows.map(s => s.state).filter(Boolean))];
  const tagline = plainText(x.tagline || '');
  const description = `${a.name}${tagline ? ` (${tagline})` : ''}: ${plural(n, 'upcoming show')}${states.length ? ` in ${states.join(', ')}` : ''}. Get tickets on YourConcertTix.`;
  const video = x.video
    ? `<h2 class="section-title">Watch</h2>
<div class="video"><iframe src="${htmlesc(x.video)}" title="${htmlesc(a.name)} promo video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`
    : x.videoLink ? `<p class="alt"><a href="${htmlesc(x.videoLink)}" target="_blank" rel="noopener">&#9654; Watch the promo video</a></p>` : '';
  return page({
    title: `${a.name}${tagline ? ' · ' + tagline : ''}`,
    description,
    nav: 'artists',
    head: `
<link rel="canonical" href="${htmlesc(url)}">
<meta property="og:url" content="${htmlesc(url)}">${photo ? `
<meta property="og:image" content="${htmlesc(photo.startsWith('/') ? SITE_ORIGIN + photo : photo)}">` : ''}`,
    body: `<div class="crumbs"><a href="/artists/">&larr; Find another artist</a></div>
<div class="artist">
  <div class="poster" style="background:${gradFor(a.slug)}">${photo ? `<img src="${htmlesc(photo)}" alt="${htmlesc(a.name)}" onerror="this.remove()">` : `<div class="fb">${htmlesc(a.name)}</div>`}</div>
  <div>
    <div class="kicker">${n > 1 ? 'Live on tour' : 'Live in concert'}</div>
    <h1>${htmlesc(a.name)}</h1>
    ${x.tagline ? `<p class="tagline">${x.tagline}</p>` : ''}
    <div class="stats"><span class="hot">${plural(n, 'upcoming show')}</span>${cities > 1 ? `<span>${plural(cities, 'city', 'cities')}</span>` : ''}<span>Next: ${shortDate(a.shows[0].date)}</span></div>
    <div class="actions"><a class="btn primary" href="#dates">${n > 1 ? 'See all dates' : 'See the date'} &darr;</a><button class="btn ghost" type="button" id="share" data-url="${htmlesc(url)}">${SHARE_ICON}<span>Share</span></button></div>
    ${x.bio ? `<div class="bio clamp">${x.bio}</div><button class="more" type="button" hidden>Read more&hellip;</button>` : ''}
  </div>
</div>
<h2 class="section-title" id="dates">Upcoming dates</h2>
<div class="dates">
  ${a.shows.map(dateRow).join('\n  ')}
</div>
${video}`,
    script: `
<script>
(function(){
  var d=document.querySelector('.bio.clamp'),m=document.querySelector('.more');
  // Only offer "Read more" when the bio is actually cut off.
  if(d&&m&&d.scrollHeight>d.clientHeight+4){m.hidden=false;m.addEventListener('click',function(){var o=d.classList.toggle('open');m.innerHTML=o?'Read less':'Read more&hellip;';});}
  var b=document.getElementById('share'),label=b.querySelector('span');
  b.addEventListener('click',function(){
    var url=b.dataset.url;
    // Phones get the share sheet; desktops copy the link.
    if(navigator.share&&matchMedia('(pointer:coarse)').matches){navigator.share({title:document.title,url:url}).catch(function(){});return;}
    function done(t){label.textContent=t;setTimeout(function(){label.textContent='Share';},2000);}
    if(navigator.clipboard)navigator.clipboard.writeText(url).then(function(){done('Link copied!');},function(){prompt('Copy this link:',url);});
    else prompt('Copy this link:',url);
  });
})();
</script>`,
  });
}

// ---- Main ----

function main() {
  const events = readHomepageEvents();
  const venues = buildVenues(events);
  const cities = buildCities(venues);
  // Never blank the directory because an upstream build came back empty.
  if (!venues.length) throw new Error('no venues found; leaving venues/, cities/ and artists/ untouched');
  const artists = groupArtists(events);
  for (const a of artists) a.extras = artistExtras(a);

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
  files.set('artists/index.html', renderArtistsIndex(artists));
  for (const a of artists) files.set(`artists/${a.slug}/index.html`, renderArtistPage(a));

  console.log(`${venues.length} venues, ${cities.length} cities (${cities.filter(c => c.venues.length > 1).length} with 2+ venues)`);
  for (const v of venues) console.log(`  ${String(v.shows.length).padStart(3)}  ${v.name} (${v.city}, ${v.state}) -> ${v.href}`);
  console.log(`${artists.length} artists (${artists.filter(a => a.fanGenie).length} only on FanGenie venue pages)`);
  if (DRY_RUN) {
    console.log(`[DRY RUN] would write ${files.size} pages under venues/, cities/ and artists/`);
    return;
  }
  rmSync(path.join(repoRoot, 'venues'), { recursive: true, force: true });
  rmSync(path.join(repoRoot, 'cities'), { recursive: true, force: true });
  rmSync(path.join(repoRoot, 'artists'), { recursive: true, force: true });
  for (const [rel, html] of files) {
    const out = path.join(repoRoot, rel);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, html);
  }
  console.log(`Wrote ${files.size} pages under venues/, cities/ and artists/`);
}

try {
  main();
} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
}
