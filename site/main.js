// Use config.js value when available (e.g. login.html loads config.js for preprod support).
const WORKER_URL = (typeof CTC_CONFIG !== 'undefined' && CTC_CONFIG.workerUrl)
  || 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';

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
