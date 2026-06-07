// Microsoft Clarity — loaded only after the visitor opts into analytics via
// the cookie-consent banner (window.CTC_Consent.hasAnalytics()). Clarity sets
// tracking cookies/identifiers, so it must not load before consent is given —
// matches the gating already applied to GA4 (ga4.js) and the first-party
// tracker (analytics.js), and the disclosures in our privacy policy
// (site/privacy.html).

(function () {
  if (typeof window === 'undefined') return;

  const CLARITY_ID = 'x3do0vxltp';
  let loaded = false;

  function loadClarity() {
    if (loaded) return;
    loaded = true;

    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', CLARITY_ID);
  }

  function consentGiven() {
    return !!(window.CTC_Consent && window.CTC_Consent.hasAnalytics && window.CTC_Consent.hasAnalytics());
  }

  function check() {
    if (consentGiven()) loadClarity();
  }

  // Load immediately if consent was already granted in a prior visit, react
  // live if the visitor accepts during this session (no reload required).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
  window.addEventListener('ctc-consent-changed', check);
})();
