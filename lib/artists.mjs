// Artist grouping + page URLs, shared by scripts/sync.mjs (the "See all dates"
// link on each event page) and scripts/directory.mjs (builds /artists/), so
// both always agree on which shows belong to which act.
//
// An artist is the homepage events' slug (Airtable BANDS-SHOWS name, or the
// /admin/ extra show's name), and its page is /artists/<slug>/. Shows on the
// FanGenie venue pages that have no Airtable twin (all of Apache Junction, whose
// Airtable rows have no ticket link) are added too. FanGenie titles carry
// subtitles ("TOBY - The Experience starring Hollywood Yates"), so they join the
// act whose name they start with, or else become an act named by the part
// before " - ".

import { FANGENIE_PAGES, clean, cityFromAddress, fanGeniePage, groupVenues, slugify, venueName } from './directory.mjs';

// "The Magic Of Manilow!" -> "magic of manilow"
function norm(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
}

// The act a FanGenie title belongs to: exact name, or the longest name it starts with.
function matchArtist(title, artists) {
  const t = norm(title);
  let best = null;
  for (const a of artists) {
    const n = norm(a.name);
    if (!n || !(t === n || t.startsWith(n + ' '))) continue;
    if (!best || n.length > norm(best.name).length) best = a;
  }
  return best;
}

// Group homepage-shape events ({ artist, slug, date, showtime, venue, venueHref,
// city, state, ticket, id, photo }) into artists, A to Z:
// { name, slug, href, photo, shows: [{ date, showtime, venue, venueHref, city,
//   state, ticket, href, title? }], fanGenie?: { poster, paragraphs, video, subtitle } }
// `fanGenie` is set for acts that only exist on a FanGenie venue page.
export function groupArtists(events) {
  const bySlug = new Map();
  const add = (slug, name, photo) => {
    if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, href: `/artists/${slug}/`, photo, shows: [] });
    return bySlug.get(slug);
  };

  for (const e of events) {
    if (!e.slug) continue;
    add(e.slug, e.artist, `/artist-photos/${e.photo || e.slug}.jpg`).shows.push({
      date: e.date, showtime: e.showtime || '', venue: venueName(e.venue, e.city, e.state), venueHref: e.venueHref || '',
      city: clean(e.city), state: clean(e.state), ticket: e.ticket || '', href: `/events/${e.id}/`,
    });
  }

  // FanGenie venue dates already published from Airtable (same venue, same day).
  const twins = new Set();
  for (const v of groupVenues(events)) {
    if (v.fanGenie) for (const e of v.events) twins.add(`${v.fanGenie.dir}|${e.date}`);
  }
  for (const p of FANGENIE_PAGES) {
    const data = fanGeniePage(p.dir);
    if (!data) continue;
    const { city, state } = cityFromAddress(data.venue.address);
    for (const e of data.events) {
      if (twins.has(`${p.dir}|${e.ymd}`)) continue;
      let a = matchArtist(e.name, bySlug.values());
      if (!a) {
        const [name, ...rest] = clean(e.name).split(/\s+[-–—]\s+/);
        const slug = slugify(name);
        if (!slug) continue;
        a = bySlug.get(slug) || Object.assign(add(slug, name, e.poster), {
          fanGenie: { poster: e.poster, paragraphs: e.paragraphs || [], video: e.video || '', subtitle: rest.join(' - ') },
        });
      }
      a.shows.push({
        date: e.ymd, showtime: e.time || '', venue: clean(data.venue.name), venueHref: `/${p.dir}/`,
        city, state, ticket: e.url || '', href: `/${p.dir}/#shows`, title: clean(e.name),
      });
    }
  }

  const artists = [...bySlug.values()];
  for (const a of artists) a.shows.sort((x, y) => x.date.localeCompare(y.date));
  return artists.sort((x, y) => norm(x.name).localeCompare(norm(y.name)));
}
