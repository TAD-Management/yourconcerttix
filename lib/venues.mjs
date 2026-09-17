// Short, sayable folder names for the venues in FanGenie's affiliate feed.
// yourconcerttix.com/a/<handle>/<dir>/ . Anything not listed falls back to a
// slug of the venue name. Shared by scripts/affiliates.mjs and api/affiliate.js.

export const VENUE_DIRS = {
  '68b25c59bdd034984c663b65': { dir: 'apachejunction', short: 'Apache Junction' },
  '68b2572dbdd034984c663b0f': { dir: 'lakehavasu', short: 'Lake Havasu' },
  '68cf864c7c282f4d1344e3c3': { dir: 'paramount', short: 'Historic Paramount' },
  '68c92b1fb8aba14ed575fd98': { dir: 'riverview', short: 'Riverview PAC' },
  '6aa4066ecdd8867d0b098af3': { dir: 'ritzcarlton', short: 'Ritz Carlton' },
  '6a17cacf0ac13f7438081883': { dir: 'harolds', short: "Harold's Corral" },
};

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function venueInfo(venueId, name) {
  const known = VENUE_DIRS[String(venueId || '')];
  if (known) return known;
  return { dir: slugify(name || venueId || 'venue'), short: name || 'Venue' };
}
