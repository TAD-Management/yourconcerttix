// Thin client for the parts of FanGenie's API the affiliate feature uses.
// Shared by api/affiliate.js (Vercel function) and scripts/affiliates.mjs.
//
// FanGenie facts this relies on (see fangenie-be/src/controllers/referral.controller.js):
//  - an affiliate link is <event url>?ref=<8-char code>, one code per user per event;
//  - POST /referral/generate is idempotent: it returns the existing link if there is one;
//  - GET /referral lists every link the signed-in user has;
//  - GET /event/affiliate is public and lists every upcoming show that pays commission.

export const FG_API = 'https://api.fangenie.com/api/v1';
export const FG_APP = 'https://app.fangenie.com';

class FanGenieError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export { FanGenieError };

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FG_API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    throw new FanGenieError(res.status, (data && data.message) || `FanGenie ${res.status}`, data && data.code);
  }
  return data;
}

// Email + password -> { token, user }. Throws FanGenieError(400) on bad credentials.
export async function login(email, password) {
  const d = await call('/auth/login', { method: 'POST', body: { email, password } });
  const out = d && d.data;
  if (!out || !out.token || !out.user) throw new FanGenieError(502, 'Unexpected login response from FanGenie');
  return out;
}

// Token -> user (also proves the token is still valid).
export async function context(token) {
  const d = await call('/auth/context', { token });
  const user = d && d.data && d.data.user;
  if (!user) throw new FanGenieError(401, 'Session expired, please sign in again');
  return user;
}

// Every upcoming show that pays affiliate commission. No auth needed.
export async function affiliateEvents() {
  const d = await call('/event/affiliate');
  return (d && d.events) || [];
}

// The signed-in user's existing referral links.
export async function myLinks(token) {
  const d = await call('/referral', { token });
  return (d && d.data) || [];
}

// Create (or fetch) the signed-in user's link for one event.
export async function generateLink(token, eventId) {
  const d = await call('/referral/generate', { method: 'POST', token, body: { eventId } });
  const link = d && d.data;
  if (!link || !link.referralCode) throw new FanGenieError(502, 'FanGenie returned no link');
  return link;
}

// Pull the referral code out of an affiliate link.
export function refCode(link) {
  const m = String(link || '').match(/[?&]ref=([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}
