// Google Analytics 4 — loaded only after the visitor opts into analytics via
// the cookie-consent banner (window.CTC_Consent.hasAnalytics()). GA4 sets
// tracking cookies/identifiers, so it must not load before consent is given —
// matches the gating already applied to the first-party tracker (analytics.js)
// and the disclosures in our privacy policy (site/privacy.html).

(function () {
  if (typeof window === 'undefined') return;

  const GA4_ID = 'G-CWYCF3H9YY';
  let loaded = false;

  function loadGtag() {
    if (loaded) return;
    loaded = true;

    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    // anonymize_ip is on by default in GA4, but set explicitly for clarity/compliance
    window.gtag('config', GA4_ID, { anonymize_ip: true });
  }

  function consentGiven() {
    return !!(window.CTC_Consent && window.CTC_Consent.hasAnalytics && window.CTC_Consent.hasAnalytics());
  }

  function check() {
    if (consentGiven()) loadGtag();
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
