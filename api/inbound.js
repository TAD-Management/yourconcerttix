// yourconcerttix.com/api/inbound — forwards mail sent to any @yourconcerttix.com
// address (hello@, venues@, ...) to a real inbox.
//
// Resend receives the mail (the domain's MX record points at Resend) and POSTs
// an `email.received` webhook here. The webhook only carries metadata, so we
// fetch the body and attachment links from Resend's API, then send a copy to
// FORWARD_TO with Reply-To set to the original sender. Hitting Reply in the
// inbox therefore answers the sender directly.
//
// Webhook retries are safe: each forward uses the received email's id as the
// Resend idempotency key, so a retried webhook can't produce a second copy.
//
// Env: RESEND_API_KEY (needs sending + receiving access), RESEND_WEBHOOK_SECRET
// (the webhook's whsec_... signing secret), FORWARD_TO (one address, or several
// comma-separated). Optional FORWARD_FROM, default inbox@yourconcerttix.com
// (must be on a domain verified for sending in Resend).

import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.resend.com';
const TOLERANCE_SECONDS = 5 * 60;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { RESEND_API_KEY, RESEND_WEBHOOK_SECRET, FORWARD_TO } = process.env;
  if (!RESEND_API_KEY || !RESEND_WEBHOOK_SECRET || !FORWARD_TO) {
    console.error('inbound: RESEND_API_KEY, RESEND_WEBHOOK_SECRET and FORWARD_TO must be set');
    return res.status(500).json({ error: 'not_configured' });
  }

  const raw = await readRawBody(req);
  if (!verifySignature(raw, req.headers, RESEND_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'bad_signature' });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad_json' }); }
  if (event.type !== 'email.received') return res.status(200).json({ ignored: event.type });

  const id = event.data?.email_id;
  if (!id) return res.status(400).json({ error: 'missing_email_id' });

  try {
    const result = await forward(id, {
      apiKey: RESEND_API_KEY,
      to: FORWARD_TO.split(',').map(s => s.trim()).filter(Boolean),
      from: process.env.FORWARD_FROM || 'inbox@yourconcerttix.com',
    });
    return res.status(200).json(result);
  } catch (err) {
    // A non-2xx makes Resend retry the webhook later.
    console.error('inbound: forward failed', id, err.message);
    return res.status(502).json({ error: 'forward_failed' });
  }
}

async function forward(id, { apiKey, to, from }) {
  const email = await api(apiKey, 'GET', `/emails/receiving/${id}`);

  // Don't bounce our own forwards back round if FORWARD_TO is ever an
  // @yourconcerttix.com address.
  if (addressOf(email.from) === addressOf(from)) return { skipped: 'own_forward' };

  // Inline images are already embedded in `html` as data: URIs, so only real
  // attachments are re-attached (by their temporary download URL).
  let attachments;
  if ((email.attachments || []).some(a => a.content_disposition !== 'inline')) {
    const list = await api(apiKey, 'GET', `/emails/receiving/${id}/attachments`);
    attachments = (list.data || [])
      .filter(a => a.content_disposition !== 'inline' && a.download_url)
      .map(a => ({ filename: a.filename || 'attachment', path: a.download_url }));
  }

  const senderName = nameOf(email.from) || addressOf(email.from);
  const sentTo = (email.received_for?.length ? email.received_for : email.to || []).join(', ');
  const note = `Sent to ${sentTo} by ${email.from}`;

  const sent = await api(apiKey, 'POST', '/emails', {
    from: `${quoteName(`${senderName} via YourConcertTix`)} <${addressOf(from)}>`,
    to,
    reply_to: email.reply_to?.length ? email.reply_to : [email.from],
    subject: email.subject || '(no subject)',
    html: `<div style="font:13px/1.4 sans-serif;color:#666;border-bottom:1px solid #ddd;padding:0 0 8px;margin:0 0 12px">${escapeHtml(note)}</div>`
      + (email.html || `<pre style="white-space:pre-wrap;font:14px/1.5 sans-serif">${escapeHtml(email.text || '')}</pre>`),
    text: `${note}\n\n${email.text || ''}`,
    attachments,
  }, { 'Idempotency-Key': `inbound-${id}` });

  return { forwarded: id, sent: sent.id };
}

async function api(apiKey, method, path, body, headers = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${data.message || ''}`.trim());
  return data;
}

// Resend signs webhooks the Svix way: HMAC-SHA256 of "<id>.<timestamp>.<body>"
// keyed with the base64 part of whsec_..., sent as "v1,<sig> v1,<sig>".
export function verifySignature(raw, headers, secret) {
  const id = headers['svix-id'], ts = headers['svix-timestamp'], sigs = headers['svix-signature'];
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest();
  return sigs.split(' ').some(part => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// The signature covers the exact bytes Resend sent, so read the stream rather
// than Vercel's parsed req.body.
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function addressOf(s = '') {
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function nameOf(s = '') {
  const m = s.match(/^\s*"?([^"<]*?)"?\s*</);
  return m ? m[1].trim() : '';
}

function quoteName(s) {
  return `"${s.replace(/["\\\r\n]/g, '')}"`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
