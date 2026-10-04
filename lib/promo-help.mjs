// Help popups about codes, shared by the page generators (sync.mjs for the
// homepage, apache-junction.mjs for the venue pages), like lib/social.mjs:
//
// - "promo": how to use a promo code. FanGenie only takes a code from a
//   signed-in buyer, so it walks people through making a free FanGenie account.
// - "earn": how to get an affiliate code (FanGenie "Affiliate Rewards") and
//   make money on every ticket bought through it. Opened by the earnButton() pill.
//
// Accounts are made on FanGenie's own pages, not in a frame on this site:
// browsers keep a framed site's login separate, so an account made in a frame
// here would not be signed in when "Get Tickets" opens FanGenie.
//
// Put HOWTO_CSS inside the page's <style>, howtoDialogs() just before </body>,
// and the triggers wherever they belong. Any element with data-howto="promo"
// or data-howto="earn" opens that popup, and so does the page URL with #promo
// or #earn on the end (for posts).

import { FOLLOW_PITCH, followLinks } from './social.mjs';

const FANGENIE = 'https://app.fangenie.com';

// The pill's pitch. FanGenie pays affiliates a fixed amount per ticket set on
// each show; the lowest on 2026-10-04 was $2 (Lake Havasu), up to $15.
export const EARN_PITCH = 'Make $2+ a ticket';

// Where FanGenie lists every show's affiliate link ("Affiliate Rewards").
const AFFILIATE_PAGE = '/dashboard/affiliate';

// Opens the promo popup. The page styles the button (pass a class, or style
// it by context as the venue pages' help bar does).
export function howtoButton(label = 'How it works', cls = '') {
  return `<button type="button"${cls ? ` class="${cls}"` : ''} data-howto="promo">${label}</button>`;
}

// The "Make $2+ a ticket" pill that opens the affiliate popup (styled here).
export function earnButton() {
  return `<button type="button" class="earn-pill" data-howto="earn"><i aria-hidden="true">$</i>${EARN_PITCH} &middot; Get your code</button>`;
}

