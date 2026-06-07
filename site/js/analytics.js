// First-party, privacy-friendly clickstream & engagement analytics (items 32 & 46).
//
// - Only runs once the visitor has opted in via the cookie-consent banner
//   (window.CTC_Consent.hasAnalytics()).
// - Uses an ephemeral per-tab session_id (crypto.randomUUID) stored in
//   sessionStorage — never a persistent identifier, never IP/UA/fingerprint.
// - Sends batched-free, fire-and-forget beacons to POST /analytics/event.
//
// Pages opt sections into dwell-tracking with `data-track-section="section_id"`
// and opt elements into conversion tracking with `data-track-event="event_name"`.

(function () {
  if (typeof window === 'undefined') return;

  const WORKER_URL = (typeof CTC_CONFIG !== 'undefined' && CTC_CONFIG.workerUrl)
    || 'https://api.coastaltravelcompany.com';

  const SESSION_KEY = 'ctc_analytics_sid';

  function consentGiven() {
    return !!(window.CTC_Consent && window.CTC_Consent.hasAnalytics && window.CTC_Consent.hasAnalytics());
  }

  function getSessionId() {
    try {
      let sid = sessionStorage.getItem(SESSION_KEY);
      if (!sid) {
        sid = (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)));
        sessionStorage.setItem(SESSION_KEY, sid);
      }
      return sid;
    } catch { return null; }
  }

  function utmParam(name) {
    try { return new URLSearchParams(window.location.search).get(name) || null; }
    catch { return null; }
  }

  // Item 46 — optional GA4 mirroring. If a GA4 property is configured (gtag.js
  // loaded and `window.gtag` present), mirror the same engagement signals into
  // GA4 so an Exploration report can group `section_dwell` by `section_id`.
  // This never substitutes for the first-party pipeline — it's additive only,
  // and still gated on analytics consent like everything else here.
  function mirrorToGA4(event_type, extra) {
    if (typeof window.gtag !== 'function') return;
    const e = extra || {};
    switch (event_type) {
      case 'conversion':
        window.gtag('event', e.label || 'conversion', {
          event_category: 'conversion',
          page_path: window.location.pathname,
        });
        break;
      case 'click':
        window.gtag('event', 'click', {
          event_category: 'click_path',
          event_label: e.label || null,
          page_path: window.location.pathname,
        });
        break;
      case 'scroll_depth':
        window.gtag('event', 'scroll_depth', {
          event_category: 'engagement',
          percent_scrolled: e.value,
          page_path: window.location.pathname,
        });
        break;
      case 'section_dwell':
        window.gtag('event', 'section_dwell', {
          event_category: 'engagement',
          section_id: e.label || null,
          value: e.value,
          page_path: window.location.pathname,
        });
        break;
      default:
        break;
    }
  }

  function send(event_type, extra) {
    if (!consentGiven()) return;
    const sid = getSessionId();
    if (!sid) return;

    mirrorToGA4(event_type, extra);

    const payload = Object.assign({
      session_id: sid,
      event_type,
      page: window.location.pathname,
      referrer: document.referrer || null,
      utm_source: utmParam('utm_source'),
      utm_medium: utmParam('utm_medium'),
      utm_campaign: utmParam('utm_campaign'),
    }, extra || {});

    const url = WORKER_URL.replace(/\/$/, '') + '/analytics/event';
    const body = JSON.stringify(payload);

    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
      }
    } catch { /* best-effort only */ }
  }

  function init() {
    if (!consentGiven()) return;

    // ── Pageview ───────────────────────────────────────────────────────────
    send('pageview');

    // ── Conversion / click tracking via data-track-event ──────────────────
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-track-event]');
      if (!el) return;
      const label = el.getAttribute('data-track-event');
      send('conversion', { label });
    }, { passive: true, capture: true });

    // Portfolio image / collection-card click tracking (no PII — just the
    // visible title/name as the event label).
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-track-click]');
      if (!el) return;
      const label = el.getAttribute('data-track-click') || el.getAttribute('title') || el.textContent.trim().slice(0, 120);
      send('click', { label });
    }, { passive: true, capture: true });

    // ── Scroll-depth milestones (25/50/75/100%, once per session per page) ─
    const milestones = [25, 50, 75, 100];
    const fired = new Set();
    function checkScroll() {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      if (scrollable <= 0) return;
      const pct = Math.min(100, Math.round((window.scrollY / scrollable) * 100));
      milestones.forEach((m) => {
        if (pct >= m && !fired.has(m)) {
          fired.add(m);
          send('scroll_depth', { value: m });
        }
      });
    }
    window.addEventListener('scroll', () => requestAnimationFrame(checkScroll), { passive: true });
    checkScroll();

    // ── Section dwell-time via IntersectionObserver ───────────────────────
    // Fires once per section when it leaves the viewport (or on page unload),
    // reporting cumulative visible time in milliseconds.
    const sections = document.querySelectorAll('[data-track-section]');
    if (sections.length && 'IntersectionObserver' in window) {
      const enteredAt = new WeakMap();
      const totalMs   = new WeakMap();
      const reported  = new WeakSet();

      function flush(el) {
        if (reported.has(el)) return;
        const id = el.getAttribute('data-track-section');
        let total = totalMs.get(el) || 0;
        const start = enteredAt.get(el);
        if (start != null) total += (Date.now() - start);
        if (total >= 1000) { // ignore noise under 1s
          send('section_dwell', { label: id, value: total });
          reported.add(el);
        }
      }

      const dwellObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const el = entry.target;
          if (entry.isIntersecting) {
            enteredAt.set(el, Date.now());
          } else {
            const start = enteredAt.get(el);
            if (start != null) {
              totalMs.set(el, (totalMs.get(el) || 0) + (Date.now() - start));
              enteredAt.delete(el);
            }
            flush(el);
          }
        });
      }, { threshold: 0.4 });

      sections.forEach((el) => dwellObserver.observe(el));

      window.addEventListener('pagehide', () => sections.forEach(flush));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') sections.forEach(flush);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
