// Copy buttons. data-copy-target names the element whose text is copied, so the copied text is always
// the text shown. If the clipboard is not available, the text is selected for Cmd+C instead.
document.querySelectorAll('[data-copy-target]').forEach(function (b) {
  var label = b.querySelector('.copy-label');
  var target = document.getElementById(b.getAttribute('data-copy-target'));
  if (!label || !target) return;
  b.addEventListener('click', function () {
    var text = target.textContent;
    var done = function (ok) {
      label.textContent = ok ? 'Copied' : 'Press Cmd+C';
      setTimeout(function () { label.textContent = 'Copy'; }, 1800);
    };
    function sel() {
      var r = document.createRange(); r.selectNodeContents(target);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { sel(); done(false); });
    } else { sel(); done(false); }
  });
});

// Google Analytics 4 (owner decision 2026-11-11). Off when the browser sends Do Not Track or Global Privacy Control.
// Ad features are always off. In the EEA, the UK and Switzerland no analytics cookie is set (no consent was asked for),
// so Google receives only cookieless pings there.
(function () {
  var ID = 'G-EV24W7HFMP';
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  gtag('consent', 'default', {
    analytics_storage: 'denied',
    region: ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH']
  });
  gtag('js', new Date());
  gtag('config', ID, { allow_google_signals: false, allow_ad_personalization_signals: false });
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
  document.head.appendChild(s);
  // Count clicks on the Mac download link (the funnel step between a visit and a plugin load). Page path only.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href="/download"]') : null;
    if (a) gtag('event', 'download_click', { page_path: location.pathname });
  });
})();

// Optional email signup. Downloads never wait on it. Posts JSON; without JS the form posts normally.
(function () {
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href="/download"]') : null;
    var box = document.getElementById('after-download');
    if (a && box) box.hidden = false;
  });
  document.querySelectorAll('form[data-sub]').forEach(function (f) {
    var msg = f.querySelector('.sub-msg');
    var btn = f.querySelector('button');
    f.addEventListener('submit', function (e) {
      if (!window.fetch) return;
      e.preventDefault();
      var data = {};
      new FormData(f).forEach(function (v, k) { data[k] = v; });
      btn.disabled = true; msg.textContent = 'Sending...';
      fetch('/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); })
        .then(function (res) {
          if (res.status === 200 && res.j.ok) { f.reset(); msg.textContent = 'Thanks. You are on the list.'; return; }
          btn.disabled = false;
          msg.textContent = res.status === 400 ? 'Please check the email address.' : res.status === 429 ? 'Too many tries. Please wait an hour.' : 'Something went wrong. Please try again later.';
        })
        .catch(function () { btn.disabled = false; msg.textContent = 'Network error. Please try again.'; });
    });
  });
})();

// Hero demo video. The file loads only after the page has loaded and the video is near the viewport,
// so it never competes with the first paint. With reduced motion it does not play by itself.
(function () {
  var v = document.querySelector('video[data-demo]');
  if (!v) return;
  var btn = document.querySelector('[data-demo-toggle]');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { v.autoplay = false; v.removeAttribute('autoplay'); v.controls = true; }
  function label() { if (btn) btn.textContent = v.paused ? (btn.getAttribute('data-play') || 'Play') : (btn.getAttribute('data-pause') || 'Pause'); }
  function start() {
    if (v.getAttribute('data-loaded')) return;
    v.setAttribute('data-loaded', '1');
    v.querySelectorAll('source[data-src]').forEach(function (s) { s.src = s.getAttribute('data-src'); });
    v.load();
    if (!reduce) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
    if (btn && !reduce) btn.hidden = false;
  }
  if (btn) {
    btn.addEventListener('click', function () { if (v.paused) { v.play(); } else { v.pause(); } });
    v.addEventListener('play', label); v.addEventListener('pause', label);
  }
  function watch() {
    if (!('IntersectionObserver' in window)) { start(); return; }
    var io = new IntersectionObserver(function (es) {
      if (es.some(function (e) { return e.isIntersecting; })) { io.disconnect(); start(); }
    }, { rootMargin: '200px' });
    io.observe(v);
  }
  if (document.readyState === 'complete') watch(); else window.addEventListener('load', watch);
})();
