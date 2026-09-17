// Shared site header/nav for the AA Scooters app.
//
// Every page includes this once (`<script src="nav.js" defer></script>` in
// <head>) and has an empty `<div id="topbar-mount"></div>` where the old
// inline topbar used to be. This script injects the topbar markup AND its
// CSS at load time, and marks whichever link matches the current page as
// active -- so adding, renaming, or reordering a nav link only ever needs
// editing here, not in every page.
//
// Relies on the CSS custom properties --petrol, --cone, and --line already
// being defined on :root by each page's own stylesheet (they all define
// the same brand palette).

// =====================================================================
// Auth gate -- replaces the old plaintext-password sessionStorage lock
// that used to live only on index.html (and, being client-side-only,
// didn't actually protect anything -- any other page was reachable
// directly with no check at all). Runs on every page that includes this
// file (this IS the shared include), and asks the server (which holds the
// real, httpOnly session cookie -- see lib/session.js) whether there's a
// currently valid Google sign-in. The actual security boundary is server
// side: every /api/data and /api/write route already refuses to serve
// anything without a valid session regardless of this check (see
// lib/apiAuth.js's withDrive) -- this redirect is purely the UX nicety of
// sending a signed-out visitor to the sign-in screen instead of showing
// them an empty, broken-looking page.
//
// Deliberately fails OPEN on a network error (doesn't redirect) -- a
// transient hiccup checking session status shouldn't lock someone out of
// even seeing the page shell; any actual data call will fail its own way
// regardless if there's truly no valid session.
(function () {
  if (/(^|\/)login\.html$/.test(window.location.pathname)) return; // avoid a redirect loop on the sign-in page itself

  fetch('/api/auth/session')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || !data.loggedIn) {
        var next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace('/login.html?next=' + next);
      }
    })
    .catch(function (err) {
      console.warn('Could not check sign-in status:', err.message);
    });
})();

