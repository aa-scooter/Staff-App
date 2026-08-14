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

  function renderTopbar() {
    var mount = document.getElementById('topbar-mount');
    if (!mount) return; // page opted out of the shared header

    injectCss();

    // Links to the in-app Calendar page (calendar.html), which embeds the
    // shared bike-returns Google Calendar directly -- no separate Google
    // login required, since that calendar is shared publicly by link.
    var calActive = currentPage() === 'calendar.html' ? ' active' : '';
    var calLinkHtml = '<a class="cal-link' + calActive + '" href="calendar.html" title="Bike returns calendar">📅</a>';
    var bugLinkHtml = '<button type="button" class="bug-link" id="bugsIconBtn" title="Bugs &amp; Features">🐛</button>';

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
      '    ' + calLinkHtml + '\n' +
      '    ' + bugLinkHtml + '\n' +
      '  </div>\n' +
      '  <nav>\n' +
      '    ' + buildLinksHtml() + '\n' +
      '    ' + settingsHtml + '\n' +
      '  </nav>\n' +
      '</div>';

    initBugsWidget();
    initNavDropdowns();
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
