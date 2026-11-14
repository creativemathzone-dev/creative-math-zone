/* Adds a "Show" button to every password box (sign-in, temporary/new password, PIN,
   profile password change, pop-up forms), including boxes added later.
   The button uses each portal's existing [data-show] click handler. */
(function () {
  'use strict';
  function wrap(input) {
    if (input.dataset.pwDone || input.closest('.pw')) return;
    input.dataset.pwDone = '1';
    var box = document.createElement('div');
    box.className = 'pw';
    input.parentNode.insertBefore(box, input);
    box.appendChild(input);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small';
    btn.setAttribute('data-show', 'password');
    btn.setAttribute('aria-label', 'Show or hide what you typed');
    btn.textContent = 'Show';
    box.appendChild(btn);
    input.style.paddingRight = '4.6rem';
  }
  function scan(root) { Array.prototype.forEach.call(root.querySelectorAll('input[type=password]'), wrap); }
  scan(document);
  new MutationObserver(function (changes) {
    changes.forEach(function (c) {
      Array.prototype.forEach.call(c.addedNodes, function (n) {
        if (n.nodeType !== 1) return;
        if (n.matches && n.matches('input[type=password]')) wrap(n); else if (n.querySelectorAll) scan(n);
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
