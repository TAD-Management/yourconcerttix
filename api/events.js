// yourconcerttix.com/api/events — backs the /admin/ form for shows that aren't
// booked in Airtable's CURRENT EVENTS. Rows live in the YCT EXTRA EVENTS table;
// scripts/sync.mjs publishes them alongside the bookings.
//
// Every request carries the shared admin password (env ADMIN_PASSWORD).
//
// POST { action: 'login', password }
//   Checks the password.
// POST { action: 'list', password }
//   Every row, newest date first.
// POST { action: 'save', password, id?, fields, image?, removeImage? }
//   Creates (no id) or updates a row. `image` is { filename, contentType, base64 }
//   (the form shrinks it first) and replaces the current one. Triggers a rebuild.
// POST { action: 'delete', password, id }
//   Deletes a row and triggers a rebuild.
//
// Env: ADMIN_PASSWORD, AIRTABLE_PAT (required); GITHUB_TOKEN (optional, see lib/rebuild.mjs).

import { createHash, timingSafeEqual } from 'node:crypto';
import { EXTRA_EVENTS_TABLE as TABLE, listAll, createAll, updateAll, getRecord, deleteRecord, uploadAttachment } from '../lib/airtable.mjs';
import { triggerRebuild } from '../lib/rebuild.mjs';

export const config = { maxDuration: 30 };

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
    await checkPassword(body.password);
    const action = String(body.action || '');
    let out;
    if (action === 'login') out = {};
    else if (action === 'list') out = { events: await listEvents() };
    else if (action === 'save') out = await saveEvent(body);
    else if (action === 'delete') out = await removeEvent(body);
    else throw new HttpError(400, 'bad_action', 'Unknown action');
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500) console.error('events api error:', err && err.stack ? err.stack : err);
    return res.status(status).json({
      ok: false,
      error: err.code || (status === 500 ? 'server_error' : 'error'),
      message: status === 500 ? 'Something went wrong on our side. Please try again in a minute.' : err.message,
    });
  }
}

// ---- auth ----

const sha = s => createHash('sha256').update(String(s)).digest();

async function checkPassword(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new HttpError(503, 'not_configured', 'The admin password has not been set up yet.');
  if (!password || !timingSafeEqual(sha(password), sha(expected))) {
    await new Promise(r => setTimeout(r, 800)); // slows down guessing
    throw new HttpError(401, 'bad_password', 'Wrong password.');
  }
}

// ---- actions ----

// Form field -> Airtable field name, with a length cap.
const TEXT_FIELDS = {
  name: ['Show Name', 200],
  time: ['Show Time', 60],
  venue: ['Venue', 200],
  address: ['Address', 300],
  city: ['City', 100],
  state: ['State', 2],
  tagline: ['Tagline', 200],
  description: ['Description', 5000],
  price: ['Price', 100],
};
const URL_FIELDS = { ticket: 'Ticket Link', video: 'Promo Video' };

function toPublic(r) {
  const f = r.fields || {};
  const img = (f.Image || [])[0];
  return {
    id: r.id,
    name: f['Show Name'] || '',
    date: f.Date || '',
    time: f['Show Time'] || '',
    venue: f.Venue || '',
    address: f.Address || '',
    city: f.City || '',
    state: f.State || '',
    ticket: f['Ticket Link'] || '',
    tagline: f.Tagline || '',
    description: f.Description || '',
    price: f.Price || '',
    video: f['Promo Video'] || '',
    hidden: !!f.Hidden,
    image: img ? ((img.thumbnails && img.thumbnails.large && img.thumbnails.large.url) || img.url) : '',
    link: f['YCT Link'] || '',
  };
}

async function listEvents() {
  const rows = await listAll(TABLE);
  return rows.map(toPublic).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function cleanFields(input) {
  const f = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [key, [field, max]] of Object.entries(TEXT_FIELDS)) {
    if (key in f) out[field] = String(f[key] ?? '').trim().slice(0, max);
  }
  if ('state' in f) out.State = out.State.toUpperCase();
  for (const [key, field] of Object.entries(URL_FIELDS)) {
    if (!(key in f)) continue;
    const v = String(f[key] ?? '').trim();
    if (v && !isHttpUrl(v)) throw new HttpError(400, 'bad_url', `${field} must be a full web address starting with https://`);
    out[field] = v || null;
  }
  if ('date' in f) {
    const d = String(f.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'bad_date', 'Pick a date');
    out.Date = d;
  }
  if ('hidden' in f) out.Hidden = !!f.hidden;
  return out;
}

function isHttpUrl(v) {
  try { const u = new URL(v); return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.'); }
  catch { return false; }
}

async function saveEvent({ id, fields, image, removeImage }) {
  const data = cleanFields(fields);
  id = id ? String(id) : '';
  if (id && !/^rec[A-Za-z0-9]{14}$/.test(id)) throw new HttpError(400, 'bad_id', 'Unknown event');
  if (!id) {
    if (!data['Show Name']) throw new HttpError(400, 'missing_name', 'Enter the show name');
    if (!data.Date) throw new HttpError(400, 'missing_date', 'Pick a date');
    if (!data['Ticket Link']) throw new HttpError(400, 'missing_ticket', 'Add the ticket link');
  }
  if (image) validateImage(image);

  if (image || removeImage) data.Image = []; // a new image replaces the old one
  let record;
  if (id) [record] = await updateAll(TABLE, [{ id, fields: data }]);
  else [record] = await createAll(TABLE, [{ fields: data }]);

  if (image) {
    await uploadAttachment(record.id, 'Image', {
      contentType: image.contentType,
      filename: String(image.filename || 'image.jpg').replace(/[^\w.\- ]+/g, '').slice(0, 80) || 'image.jpg',
      base64: image.base64,
    });
    record = await getRecord(TABLE, record.id);
  }
  return { event: toPublic(record), rebuild: await triggerRebuild('events-rebuild') };
}

function validateImage(image) {
  const type = String(image.contentType || '');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) throw new HttpError(400, 'bad_image', 'The image must be a JPG, PNG, WebP or GIF');
  const b64 = String(image.base64 || '');
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) throw new HttpError(400, 'bad_image', 'The image could not be read');
  if (b64.length * 0.75 > 3 * 1024 * 1024) // Vercel caps the whole request at 4.5 MB
    throw new HttpError(413, 'image_too_big', 'The image is too large. Try a smaller one.');
}

async function removeEvent({ id }) {
  id = String(id || '');
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new HttpError(400, 'bad_id', 'Unknown event');
  await deleteRecord(TABLE, id);
  return { rebuild: await triggerRebuild('events-rebuild') };
}
