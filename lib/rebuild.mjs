// Ask GitHub to run the sync workflow now (repository_dispatch). Without a
// token the site still rebuilds on the next scheduled run (every 4 hours).
// Shared by api/affiliate.js and api/events.js.
//
// Env: GITHUB_TOKEN (optional), GITHUB_REPO (default TAD-Management/yourconcerttix).

const GITHUB_REPO = process.env.GITHUB_REPO || 'TAD-Management/yourconcerttix';

export async function triggerRebuild(eventType) {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return 'scheduled';
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'yourconcerttix-api' },
      body: JSON.stringify({ event_type: eventType }),
    });
    if (res.status === 204) return 'queued';
    console.error('repository_dispatch failed:', res.status, (await res.text()).slice(0, 200));
  } catch (err) {
    console.error('repository_dispatch error:', err.message);
  }
  return 'scheduled';
}