(function () {
  // Same Apps Script web-app URL every page's own inline script points at.
  // Duplicated here (rather than reading the page's `scriptUrl` const)
  // because nav.js is a <head>, defer-loaded script -- relying on script
  // execution order to guarantee the page's own `scriptUrl` already exists
  // by the time this runs would be fragile. Keep this in sync with the
  // scriptUrl constant in every HTML page when the deployment URL changes.
  var BUGS_SCRIPT_URL = ''; // DISCONNECTED: see project CLAUDE.md

  // Four top-level menu entries, per explicit request: no separate "Home"
  // (the logo/brand link already goes to index.html), three grouped
  // dropdown categories, and Accounts standing alone as a single direct
  // link (it's only ever one page, so a one-item dropdown would be
  // pointless). reply-assistant.html deliberately left out of every
  // category for now -- still a work in progress, page itself stays
  // reachable by direct URL.
  var NAV_STRUCTURE = [
    {
      label: 'Bookings',
      items: [
        { href: 'customers.html', label: 'Customer Record' },
        { href: 'contract.html', label: 'Contract' },
        { href: 'pricing.html', label: 'Price Calculator' }
      ]
    },
    {
      label: 'Fleet',
      items: [
        { href: 'bikes.html', label: 'Bikes Status' },
        { href: 'add-bikes.html', label: 'Add Bike' },
        { href: 'bikephotos.html', label: 'Bike Photos' },
        { href: 'available-bikes.html', label: 'Available Bikes' }
      ]
    },
    {
      label: 'Upkeep',
      items: [
        { href: 'parts.html', label: 'Parts &amp; Oil' },
        { href: 'oilchange.html', label: 'Oil Change' }
      ]
    },
    {
      href: 'accounts.html',
      label: 'Accounts'
      // no items -- single direct link, not a dropdown
    }
  ];

  var TOPBAR_CSS = '\n' +
    '  .topbar{\n' +
    '    background:var(--petrol);\n' +
    '    padding:14px 16px;\n' +
    '    display:flex;\n' +
    '    align-items:center;\n' +
    '    justify-content:space-between;\n' +
    '    flex-wrap:wrap;\n' +
    '    gap:10px;\n' +
    '  }\n' +
    '  .topbar .brand-group{\n' +
    '    display:flex;\n' +
    '    align-items:center;\n' +
    '    gap:10px;\n' +
    '  }\n' +
    '  .topbar .brand{\n' +
    '    display:flex;\n' +
    '    align-items:center;\n' +
    '    gap:8px;\n' +
    '    text-decoration:none;\n' +
    '  }\n' +
    '  .topbar .brand img{\n' +
    '    width:28px; height:28px;\n' +
    '    object-fit:contain;\n' +
    '  }\n' +
    '  .topbar .brand span{\n' +
    "    font-family:'Barlow Condensed',sans-serif;\n" +
    '    font-weight:700;\n' +
    '    font-size:15px;\n' +
    '    color:#fff;\n' +
    '    letter-spacing:.02em;\n' +
    '  }\n' +
    '  .topbar .cal-link{\n' +
    '    display:flex;\n' +
    '    align-items:center;\n' +
    '    justify-content:center;\n' +
    '    width:26px; height:26px;\n' +
    '    border-radius:7px;\n' +
    '    background:rgba(255,255,255,.12);\n' +
    '    text-decoration:none;\n' +
    '    font-size:14px;\n' +
    '    line-height:1;\n' +
    '  }\n' +
    '  .topbar .cal-link:hover{ background:rgba(255,255,255,.22); }\n' +
    '  .topbar .cal-link.active{ background:rgba(255,255,255,.28); }\n' +
    '  .topbar .sync-badge{\n' +
    '    display:flex;\n' +
    '    align-items:center;\n' +
    '    gap:4px;\n' +
    '    padding:0 8px;\n' +
    '    height:26px;\n' +
    '    border-radius:7px;\n' +
    '    background:#C53030;\n' + // hardcoded, not var(--bad) -- this file only guarantees --petrol/--cone/--line exist on every page (see the top-of-file comment), not --bad
    '    color:#fff;\n' +
    '    text-decoration:none;\n' +
    "    font-family:'Barlow Condensed',sans-serif;\n" +
    '    font-weight:700;\n' +
    '    font-size:12px;\n' +
    '    letter-spacing:.02em;\n' +
    '    white-space:nowrap;\n' +
    '  }\n' +
    '  .topbar .sync-badge:hover{ background:#A82828; }\n' +
    // Shared "Saving..." strip (17/08/2026) -- sits right under the topbar
    // on EVERY page, not just bikes.html. bikes.html has its own in-page
    // save-pipeline engine (queue/keepalive/retry-on-409, see that file's
    // own comments) which is the real, live-accurate source of truth while
    // you're actually standing on that page -- but a normal multi-page
    // site tears the whole page's script down the moment you navigate
    // anywhere else, so a save that's still genuinely in flight (kept
    // alive server-side by fetch's keepalive flag) would otherwise become
    // invisible the instant you left. This strip is the fix: it just polls
    // the same localStorage key that engine already writes to
    // (aaBikesPendingSaves) the instant something is queued, from
    // whichever page happens to be open. Same "read shared localStorage,
    // fail quiet" approach as the sync-badge above, just polled instead of
    // read once, and rendered as a full-width strip instead of a pill,
    // to match bikes.html's own original design almost exactly.
    '  .save-strip{\n' +
    '    display:none;\n' +
    '    align-items:center;\n' +
    '    justify-content:center;\n' +
    '    gap:8px;\n' +
    '    padding:9px 14px;\n' +
    '    background:#FFF3E6;\n' +
    '    color:#B36A2E;\n' +
    '    border-bottom:1px solid #F3D9B8;\n' +
    "    font-family:'Barlow Condensed',sans-serif;\n" +
    '    font-weight:700;\n' +
    '    font-size:13.5px;\n' +
    '    letter-spacing:.02em;\n' +
    '    text-align:center;\n' +
    '    text-decoration:none;\n' +
    '    cursor:pointer;\n' +
    '  }\n' +
    '  .save-strip.show{ display:flex; }\n' +
    '  .save-strip:active{ opacity:.85; }\n' +
    '  .topbar .bug-link{\n' +
    '    all:unset;\n' + // several pages define a bare `button{...}` reset for their
                         // own form buttons (customers.html, contract.html, parts.html,
                         // add-bikes.html); since this is a real <button>, those
                         // page-level rules bleed into any property left unset here
                         // (CSS cascades per-property, not per-rule). Reset everything
                         // first so this always renders identically on every page.
    '    box-sizing:border-box;\n' +
    '    display:flex;\n' +
    '    align-items:center;\n' +
    '    justify-content:center;\n' +
    '    width:26px; height:26px;\n' +
    '    border-radius:7px;\n' +
    '    background:rgba(255,255,255,.12);\n' +
    '    text-decoration:none;\n' +
    '    font-size:14px;\n' +
    '    line-height:1;\n' +
    '    cursor:pointer;\n' +
    '    border:none;\n' +
    '  }\n' +
    '  .topbar .bug-link:hover{ background:rgba(255,255,255,.22); }\n' +
    '  .topbar .followup-badge{\n' +
    '    all:unset;\n' +
    '    box-sizing:border-box;\n' +
    '    display:flex;\n' +
    '    align-items:center;\n' +
    '    gap:4px;\n' +
    '    padding:0 8px;\n' +
    '    height:26px;\n' +
    '    border-radius:7px;\n' +
    '    background:#C53030;\n' +
    '    color:#fff;\n' +
    '    font-family:\'Barlow Condensed\',sans-serif;\n' +
    '    font-weight:700;\n' +
    '    font-size:12px;\n' +
    '    letter-spacing:.02em;\n' +
    '    white-space:nowrap;\n' +
    '    cursor:pointer;\n' +
    '  }\n' +
    '  .topbar .followup-badge:hover{ background:#A82828; }\n' +
    '  .followup-backdrop{\n' +
    '    display:none;\n' +
    '    position:fixed; inset:0;\n' +
    '    background:rgba(15,36,33,.45);\n' +
    '    z-index:9999;\n' +
    '    align-items:flex-end; justify-content:center;\n' +
    '  }\n' +
    '  .followup-backdrop.open{ display:flex; }\n' +
    '  .followup-sheet{\n' +
    '    background:#fff; width:100%; max-width:440px;\n' +
    '    border-radius:16px 16px 0 0; padding:20px 18px 22px;\n' +
    '    max-height:82vh; overflow-y:auto;\n' +
    '  }\n' +
    '  @media (min-width:560px){\n' +
    '    .followup-backdrop{ align-items:center; }\n' +
    '    .followup-sheet{ border-radius:16px; }\n' +
    '  }\n' +
    '  .followup-sheet h3{\n' +
    '    font-family:\'Barlow Condensed\',sans-serif; font-weight:700; font-size:20px;\n' +
    '    color:var(--petrol); margin:0 0 4px;\n' +
    '  }\n' +
    '  .followup-sub{ font-size:12.5px; color:#5A6663; margin-bottom:14px; line-height:1.4; }\n' +
    '  .followup-item{\n' +
    '    display:flex; align-items:center; justify-content:space-between; gap:10px;\n' +
    '    padding:11px 12px; border:1px solid var(--line); border-radius:10px; margin-bottom:9px;\n' +
    '    cursor:pointer; background:#fff; transition:background .15s;\n' +
    '  }\n' +
    '  .followup-item:hover{ background:#F5EFE6; }\n' +
    '  .fi-name{ font-family:\'Barlow Condensed\',sans-serif; font-weight:700; font-size:15px; color:var(--petrol); }\n' +
    '  .fi-renter{ font-size:12px; color:#5A6663; margin-top:2px; }\n' +
    '  .fi-tag{\n' +
    '    background:#C53030; color:#fff; font-family:\'Barlow Condensed\',sans-serif;\n' +
    '    font-weight:700; font-size:11px; letter-spacing:.02em; padding:4px 8px; border-radius:6px; white-space:nowrap;\n' +
    '  }\n' +
    '  .followup-empty{ font-size:13px; color:#5A6663; text-align:center; padding:16px 4px; }\n' +
    '  .followup-close-btn{\n' +
    '    width:100%; margin-top:6px; padding:12px; border:none; border-radius:10px; background:#EFEAE0;\n' +
    '    color:var(--petrol); font-family:\'Barlow Condensed\',sans-serif; font-weight:700; font-size:13px;\n' +
    '    letter-spacing:.03em; text-transform:uppercase; cursor:pointer;\n' +
    '  }\n' +
    '  .bugs-backdrop{\n' +
    '    display:none;\n' +
    '    position:fixed; inset:0;\n' +
    '    background:rgba(10,20,20,.45);\n' +
    '    z-index:9999;\n' +
    '    align-items:flex-start;\n' +
    '    justify-content:center;\n' +
    '    padding:60px 16px 16px;\n' +
    '  }\n' +
    '  .bugs-backdrop.open{ display:flex; }\n' +
    '  .bugs-sheet{\n' +
    '    background:#fff;\n' +
    '    border-radius:12px;\n' +
    '    width:100%; max-width:420px;\n' +
    '    max-height:80vh;\n' +
    '    display:flex; flex-direction:column;\n' +
    '    box-shadow:0 12px 40px rgba(0,0,0,.25);\n' +
    '    font-family:Arial,Helvetica,sans-serif;\n' +
    '  }\n' +
    '  .bugs-sheet-header{\n' +
    '    display:flex; align-items:center; justify-content:space-between;\n' +
    '    padding:14px 16px;\n' +
    '    border-bottom:1px solid var(--line, #e2e2e2);\n' +
    '  }\n' +
    '  .bugs-sheet-header h3{\n' +
    '    margin:0; font-size:16px; color:var(--petrol);\n' +
    '  }\n' +
    '  .bugs-close-btn{\n' +
    '    border:none; background:none; cursor:pointer;\n' +
    '    font-size:18px; line-height:1; color:#888; padding:2px 6px;\n' +
    '  }\n' +
    '  .bugs-close-btn:hover{ color:#333; }\n' +
    '  .bugs-add-row{\n' +
    '    display:flex; gap:6px;\n' +
    '    padding:12px 16px;\n' +
    '    border-bottom:1px solid var(--line, #e2e2e2);\n' +
    '  }\n' +
    '  .bugs-add-row input[type=text]{\n' +
    '    flex:1;\n' +
    '    padding:7px 8px;\n' +
    '    border:1px solid #ccc; border-radius:6px;\n' +
    '    font-size:13px;\n' +
    '  }\n' +
    '  .bugs-add-row select{\n' +
    '    padding:7px 6px;\n' +
    '    border:1px solid #ccc; border-radius:6px;\n' +
    '    font-size:13px;\n' +
    '  }\n' +
    '  .bugs-add-row button{\n' +
    '    padding:7px 12px;\n' +
    '    border:none; border-radius:6px;\n' +
    '    background:var(--petrol);\n' +
    '    color:#fff; font-size:13px; font-weight:600;\n' +
    '    cursor:pointer;\n' +
    '  }\n' +
    '  .bugs-add-row button:disabled{ opacity:.6; cursor:default; }\n' +
    '  .bugs-body{\n' +
    '    overflow-y:auto;\n' +
    '    padding:4px 16px 12px;\n' +
    '  }\n' +
    '  .bugs-section-title{\n' +
    '    display:flex; align-items:center; gap:6px;\n' +
    '    font-size:12.5px; font-weight:700;\n' +
    '    color:#555;\n' +
    '    margin:12px 0 6px;\n' +
    '    text-transform:uppercase; letter-spacing:.03em;\n' +
    '  }\n' +
    '  .bugs-dot{\n' +
    '    width:8px; height:8px; border-radius:50%;\n' +
    '    display:inline-block;\n' +
    '  }\n' +
    '  .bugs-dot.bug{ background:#e08a2e; }\n' +
    '  .bugs-dot.feature{ background:#3a7bd5; }\n' +
    '  .bugs-item{\n' +
    '    display:flex; align-items:flex-start; gap:8px;\n' +
    '    padding:6px 2px;\n' +
    '    font-size:13px;\n' +
    '    border-bottom:1px solid #f1f1f1;\n' +
    '  }\n' +
    '  .bugs-item input[type=checkbox]{ margin-top:2px; }\n' +
    '  .bugs-item .bugs-item-text{ flex:1; color:#222; }\n' +
    '  .bugs-item.done .bugs-item-text{ color:#999; text-decoration:line-through; }\n' +
    '  .bugs-item .bugs-item-date{ font-size:11px; color:#aaa; white-space:nowrap; }\n' +
    '  .bugs-empty{ font-size:12.5px; color:#999; padding:6px 2px; }\n' +
    '  .bugs-footer{\n' +
    '    padding:10px 16px;\n' +
    '    border-top:1px solid var(--line, #e2e2e2);\n' +
    '    text-align:right;\n' +
    '  }\n' +
    '  .bugs-footer a{\n' +
    '    font-size:12.5px; color:var(--petrol);\n' +
    '    text-decoration:underline; cursor:pointer;\n' +
    '  }\n' +
    '  .bugs-status{\n' +
    '    font-size:12px; color:#c0392b; padding:0 16px 8px;\n' +
    '  }\n' +
    '  .topbar nav{\n' +
    '    display:flex;\n' +
    '    align-items:center;\n' +
    '    gap:20px;\n' +
    '    flex-wrap:wrap;\n' +
    '    position:relative;\n' +
    '  }\n' +
    '  .topbar nav a{\n' +
    '    color:#CFE3E0;\n' +
    '    text-decoration:none;\n' +
    '    font-size:12.5px;\n' +
    '    font-weight:500;\n' +
    '    padding:3px 0;\n' +
    '    border-bottom:2px solid transparent;\n' +
    '  }\n' +
    '  .topbar nav a:hover{ color:#fff; }\n' +
    '  .topbar nav a.active{ color:#fff; border-bottom-color:var(--cone); }\n' +
    '  .topbar .nav-cat{\n' +
    '    position:relative;\n' +
    '  }\n' +
    '  .topbar .nav-cat-btn{\n' +
    '    all:unset;\n' + // same page-level `button{...}` bleed risk as .bug-link above --
                         // customers.html, contract.html, parts.html and add-bikes.html
                         // all define a bare `button` reset (uppercase text, full width,
                         // orange background, margin-top) that otherwise leaks into
                         // whichever of these properties this rule doesn't explicitly
                         // set, since CSS cascades per-property, not per-rule.
    '    box-sizing:border-box;\n' +
    '    display:flex;\n' +
    '    align-items:center;\n' +
    '    gap:4px;\n' +
    '    background:none;\n' +
    '    border:none;\n' +
    '    border-bottom:2px solid transparent;\n' +
    '    cursor:pointer;\n' +
    '    color:#CFE3E0;\n' +
    '    font-family:inherit;\n' +
    '    font-size:12.5px;\n' +
    '    font-weight:500;\n' +
    '    text-transform:none;\n' +
    '    letter-spacing:normal;\n' +
    '    line-height:normal;\n' +
    '    padding:3px 0;\n' +
    '    margin:0;\n' +
    '    width:auto;\n' +
    '  }\n' +
    '  .topbar .nav-cat-btn:hover{ color:#fff; }\n' +
    '  .topbar .nav-cat-btn .nav-caret{\n' +
    '    font-size:9px;\n' +
    '    transition:transform .15s ease;\n' +
    '  }\n' +
    '  .topbar .nav-cat.open .nav-cat-btn .nav-caret{ transform:rotate(180deg); }\n' +
    '  .topbar .nav-cat-btn.active{ color:#fff; border-bottom-color:var(--cone); }\n' +
    '  .topbar .nav-dropdown{\n' +
    '    display:none;\n' +
    '    position:absolute;\n' +
    '    top:calc(100% + 10px);\n' +
    '    left:0;\n' +
    '    background:var(--petrol);\n' +
    '    border:1px solid rgba(255,255,255,.15);\n' +
    '    border-radius:8px;\n' +
    '    min-width:180px;\n' +
    '    padding:6px;\n' +
    '    box-shadow:0 10px 28px rgba(0,0,0,.28);\n' +
    '    z-index:500;\n' +
    '    flex-direction:column;\n' +
    '    gap:2px;\n' +
    '  }\n' +
    '  .topbar .nav-cat.open .nav-dropdown{ display:flex; }\n' +
    '  .topbar .nav-dropdown a{\n' +
    '    color:#CFE3E0;\n' +
    '    text-decoration:none;\n' +
    '    font-size:12.5px;\n' +
    '    font-weight:500;\n' +
    '    padding:7px 10px;\n' +
    '    border-radius:6px;\n' +
    '    border-bottom:none;\n' +
    '    white-space:nowrap;\n' +
    '  }\n' +
    '  .topbar .nav-dropdown a:hover{ color:#fff; background:rgba(255,255,255,.10); }\n' +
    '  .topbar .nav-dropdown a.active{ color:#fff; background:rgba(255,255,255,.16); }\n' +
    '  .topbar .settings-link{\n' +
    '    display:flex;\n' +
    '    align-items:center;\n' +
    '    justify-content:center;\n' +
    '    width:26px; height:26px;\n' +
    '    border-radius:7px;\n' +
    '    background:rgba(255,255,255,.12);\n' +
    '    text-decoration:none;\n' +
    '    font-size:14px;\n' +
    '    color:#CFE3E0;\n' +
    '  }\n' +
    '  .topbar .settings-link:hover{ background:rgba(255,255,255,.22); }\n' +
    '  .topbar .settings-link.active{ background:rgba(255,255,255,.28); color:#fff; }\n';

  function currentPage() {
    var path = window.location.pathname.split('/').pop();
    return path || 'index.html';
  }

  function injectCss() {
    if (document.getElementById('shared-topbar-css')) return;
    var style = document.createElement('style');
    style.id = 'shared-topbar-css';
    style.textContent = TOPBAR_CSS;
    document.head.appendChild(style);
  }

  function buildLinksHtml() {
    var current = currentPage();
    var catIndex = 0;
    return NAV_STRUCTURE.map(function (entry) {
      // Single direct link (no "items" array) -- e.g. Accounts.
      if (!entry.items) {
        var active = entry.href === current ? ' class="active"' : '';
        return '<a href="' + entry.href + '"' + active + '>' + entry.label + '</a>';
      }

      // Dropdown category: parent button shows "active" styling when the
      // current page belongs to one of its sub-items.
      var containsCurrent = entry.items.some(function (it) { return it.href === current; });
      var id = 'navCat' + (catIndex++);
      var subLinksHtml = entry.items.map(function (it) {
        var itActive = it.href === current ? ' class="active"' : '';
        return '<a href="' + it.href + '"' + itActive + '>' + it.label + '</a>';
      }).join('\n        ');

      return (
        '<div class="nav-cat" id="' + id + '">' +
        '<button type="button" class="nav-cat-btn' + (containsCurrent ? ' active' : '') + '" aria-expanded="false">' +
        entry.label + ' <span class="nav-caret">&#9660;</span>' +
        '</button>' +
        '<div class="nav-dropdown">\n        ' + subLinksHtml + '\n      </div>' +
        '</div>'
      );
    }).join('\n    ');
  }

  // Click/tap-to-toggle, accordion-style: opening one category dropdown
  // closes any other that's open, and clicking anywhere outside the nav
  // closes whichever is open. Chosen over hover because it behaves the
  // same on touch devices as on desktop.
  function closeAllNavDropdowns(except) {
    var cats = document.querySelectorAll('.topbar .nav-cat.open');
    for (var i = 0; i < cats.length; i++) {
      if (cats[i] !== except) {
        cats[i].classList.remove('open');
        var btn = cats[i].querySelector('.nav-cat-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }
    }
  }

  function initNavDropdowns() {
    var cats = document.querySelectorAll('.topbar .nav-cat');
    for (var i = 0; i < cats.length; i++) {
      (function (cat) {
        var btn = cat.querySelector('.nav-cat-btn');
        if (!btn) return;
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var isOpen = cat.classList.contains('open');
          closeAllNavDropdowns(cat);
          cat.classList.toggle('open', !isOpen);
          btn.setAttribute('aria-expanded', String(!isOpen));
        });
      })(cats[i]);
    }
    document.addEventListener('click', function () {
      closeAllNavDropdowns();
    });
  }

  // Small alert pill shown in the shared header when accounts.html has one
  // or more saves that failed to reach Google Drive and are still waiting
  // on a retry -- see accounts.html's persistFailedSaves()/optItems/
  // FAILED_SAVES_STORAGE_KEY, which this key name and shape are shared
  // with (keep both in sync if either ever changes). This exists because
  // accounts.html's own in-page banner only helps while you're actually
  // ON accounts.html -- this is a normal multi-page site, not a
  // single-page app, so navigating anywhere else tears down that page's
  // whole script (and its in-memory failure list) along with it. Read
  // fresh once per page load, same as the rest of this topbar -- doesn't
  // live-update if another tab changes it while this page stays open.
  function syncBadgeHtml() {
    try {
      var raw = localStorage.getItem('aaAccountsFailedSaves');
      if (!raw) return '';
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return '';
      var n = arr.length;
      return '<a class="sync-badge" href="accounts.html" title="' + n + ' accounts save' + (n === 1 ? '' : 's') +
        ' didn\'t reach Google Drive -- tap to review">&#9888; ' + n + '</a>';
    } catch (e) { return ''; } // corrupt/inaccessible storage -- fail quiet, same as everything else here
  }

  // Reads ONE page's save-pipeline engine state straight out of
  // localStorage (see that page's own persistPendingSaves()) and returns
  // how many saves are currently running/queued there, 0 if none or
  // unreadable. Deliberately does NOT try to distinguish "running" vs
  // "queued" here (that nuance only matters while actually standing on
  // the owning page, where its own live in-memory queue drives it
  // precisely) -- from anywhere else, "something is still saving" is the
  // whole story that matters. Generic over PENDING_SAVE_SOURCES (defined
  // below) rather than hardcoded to bikes.html, so this and
  // refreshSaveStrip() automatically pick up contract.html's (and any
  // future page's) own pending-save key with no further changes here.
  function pendingSaveItems(source) {
    try {
      var raw = localStorage.getItem(source.pendingKey);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; } // corrupt/inaccessible storage -- fail quiet, same as syncBadgeHtml above
  }
  function pendingSaveCount(source) { return pendingSaveItems(source).length; }

  // ---- Percentage on the shared strip (added 22/08/2026, Anton: "a lot of
  // them are really slow... can we have a percentage everywhere for
  // saving?"). This strip is read-only from any page OTHER than the one
  // that queued the save (see file header) -- the only signal available
  // here is elapsed time since the oldest pending item's own queuedAt (set
  // by that page's persistPendingSaves()), so this climbs toward a generic
  // estimated-duration asymptote exactly like every other progress
  // indicator added this same day (see settings.html's
  // startPercentProgress for the identical formula/reasoning) -- never
  // claims 100%, since from here there's no way to know the save actually
  // finished until the strip disappears entirely. ----
  function oldestQueuedAt(counts) {
    var oldest = null;
    counts.forEach(function (c) {
      c.items.forEach(function (it) {
        if (typeof it.queuedAt === 'number' && (oldest === null || it.queuedAt < oldest)) oldest = it.queuedAt;
      });
    });
    return oldest;
  }
  function estimatedSavePercent(queuedAt) {
    if (!queuedAt) return null;
    var elapsed = Date.now() - queuedAt;
    var estimatedMs = 6000; // generic -- this strip can't know which specific action queued it
    return Math.max(1, Math.round(92 * (1 - Math.exp(-elapsed / estimatedMs))));
  }

  // Keeps the shared "Saving..." strip in step with localStorage --
  // called once at render time and then polled (see the setInterval in
  // renderTopbar below), so it stays reasonably fresh while sitting on a
  // DIFFERENT page from the one that queued the save, not just at the
  // moment this page happened to load. Deliberately only updates this one
  // element in place rather than re-running renderTopbar() on every tick
  // -- re-injecting the whole topbar's outerHTML on a timer would reset
  // any open dropdown/modal state for no reason. Sums across EVERY
  // registered source (bikes.html, contract.html, ...) -- "(N queued)"
  // is the total waiting behind each source's own 1 "running" slot, not
  // any single page's queue, since two different pages can each have
  // their own save genuinely in flight at once.
  function refreshSaveStrip() {
    var el = document.getElementById('saveStrip');
    if (!el) return;
    var counts = PENDING_SAVE_SOURCES.map(function (s) { return { source: s, items: pendingSaveItems(s) }; });
    var total = counts.reduce(function (sum, c) { return sum + c.items.length; }, 0);
    if (!total) { el.classList.remove('show'); return; }
    var queuedCount = counts.reduce(function (sum, c) { return sum + Math.max(0, c.items.length - 1); }, 0);
    var pct = estimatedSavePercent(oldestQueuedAt(counts));
    var pctLabel = pct ? (' ' + pct + '%') : '';
    el.textContent = queuedCount ? ('● Saving…' + pctLabel + ' (' + queuedCount + ' queued)') : ('● Saving…' + pctLabel);
    // Link to whichever source actually has the most pending right now
    // (stable tie-break to the first entry, i.e. bikes.html, if equal) --
    // that's the one worth reviewing/retrying from if something's stuck.
    var withMost = counts.reduce(function (best, c) { return (c.items.length > best.items.length) ? c : best; }, counts[0]);
    el.href = withMost.source.ownerPage;
    el.title = 'A save is still in progress -- tap to go there';
    el.classList.add('show');
  }

  // =====================================================================
  // Cross-page orphan-save recovery (Anton, 17/08/2026 -- reported the
  // strip stuck on "Saving..." on parts.html for minutes, transaction
  // long since gone through). Root cause: the strip above is READ-ONLY --
  // it just displays whatever bikes.html's own save-pipeline engine last
  // wrote to aaBikesPendingSaves. Only bikes.html's OWN script
  // (restoreUnresolvedSaves(), run on ITS OWN page load) ever actually
  // resubmits/clears a leftover entry. bikes.html's writes use
  // fetch(..., {keepalive:true}) -- keepalive keeps the NETWORK REQUEST
  // alive across a navigation, but the JS that would receive the response
  // and clear the flag is torn down the instant you leave that page. If
  // nobody goes back to bikes.html afterwards, that flag -- and the
  // header strip everywhere else in the app -- is stuck forever, even
  // though the write itself finished successfully server-side within
  // seconds.
  //
  // Fix: give this shared file its OWN minimal resubmit capability,
  // duplicated from bikes.html's bkDispatch/bkDispatchWithRetry (same
  // POST shape, same 409-retry -- see that file's own comment for why
  // this is safe: every action here is idempotency-guarded server-side,
  // so blindly resubmitting something that already succeeded is a cheap,
  // safe no-op that just confirms it and lets the flag clear). This runs
  // from ANY page that includes this shared header, not just bikes.html,
  // which is the actual fix -- recovery is no longer stuck waiting for
  // someone to happen to revisit the one page that used to own it.
  //
  // One entry per page with its own save-pipeline engine + pending-save
  // localStorage key. Add contract.html's here once its own engine exists
  // (see PROGRESS.md's rollout plan) -- everything below is written
  // generically against this table, not hardcoded to bikes.html.
  var PENDING_SAVE_SOURCES = [
    { ownerPage: 'bikes.html', pendingKey: 'aaBikesPendingSaves', failedKey: 'aaBikesFailedSaves', endpoint: '/api/bikes/write' },
    // Added 17/08/2026 the moment contract.html's own save-pipeline engine
    // scaffold landed (see PROGRESS.md) -- this table was written
    // generically specifically so this is a one-line addition, closing the
    // loop on the orphan-recovery fix above for this page too.
    { ownerPage: 'contract.html', pendingKey: 'aaContractPendingSaves', failedKey: 'aaContractFailedSaves', endpoint: '/api/contract/write' },
    // Added 17/08/2026 the moment deposits.html's own save-pipeline engine
    // landed (see PROGRESS.md). endpoint is /api/accounts/write, NOT a
    // dedicated /api/deposits/write -- deposits.html's 5 actions are
    // routed through the SAME endpoint accounts.html uses (see that file's
    // own routing comment for why: Vercel's Hobby-plan 12-function cap).
    { ownerPage: 'deposits.html', pendingKey: 'aaDepositsPendingSaves', failedKey: 'aaDepositsFailedSaves', endpoint: '/api/accounts/write' },
    // Added 17/08/2026 (overnight) the moment add-bikes.html's own
    // save-pipeline engine landed (see PROGRESS.md). endpoint is
    // /api/bikes/write, NOT a dedicated /api/add-bikes/write -- routed
    // through the SAME endpoint bikes.html uses, split by action name (see
    // api/bikes/write.js's own ROUTING NOTE comment for why: Vercel's
    // Hobby-plan 12-function cap).
    { ownerPage: 'add-bikes.html', pendingKey: 'aaAddBikesPendingSaves', failedKey: 'aaAddBikesFailedSaves', endpoint: '/api/bikes/write' },
    // Added 17/08/2026 (overnight) the moment customers.html's own
    // save-pipeline engine landed (see PROGRESS.md) -- last page in this
    // rollout. endpoint is /api/accounts/write, NOT a dedicated
    // /api/customers/write -- routed through the SAME endpoint
    // accounts.html/deposits.html use, split by action name (see
    // lib/customersWrites.js's own header comment for why: Vercel's
    // Hobby-plan 12-function cap).
    { ownerPage: 'customers.html', pendingKey: 'aaCustomersPendingSaves', failedKey: 'aaCustomersFailedSaves', endpoint: '/api/accounts/write' }
  ];

  // Only items queued at least this long ago are treated as possibly
  // orphaned. Guards against jumping in on a save that's simply still
  // genuinely in flight on its own tab elsewhere (e.g. a slow long-
  // extend) -- 15s is comfortably longer than any real round trip this
  // app makes, per bikes.html's own comment on why several seconds is
  // normal for a multi-step action.
  var RECOVERY_MIN_AGE_MS = 15000;

  function readJsonArray(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function writeJsonArrayOrRemove(key, arr) {
    try {
      if (arr.length) localStorage.setItem(key, JSON.stringify(arr));
      else localStorage.removeItem(key);
    } catch (e) { /* best-effort, same posture as everywhere else in this file */ }
  }
  // Read-modify-write scoped to ONE item (matched by clientTxnId) rather
  // than overwriting the whole key with a stale snapshot -- so this can't
  // clobber a genuinely NEW save some other tab queues on bikes.html
  // itself while this recovery pass is still mid-flight.
  function removeFromPending(pendingKey, clientTxnId) {
    var current = readJsonArray(pendingKey);
    writeJsonArrayOrRemove(pendingKey, current.filter(function (r) { return r && r.clientTxnId !== clientTxnId; }));
  }

  // Resubmits ONE item's remaining requests in strict order -- mirrors
  // bikes.html's bkRun/bkDispatch/bkDispatchWithRetry, duplicated here
  // per this project's per-file convention (see CLAUDE.md). Resolves to
  // {success:true} or {success:false, message}.
  function recoverItem(source, item) {
    var i = 0;
    function runNext() {
      if (i >= item.requests.length) return Promise.resolve({ success: true });
      var req = item.requests[i];
      var body = Object.assign({ action: req.action }, req.payload);
      var attempt = 1;
      var maxAttempts = 3;
      function attemptOnce() {
        return fetch(source.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true
        }).then(function (r) {
          if (r.status === 401) return { success: false, message: 'Signed out -- please refresh to sign in again.' };
          return r.json().catch(function () { return {}; }).then(function (res) {
            if (r.status === 409) {
              if (attempt < maxAttempts) {
                attempt++;
                return new Promise(function (resolve) { setTimeout(resolve, 700 * attempt); }).then(attemptOnce);
              }
              return { success: false, message: res.error || 'This record was changed by someone else in the meantime -- please reload and try again.' };
            }
            if (!r.ok || res.success === undefined) return { success: false, message: res.error || ('HTTP ' + r.status) };
            if (res.success === false) return { success: false, message: res.error || 'Could not save.' };
            return { success: true, __step: res };
          });
        }, function (err) {
          return { success: false, message: (err && err.message) || 'Network error.' };
        });
      }
      return attemptOnce().then(function (result) {
        if (!result.success) return result;
        i++;
        return runNext();
      });
    }
    return runNext();
  }

  // Guards against this running again while a previous pass is still
  // resolving (a pass can take a few seconds across a couple of retries)
  // -- the 2.5s poll tick that drives this would otherwise pile up
  // overlapping fetches for the same stuck item.
  var recoveryInFlight = false;

  function recoverOrphanedSaves() {
    if (recoveryInFlight) return;
    var here = currentPage();
    var jobs = [];
    PENDING_SAVE_SOURCES.forEach(function (source) {
      if (here === source.ownerPage) return; // that page's own engine already owns recovery while you're standing on it
      var now = Date.now();
      readJsonArray(source.pendingKey).forEach(function (rec) {
        if (!rec || !Array.isArray(rec.requests) || !rec.requests.length) return;
        var age = now - (rec.queuedAt || 0);
        if (age >= RECOVERY_MIN_AGE_MS) jobs.push({ source: source, rec: rec });
      });
    });
    if (!jobs.length) return;
    recoveryInFlight = true;
    console.warn('[nav] ' + jobs.length + ' unfinished save(s) elsewhere in the app look orphaned (queued 15s+ ago, not on their own page right now) -- resubmitting in the background to confirm/finish them.');

    // Sequential, not parallel -- keeps this simple, and matches
    // bikes.html's own one-at-a-time bkRun. The pending count (and the
    // strip's text/visibility) is refreshed after EACH item resolves, not
    // just once at the end, so "Saving... (1 queued)" correctly steps
    // down to "Saving..." -- and then disappears entirely -- as each one
    // actually finishes, the same way bikes.html's own strip already
    // behaves while you're standing on that page. If a NEW save gets
    // queued (on bikes.html itself, in another tab) partway through this
    // pass, the next poll tick's refreshSaveStrip() picks it up
    // immediately regardless, since that's always a fresh localStorage
    // read.
    function runOne(idx) {
      if (idx >= jobs.length) { recoveryInFlight = false; refreshSaveStrip(); return; }
      var job = jobs[idx];
      recoverItem(job.source, job.rec).then(function (result) {
        if (!result.success) {
          var failedArr = readJsonArray(job.source.failedKey);
          failedArr.push({
            id: 'nav_' + Date.now() + '_' + idx, label: job.rec.label || 'Unfinished save',
            rows: job.rec.rows || [], requests: job.rec.requests, message: result.message
          });
          writeJsonArrayOrRemove(job.source.failedKey, failedArr);
        }
        // Resolved (dropped) or moved to the failed list above -- either
        // way it's no longer "pending". Removed by clientTxnId, not by
        // overwriting the whole key, so a concurrently-added new save on
        // the owner page survives untouched.
        removeFromPending(job.source.pendingKey, job.rec.clientTxnId);
        refreshSaveStrip();
        runOne(idx + 1);
      });
    }
    runOne(0);
  }

  function renderTopbar() {
    var mount = document.getElementById('topbar-mount');
    if (!mount) return; // page opted out of the shared header

    injectCss();

    var syncHtml = syncBadgeHtml();

    // Links to the in-app Calendar page (calendar.html), which embeds the
    // shared bike-returns Google Calendar directly -- no separate Google
    // login required, since that calendar is shared publicly by link.
    var calActive = currentPage() === 'calendar.html' ? ' active' : '';
    var calLinkHtml = '<a class="cal-link' + calActive + '" href="calendar.html" title="Bike returns calendar">📅</a>';
    var bugLinkHtml = '<button type="button" class="bug-link" id="bugsIconBtn" title="Bugs &amp; Features">🐛</button>';
    var followUpHtml = followUpBadgeHtml();

    // Settings gear -- links to the dedicated settings.html page (AI
    // provider toggle, transaction history/reverse, data reset, sign out).
    // Used to be an inline dropdown built here; moved out to its own page
    // 14/08/2026 once it grew a real feature (reverse transactions) that
    // needed more room than a small dropdown, and so that page's business
    // logic didn't have to live in this shared UI-chrome file.
    var settingsActive = currentPage() === 'settings.html' ? ' active' : '';
    var settingsHtml = '<a class="settings-link' + settingsActive + '" href="settings.html" title="Settings" aria-label="Settings">&#9881;</a>';

    mount.outerHTML =
      '<div class="topbar">\n' +
      '  <div class="brand-group">\n' +
      '    <a class="brand" href="index.html">\n' +
      '      <img src="https://scooterrentalchiangmai.com/wp-content/uploads/2025/02/cropped-logo-3333-101x105.png" alt="AA Scooters logo">\n' +
      '      <span>AA Scooter Rental</span>\n' +
      '    </a>\n' +
      '    ' + syncHtml + '\n' +
      '    ' + calLinkHtml + '\n' +
      '    ' + followUpHtml + '\n' +
      '    ' + bugLinkHtml + '\n' +
      '  </div>\n' +
      '  <nav>\n' +
      '    ' + buildLinksHtml() + '\n' +
      '    ' + settingsHtml + '\n' +
      '  </nav>\n' +
      '</div>\n' +
      // Full-width strip, sibling of (not nested inside) .topbar -- see
      // pendingSaveCount()/refreshSaveStrip() above for what drives it.
      // href/title are placeholders here -- refreshSaveStrip() sets both
      // dynamically to whichever registered page actually has something
      // pending, the moment it first runs.
      '<a class="save-strip" id="saveStrip" href="bikes.html" title="A save is still in progress -- tap to go there"></a>';

    initBugsWidget();
    initNavDropdowns();
    initFollowUpQueueModal();

    refreshSaveStrip();
    // Attempt orphan recovery right away too (not just on the first poll
    // tick 2.5s from now) -- see recoverOrphanedSaves()'s own comment for
    // the full "why". Harmless/instant no-op when there's nothing old
    // enough to act on, which is the common case.
    recoverOrphanedSaves();
    // Polled (not just read once, unlike syncBadgeHtml's failed-save pill
    // above) so the strip stays reasonably fresh while sitting on a
    // DIFFERENT page from whichever one queued the save -- that page's own
    // script (the only thing that would otherwise resolve/clear it) is
    // gone the moment you navigate away. 2.5s is frequent enough to feel
    // live without hammering localStorage. Cleared and restarted is never
    // needed -- renderTopbar() only ever runs once per page load. Each
    // tick also re-tries recoverOrphanedSaves() -- cheap when nothing
    // qualifies, and lets an item that was too young to touch on the
    // first pass become eligible without needing a reload.
    setInterval(function () { refreshSaveStrip(); recoverOrphanedSaves(); }, 2500);

    // See checkDailyBackup()'s own comment below for what this does and why.
    checkDailyBackup();
    setInterval(checkDailyBackup, BACKUP_CHECK_INTERVAL_MS);

    // See refreshFollowUpDataFromServer()'s own comment below for what
    // this does and why (keeps the header follow-up badge accurate on
    // THIS device without depending on oilchange.html ever having been
    // opened here -- see its FIX 2026-09-17 comment for the full story).
    refreshFollowUpDataFromServer();
    setInterval(refreshFollowUpDataFromServer, FOLLOWUP_POLL_MS);
  }

  // =====================================================================
  // Silent daily data backup (added 2026-08-20, per Anton -- see
  // lib/backups.js's header comment for the full design/why). Runs once
  // per page load PLUS on a recurring hourly timer, both calling the same
  // "create a backup only if it's been a while since the last one"
  // endpoint action through whichever staff session is ALREADY logged
  // into this tab -- no separate stored credential, no cron.
  //
  // The hourly timer specifically exists for Anton's own workflow: he
  // often leaves the app open in a browser tab on his phone for two or
  // three days straight without closing/reopening it, so a check that
  // only ran once at page-load time would miss every day after the
  // first. An hourly re-check while the tab stays open catches a new day
  // rolling over within about an hour, without needing a reload. If the
  // tab genuinely isn't open for a few days, nothing's changing in the
  // live data either, so there's nothing lost by not backing up on those
  // days -- the next time the tab IS open, this check catches up.
  //
  // Deliberately silent/best-effort throughout: this is a background
  // safety net, never something a staff member should have to notice,
  // wait for, or be interrupted by. A failure here (signed out, offline,
  // Drive hiccup) is swallowed exactly like recoverOrphanedSaves()'s own
  // background retries above -- the NEXT check (next page load, or next
  // hourly tick) just tries again.
  // =====================================================================
  var BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  function checkDailyBackup() {
    fetch('/api/admin/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'backupEnsureDaily' })
    }).catch(function () { /* best-effort, see comment above */ });
  }

  // =====================================================================
  // Oil Change follow-up queue (added 12/09/2026) -- the red header badge
  // and its queue list for bikes whose "customer contacted" checkbox
  // (oilchange.html) has had no update for 2+ days. This file never talks
  // to /api/data itself -- it just reads the small summary oilchange.html
  // caches to localStorage every time IT loads or changes that data (see
  // that file's writeFollowUpCache()), same "read fresh once per page
  // load, doesn't live-update elsewhere" tradeoff syncBadgeHtml() above
  // already accepts, for the same reason (normal multi-page site).
  // Clicking a queue item sends you to oilchange.html?followup=<bike
  // name>, which scrolls to and highlights that card (see
  // handleFollowupDeepLink() there) -- this file doesn't render bike
  // cards itself, so navigating is simpler than trying to share state.
  // =====================================================================
  function followUpBadgeHtml() {
    try {
      var raw = localStorage.getItem('aaOilchangeFollowUps');
      if (!raw) return '';
      var parsed = JSON.parse(raw);
      var items = (parsed && parsed.items) || [];
      if (!items.length) return '';
      return '<button type="button" class="followup-badge" id="followUpBadgeBtn" title="' + items.length + ' bike' + (items.length === 1 ? '' : 's') +
        ' waiting on a customer follow-up">&#9888; Follow-up &middot; ' + items.length + '</button>';
    } catch (e) { return ''; } // corrupt/inaccessible storage -- fail quiet, same as everything else here
  }

  // FIX 2026-09-14 (Anton: the header badge never appeared even once a
  // bike's follow-up genuinely went overdue): followUpBadgeHtml() above is
  // only ever evaluated ONCE per page, at renderTopbar()'s own
  // DOMContentLoaded time -- see that comment. On oilchange.html itself,
  // that happens BEFORE loadParts() has fetched anything, so the topbar
  // gets built from whatever localStorage held from the *previous* visit,
  // not the fresh totals this load just computed in writeFollowUpCache().
  // The badge was never actually broken -- it just always lagged one full
  // page load behind reality, which is why it could look like it "never"
  // shows up if the overdue count only just became nonzero (or just went
  // back to zero) on the load you're looking at.
  //
  // This closes that gap: oilchange.html now dispatches
  // 'aa:oilchangeFollowUpsUpdated' on window right after it (re)writes the
  // cache (see writeFollowUpCache() there), and this re-runs the exact
  // same followUpBadgeHtml() markup against the just-updated cache,
  // inserting/updating/removing the button in place -- no reload needed.
  // Harmless on every other page too (nothing ever dispatches this event
  // there), and harmless if oilchange.html's script happens to fire this
  // before renderTopbar() has run yet (mount lookup below just no-ops).
  function refreshFollowUpBadge() {
    var topbar = document.querySelector('.topbar .brand-group');
    if (!topbar) return; // topbar hasn't been rendered yet on this page
    var existing = document.getElementById('followUpBadgeBtn');
    var html = followUpBadgeHtml();
    if (!html) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      // Count (and therefore the title/text) can change without the
      // button needing to be recreated -- update it in place so it isn't
      // re-inserted (and doesn't lose focus/hover state) on every tick.
      var wrap = document.createElement('div');
      wrap.innerHTML = html;
      var fresh = wrap.firstChild;
      existing.title = fresh.title;
      existing.textContent = fresh.textContent;
      return;
    }
    // Wasn't showing before -- insert it in the same brand-group slot
    // renderTopbar() itself uses (right before the bug-tracker icon).
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    var btn = wrap.firstChild;
    var bugLink = document.getElementById('bugsIconBtn');
    if (bugLink) topbar.insertBefore(btn, bugLink); else topbar.appendChild(btn);
    initFollowUpQueueModal();
  }
  window.addEventListener('aa:oilchangeFollowUpsUpdated', refreshFollowUpBadge);

  // =====================================================================
  // FIX 2026-09-17 (Anton: follow-up alert inconsistent across devices --
  // "showing different alerts to others", not refreshing properly):
  // everything above (followUpBadgeHtml/refreshFollowUpBadge) only ever
  // READS the 'aaOilchangeFollowUps' localStorage cache -- nothing in
  // this file ever WROTE it. The only thing that ever wrote it was
  // oilchange.html's own writeFollowUpCache(), which only runs on a
  // device when THAT device loads oilchange.html itself. localStorage is
  // per browser/device, never shared -- so a phone that hasn't opened
  // Oil Change in a few days keeps showing whatever was true days ago
  // (or nothing, if it's never opened that page at all), while a tablet
  // that opened it this morning shows today's real count. Every device's
  // badge was only ever as fresh as THAT device's own oilchange.html
  // visit history -- exactly the "different alerts on different devices"
  // symptom, not a rendering bug. (The "same tradeoff syncBadgeHtml()
  // above already accepts" comment above this one was actually comparing
  // two different things: syncBadgeHtml's failed-save pill really is
  // per-device data -- MY OWN failed local writes -- but which customers
  // need following up is shared team state, not per-device.)
  //
  // This gives every page its own independent source of truth instead of
  // depending on oilchange.html ever having been opened on this device:
  // fetches the same 'Parts_and_Oil_change' + 'bikes_notes' sheets
  // oilchange.html's own getPartsDataFromJson() reads, ports that same
  // "contacted N+ days ago, not a sold bike" filter
  // (writeFollowUpCache()/__struck there) against the raw cell value
  // directly (no need for the dd/mm/yyyy round-trip oilchange.html's own
  // display layer uses), and writes the result to the SAME cache
  // key/shape so followUpBadgeHtml() above needs no changes at all.
  // Renter name is intentionally left blank here (it needs a further
  // Customer+Contract cross-reference oilchange.html does client-side --
  // out of scope for a header-badge poll running on every page); a
  // device that later visits oilchange.html fills it back in as before,
  // same as it always has. Same fire-and-forget/fail-quiet pattern as
  // checkDailyBackup() above -- never something a staff member should
  // notice, wait for, or be blocked by if it fails.
  // =====================================================================
  var FOLLOWUP_POLL_MS = 5 * 60 * 1000; // 5 min -- overdue is a 2-DAY threshold, this just needs to catch up occasionally on a long-open tab (see checkDailyBackup()'s own reasoning above), not live-tick
  var FOLLOWUP_CONTACT_HEADER = 'Oil change contacted on';
  var FOLLOWUP_DUE_DAYS = 2;
  var FOLLOWUP_DISTINGUISHING_SUFFIXES = {
    one: 1, two: 1, three: 1, four: 1, five: 1, six: 1, seven: 1, eight: 1, nine: 1, ten: 1,
    i: 1, ii: 1, iii: 1, iv: 1, v: 1, vi: 1, vii: 1, viii: 1, ix: 1, x: 1,
    '1': 1, '2': 1, '3': 1, '4': 1, '5': 1, '6': 1, '7': 1, '8': 1, '9': 1, '10': 1
  };
  function followUpNormalizeBikeName_(s) {
    return (s || '').toString().toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }
  function followUpBikeNamesMatch_(a, b) {
    var na = followUpNormalizeBikeName_(a), nb = followUpNormalizeBikeName_(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    var ta = na.split(' '), tb = nb.split(' ');
    var shorter = ta.length <= tb.length ? ta : tb;
    var longer = ta.length <= tb.length ? tb : ta;
    var isPrefix = true;
    for (var i = 0; i < shorter.length; i++) { if (shorter[i] !== longer[i]) { isPrefix = false; break; } }
    if (isPrefix) {
      var extra = longer.slice(shorter.length);
      for (var j = 0; j < extra.length; j++) { if (FOLLOWUP_DISTINGUISHING_SUFFIXES[extra[j]]) return false; }
      return true;
    }
    return na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1;
  }
  // Same two raw-cell shapes decodeSheetDate() (oilchange.html) parses --
  // 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS...' -- but diffed against today
  // directly instead of round-tripping through a dd/mm/yyyy string.
  function followUpDaysSince_(rawVal) {
    if (typeof rawVal !== 'string') return null;
    var m = rawVal.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    d.setHours(0, 0, 0, 0);
    return Math.round((today - d) / 86400000);
  }
  function refreshFollowUpDataFromServer() {
    Promise.all([
      fetch('/api/data/Parts_and_Oil_change').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch('/api/data/bikes_notes').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (results) {
      var partsRes = results[0], notesRes = results[1];
      if (!partsRes || !partsRes.success || !partsRes.rows || !partsRes.rows.length) return; // fail quiet -- keep whatever the cache already had
      var partsRows = partsRes.rows;
      var header = partsRows[0] || [];
      var contactColIdx = -1;
      for (var h = 0; h < header.length; h++) {
        if ((header[h] || '').toString().trim().toLowerCase() === FOLLOWUP_CONTACT_HEADER.toLowerCase()) { contactColIdx = h; break; }
      }
      if (contactColIdx === -1) return; // column never created yet -- nothing to report
      var soldBikeNames = [];
      if (notesRes && notesRes.success && notesRes.rows) {
        notesRes.rows.forEach(function (n) {
          try {
            var p = JSON.parse(n[1]);
            if (p && (p.soldAmount || p.reason)) soldBikeNames.push(n[0]);
          } catch (e) { /* not a sell/write-off note -- ignore, same as oilchange.html's own parse */ }
        });
      }
      // Preserve any renter name the cache already has from a real
      // oilchange.html visit on this device -- this poll has no
      // Customer/Contract data to derive one fresh.
      var previousRenters = {};
      try {
        var prevRaw = JSON.parse(localStorage.getItem('aaOilchangeFollowUps') || 'null');
        ((prevRaw && prevRaw.items) || []).forEach(function (it) { if (it && it.bike) previousRenters[it.bike] = it.renter || ''; });
      } catch (e) { /* ignore */ }
      var items = [];
      for (var r = 1; r < partsRows.length; r++) {
        var bikeName = (partsRows[r][0] || '').toString().trim();
        if (!bikeName) continue;
        if (soldBikeNames.some(function (n) { return followUpBikeNamesMatch_(n, bikeName); })) continue;
        var contactedOn = partsRows[r][contactColIdx];
        if (!contactedOn) continue;
        var daysSince = followUpDaysSince_(contactedOn);
        if (daysSince === null || daysSince < FOLLOWUP_DUE_DAYS) continue;
        items.push({ bike: bikeName, renter: previousRenters[bikeName] || '', daysSince: daysSince });
      }
      items.sort(function (a, b) { return b.daysSince - a.daysSince; });
      try {
        localStorage.setItem('aaOilchangeFollowUps', JSON.stringify({ items: items, updatedAt: Date.now() }));
        window.dispatchEvent(new CustomEvent('aa:oilchangeFollowUpsUpdated'));
      } catch (e) { /* best-effort, same as everywhere else here */ }
    }).catch(function () { /* best-effort -- next poll (or an oilchange.html visit) tries again */ });
  }

  var followUpModalBuilt = false;
  var followUpBackdrop;
  var followUpMouseDownOnBackdrop = false;

  function buildFollowUpModal() {
    if (followUpModalBuilt) return;
    followUpModalBuilt = true;

    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div class="followup-backdrop" id="followUpBackdrop">\n' +
      '  <div class="followup-sheet" id="followUpSheet">\n' +
      '    <h3>Follow-up Queue</h3>\n' +
      '    <div class="followup-sub">Customers contacted 2+ days ago with no update since -- check in, then mark completed or reschedule on their bike\'s card.</div>\n' +
      '    <div id="followUpBody"></div>\n' +
      '    <button type="button" class="followup-close-btn" id="followUpCloseBtn">Close</button>\n' +
      '  </div>\n' +
      '</div>';
    document.body.appendChild(wrap.firstChild);

    followUpBackdrop = document.getElementById('followUpBackdrop');

    // Click-outside-to-close, guarded against mid-drag mouseup landing on
    // the backdrop (see CLAUDE.md "Modal / lightbox click outside to
    // close" convention) -- only close if BOTH the mousedown and the
    // click landed on the backdrop itself, not inside the sheet. Same
    // guard as the Bugs modal below.
    followUpBackdrop.addEventListener('mousedown', function (e) {
      followUpMouseDownOnBackdrop = (e.target === followUpBackdrop);
    });
    followUpBackdrop.addEventListener('click', function (e) {
      if (e.target === followUpBackdrop && followUpMouseDownOnBackdrop) closeFollowUpModal();
      followUpMouseDownOnBackdrop = false;
    });
    document.getElementById('followUpCloseBtn').addEventListener('click', closeFollowUpModal);
  }

  function renderFollowUpList() {
    var body = document.getElementById('followUpBody');
    if (!body) return;
    var raw;
    try { raw = JSON.parse(localStorage.getItem('aaOilchangeFollowUps') || 'null'); } catch (e) { raw = null; }
    var items = (raw && raw.items) || [];
    if (!items.length) {
      body.innerHTML = '<div class="followup-empty">Nothing pending -- you\'re all caught up.</div>';
      return;
    }
    body.innerHTML = items.map(function (it) {
      var renterLine = it.renter ? ('<div class="fi-renter">' + escapeHtml(it.renter) + '</div>') : '';
      var agoLabel = it.daysSince + (it.daysSince === 1 ? ' day' : ' days') + ' ago';
      return (
        '<div class="followup-item" data-bike="' + escapeHtml(it.bike) + '">' +
        '<div><div class="fi-name">' + escapeHtml(it.bike) + '</div>' + renterLine + '</div>' +
        '<div class="fi-tag">' + agoLabel + '</div>' +
        '</div>'
      );
    }).join('');
    Array.prototype.forEach.call(body.querySelectorAll('.followup-item'), function (el) {
      el.addEventListener('click', function () {
        var bike = el.getAttribute('data-bike');
        window.location.href = 'oilchange.html?followup=' + encodeURIComponent(bike);
      });
    });
  }

  function openFollowUpModal() {
    buildFollowUpModal();
    renderFollowUpList();
    followUpBackdrop.classList.add('open');
  }
  function closeFollowUpModal() {
    if (followUpBackdrop) followUpBackdrop.classList.remove('open');
  }

  function initFollowUpQueueModal() {
    var btn = document.getElementById('followUpBadgeBtn');
    if (btn) btn.addEventListener('click', openFollowUpModal);
  }

  // =====================================================================
  // Bugs & Features tracker -- temporary beta feature (per the user: will
  // be removed later, deliberately left off the main nav menu). Reads and
  // writes the "Bugs" sheet tab via Code.gs actions bugsList/addBugItem/
  // toggleBugItem/clearCompletedBugs. Modal markup is injected into
  // <body> once, the first time a page with the shared topbar loads.
  // =====================================================================
  var bugsModalBuilt = false;
  var bugsBackdrop, bugsSheetEl, bugsCloseBtn, bugsBody, bugsStatusEl,
      bugsDescInput, bugsTypeSelect, bugsAddBtn, bugsClearLink;
  var bugsMouseDownOnBackdrop = false;
  var bugsLoaded = false;
  var bugsItemsCache = [];

  function buildBugsModal() {
    if (bugsModalBuilt) return;
    bugsModalBuilt = true;

    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div class="bugs-backdrop" id="bugsBackdrop">\n' +
      '  <div class="bugs-sheet" id="bugsSheet">\n' +
      '    <div class="bugs-sheet-header">\n' +
      '      <h3>Bugs &amp; Features</h3>\n' +
      '      <button type="button" class="bugs-close-btn" id="bugsCloseBtn">&times;</button>\n' +
      '    </div>\n' +
      '    <div class="bugs-add-row">\n' +
      '      <input type="text" id="bugsDescInput" placeholder="Describe a bug or feature idea...">\n' +
      '      <select id="bugsTypeSelect">\n' +
      '        <option value="Bug">Bug</option>\n' +
      '        <option value="Feature">Feature</option>\n' +
      '      </select>\n' +
      '      <button type="button" id="bugsAddBtn">Add</button>\n' +
      '    </div>\n' +
      '    <div class="bugs-status" id="bugsStatus" style="display:none;"></div>\n' +
      '    <div class="bugs-body" id="bugsBody">\n' +
      '      <div class="bugs-empty">Loading...</div>\n' +
      '    </div>\n' +
      '    <div class="bugs-footer">\n' +
      '      <a id="bugsClearLink">Clear completed</a>\n' +
      '    </div>\n' +
      '  </div>\n' +
      '</div>';
    document.body.appendChild(wrap.firstChild);

    bugsBackdrop = document.getElementById('bugsBackdrop');
    bugsSheetEl = document.getElementById('bugsSheet');
    bugsCloseBtn = document.getElementById('bugsCloseBtn');
    bugsBody = document.getElementById('bugsBody');
    bugsStatusEl = document.getElementById('bugsStatus');
    bugsDescInput = document.getElementById('bugsDescInput');
    bugsTypeSelect = document.getElementById('bugsTypeSelect');
    bugsAddBtn = document.getElementById('bugsAddBtn');
    bugsClearLink = document.getElementById('bugsClearLink');

    // Click-outside-to-close, guarded against mid-drag mouseup landing on
    // the backdrop (see CLAUDE.md "Modal / lightbox click outside to
    // close" convention) -- only close if BOTH the mousedown and the
    // click landed on the backdrop itself, not inside the card.
    bugsBackdrop.addEventListener('mousedown', function (e) {
      bugsMouseDownOnBackdrop = (e.target === bugsBackdrop);
    });
    bugsBackdrop.addEventListener('click', function (e) {
      if (e.target === bugsBackdrop && bugsMouseDownOnBackdrop) closeBugsModal();
      bugsMouseDownOnBackdrop = false;
    });

    bugsCloseBtn.addEventListener('click', closeBugsModal);
    bugsAddBtn.addEventListener('click', submitBugItem);
    bugsDescInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitBugItem();
    });
    bugsClearLink.addEventListener('click', submitClearCompleted);

    bugsBody.addEventListener('change', function (e) {
      if (e.target && e.target.matches('input[type=checkbox][data-row]')) {
        submitToggleItem(e.target);
      }
    });
  }

  function showBugsStatus(message) {
    if (!message) {
      bugsStatusEl.style.display = 'none';
      bugsStatusEl.textContent = '';
      return;
    }
    bugsStatusEl.style.display = 'block';
    bugsStatusEl.textContent = message;
  }

  function escapeHtml(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderBugsList() {
    var bugs = bugsItemsCache.filter(function (it) { return (it.type || '').toLowerCase() !== 'feature'; });
    var features = bugsItemsCache.filter(function (it) { return (it.type || '').toLowerCase() === 'feature'; });

    function itemRow(item) {
      var doneClass = item.status === 'Done' ? ' done' : '';
      var checked = item.status === 'Done' ? ' checked' : '';
      var dateText = item.status === 'Done' && item.dateCompleted ? item.dateCompleted : (item.dateAdded || '');
      return (
        '<div class="bugs-item' + doneClass + '">' +
        '<input type="checkbox" data-row="' + item.rowNumber + '"' + checked + '>' +
        '<span class="bugs-item-text">' + escapeHtml(item.description) + '</span>' +
        '<span class="bugs-item-date">' + escapeHtml(dateText) + '</span>' +
        '</div>'
      );
    }

    var html = '';
    html += '<div class="bugs-section-title"><span class="bugs-dot bug"></span> Bugs (' + bugs.length + ')</div>';
    html += bugs.length ? bugs.map(itemRow).join('') : '<div class="bugs-empty">No bugs logged.</div>';
    html += '<div class="bugs-section-title"><span class="bugs-dot feature"></span> Features (' + features.length + ')</div>';
    html += features.length ? features.map(itemRow).join('') : '<div class="bugs-empty">No feature ideas logged.</div>';

    bugsBody.innerHTML = html;
  }

  function loadBugsList(force) {
    if (bugsLoaded && !force) { renderBugsList(); return; }
    bugsBody.innerHTML = '<div class="bugs-empty">Loading...</div>';
    fetch(BUGS_SCRIPT_URL + '?action=bugsList')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.success) {
          bugsBody.innerHTML = '<div class="bugs-empty">Could not load: ' + escapeHtml((data && data.error) || 'unknown error') + '</div>';
          return;
        }
        bugsItemsCache = data.items || [];
        bugsLoaded = true;
        renderBugsList();
      })
      .catch(function (err) {
        bugsBody.innerHTML = '<div class="bugs-empty">Could not load: ' + escapeHtml(err.message) + '</div>';
      });
  }

  function submitBugItem() {
    var description = bugsDescInput.value.trim();
    if (!description) return;
    var type = bugsTypeSelect.value;

    bugsAddBtn.disabled = true;
    bugsAddBtn.textContent = 'Adding...';
    showBugsStatus('');

    fetch(BUGS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'addBugItem', type: type, description: description })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.success) {
          showBugsStatus((data && data.error) || 'Could not add that -- please try again.');
          return;
        }
        bugsDescInput.value = '';
        loadBugsList(true);
      })
      .catch(function (err) {
        showBugsStatus('Could not add that: ' + err.message);
      })
      .finally(function () {
        bugsAddBtn.disabled = false;
        bugsAddBtn.textContent = 'Add';
      });
  }

  function submitToggleItem(checkbox) {
    var rowNumber = checkbox.getAttribute('data-row');
    var done = checkbox.checked;
    checkbox.disabled = true;

    fetch(BUGS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'toggleBugItem', rowNumber: rowNumber, done: done })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.success) {
          showBugsStatus((data && data.error) || 'Could not update that -- please try again.');
          checkbox.checked = !done;
          checkbox.disabled = false;
          return;
        }
        loadBugsList(true);
      })
      .catch(function (err) {
        showBugsStatus('Could not update that: ' + err.message);
        checkbox.checked = !done;
        checkbox.disabled = false;
      });
  }

  function submitClearCompleted() {
    showBugsStatus('');
    bugsClearLink.textContent = 'Clearing...';
    fetch(BUGS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'clearCompletedBugs' })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.success) {
          showBugsStatus((data && data.error) || 'Could not clear completed items.');
          return;
        }
        loadBugsList(true);
      })
      .catch(function (err) {
        showBugsStatus('Could not clear completed items: ' + err.message);
      })
      .finally(function () {
        bugsClearLink.textContent = 'Clear completed';
      });
  }

  function openBugsModal() {
    buildBugsModal();
    bugsBackdrop.classList.add('open');
    loadBugsList(false);
  }

  function closeBugsModal() {
    if (bugsBackdrop) bugsBackdrop.classList.remove('open');
  }

  function initBugsWidget() {
    var btn = document.getElementById('bugsIconBtn');
    if (!btn) return;
    btn.addEventListener('click', openBugsModal);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderTopbar);
  } else {
    renderTopbar();
  }
})();
