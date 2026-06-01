(function () {
  const CONSENT_KEY = 'ctc_cookie_consent';
  const EXPIRY_MS   = 365 * 24 * 3600 * 1000; // 12 months

  function loadConsent() {
    try {
      const raw = localStorage.getItem(CONSENT_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || !c.ts) return null;
      if (Date.now() - new Date(c.ts).getTime() > EXPIRY_MS) return null;
      return c;
    } catch { return null; }
  }

  function saveConsent(analytics, marketing) {
    const c = {
      essential: true,
      analytics: !!analytics,
      marketing: !!marketing,
      ts: new Date().toISOString(),
    };
    localStorage.setItem(CONSENT_KEY, JSON.stringify(c));
    return c;
  }

  // Public API — available synchronously before DOM is ready
  window.CTC_Consent = {
    hasAnalytics() { const c = loadConsent(); return !!(c && c.analytics); },
    hasMarketing()  { const c = loadConsent(); return !!(c && c.marketing); },
  };

  // Already consented this year — no banner needed
  if (loadConsent()) return;

  function inject() {
    const style = document.createElement('style');
    style.textContent = [
      '#ctc-cb{position:fixed;bottom:0;left:0;right:0;background:#1a1a1a;color:#f0f0f0;padding:14px 20px;',
      'z-index:99999;font-family:sans-serif;font-size:13px;display:flex;align-items:center;',
      'gap:10px;flex-wrap:wrap;box-shadow:0 -2px 12px rgba(0,0,0,.4)}',
      '#ctc-cb p{margin:0;flex:1;min-width:180px;line-height:1.5}',
      '#ctc-cb a{color:#7ec8a8;text-underline-offset:2px}',
      '.ctc-cb-btn{padding:7px 15px;border:none;border-radius:4px;font-size:12px;',
      'cursor:pointer;font-family:inherit;white-space:nowrap}',
      '#ctc-cb-accept{background:#2A5C45;color:#fff}',
      '#ctc-cb-essential{background:transparent;color:#ccc;border:1px solid #555}',
      '#ctc-cb-prefs{background:transparent;color:#999;border:1px solid #444;font-size:11px}',
      '#ctc-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);',
      'z-index:100000;align-items:center;justify-content:center}',
      '#ctc-modal.open{display:flex}',
      '#ctc-mbox{background:#fff;color:#222;border-radius:8px;padding:24px 28px;',
      'max-width:420px;width:92%;font-family:sans-serif;font-size:14px}',
      '#ctc-mbox h3{margin:0 0 14px;font-size:16px;font-weight:600}',
      '.ctc-row{display:flex;justify-content:space-between;align-items:center;',
      'padding:10px 0;border-top:1px solid #eee}',
      '.ctc-row-text label{font-weight:600;font-size:13px;display:block}',
      '.ctc-row-text p{margin:2px 0 0;font-size:11px;color:#666}',
      '.ctc-sw{position:relative;display:inline-block;width:38px;height:21px;',
      'flex-shrink:0;margin-left:12px}',
      '.ctc-sw input{opacity:0;width:0;height:0}',
      '.ctc-sl{position:absolute;inset:0;background:#ccc;border-radius:21px;transition:.2s}',
      '.ctc-sl:before{content:"";position:absolute;width:15px;height:15px;left:3px;bottom:3px;',
      'background:#fff;border-radius:50%;transition:.2s}',
      'input:checked+.ctc-sl{background:#2A5C45}',
      'input:checked+.ctc-sl:before{transform:translateX(17px)}',
      'input:disabled+.ctc-sl{opacity:.55;cursor:not-allowed}',
      '#ctc-save{display:block;margin-top:18px;margin-left:auto;background:#2A5C45;color:#fff;',
      'padding:9px 22px;border:none;border-radius:4px;font-size:13px;cursor:pointer;font-family:inherit}',
    ].join('');
    document.head.appendChild(style);

    const banner = document.createElement('div');
    banner.id = 'ctc-cb';
    banner.innerHTML =
      '<p>We use cookies for secure login and, with your consent, to understand how visitors use our site. ' +
      '<a href="/privacy.html">Privacy&nbsp;Policy</a></p>' +
      '<button class="ctc-cb-btn" id="ctc-cb-accept">Accept All</button>' +
      '<button class="ctc-cb-btn" id="ctc-cb-essential">Essential Only</button>' +
      '<button class="ctc-cb-btn" id="ctc-cb-prefs">Manage Preferences</button>';

    const modal = document.createElement('div');
    modal.id = 'ctc-modal';
    modal.innerHTML =
      '<div id="ctc-mbox">' +
        '<h3>Cookie Preferences</h3>' +
        '<div class="ctc-row">' +
          '<div class="ctc-row-text"><label>Essential</label>' +
          '<p>Required for secure login and site functionality. Always active.</p></div>' +
          '<label class="ctc-sw"><input type="checkbox" checked disabled>' +
          '<span class="ctc-sl"></span></label>' +
        '</div>' +
        '<div class="ctc-row">' +
          '<div class="ctc-row-text"><label>Analytics</label>' +
          '<p>Helps us understand how visitors use the site (Google Analytics, Clarity).</p></div>' +
          '<label class="ctc-sw"><input type="checkbox" id="ctc-chk-a">' +
          '<span class="ctc-sl"></span></label>' +
        '</div>' +
        '<div class="ctc-row">' +
          '<div class="ctc-row-text"><label>Marketing</label>' +
          '<p>Enables anonymous session tracking for usage statistics.</p></div>' +
          '<label class="ctc-sw"><input type="checkbox" id="ctc-chk-m">' +
          '<span class="ctc-sl"></span></label>' +
        '</div>' +
        '<button id="ctc-save">Save Preferences</button>' +
      '</div>';

    document.body.appendChild(banner);
    document.body.appendChild(modal);

    function dismiss() {
      banner.style.display = 'none';
      modal.classList.remove('open');
    }

    banner.querySelector('#ctc-cb-accept').addEventListener('click', function () {
      saveConsent(true, true);
      dismiss();
    });
    banner.querySelector('#ctc-cb-essential').addEventListener('click', function () {
      saveConsent(false, false);
      dismiss();
    });
    banner.querySelector('#ctc-cb-prefs').addEventListener('click', function () {
      modal.classList.add('open');
    });
    modal.querySelector('#ctc-save').addEventListener('click', function () {
      saveConsent(
        modal.querySelector('#ctc-chk-a').checked,
        modal.querySelector('#ctc-chk-m').checked
      );
      dismiss();
    });
    // Close modal on backdrop click
    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.classList.remove('open');
    });
  }

  if (document.body) {
    inject();
  } else {
    document.addEventListener('DOMContentLoaded', inject);
  }
})();
