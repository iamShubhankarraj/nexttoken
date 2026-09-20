/**
 * Floating picture-in-picture button (Dia-style discoverability).
 *
 * Injected into every guest page on dom-ready via webview
 * executeJavaScript (see TabView). Shows a small floating button at the
 * top-right corner of any hovered <video> that isn't PiP-disabled;
 * clicking it toggles Chromium's native picture-in-picture.
 *
 * Self-guards against double-install; never touches page styles beyond
 * its own fixed-position button.
 */

export const PIP_SCRIPT = `(function () {
  if (window.__ntPipInstalled) return;
  window.__ntPipInstalled = true;

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Picture in picture');
  btn.title = 'Picture in picture';
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10.5l7-3.5v10l-7-3.5"/></svg>';
  btn.style.cssText = 'position:fixed;z-index:2147483647;display:none;align-items:center;justify-content:center;' +
    'width:36px;height:36px;border-radius:10px;border:1px solid rgba(255,255,255,0.18);' +
    'background:rgba(11,11,13,0.85);color:#F4F2ED;cursor:pointer;padding:0;margin:0;' +
    'box-shadow:0 4px 16px rgba(0,0,0,0.5);font:inherit;line-height:0;';

  function ensureAttached() {
    if (!btn.isConnected && document.documentElement) {
      document.documentElement.appendChild(btn);
    }
  }
  ensureAttached();
  if (document.documentElement) {
    new MutationObserver(ensureAttached).observe(document.documentElement, { childList: true });
  }

  var current = null;
  var hideTimer = 0;

  function place(v) {
    var r = v.getBoundingClientRect();
    if (!r || r.width < 80 || r.height < 60) return false;
    var x = Math.max(8, Math.min(window.innerWidth - 46, r.right - 46));
    var y = Math.max(8, r.top + 10);
    btn.style.left = x + 'px';
    btn.style.top = y + 'px';
    return true;
  }

  function show(v) {
    if (!v || v.disablePictureInPicture) return;
    current = v;
    if (place(v)) btn.style.display = 'flex';
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
  }

  function hideSoon() {
    if (hideTimer) return;
    hideTimer = setTimeout(function () {
      btn.style.display = 'none';
      current = null;
      hideTimer = 0;
    }, 350);
  }

  function hideNow() {
    btn.style.display = 'none';
    current = null;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
  }

  document.addEventListener('mouseover', function (e) {
    var t = e.target;
    var v = t && t.closest ? t.closest('video') : null;
    if (v) { show(v); return; }
    if (t === btn || (btn.contains && btn.contains(t))) return;
    hideSoon();
  }, true);

  btn.addEventListener('mouseenter', function () {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
  });
  btn.addEventListener('mouseleave', hideSoon);

  // Keep the button glued to the video while the page scrolls.
  document.addEventListener('scroll', function () {
    if (current) { if (!place(current)) hideNow(); }
  }, true);
  window.addEventListener('resize', hideNow);

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var v = current;
    hideNow();
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        var p = document.exitPictureInPicture();
        if (p && p.catch) p.catch(function () {});
        return;
      }
      if (!document.pictureInPictureEnabled) return;
      var q = v.requestPictureInPicture();
      if (q && q.catch) q.catch(function () {});
    } catch (err) { /* PiP unsupported for this video */ }
  });
})();`;
