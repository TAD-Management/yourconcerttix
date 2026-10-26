// Artist grouping + page URLs, shared by scripts/sync.mjs (the "See all dates"
// link on each event page), scripts/directory.mjs (builds /artists/) and
// scripts/affiliates.mjs (builds /a/<handle>/artists/), so all three agree on
// which shows belong to which act and on its slug.
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

// The act a FanGenie show title belongs to: one of `artists` ({ name, slug })
// when the title starts with its name, else a new act named by the part before
// " - " ({ name, slug, subtitle }).
export function actFor(title, artists) {
  const known = matchArtist(title, artists);
  if (known) return known;
  const [name, ...rest] = clean(title).split(/\s+[-–—]\s+/);
  return { name, slug: slugify(name), subtitle: rest.join(' - ') };
}

// The act for a FanGenie show ({ title, date, city }): by title as in actFor,
// else the main-site act (from groupArtists) playing the same city that day,
// since FanGenie sometimes names an act differently ("CCR Tribute starring
// Randy Linder" for "Randy Linder - CCR"). `more` are extra acts to match by title.
export function actForShow(show, siteArtists, more = []) {
  const byTitle = matchArtist(show.title, [...siteArtists, ...more]);
  if (byTitle) return byTitle;
  const key = `${show.date}|${norm(show.city)}`;
  const twins = siteArtists.filter(a => a.shows.some(s => `${s.date}|${norm(s.city)}` === key));
  return twins.length === 1 ? twins[0] : actFor(show.title, []);
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
      const act = actFor(e.name, bySlug.values());
      if (!act.slug) continue;
      const a = bySlug.get(act.slug) || Object.assign(add(act.slug, act.name, e.poster), {
        fanGenie: { poster: e.poster, paragraphs: e.paragraphs || [], video: e.video || '', subtitle: act.subtitle },
      });
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

// The artist search box behind /artists/ and /a/<handle>/artists/: results
// appear only once something is typed, so the page never lists every act.
// `index` is [{ n: name, u: page url, t: tagline, c: show count, x: next date,
// p: poster url or '', g: placeholder background, k: searchable text }]; the
// name, tagline and FanGenie titles are searchable, so "Neil Diamond" finds Hot
// August Night. The page supplies #q, #results, #hint (buttons with data-q) and #none.
export function finderScript(index) {
  return `
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
</script>`;
}
