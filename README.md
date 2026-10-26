# yourconcerttix

Static site for [yourconcerttix.com](https://yourconcerttix.com), deployed via Vercel from this repo.

## How it works

- **`index.html`** — the entire site, single-file. Embeds the event list as a JS array, plus inline CSS and a search/filter UI.
- **`artist-photos/`** — one `.jpg` per artist slug. Missing photos fall back to a gradient with the artist name.
- **`scripts/sync.mjs`** — pulls upcoming events from Airtable (base `appEy2dr1ecmzbEpb`), downloads artist photos, and rebuilds `index.html` from scratch.
- **`apachejunction/`, `lakehavasu/`** — standalone venue pages (Apache Junction Performing Arts Center, Lake Havasu Aquatic Center), rebuilt by `scripts/apache-junction.mjs` from FanGenie's public API (no secrets needed). Every show and season bundle links to its page on FanGenie. To add a venue, append it to the `VENUES` list in that script and add its folder to the `git add` line in the workflow.
- **`venues/`, `cities/`** — the venue and city directories behind the two "Browse by" tiles on the homepage, rebuilt by `scripts/directory.mjs` from the homepage's show list plus the FanGenie venue pages (no secrets needed). Each venue gets `/venues/<slug>/` with all its shows, except venues that already have their own page (Apache Junction, Lake Havasu, Paramount, Cocopah), whose tiles link there. Cities with two or more venues get `/cities/<slug>/`; a one-venue city links straight to its venue. The venue name on each event page links to the same page; `lib/directory.mjs` holds the shared venue grouping so `sync.mjs` and `directory.mjs` always agree on the URL.
- **`artists/`** — one page per act at `/artists/<slug>/` (every upcoming date, with poster, tagline, bio, promo video and a Share button), the link to use when promoting an act's whole run of shows. Also built by `scripts/directory.mjs`. `/artists/` itself is a search box, not a list: type an act or the star it pays tribute to ("Neil Diamond" finds Hot August Night). Shows on the FanGenie venue pages with no Airtable twin (all of Apache Junction) are included, joined to the act whose name the FanGenie title starts with. The homepage "Search by Artist" tile links to `/artists/`, and each event page links to its act's page when the act has more than one date. `lib/artists.mjs` holds the shared grouping.
- **`.github/workflows/sync.yml`** — runs `scripts/sync.mjs` every 4 hours (and on manual dispatch) and commits any changes. Vercel auto-deploys on each commit.

## Running the sync locally

```bash
export AIRTABLE_PAT=patXXXXXXXXXXXX
node scripts/sync.mjs            # write changes
node scripts/sync.mjs --dry-run  # just report what would change
```

## Secrets

The GitHub Action needs `AIRTABLE_PAT` set as a repo secret (Settings → Secrets and variables → Actions). The token needs `data.records:read` scope on base `appEy2dr1ecmzbEpb`.
