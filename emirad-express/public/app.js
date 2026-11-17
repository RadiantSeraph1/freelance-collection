// Small progressive enhancements. Every page still works without this file.
(function () {
  // Mobile navigation
  var header = document.querySelector('.site-header');
  var toggle = document.querySelector('[data-nav-toggle]');
  if (header && toggle) {
    toggle.addEventListener('click', function () {
      var open = header.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  // Photo gallery: thumbnails swap the main photo
  document.querySelectorAll('[data-gallery]').forEach(function (gallery) {
    var main = gallery.querySelector('[data-gallery-main]');
    gallery.querySelectorAll('[data-gallery-thumb]').forEach(function (thumb) {
      thumb.addEventListener('click', function () {
        main.src = thumb.getAttribute('data-full');
        main.alt = thumb.getAttribute('data-alt') || '';
        gallery.querySelectorAll('[data-gallery-thumb]').forEach(function (t) { t.removeAttribute('aria-current'); });
        thumb.setAttribute('aria-current', 'true');
      });
    });
  });

  // Payment-plan / mortgage calculator
  document.querySelectorAll('[data-calc]').forEach(function (calc) {
    var price = Number(calc.getAttribute('data-price')) || 0;
    var symbol = calc.getAttribute('data-symbol') || '';
    var f = function (name) { return calc.querySelector('[name=' + name + ']'); };
    var out = calc.querySelector('[data-calc-out]');
    var note = calc.querySelector('[data-calc-note]');
    function run() {
      var deposit = Math.min(Math.max(Number(f('deposit').value) || 0, 0), 90) / 100;
      var years = Math.max(Number(f('years').value) || 1, 1);
      var rate = Math.max(Number(f('rate').value) || 0, 0) / 100 / 12;
      var loan = price * (1 - deposit);
      var n = years * 12;
      var monthly = rate === 0 ? loan / n : (loan * rate) / (1 - Math.pow(1 + rate, -n));
      out.textContent = symbol + Math.round(monthly).toLocaleString('en-US') + ' / month';
      note.textContent = 'Deposit ' + symbol + Math.round(price * deposit).toLocaleString('en-US') + ' · financed ' + symbol + Math.round(loan).toLocaleString('en-US') + ' over ' + years + ' years';
    }
    calc.addEventListener('input', run);
    run();
  });

  // Copy-to-clipboard buttons
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      var original = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = original; }, 1500);
    });
  });
})();
