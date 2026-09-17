// yourconcerttix.com/api/affiliate — the one server-side piece of the affiliate
// feature. The browser can't call FanGenie's API (CORS), so this function does
// it and records the results in Airtable. The page itself is then rebuilt by the
// GitHub Action (scripts/affiliates.mjs).
//
// POST { action: 'login', email, password }
//   Signs in to FanGenie with the affiliate's own credentials, checks they are
//   invited (AFFILIATES row, Status = Active), imports any links they already
//   made in the FanGenie app, and returns the lineup grouped by venue with a
//   flag per show saying whether they already have a link.
//   The password is forwarded to FanGenie once and never stored or logged.
//
// POST { action: 'generate', token, eventIds: [...] }
//   Creates their link for each show (FanGenie returns the existing one if it
//   already exists), saves the rows to Airtable and asks GitHub to rebuild.
//
// POST { action: 'status', token }
//   Same lineup for an existing session (used when the page is reloaded).
//
// POST { action: 'handle', token, handle }
//   Changes the affiliate's page address (/a/<handle>/). The old address stops
//   working at the next rebuild.
//
// POST { action: 'rebuild', token }
//   Just triggers the rebuild.
//
// Env: AIRTABLE_PAT (required), GITHUB_TOKEN (optional, enables instant
// rebuilds via repository_dispatch), GITHUB_REPO (default TAD-Management/yourconcerttix).

import * as fg from '../lib/fangenie.mjs';
import { AFFILIATES_TABLE, LINKS_TABLE, listAll, createAll, updateAll, q, findAffiliateByEmail } from '../lib/airtable.mjs';
import { venueInfo } from '../lib/venues.mjs';

export const config = { maxDuration: 60 };

const SITE = 'https://yourconcerttix.com';
const GITHUB_REPO = process.env.GITHUB_REPO || 'TAD-Management/yourconcerttix';

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || '');
    let out;
    if (action === 'login') out = await doLogin(body);
    else if (action === 'generate') out = await doGenerate(body);
    else if (action === 'status') out = await doStatus(body);
    else if (action === 'handle') out = await doHandle(body);
    else if (action === 'rebuild') out = await doRebuild(body);
    else throw new HttpError(400, 'bad_action', 'Unknown action');
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    const code = err.code || (status === 500 ? 'server_error' : 'error');
    if (status === 500) console.error('affiliate api error:', err && err.stack ? err.stack : err);
    return res.status(status).json({ ok: false, error: code, message: safeMessage(err, status) });
  }
}

function safeMessage(err, status) {
  if (status === 500) return 'Something went wrong on our side. Please try again in a minute.';
  return err.message || 'Request failed';
}

// ---- actions ----

async function doLogin({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!email || !password) throw new HttpError(400, 'missing_fields', 'Enter your FanGenie email and password');

  // Invite check first so an uninvited person never has their password forwarded.
  const affiliate = await findAffiliateByEmail(email);
  if (!affiliate) throw new HttpError(403, 'not_invited', 'This email is not on the affiliate list yet. Ask TAD to add you.');

  let session;
  try {
    session = await fg.login(email, password);
  } catch (err) {
    if (err instanceof fg.FanGenieError && err.status < 500) {
      throw new HttpError(401, err.code === 'verification_required' ? 'verify_email' : 'bad_login', err.message);
    }
    throw err;
  }
  const { token, user } = session;

  await updateAll(AFFILIATES_TABLE, [{ id: affiliate.id, fields: {
    'FanGenie User ID': String(user._id || ''),
    'Last Connected': new Date().toISOString(),
  } }]);

  const state = await loadState(token, affiliate);
  const imported = await importExistingLinks(affiliate, state);
  if (imported) await refreshRows(affiliate, state);

  return {
    token,
    affiliate: publicAffiliate(affiliate),
    imported,
    ...lineup(state, affiliate),
  };
}

