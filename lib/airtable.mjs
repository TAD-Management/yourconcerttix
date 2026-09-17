// Minimal Airtable REST client (field names, not ids) for the affiliate tables.
// Shared by api/affiliate.js and scripts/affiliates.mjs.

export const BASE_ID = 'appEy2dr1ecmzbEpb';
export const AFFILIATES_TABLE = 'tbl9rA9yYNfw3ejYZ';
export const LINKS_TABLE = 'tblm5PdzhTng2gYuV';

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