// Both popups plus the script that runs them. `pickShow` is the promo popup's
// step 2 text (HTML), which differs per page; `showsLink` optionally adds a
// button there that closes the popup and jumps to the shows ({ href, label }).
export function howtoDialogs({ pickShow, showsLink = null }) {
  const nextAffiliate = `?next=${encodeURIComponent(AFFILIATE_PAGE)}`;
  return `<dialog class="howto" id="howto-promo" aria-labelledby="howto-promo-title">
  <div class="howto-in">
    <button type="button" class="howto-x" data-howto-close aria-label="Close">&times;</button>
    <div class="howto-kicker">Promo codes</div>
    <h2 id="howto-promo-title">How to use a promo code</h2>
    <p class="howto-lead">Our tickets are sold on FanGenie. To use a code there, you need a free FanGenie account.</p>
    <ol>
      <li><h3>Create your free FanGenie account</h3>
        <p>You only do this once, and it takes about a minute. FanGenie emails you a 6-digit number to confirm it's you.</p>
        <div class="howto-acts">
          <a class="howto-go" data-fg href="${FANGENIE}/auth" target="_blank" rel="noopener">Create my free account</a>
          <a class="howto-alt" data-fg href="${FANGENIE}/auth/login" target="_blank" rel="noopener">Already have one? Sign in</a>
        </div></li>
      <li><h3>Pick your show</h3>
        <p>${pickShow}</p>${showsLink ? `
        <div class="howto-acts"><a class="howto-alt" href="${showsLink.href}" data-howto-close>${showsLink.label}</a></div>` : ''}</li>
      <li><h3>Enter the code in your cart</h3>
        <p>Under &ldquo;Have a promo code?&rdquo; type the code, then tap &ldquo;Apply Promo Code&rdquo;. You need to be signed in.</p></li>
    </ol>
    <div class="howto-foot">
      <p><b>${FOLLOW_PITCH}</b> on our Facebook and Instagram.</p>
      <span class="howto-links">${followLinks('howto-follow')}</span>
    </div>
  </div>
</dialog>
<dialog class="howto" id="howto-earn" aria-labelledby="howto-earn-title">
  <div class="howto-in">
    <button type="button" class="howto-x" data-howto-close aria-label="Close">&times;</button>
    <div class="howto-kicker">Affiliate Rewards</div>
    <h2 id="howto-earn-title">Make $2+ for every ticket</h2>
    <p class="howto-lead">Earn at least $2 for every ticket bought through your link. Some shows pay more.</p>
    <ol>
      <li><h3>Create your free FanGenie account</h3>
        <p>Your code comes from FanGenie, where our tickets are sold. It takes a minute: FanGenie emails you a 6-digit number to confirm.</p>
        <div class="howto-acts">
          <a class="howto-go" href="${FANGENIE}/auth${nextAffiliate}" target="_blank" rel="noopener">Create my free account</a>
          <a class="howto-alt" href="${FANGENIE}/auth/login${nextAffiliate}" target="_blank" rel="noopener">Already have one? Sign in</a>
        </div></li>
      <li><h3>Get your link</h3>
        <p>Open <b>Affiliate Rewards</b> and tap <b>Get Affiliate Link</b> next to any show. Each show gets its own link with your code.</p>
        <div class="howto-acts"><a class="howto-alt" href="${FANGENIE}${AFFILIATE_PAGE}" target="_blank" rel="noopener">Open Affiliate Rewards</a></div></li>
      <li><h3>Share it and get paid</h3>
        <p>Post it anywhere. Earnings go to your FanGenie wallet: spend them on tickets or cash out to PayPal from $10. Your own purchases don't count.</p></li>
    </ol>
    <div class="howto-foot">
      <p><b>Raising money for a school, team or club?</b> <a href="/fundfare/">See Fundfare</a></p>
    </div>
  </div>
</dialog>
<script>
(function(){
  var dialogs=document.querySelectorAll('dialog.howto'); if(!dialogs.length) return;
  // FanGenie can send people back here after signing up (?next=, allow-listed on its side).
  var back='?next='+encodeURIComponent(location.origin+location.pathname);
  document.querySelectorAll('dialog.howto [data-fg]').forEach(function(a){a.href+=back;});
  function anyOpen(){return document.querySelector('dialog.howto[open]');}
  function show(key){
    var d=document.getElementById('howto-'+key);
    if(!d||d.open) return;
    var other=anyOpen(); if(other) hide(other);
    if(typeof d.showModal==='function') d.showModal(); else d.setAttribute('open','');
    document.body.style.overflow='hidden';
  }
  function closed(){
    if(anyOpen()) return;
    document.body.style.overflow='';
    if(location.hash==='#promo'||location.hash==='#earn') history.replaceState(null,'',location.pathname+location.search);
  }
  function hide(d){
    if(typeof d.close==='function') d.close(); else d.removeAttribute('open');
    closed();
  }
  dialogs.forEach(function(d){
    d.addEventListener('close',closed);
    // Bound on each dialog so iOS reports taps on the backdrop.
    // e.target===d is the backdrop: the content fills the dialog box.
    d.addEventListener('click',function(e){
      if(e.target===d||e.target.closest('[data-howto-close]')) hide(d);
    });
  });
  document.addEventListener('click',function(e){
    var t=e.target.closest('[data-howto]');
    if(t){e.preventDefault();show(t.getAttribute('data-howto'));}
  });
  function fromHash(){var k=location.hash.slice(1); if(k==='promo'||k==='earn') show(k);}
  addEventListener('hashchange',fromHash);
  fromHash();
})();
</script>`;
}