async function doGenerate({ token, eventIds }) {
  const { affiliate } = await authed(token);
  const wanted = [...new Set((Array.isArray(eventIds) ? eventIds : []).map(String))];
  if (!wanted.length) throw new HttpError(400, 'no_events', 'Pick at least one show');

  const state = await loadState(token, affiliate);
  // Only shows that are still ahead of us; the lineup uses the same rule.
  const eligible = new Map(upcoming(state.events).map(e => [String(e._id), e]));
  const results = { created: 0, existing: 0, failed: [] };
  const newLinks = [];

  // A few at a time is plenty; FanGenie's generate call is quick.
  const queue = wanted.slice();
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      const ev = eligible.get(id);
      if (!ev) { results.failed.push({ eventId: id, reason: 'not_eligible' }); continue; }
      try {
        const link = await fg.generateLink(token, id);
        const had = state.rowsByEvent.has(id);
        newLinks.push({ ev, link });
        if (had) results.existing++; else results.created++;
      } catch (err) {
        results.failed.push({ eventId: id, reason: err.message || 'failed' });
      }
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));

  await upsertRows(affiliate, state, newLinks.map(({ ev, link }) => ({
    ev, code: link.referralCode, url: link.link, source: 'Auto',
  })));
  await refreshRows(affiliate, state);

  const rebuild = await triggerRebuild();
  return { affiliate: publicAffiliate(affiliate), ...results, rebuild, ...lineup(state, affiliate) };
}

// Reload the lineup for an existing session (page refresh).
async function doStatus({ token }) {
  const { affiliate } = await authed(token);
  const state = await loadState(token, affiliate);
  return { affiliate: publicAffiliate(affiliate), ...lineup(state, affiliate) };
}

const RESERVED_HANDLES = new Set(['a', 'api', 'affiliate', 'affiliates', 'admin', 'index', 'tad', 'fangenie', 'yourconcerttix', 'events', 'venues']);

async function doHandle({ token, handle }) {
  const { affiliate } = await authed(token);
  handle = String(handle || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(handle)) {
    throw new HttpError(400, 'bad_handle', 'Use 3 to 30 lowercase letters, numbers or hyphens, starting and ending with a letter or number.');
  }
  if (RESERVED_HANDLES.has(handle)) throw new HttpError(400, 'bad_handle', 'That address is reserved. Try another.');
  if (handle !== affiliate.fields.Handle) {
    const clash = await listAll(AFFILIATES_TABLE, { filterByFormula: `LOWER({Handle})='${q(handle)}'` });
    if (clash.some(r => r.id !== affiliate.id)) throw new HttpError(409, 'handle_taken', 'Someone already has that address. Try another.');
    await updateAll(AFFILIATES_TABLE, [{ id: affiliate.id, fields: { Handle: handle, 'Page URL': null } }]);
    affiliate.fields.Handle = handle;
  }
  const state = await loadState(token, affiliate);
  const rebuild = await triggerRebuild();
  return { affiliate: publicAffiliate(affiliate), rebuild, ...lineup(state, affiliate) };
}

async function doRebuild({ token }) {
  await authed(token);
  return { rebuild: await triggerRebuild() };
}

// ---- helpers ----

async function authed(token) {
  token = String(token || '');
  if (!token) throw new HttpError(401, 'no_session', 'Please sign in');
  let user;
  try {
    user = await fg.context(token);
  } catch (err) {
    if (err instanceof fg.FanGenieError && err.status < 500) throw new HttpError(401, 'session_expired', 'Your session expired. Please sign in again.');
    throw err;
  }
  const affiliate = await findAffiliateByEmail(user.email);
  if (!affiliate) throw new HttpError(403, 'not_invited', 'This account is not on the affiliate list.');
  return { user, affiliate };
}

function publicAffiliate(row) {
  const f = row.fields;
  return {
    handle: f.Handle,
    displayName: f['Display Name'] || f.Handle,
    pageUrl: `${SITE}/a/${f.Handle}/`,
  };
}

// Everything the actions need: the commissionable lineup, the user's FanGenie
// links, and the affiliate's rows in Airtable.
async function loadState(token, affiliate) {
  const [events, fgLinks, rows] = await Promise.all([
    fg.affiliateEvents(),
    fg.myLinks(token),
    affiliateRows(affiliate),
  ]);
  return { events, fgLinks, rowsByEvent: new Map(rows.map(r => [String(r.fields['Event ID'] || ''), r])) };
}

// The linked Affiliate field renders as the handle, so an exact match on it
// gives just this affiliate's rows.
function affiliateRows(affiliate) {
  return listAll(LINKS_TABLE, { filterByFormula: `ARRAYJOIN({Affiliate})='${q(affiliate.fields.Handle)}'` });
}

