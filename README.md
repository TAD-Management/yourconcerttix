# yourconcerttix

Static site for [yourconcerttix.com](https://yourconcerttix.com), deployed via Vercel from this repo.

## How it works

- **`index.html`** — the entire site, single-file. Embeds the event list as a JS array, plus inline CSS and a search/filter UI.
- **`artist-photos/`** — one `.jpg` per artist slug. Missing photos fall back to a gradient with the artist name.
- **`scripts/sync.mjs`** — pulls upcoming events from Airtable (base `appEy2dr1ecmzbEpb`), downloads artist photos, and rebuilds `index.html` from scratch.
- **`apachejunction/`, `lakehavasu/`** — standalone venue pages (Apache Junction Performing Arts Center, Lake Havasu Aquatic Center), rebuilt by `scripts/apache-junction.mjs` from FanGenie's public API (no secrets needed). Every show and season bundle links to its page on FanGenie. To add a venue, append it to the `VENUES` list in that script and add its folder to the `git add` line in the workflow.
- **`venues/`, `cities/`** — the venue and city directories behind the two "Browse by" tiles on the homepage, rebuilt by `scripts/directory.mjs` from the homepage's show list plus the FanGenie venue pages (no secrets needed). Each venue gets `/venues/<slug>/` with all its shows, except venues that already have their own page (Apache Junction, Lake Havasu, Paramount, Cocopah), whose tiles link there. Cities with two or more venues get `/cities/<slug>/`; a one-venue city links straight to its venue.
- **`.github/workflows/sync.yml`** — runs `scripts/sync.mjs` every 4 hours (and on manual dispatch) and commits any changes. Vercel auto-deploys on each commit.

## Running the sync locally

```bash
export AIRTABLE_PAT=patXXXXXXXXXXXX
node scripts/sync.mjs            # write changes
node scripts/sync.mjs --dry-run  # just report what would change
```

## Secrets

The GitHub Action needs `AIRTABLE_PAT` set as a repo secret (Settings → Secrets and variables → Actions). The token needs `data.records:read` scope on base `appEy2dr1ecmzbEpb`.
