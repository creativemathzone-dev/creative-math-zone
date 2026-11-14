/* E4: big bottom menu on phones (like a normal app). Desktop keeps the side menu.
   CMZBottomNav.mount(appEl, items, go)  items: [[view, icon, label], ...]  — "More" opens the side menu.
   CMZBottomNav.setActive(view)          called from each portal's go(). */
(function () {
  'use strict';
  var CSS = '.cmz-bnav{display:none}' +
    '@media (max-width:900px){.cmz-bnav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:35;background:#fff;border-top:1px solid #d9e1ec;' +
    'box-shadow:0 -4px 16px rgba(16,36,71,.08);padding:4px 4px calc(4px + env(safe-area-inset-bottom))}' +
    '.cmz-bnav button{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:1px;border:0;background:none;color:#5b6b82;font:inherit;font-size:.72rem;padding:6px 2px;border-radius:10px;cursor:pointer}' +
    '.cmz-bnav button span:first-child{font-size:1.35rem;line-height:1.1}.cmz-bnav button[aria-current=page]{color:#102447;background:#eef3fb;font-weight:700}' +
    '.cmz-bnav-pad main{padding-bottom:84px!important}}' +
    '@media print{.cmz-bnav{display:none!important}}';
  var nav = null;
  function mount(appEl, items, go) {
    if (!appEl || nav) return;
    var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
    nav = document.createElement('nav');
    nav.className = 'cmz-bnav'; nav.setAttribute('aria-label', 'Quick menu');
    nav.innerHTML = items.map(function (i) { return '<button type="button" data-bgo="' + i[0] + '"><span aria-hidden="true">' + i[1] + '</span><span>' + i[2] + '</span></button>'; }).join('') +
      '<button type="button" data-bmore><span aria-hidden="true">☰</span><span>More</span></button>';
    appEl.appendChild(nav);
    appEl.classList.add('cmz-bnav-pad');
    nav.addEventListener('click', function (ev) {
      var b = ev.target.closest('button'); if (!b) return;
      var side = document.getElementById('side');
      if (b.hasAttribute('data-bmore')) { if (side) side.classList.toggle('open'); return; }
      if (side) side.classList.remove('open');
      go(b.getAttribute('data-bgo'));
    });
  }
  function setActive(view) {
    if (!nav) return;
    Array.prototype.forEach.call(nav.querySelectorAll('[data-bgo]'), function (b) { b.setAttribute('aria-current', b.getAttribute('data-bgo') === view ? 'page' : 'false'); });
  }
  window.CMZBottomNav = { mount: mount, setActive: setActive };
})();