async function refreshRows(affiliate, state) {
  const rows = await affiliateRows(affiliate);
  state.rowsByEvent = new Map(rows.map(r => [String(r.fields['Event ID'] || ''), r]));
}

// Links the affiliate already made inside the FanGenie app (or on a previous
// visit) that Airtable doesn't know about yet.
async function importExistingLinks(affiliate, state) {
  const byId = new Map(state.events.map(e => [String(e._id), e]));
  const missing = [];
  for (const l of state.fgLinks) {
    const eventId = String((l.eventId && l.eventId._id) || l.eventId || '');
    const ev = byId.get(eventId);
    if (!ev || state.rowsByEvent.has(eventId)) continue;
    missing.push({ ev, code: l.referralCode, url: l.link, source: 'Auto' });
  }
  if (missing.length) await upsertRows(affiliate, state, missing);
  return missing.length;
}

function rowFields(affiliate, { ev, code, url, source }) {
  const venue = ev.venueId || {};
  return {
    Key: `${affiliate.fields.Handle} · ${ev.name}`,
    Affiliate: [affiliate.id],
    'Event ID': String(ev._id),
    'Event Name': ev.name || '',
    'Event Slug': ev.slug || '',
    'Venue Name': venue.name || '',
    'Venue ID': String(venue._id || ''),
    'Event Date': ev.date || null,
    'Referral Code': code || fg.refCode(url),
    Link: url,
    Source: source,
  };
}

async function upsertRows(affiliate, state, items) {
  const creates = [], updates = [];
  for (const it of items) {
    const fields = rowFields(affiliate, it);
    const existing = state.rowsByEvent.get(String(it.ev._id));
    if (existing) updates.push({ id: existing.id, fields });
    else creates.push({ fields });
  }
  if (creates.length) await createAll(LINKS_TABLE, creates);
  if (updates.length) await updateAll(LINKS_TABLE, updates);
}

// Lineup grouped by venue, each show flagged with the affiliate's link if any.
function upcoming(events) {
  const now = Date.now();
  return events.filter(e => e.date && new Date(e.date).getTime() >= now);
}

function lineup(state, affiliate) {
  const venues = new Map();
  const base = `${SITE}/a/${affiliate.fields.Handle}/`;
  for (const e of upcoming(state.events)) {
    const v = e.venueId || {};
    const key = String(v._id || v.name || 'unknown');
    if (!venues.has(key)) {
      const info = venueInfo(v._id, v.name);
      venues.set(key, { id: key, name: v.name || 'Venue', short: info.short, city: e.city || '', pageUrl: `${base}${info.dir}/`, events: [] });
    }
    const row = state.rowsByEvent.get(String(e._id));
    venues.get(key).events.push({
      id: String(e._id),
      name: e.name,
      slug: e.slug,
      date: e.date,
      printDate: e.printDate || '',
      city: e.city || '',
      state: e.state || '',
      image: e.heroBannerImageMobile || (e.galleryImages || [])[0] || e.heroBannerImage || '',
      link: row ? row.fields.Link : null,
      hidden: !!(row && row.fields.Hidden),
    });
  }
  const list = [...venues.values()].map(v => {
    v.events.sort((a, b) => a.date.localeCompare(b.date));
    v.withLink = v.events.filter(e => e.link).length;
    return v;
  }).sort((a, b) => b.events.length - a.events.length || a.name.localeCompare(b.name));
  return {
    venues: list,
    totals: { events: list.reduce((n, v) => n + v.events.length, 0), withLink: list.reduce((n, v) => n + v.withLink, 0) },
  };
}

// Ask GitHub to run the sync workflow now. Without a token the page still
// rebuilds on the next scheduled run (every 4 hours).
async function triggerRebuild() {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return 'scheduled';
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'yourconcerttix-affiliate' },
      body: JSON.stringify({ event_type: 'affiliate-rebuild' }),
    });
    if (res.status === 204) return 'queued';
    console.error('repository_dispatch failed:', res.status, (await res.text()).slice(0, 200));
  } catch (err) {
    console.error('repository_dispatch error:', err.message);
  }
  return 'scheduled';
}
