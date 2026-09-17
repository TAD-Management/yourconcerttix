#!/usr/bin/env node
// Affiliate pages — builds /a/<handle>/ (all venues) and /a/<handle>/<venue>/
// for every Active row in the Airtable AFFILIATES table, using the links in
// AFFILIATE LINKS. Show details (name, date, image, venue) come fresh from
// FanGenie's public affiliate-events feed, so a show that has passed or lost
// its commission simply drops off the page; the stored rows are left alone.
//
// Runs in the GitHub Action after scripts/sync.mjs. Needs AIRTABLE_PAT.
//
// Usage:
//   node scripts/affiliates.mjs                    # rebuild every affiliate page
//   node scripts/affiliates.mjs --only terry       # just one handle
//   node scripts/affiliates.mjs --dry-run          # summary only, write nothing
//   node scripts/affiliates.mjs --fixture f.json   # local preview without a PAT:
//        { "affiliates": [{ "id": "recX", "fields": {...} }], "links": [{ "fields": {...} }] }

import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as fg from '../lib/fangenie.mjs';
import { AFFILIATES_TABLE, LINKS_TABLE, listAll, updateAll } from '../lib/airtable.mjs';
import { venueInfo } from '../lib/venues.mjs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const flag = name => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; };
const ONLY = flag('--only');
const FIXTURE = flag('--fixture');

const SITE_ORIGIN = 'https://yourconcerttix.com';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(repoRoot, 'a');

// ---- data ----

async function loadAirtable() {
  if (FIXTURE) {
    const fx = JSON.parse(readFileSync(path.resolve(FIXTURE), 'utf8'));
    return { affiliates: fx.affiliates || [], links: fx.links || [] };
  }
  if (!process.env.AIRTABLE_PAT) {
    console.log('AIRTABLE_PAT not set: nothing to build (pass --fixture for a local preview).');
    return null;
  }
  const [affiliates, links] = await Promise.all([
    listAll(AFFILIATES_TABLE, { filterByFormula: `{Status}='Active'` }),
    listAll(LINKS_TABLE, { filterByFormula: `NOT({Hidden})` }),
  ]);
  return { affiliates, links };
}

function fmt(date, tz, opts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(date);
}

// Join the affiliate's rows with the live feed; returns shows sorted by date.
function buildShows(rows, eventsById) {
  const now = Date.now();
  const shows = [];
  for (const r of rows) {
    const f = r.fields;
    const ev = eventsById.get(String(f['Event ID'] || ''));
    if (!ev || !f.Link) continue;
    const when = new Date(ev.date);
    if (isNaN(when) || when.getTime() < now - 6 * 3600 * 1000) continue;
    const tz = ev.timezone || 'America/Phoenix';
    const venue = ev.venueId || {};
    const vid = String(venue._id || '');
    const known = venueInfo(vid, venue.name);
    const gallery = (ev.galleryImages || []).filter(Boolean);
    shows.push({
      id: String(ev._id),
      name: ev.name,
      url: f.Link,
      iso: when.toISOString(),
      dow: fmt(when, tz, { weekday: 'short' }),
      dowLong: fmt(when, tz, { weekday: 'long' }),
      day: fmt(when, tz, { day: 'numeric' }),
      mon: fmt(when, tz, { month: 'short' }),
      monLong: fmt(when, tz, { month: 'long' }),
      year: fmt(when, tz, { year: 'numeric' }),
      time: fmt(when, tz, { hour: 'numeric', minute: '2-digit' }),
      poster: ev.heroBannerImageMobile || gallery[0] || ev.heroBannerImage || '',
      venue: {
        id: vid,
        name: venue.name || 'Venue',
        short: known.short,
        dir: known.dir,
        city: ev.city || '',
        state: ev.state || '',
        address: ev.address || '',
      },
    });
  }
  shows.sort((a, b) => a.iso.localeCompare(b.iso));
  return shows;
}