// Self-contained colours and fonts (Montserrat 800 + Inter, which both pages
// load) so it looks the same on every page. Phones get a bottom sheet.
export const HOWTO_CSS = `
/* ---------- help popups + "Make $2+ a ticket" pill (lib/promo-help.mjs) ---------- */
.earn-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 14px 6px 6px;border:0;border-radius:999px;background:linear-gradient(90deg,#f5a623,#ffd166);color:#1b1300;
  font:inherit;font-size:13px;font-weight:700;line-height:1.2;white-space:nowrap;cursor:pointer;box-shadow:0 8px 22px -10px rgba(245,166,35,.9);transition:filter .15s,transform .15s}
.earn-pill:hover{filter:brightness(1.06);transform:translateY(-1px)}
.earn-pill i{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#1b1300;color:#ffd166;font-style:normal;font-family:'Montserrat',sans-serif;font-size:12px;font-weight:800}
.howto{position:fixed;inset:0;z-index:100;width:min(540px,calc(100% - 32px));max-width:none;max-height:calc(100% - 32px);margin:auto;padding:0;overflow:auto;overscroll-behavior:contain;
  border:1px solid rgba(255,255,255,.14);border-radius:22px;background:#141430;color:#e8e8f0;box-shadow:0 40px 100px rgba(0,0,0,.8);font-family:'Inter',sans-serif;line-height:1.5;text-align:left}
.howto:not([open]){display:none}
.howto::backdrop{background:rgba(6,6,18,.82);backdrop-filter:blur(6px)}
.howto[open]{animation:howto-rise .25s ease}
@keyframes howto-rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.howto-in{position:relative;padding:24px 24px 22px}
.howto-x{position:absolute;top:12px;right:12px;width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.05);color:#fff;font:inherit;font-size:22px;line-height:1;cursor:pointer}
.howto-x:hover{border-color:#e94560}
.howto-kicker{font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#f5a623}
.howto h2{margin:6px 48px 6px 0;font-family:'Montserrat',sans-serif;font-weight:800;font-size:26px;line-height:1.1;letter-spacing:-.02em}
.howto-lead{color:#b4b4cc;font-size:14.5px}
.howto ol{display:flex;flex-direction:column;gap:10px;margin:18px 0 0;padding:0;list-style:none;counter-reset:howto}
.howto li{position:relative;padding:14px 14px 14px 56px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);counter-increment:howto}
.howto li::before{content:counter(howto);position:absolute;left:14px;top:13px;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#e94560,#f5a623);color:#fff;font-family:'Montserrat',sans-serif;font-weight:800;font-size:14px}
.howto li h3{margin-bottom:2px;font-family:'Montserrat',sans-serif;font-weight:800;font-size:16px;line-height:1.3;letter-spacing:0}
.howto li p{color:#b4b4cc;font-size:14px}
.howto li p b{color:#e8e8f0}
.howto li p a,.howto-foot p a{color:#f5a623;font-weight:600;text-decoration:underline;text-underline-offset:3px}
.howto-acts{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;margin-top:12px}
.howto-go{display:inline-flex;align-items:center;justify-content:center;padding:12px 18px;border-radius:12px;background:linear-gradient(90deg,#e94560,#f5a623);color:#fff;
  font-family:'Montserrat',sans-serif;font-weight:800;font-size:15px;text-decoration:none;box-shadow:0 10px 30px -10px #e94560;transition:filter .2s}
.howto-go:hover{filter:brightness(1.08)}
.howto-alt{color:#f5a623;font-size:14px;font-weight:600;text-decoration:underline;text-underline-offset:3px}
.howto-alt:hover{color:#fff}
.howto-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,.1)}
.howto-foot p{flex:1 1 100%;color:#b4b4cc;font-size:13.5px}
.howto-foot b{color:#f5a623}
.howto-links{display:inline-flex;gap:8px}
.howto-follow{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.04);color:#e8e8f0;font-size:13px;font-weight:600;text-decoration:none}
.howto-follow:hover{border-color:#e94560}
.howto-follow svg{width:16px;height:16px;flex:0 0 auto}
@media (max-width:600px){
  .howto{width:100%;max-height:92%;margin:auto 0 0;border-width:1px 0 0;border-radius:20px 20px 0 0}
  .howto[open]{animation:howto-up .3s ease}
  .howto-in{padding:20px 16px calc(18px + env(safe-area-inset-bottom))}
  .howto h2{font-size:22px}
  .howto ol{margin-top:14px}.howto-foot{margin-top:12px;padding-top:12px}
  .howto li{padding:12px 12px 12px 50px}.howto li::before{left:12px;top:11px}
  .howto-go{width:100%}
}
@keyframes howto-up{from{transform:translateY(100%)}to{transform:none}}
@media (prefers-reduced-motion:reduce){.howto[open]{animation:none}.earn-pill{transition:none}}
`;
