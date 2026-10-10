// Minimal Airtable REST client (field names, not ids) for the affiliate tables
// and YCT EXTRA EVENTS. Shared by api/affiliate.js, api/events.js and
// scripts/affiliates.mjs.

export const BASE_ID = 'appEy2dr1ecmzbEpb';
export const AFFILIATES_TABLE = 'tbl9rA9yYNfw3ejYZ';
export const LINKS_TABLE = 'tblm5PdzhTng2gYuV';
export const EXTRA_EVENTS_TABLE = 'tbl4xJfw7ltLEFkbS'; // YCT EXTRA EVENTS (api/events.js)

function pat() {
  const v = process.env.AIRTABLE_PAT;
  if (!v) throw new Error('AIRTABLE_PAT is not set');
  return v;
}

async function req(method, path, body) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${pat()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Airtable ${method} ${path.split('?')[0]} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function listAll(table, { filterByFormula = null, fields = [] } = {}) {
  const records = [];
  let offset = null;
  do {
    const p = new URLSearchParams();
    if (filterByFormula) p.set('filterByFormula', filterByFormula);
    for (const f of fields) p.append('fields[]', f);
    p.set('pageSize', '100');
    if (offset) p.set('offset', offset);
    const data = await req('GET', `${table}?${p}`);
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

// Airtable takes at most 10 records per write.
async function batched(method, table, records) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const data = await req(method, table, { records: records.slice(i, i + 10), typecast: true });
    out.push(...data.records);
  }
  return out;
}
export const createAll = (table, records) => batched('POST', table, records);
export const updateAll = (table, records) => batched('PATCH', table, records);

export const getRecord = (table, id) => req('GET', `${table}/${id}`);
export const deleteRecord = (table, id) => req('DELETE', `${table}/${id}`);

// Add a file to an attachment field (Airtable's upload endpoint, 5 MB max).
export async function uploadAttachment(recordId, field, { contentType, filename, base64 }) {
  const res = await fetch(`https://content.airtable.com/v0/${BASE_ID}/${recordId}/${encodeURIComponent(field)}/uploadAttachment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType, filename, file: base64 }),
  });
  if (!res.ok) throw new Error(`Airtable upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Escape a value for use inside single quotes in filterByFormula.
export function q(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// The one Active affiliate row for a FanGenie email, or null.
export async function findAffiliateByEmail(email) {
  const rows = await listAll(AFFILIATES_TABLE, {
    filterByFormula: `AND(LOWER({FanGenie Email})=LOWER('${q(email)}'), {Status}='Active')`,
  });
  return rows[0] || null;
}