function groupVenues(shows) {
  const venues = [];
  for (const s of shows) {
    let v = venues.find(x => x.dir === s.venue.dir);
    if (!v) { v = { ...s.venue, shows: [] }; venues.push(v); }
    v.shows.push(s);
  }
  venues.sort((a, b) => b.shows.length - a.shows.length || a.short.localeCompare(b.short));
  return venues;
}

// ---- render ----

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPage({ affiliate, venues, shows, current }) {
  const handle = affiliate.fields.Handle;
  const name = affiliate.fields['Display Name'] || handle;
  const headline = affiliate.fields.Headline || '';
  const photo = (affiliate.fields.Photo || [])[0];
  const photoUrl = photo ? ((photo.thumbnails && photo.thumbnails.large && photo.thumbnails.large.url) || photo.url) : '';
  const base = `/a/${handle}/`;
  const pagePath = current ? `${base}${current.dir}/` : base;
  const listed = current ? current.shows : shows;
  const title = current ? `${name}'s picks at ${current.short}` : `${name}'s picks`;
  const first = listed[0], last = listed[listed.length - 1];
  const range = first && last ? (first.mon === last.mon && first.year === last.year
    ? `${first.monLong} ${first.year}`
    : `${first.mon} ${first.year === last.year ? '' : first.year + ' '}– ${last.mon} ${last.year}`) : '';
  const descLine = current
    ? `${listed.length} upcoming shows at ${current.name}, ${current.city}, ${current.state}, picked by ${name}. Tickets on FanGenie.`
    : `${listed.length} upcoming shows across ${venues.length} venue${venues.length === 1 ? '' : 's'}, picked by ${name}. Tickets on FanGenie.`;
  const ogImage = (first && first.poster) || photoUrl || '';
  const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  const ARROW = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  const nav = [`<a class="vp${current ? '' : ' on'}" href="${esc(base)}"><b>All venues</b><small>${shows.length} show${shows.length === 1 ? '' : 's'}</small></a>`]
    .concat(venues.map(v => `<a class="vp${current && current.dir === v.dir ? ' on' : ''}" href="${esc(base + v.dir + '/')}"><b>${esc(v.short)}</b><small>${esc(v.city || v.name)} &middot; ${v.shows.length} show${v.shows.length === 1 ? '' : 's'}</small></a>`))
    .join('');

  const cards = listed.map((s, i) => `<article class="card c${hash(s.name) % 10}" style="animation-delay:${(0.05 * Math.min(i, 12)).toFixed(2)}s">
      <a class="art" href="${esc(s.url)}" target="_blank" rel="noopener" aria-label="Tickets for ${esc(s.name)}">
        ${s.poster ? `<img src="${esc(s.poster)}" alt="${esc(s.name)}" loading="${i < 4 ? 'eager' : 'lazy'}" decoding="async" onerror="this.remove()">` : ''}
        <div class="ph" aria-hidden="true">${esc(s.name)}</div>
        <div class="date"><b>${esc(s.day)}</b><small>${esc(s.mon)}</small><i>${esc(s.dow)}</i></div>
        ${i === 0 && !current ? '<span class="tag hot">Next up</span>' : ''}
      </a>
      <div class="body">
        <h3><small>${esc(s.dowLong)}, ${esc(s.monLong)} ${esc(s.day)} &middot; ${esc(s.time)}</small>${esc(s.name)}</h3>
        <p>${esc(s.venue.name)}${s.venue.city ? `, ${esc(s.venue.city)}` : ''}</p>
        <a class="cta" href="${esc(s.url)}" target="_blank" rel="noopener">Get Tickets ${ARROW}</a>
      </div>
    </article>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | YourConcertTix</title>
<meta name="description" content="${esc(descLine)}">
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${SITE_ORIGIN}${esc(pagePath)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(descLine)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE_ORIGIN}${esc(pagePath)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://fangenie.s3.eu-north-1.amazonaws.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Montserrat:wght@700;800;900&display=swap" rel="stylesheet">
<style>
:root{--bg:#0f0f23;--card:#16213e;--accent:#e94560;--gold:#f5a623;--text:#e8e8f0;--muted:#9a9ab8}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;overflow-x:hidden}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);line-height:1.5;overflow-x:hidden;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.stage{position:fixed;inset:0;z-index:-2;overflow:hidden;background:
  radial-gradient(60% 45% at 15% 0%, rgba(233,69,96,.35), transparent 70%),
  radial-gradient(55% 45% at 85% 10%, rgba(142,45,226,.35), transparent 70%),
  radial-gradient(70% 40% at 50% 100%, rgba(245,166,35,.18), transparent 70%),var(--bg)}
.stage::before,.stage::after{content:"";position:absolute;width:140vmax;height:140vmax;left:50%;top:50%;
  background:conic-gradient(from 0deg, transparent 0 40%, rgba(255,255,255,.05) 42%, transparent 44%, transparent 60%, rgba(255,255,255,.04) 62%, transparent 64%);
  transform:translate(-50%,-50%);animation:beams 40s linear infinite;opacity:.9}
.stage::after{animation-duration:65s;animation-direction:reverse;opacity:.6}
@keyframes beams{to{transform:translate(-50%,-50%) rotate(360deg)}}
.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 24px;max-width:1240px;margin:0 auto}
.bar .brand{font-family:'Montserrat',sans-serif;font-weight:800;font-size:18px;letter-spacing:-.3px}
.bar .brand span{color:var(--accent)}
.bar .fg{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;font-weight:500}
.bar .fg img{height:16px}
.hero{position:relative;text-align:center;padding:40px 20px 10px;max-width:900px;margin:0 auto}
.avatar{width:96px;height:96px;border-radius:50%;margin:0 auto 18px;overflow:hidden;border:3px solid rgba(255,255,255,.15);box-shadow:0 20px 50px -20px rgba(233,69,96,.6);background:linear-gradient(135deg,var(--accent),var(--gold));display:flex;align-items:center;justify-content:center;font-family:'Montserrat',sans-serif;font-weight:900;font-size:36px;animation:rise .7s ease both}
.avatar img{width:100%;height:100%;object-fit:cover}
.kicker{display:inline-flex;align-items:center;gap:10px;font-size:12px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);
  border:1px solid rgba(245,166,35,.35);background:rgba(245,166,35,.08);padding:8px 16px;border-radius:999px;animation:rise .7s ease both}
.kicker i{width:8px;height:8px;border-radius:50%;background:var(--gold);box-shadow:0 0 0 0 rgba(245,166,35,.7);animation:pulse 1.8s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 10px rgba(245,166,35,0)}100%{box-shadow:0 0 0 0 rgba(245,166,35,0)}}
.hero h1{font-family:'Montserrat',sans-serif;font-weight:900;font-size:clamp(32px,6vw,64px);line-height:1;letter-spacing:-.04em;margin:18px auto 12px;animation:rise .8s .1s ease both}
.hero h1 em{font-style:normal;background:linear-gradient(90deg,var(--accent),var(--gold));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .sub{font-size:clamp(15px,2vw,19px);color:var(--muted);max-width:600px;margin:0 auto;animation:rise .8s .2s ease both}
.hero .sub strong{color:var(--text)}
.share{display:inline-flex;align-items:center;gap:8px;margin-top:20px;padding:10px 16px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);font-size:13px;font-weight:600;animation:rise .8s .3s ease both}
.share svg{width:15px;height:15px;stroke:var(--gold);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.share:hover{border-color:rgba(245,166,35,.5)}
@keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
.filters{max-width:1240px;margin:30px auto 0;padding:0 20px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;animation:rise .8s .35s ease both}
.filters .title{font-family:'Montserrat',sans-serif;font-weight:800;font-size:clamp(18px,3vw,26px);letter-spacing:-.02em;margin-right:auto}
.filters .title span{color:var(--muted);font-family:'Inter',sans-serif;font-weight:500;font-size:14px;margin-left:8px}
.venues{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:24px;animation:rise .8s .3s ease both}
.vp{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:150px;padding:12px 18px;border-radius:16px;text-align:left;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);transition:all .2s;backdrop-filter:blur(8px)}
.vp b{font-family:'Montserrat',sans-serif;font-weight:800;font-size:15px;letter-spacing:-.01em}
.vp small{font-size:11.5px;font-weight:600;color:var(--muted);letter-spacing:.02em}
.vp:hover{border-color:rgba(245,166,35,.6);transform:translateY(-2px)}
.vp.on{background:linear-gradient(90deg,var(--accent),var(--gold));border-color:transparent;box-shadow:0 12px 30px -12px var(--accent)}
.vp.on b,.vp.on small{color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:22px;max-width:1240px;margin:20px auto 0;padding:0 20px}
.card{position:relative;display:flex;flex-direction:column;border-radius:20px;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02));
  border:1px solid rgba(255,255,255,.1);overflow:hidden;transition:transform .35s cubic-bezier(.2,.8,.2,1),box-shadow .35s,border-color .35s;animation:rise .6s ease both}
.card::before{content:"";position:absolute;inset:0;border-radius:20px;padding:1px;pointer-events:none;z-index:3;
  background:linear-gradient(140deg,var(--c1),var(--c2));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:0;transition:opacity .35s}
.card:hover{transform:translateY(-8px);box-shadow:0 30px 60px -20px rgba(0,0,0,.7),0 0 60px -20px var(--c1);border-color:transparent}
.card:hover::before{opacity:1}
.art{display:block;position:relative;aspect-ratio:1/1;overflow:hidden;background:radial-gradient(80% 80% at 50% 30%,rgba(255,255,255,.10),transparent 70%),linear-gradient(135deg,var(--c1),var(--c2))}
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
  background:linear-gradient(90deg,var(--accent),var(--gold));color:#fff}
.body{display:flex;flex-direction:column;gap:10px;padding:16px 16px 18px;flex:1}
.body h3{font-family:'Montserrat',sans-serif;font-weight:800;font-size:19px;line-height:1.15;letter-spacing:-.01em}
.body h3 small{display:block;font-family:'Inter',sans-serif;font-weight:600;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.body p{color:#c6c6dd;font-size:13.5px;line-height:1.5;flex:1}
.cta{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:4px;padding:13px;border-radius:12px;font-family:'Montserrat',sans-serif;font-weight:800;font-size:15px;letter-spacing:.02em;color:#fff;
  background:linear-gradient(90deg,var(--c1),var(--c2));box-shadow:0 10px 30px -10px var(--c1);transition:transform .2s,box-shadow .2s,filter .2s}
.cta svg{width:16px;height:16px;stroke:#fff;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s}
.cta:hover{transform:translateY(-2px);filter:brightness(1.08)}
.cta:hover svg{transform:translateX(3px)}
.empty{grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted)}
.c0{--c1:#e94560;--c2:#f5a623}.c1{--c1:#6a11cb;--c2:#2575fc}.c2{--c1:#ff512f;--c2:#dd2476}.c3{--c1:#11998e;--c2:#38ef7d}.c4{--c1:#f12711;--c2:#f5af19}
.c5{--c1:#8e2de2;--c2:#4a00e0}.c6{--c1:#ee0979;--c2:#ff6a00}.c7{--c1:#4568dc;--c2:#b06ab3}.c8{--c1:#c94b4b;--c2:#4b134f}.c9{--c1:#ff9966;--c2:#ff5e62}
.trust{max-width:1000px;margin:52px auto 0;padding:0 20px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.trust div{padding:18px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);text-align:center}
.trust b{display:block;font-family:'Montserrat',sans-serif;font-size:15px;margin-bottom:4px}
.trust p{color:var(--muted);font-size:13px}
.trust a{color:var(--gold)}
footer{text-align:center;padding:40px 20px 60px;color:var(--muted);font-size:13px}
footer a{color:var(--text);font-weight:600}
footer a:hover{color:var(--accent)}
footer .stamp{margin-top:8px;font-size:11px;opacity:.7}
@media (max-width:820px){.trust{grid-template-columns:1fr}}
@media (max-width:640px){
  .hero{padding-top:28px}
  .grid{gap:14px;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));padding:0 14px}
  .body{padding:12px 12px 14px;gap:8px}.body h3{font-size:15px}.body h3 small{font-size:10.5px;letter-spacing:.04em}.body p{font-size:12px}
  .cta{padding:11px;font-size:13px}.date{min-width:48px;padding:6px 6px 5px}.date b{font-size:19px}.tag{display:none}
  .bar .fg span{display:none}.kicker{font-size:10px;letter-spacing:.14em;padding:7px 12px}
  .filters .title{width:100%}
  .venues{gap:8px}.vp{min-width:0;flex:1 1 calc(50% - 8px);padding:10px 12px}.vp b{font-size:13.5px}.vp small{font-size:10.5px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="stage"></div>

<nav class="bar">
  <a class="brand" href="/">Your<span>Concert</span>Tix</a>
  <a class="fg" href="https://fangenie.com" target="_blank" rel="noopener"><span>Tickets powered by</span><img src="https://app.fangenie.com/assets/images/newlogo.png" alt="FanGenie"></a>
</nav>

<section class="hero">
  <div class="avatar">${photoUrl ? `<img src="${esc(photoUrl)}" alt="${esc(name)}">` : esc(name.trim()[0] || 'Y').toUpperCase()}</div>
  <div class="kicker"><i></i> ${current ? esc(current.short) + ' &middot; ' : ''}${esc(range || 'Upcoming shows')}</div>
  <h1>${esc(name)}'s <em>picks</em></h1>
  <p class="sub">${headline ? `<strong>${esc(headline)}</strong> ` : ''}${current
    ? `${listed.length} show${listed.length === 1 ? '' : 's'} at the ${esc(current.name)}${current.city ? `, ${esc(current.city)}` : ''}. Grab tickets straight from FanGenie.`
    : `${listed.length} show${listed.length === 1 ? '' : 's'} across ${venues.length} venue${venues.length === 1 ? '' : 's'}. Pick a venue below and grab tickets straight from FanGenie.`}</p>
  <nav class="venues" aria-label="Venues">${nav}</nav>
  <button class="share" type="button" id="share"><svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg><span>Share this page</span></button>
</section>

<div class="filters">
  <div class="title">${current ? esc(current.name) : 'All Shows'} <span>${listed.length} show${listed.length === 1 ? '' : 's'}</span></div>
</div>

<div class="grid">${cards || '<div class="empty">No upcoming shows listed right now. Check back soon.</div>'}</div>

<div class="trust">
  <div><b>Official tickets</b><p>Every link goes straight to the show's page on FanGenie, the venue's official ticketing partner.</p></div>
  <div><b>Same price</b><p>You pay exactly what you would on FanGenie. Buying through this page supports ${esc(name)}.</p></div>
  <div><b>Questions?</b><p>See the show's page on FanGenie or visit <a href="/">YourConcertTix</a> for the full calendar.</p></div>
</div>

<footer>
  <a href="/">YourConcertTix</a> &middot; Tickets by <a href="https://fangenie.com" target="_blank" rel="noopener">FanGenie</a> &middot; Presented by TAD Management
  <div class="stamp">Listings refresh automatically from FanGenie.</div>
</footer>

<script>
(function(){
  var btn=document.getElementById('share'), url=location.origin+${JSON.stringify(pagePath)}, label=btn.querySelector('span');
  btn.addEventListener('click',async function(){
    try{
      if(navigator.share){await navigator.share({title:document.title,url:url});return;}
      await navigator.clipboard.writeText(url); label.textContent='Link copied!';
    }catch(e){label.textContent=url;}
    setTimeout(function(){label.textContent='Share this page';},2200);
  });
})();
</script>
</body>
</html>
`;
}

// ---- main ----

async function main() {
  const data = await loadAirtable();
  if (!data) return;
  let affiliates = data.affiliates.filter(a => a.fields.Handle && /^[a-z0-9-]+$/.test(a.fields.Handle));
  const skipped = data.affiliates.length - affiliates.length;
  if (skipped) console.warn(`WARN ${skipped} affiliate row(s) skipped: Handle must be lowercase letters, digits and hyphens.`);
  if (ONLY) affiliates = affiliates.filter(a => a.fields.Handle === ONLY);
  console.log(`${affiliates.length} active affiliate(s), ${data.links.length} link row(s)`);

  console.log('pulling the commissionable lineup from FanGenie...');
  const events = await fg.affiliateEvents();
  console.log(`  ${events.length} shows in the feed`);
  if (!events.length) {
    console.warn('WARNING: FanGenie returned no affiliate events; leaving existing pages untouched.');
    return;
  }
  const eventsById = new Map(events.map(e => [String(e._id), e]));

  const linksByAffiliate = new Map();
  for (const l of data.links) for (const id of l.fields.Affiliate || []) {
    if (!linksByAffiliate.has(id)) linksByAffiliate.set(id, []);
    linksByAffiliate.get(id).push(l);
  }

  const built = new Set();
  const pageUrlUpdates = [];
  for (const affiliate of affiliates) {
    const handle = affiliate.fields.Handle;
    const shows = buildShows(linksByAffiliate.get(affiliate.id) || [], eventsById);
    const venues = groupVenues(shows);
    console.log(`${handle}: ${shows.length} upcoming show(s) with a link across ${venues.length} venue(s)`);
    if (!shows.length) {
      if (affiliate.fields['Page URL']) pageUrlUpdates.push({ id: affiliate.id, fields: { 'Page URL': null } });
      continue;
    }
    const dir = path.join(OUT_ROOT, handle);
    const pages = [{ file: path.join(dir, 'index.html'), html: renderPage({ affiliate, venues, shows, current: null }) }];
    for (const v of venues) pages.push({ file: path.join(dir, v.dir, 'index.html'), html: renderPage({ affiliate, venues, shows, current: v }) });
    for (const p of pages) {
      if (DRY_RUN) { console.log(`  [DRY RUN] would write ${path.relative(repoRoot, p.file)} (${p.html.length} bytes)`); continue; }
      mkdirSync(path.dirname(p.file), { recursive: true });
      writeFileSync(p.file, p.html);
      console.log(`  wrote ${path.relative(repoRoot, p.file)}`);
    }
    // Venue folders that no longer apply (a venue dropped off) go away too.
    if (!DRY_RUN) {
      const keepDirs = new Set(venues.map(v => v.dir));
      for (const entry of readdirSync(dir)) {
        const p = path.join(dir, entry);
        if (statSync(p).isDirectory() && !keepDirs.has(entry)) { rmSync(p, { recursive: true, force: true }); console.log(`  removed stale ${handle}/${entry}/`); }
      }
    }
    built.add(handle);
    const url = `${SITE_ORIGIN}/a/${handle}/`;
    if (affiliate.fields['Page URL'] !== url) pageUrlUpdates.push({ id: affiliate.id, fields: { 'Page URL': url } });
  }

  // Pages for affiliates who are no longer Active (or have no links) come down.
  if (!DRY_RUN && !ONLY && existsSync(OUT_ROOT)) {
    for (const entry of readdirSync(OUT_ROOT)) {
      const p = path.join(OUT_ROOT, entry);
      if (statSync(p).isDirectory() && !built.has(entry)) { rmSync(p, { recursive: true, force: true }); console.log(`removed /a/${entry}/ (no longer active)`); }
    }
  }

  if (pageUrlUpdates.length && !DRY_RUN && !FIXTURE) {
    await updateAll(AFFILIATES_TABLE, pageUrlUpdates);
    console.log(`updated Page URL on ${pageUrlUpdates.length} affiliate row(s)`);
  }
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
