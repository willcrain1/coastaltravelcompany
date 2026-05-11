// ── Nav scroll behavior ────────────────────────────────────
const nav = document.getElementById('main-nav');

window.addEventListener('scroll', () => {
  if (window.scrollY > 60) {
    nav.classList.add('scrolled');
  } else {
    nav.classList.remove('scrolled');
  }
}, { passive: true });

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

if (toggle && navLinks) {
  toggle.addEventListener('click', () => {
    const open = navLinks.style.display === 'flex';
    navLinks.style.display = open ? 'none' : 'flex';
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

    if (!open) {
      navLinks.querySelectorAll('a').forEach(a => {
        a.style.color = 'var(--black)';
        a.style.fontSize = '13px';
        a.style.letterSpacing = '0.3em';
      });
    }
  });

  // Close menu when a link is clicked
  navLinks.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      navLinks.style.display = 'none';
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

// ── Form submit (placeholder) ──────────────────────────────
const form = document.querySelector('form');
if (form) {
  form.addEventListener('submit', e => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.textContent = 'Thank You — We\'ll Be In Touch';
    btn.style.background = 'var(--forest-green)';
    btn.disabled = true;
  });
}
