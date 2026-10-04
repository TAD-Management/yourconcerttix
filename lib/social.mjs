// Your Concert Tix social accounts. Shared by the page generators (sync.mjs for
// the homepage and event pages, apache-junction.mjs for the venue pages) so the
// follow links live in one place. Icons are Feather (MIT), stroked with
// currentColor so each page's CSS sets the colour.

export const SOCIAL = [
  {
    name: 'Facebook',
    url: 'https://www.facebook.com/yourconcerttix',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>',
  },
  {
    name: 'Instagram',
    url: 'https://www.instagram.com/yourconcerttix/',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><path d="M17.5 6.5h.01"/></svg>',
  },
];

// The reason to follow, shown next to the buttons.
export const FOLLOW_PITCH = 'New promo code every day at 10 AM';

// <a> per account: icon + name. `cls` is the class each page styles.
export function followLinks(cls) {
  return SOCIAL.map(s =>
    `<a class="${cls}" href="${s.url}" target="_blank" rel="noopener" aria-label="Your Concert Tix on ${s.name}">${s.icon}<span>${s.name}</span></a>`
  ).join('');
}
