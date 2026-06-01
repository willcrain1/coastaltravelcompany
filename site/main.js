// Use config.js value when available (e.g. login.html loads config.js for preprod support).
const WORKER_URL = (typeof CTC_CONFIG !== 'undefined' && CTC_CONFIG.workerUrl)
  || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';

// ── Cookie Consent Banner ──────────────────────────────────
(function () {
  if (localStorage.getItem('ctc_consent')) return;

  const banner = document.createElement('div');
  banner.id = 'cookie-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Cookie consent');
  banner.innerHTML = `
    <div class="cookie-inner">
      <p class="cookie-text">We use cookies for secure login and, with your consent, to understand how visitors use our site. <a href="privacy.html">Privacy Policy</a></p>
      <div class="cookie-actions">
        <button class="cookie-btn cookie-btn-accept"    id="ck-accept">Accept All</button>
        <button class="cookie-btn cookie-btn-essential" id="ck-essential">Essential Only</button>
        <button class="cookie-btn cookie-btn-manage"    id="ck-manage">Manage Preferences</button>
      </div>
    </div>
    <div class="cookie-prefs" id="ck-prefs" hidden>
      <div class="cookie-pref-row">
        <div>
          <div class="cookie-pref-label">Essential Cookies</div>
          <div class="cookie-pref-desc">Required for secure login and core site functionality. Cannot be disabled.</div>
        </div>
        <span class="cookie-always-on">Always On</span>
      </div>
      <div class="cookie-pref-row">
        <div>
          <div class="cookie-pref-label">Analytics Cookies</div>
          <div class="cookie-pref-desc">Help us understand how visitors use our site so we can improve it.</div>
        </div>
        <label class="cookie-toggle" aria-label="Analytics cookies">
          <input type="checkbox" id="ck-analytics">
          <span class="cookie-toggle-slider"></span>
        </label>
      </div>
      <button class="cookie-btn cookie-btn-accept cookie-save-btn" id="ck-save">Save Preferences</button>
    </div>
  `;
  document.body.appendChild(banner);

  function dismiss(consent) {
    localStorage.setItem('ctc_consent', JSON.stringify(consent));
    banner.classList.add('cookie-dismissing');
    setTimeout(() => banner.remove(), 320);
  }

  banner.querySelector('#ck-accept').addEventListener('click', () =>
    dismiss({ essential: true, analytics: true }));
  banner.querySelector('#ck-essential').addEventListener('click', () =>
    dismiss({ essential: true, analytics: false }));
  banner.querySelector('#ck-manage').addEventListener('click', () => {
    const prefs = banner.querySelector('#ck-prefs');
    prefs.hidden = !prefs.hidden;
  });
  banner.querySelector('#ck-save').addEventListener('click', () => {
    const analytics = banner.querySelector('#ck-analytics').checked;
    dismiss({ essential: true, analytics });
  });
})();

// ── Nav scroll behavior ────────────────────────────────────
const nav = document.getElementById('main-nav');

// Pages with data-nav-pinned keep the scrolled style at all scroll positions.
if (!nav.dataset.navPinned) {
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 60);
  }, { passive: true });
}

// ── Fade-up scroll animations ──────────────────────────────
const fadeEls = document.querySelectorAll('.fade-up');

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in-view');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

fadeEls.forEach(el => observer.observe(el));

// ── Mobile nav toggle ──────────────────────────────────────
const toggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');

// Close button injected into the overlay — created once, reused on each open.
let menuCloseBtn = null;
function getMenuCloseBtn() {
  if (menuCloseBtn) return menuCloseBtn;
  menuCloseBtn = document.createElement('button');
  menuCloseBtn.setAttribute('aria-label', 'Close menu');
  menuCloseBtn.style.cssText = [
    'position:absolute', 'top:20px', 'right:20px',
    'background:none', 'border:none', 'cursor:pointer',
    'padding:10px', 'line-height:0', 'color:var(--black)',
  ].join(';');
  menuCloseBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="3" y1="3" x2="19" y2="19"/><line x1="19" y1="3" x2="3" y2="19"/></svg>';
  menuCloseBtn.addEventListener('click', closeMobileMenu);
  navLinks.appendChild(menuCloseBtn);
  return menuCloseBtn;
}

function openMobileMenu() {
  // Scroll to top instantly so the full-screen overlay always appears at
  // the top of the viewport and all nav links are visible.
  window.scrollTo({ top: 0, behavior: 'instant' });
  // backdrop-filter on nav.scrolled makes nav a containing block for
  // position:fixed children, clipping the overlay to the nav bar height.
  // Overriding it to none restores the viewport as the containing block.
  nav.style.backdropFilter = 'none';
  navLinks.style.display = 'flex';
  navLinks.style.flexDirection = 'column';
  navLinks.style.position = 'fixed';
  navLinks.style.top = '0';
  navLinks.style.left = '0';
  navLinks.style.right = '0';
  navLinks.style.bottom = '0';
  navLinks.style.background = 'var(--cream)';
  navLinks.style.alignItems = 'center';
  navLinks.style.justifyContent = 'center';
  navLinks.style.gap = '36px';
  navLinks.style.zIndex = '150';
  navLinks.querySelectorAll('a').forEach(a => {
    a.style.color = 'var(--black)';
    a.style.fontSize = '13px';
    a.style.letterSpacing = '0.3em';
  });
  getMenuCloseBtn();
  toggle.classList.add('open');
  // iOS Safari ignores overflow:hidden on body and allows the page to scroll
  // behind the overlay. position:fixed is the reliable cross-browser scroll lock.
  document.body.style.position = 'fixed';
  document.body.style.width = '100%';
  document.body.style.overflow = 'hidden';
}

function closeMobileMenu() {
  nav.style.backdropFilter = '';
  document.body.style.position = '';
  document.body.style.width = '';
  document.body.style.overflow = '';
  navLinks.style.display = 'none';
  toggle.classList.remove('open');
}

if (toggle && navLinks) {
  toggle.addEventListener('click', () => {
    if (navLinks.style.display === 'flex') {
      closeMobileMenu();
    } else {
      openMobileMenu();
    }
  });

  // Close menu when a link is clicked
  navLinks.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      closeMobileMenu();
    });
  });
}

// ── Smooth anchor scroll ───────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', e => {
    const target = document.querySelector(anchor.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// ── Contact form submit ────────────────────────────────────
const form = document.getElementById('contact-form');
if (form) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn    = form.querySelector('button[type="submit"]');
    const status = document.getElementById('form-status');
    const orig   = btn.textContent;

    btn.textContent = 'Sending…';
    btn.disabled    = true;
    if (status) { status.style.color = ''; status.textContent = ''; }

    try {
      const res  = await fetch(WORKER_URL + '/contact', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams(new FormData(form)).toString(),
      });
      const json = await res.json();

      if (res.ok) {
        btn.textContent      = 'Inquiry Sent — We’ll Be In Touch';
        btn.style.background = 'var(--forest-green)';
        if (status) {
          status.style.color  = 'var(--forest-green)';
          status.textContent  = 'Your message has been received. We’ll respond within 48 hours.';
        }
      } else {
        btn.textContent = orig;
        btn.disabled    = false;
        if (status) {
          status.style.color = '#c0392b';
          status.textContent = json.error || 'Something went wrong. Please try again.';
        }
      }
    } catch {
      btn.textContent = orig;
      btn.disabled    = false;
      if (status) {
        status.style.color = '#c0392b';
        status.textContent = 'Network error. Please check your connection and try again.';
      }
    }
  });
}
