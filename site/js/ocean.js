/* ═══════════════════════════════════════════════════════════════
   Ocean UI engine — scroll- and pointer-reactive water effects.

   One rAF loop drives everything: smoothed pointer/scroll custom
   properties, the layered wave + bubble canvases in hero sections,
   wave divider drift, photo parallax, and the depth tint.

   Every feature no-ops when its target elements are absent, so this
   single file is shared by all public pages. Under
   prefers-reduced-motion the engine never starts and the site
   renders exactly as it does without JS.
   ═══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)');
  const FINE   = window.matchMedia('(pointer: fine)');
  if (REDUCE.matches) return;

  const root = document.documentElement;
  root.classList.add('ocean-on');

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ── Shared state ──────────────────────────────────────────
  // Pointer normalized to −0.5…0.5 around viewport center; raw px
  // kept for canvas-local effects. Smoothed in the rAF loop so
  // everything eases like it's moving through water.
  const ptr = { tx: 0, ty: 0, x: 0, y: 0, px: innerWidth / 2, py: innerHeight / 2 };
  let scrollY = window.scrollY;
  let scrollVel = 0;          // smoothed px/frame, adds chop to the waves
  let docH = 1;

  window.addEventListener('pointermove', e => {
    ptr.tx = e.clientX / innerWidth - 0.5;
    ptr.ty = e.clientY / innerHeight - 0.5;
    ptr.px = e.clientX;
    ptr.py = e.clientY;
  }, { passive: true });

  function measure() {
    docH = Math.max(1, document.body.scrollHeight - innerHeight);
  }
  measure();
  window.addEventListener('resize', measure);

  // ── Click ripple ──────────────────────────────────────────
  if (FINE.matches) {
    window.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse') return;
      const r = document.createElement('div');
      r.className = 'ocean-ripple';
      r.style.left = e.clientX + 'px';
      r.style.top  = e.clientY + 'px';
      document.body.appendChild(r);
      r.addEventListener('animationend', () => r.remove());
    }, { passive: true });
  }

  // ── Depth tint overlay ────────────────────────────────────
  const depth = document.createElement('div');
  depth.className = 'ocean-depth';
  depth.setAttribute('aria-hidden', 'true');
  document.body.appendChild(depth);

  // ── Hero: waves + bubbles canvas, caustics, photo drift ───
  // Waves are sums of sines per layer; the pointer raises a local
  // swell (gaussian bump) under the cursor and scroll velocity
  // adds chop across the whole surface.
  const heroes = [];
  document.querySelectorAll('.hero, .page-hero, [data-ocean-waves]').forEach(el => {
    const canvas = document.createElement('canvas');
    canvas.className = 'ocean-waves';
    canvas.setAttribute('aria-hidden', 'true');
    el.appendChild(canvas);

    const caustics = document.createElement('div');
    caustics.className = 'ocean-caustics';
    caustics.setAttribute('aria-hidden', 'true');
    el.appendChild(caustics);

    const hero = {
      el, canvas,
      ctx: canvas.getContext('2d'),
      w: 0, h: 0, dpr: 1,
      bg: el.querySelector('.hero-bg, .page-hero-bg'),
      content: el.querySelector('.hero-content, .page-hero-content'),
      layers: [
        { amp: 14, k: 1.7, k2: 3.9, speed: 0.45, react: 1.0, fill: 'rgba(143,191,190,0.34)', y: 0.32 },
        { amp: 18, k: 1.1, k2: 2.6, speed: 0.7,  react: 1.5, fill: 'rgba(221,240,238,0.4)',  y: 0.52 },
        { amp: 12, k: 2.3, k2: 5.1, speed: 1.05, react: 2.2, fill: 'rgba(255,255,255,0.55)', y: 0.7, crest: true },
      ],
      bubbles: [],
    };

    for (let i = 0; i < 22; i++) hero.bubbles.push(spawnBubble(hero, true));
    new ResizeObserver(() => sizeHero(hero)).observe(el);
    sizeHero(hero);
    heroes.push(hero);
  });

  function sizeHero(hero) {
    hero.dpr = Math.min(2, window.devicePixelRatio || 1);
    hero.w = hero.canvas.clientWidth;
    hero.h = hero.canvas.clientHeight;
    hero.canvas.width = hero.w * hero.dpr;
    hero.canvas.height = hero.h * hero.dpr;
    hero.ctx.setTransform(hero.dpr, 0, 0, hero.dpr, 0, 0);
  }

  function spawnBubble(hero, anywhere) {
    return {
      x: Math.random(),
      y: anywhere ? Math.random() : 1.05,
      r: 1 + Math.random() * 3,
      v: 0.0012 + Math.random() * 0.0022,
      drift: Math.random() * Math.PI * 2,
      a: 0.08 + Math.random() * 0.2,
    };
  }

  function drawHero(hero, t) {
    const { ctx, w, h } = hero;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    // Pointer position relative to this canvas, for the local swell.
    const rect = hero.canvas.getBoundingClientRect();
    const localX = ptr.px - rect.left;
    const nearY = clamp(1 - Math.abs(ptr.py - (rect.top + h * 0.5)) / (h * 2.2), 0, 1);
    const chop = clamp(Math.abs(scrollVel) * 0.18, 0, 10);

    for (const L of hero.layers) {
      const base = h * L.y;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) {
        const swell = FINE.matches
          ? Math.exp(-(((x - localX) / (w * 0.16)) ** 2)) * 16 * L.react * nearY
          : 0;
        const y = base
          + Math.sin(x / w * Math.PI * 2 * L.k + t * L.speed) * (L.amp + chop)
          + Math.sin(x / w * Math.PI * 2 * L.k2 - t * L.speed * 1.6) * (L.amp * 0.45)
          - swell;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = L.fill;
      ctx.fill();
      if (L.crest) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    // Bubbles rise through the surf strip, nudged away from the cursor.
    ctx.fillStyle = '#fff';
    for (const b of hero.bubbles) {
      b.y -= b.v;
      b.x += Math.sin(t * 1.4 + b.drift) * 0.0006;
      if (FINE.matches) {
        const dx = b.x * w - localX;
        const dy = rect.top + b.y * h - ptr.py;
        if (dx * dx + dy * dy < 14400) b.x += (dx > 0 ? 1 : -1) * 0.0018;
      }
      if (b.y < -0.05) Object.assign(b, spawnBubble(hero, false));
      ctx.globalAlpha = b.a;
      ctx.beginPath();
      ctx.arc(b.x * w, b.y * h, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Hero photo: slow breathing zoom + pointer/scroll parallax
    // (replaces the CSS Ken Burns, which ocean.css disables).
    if (hero.bg) {
      const zoom = 1.1 + Math.sin(t * 0.08) * 0.015;
      const sy = clamp(scrollY * 0.12, 0, 200);
      hero.bg.style.transform =
        `translate3d(${(-ptr.x * 22).toFixed(2)}px, ${(-ptr.y * 14 + sy).toFixed(2)}px, 0) scale(${zoom.toFixed(4)})`;
    }
    if (hero.content) {
      hero.content.style.transform =
        `translate3d(${(ptr.x * 16).toFixed(2)}px, ${(ptr.y * 10).toFixed(2)}px, 0)`;
    }
  }

  // ── Wave dividers ─────────────────────────────────────────
  // Markup: <div class="ocean-divider" data-top="cream" data-bottom="white">
  // JS builds seamless sine paths (period = half the SVG width) and
  // drifts them from time + scroll so dividers visibly react to
  // scrolling. Layers move at different speeds for depth.
  const VBW = 1440, VBH = 120;

  function wavePath(a1, a2, phase, mid) {
    const pts = [];
    for (let x = 0; x <= VBW * 2; x += 30) {
      const y = mid
        + Math.sin(x / VBW * Math.PI * 2 + phase) * a1
        + Math.sin(x / VBW * Math.PI * 4 + phase * 1.7) * a2;
      pts.push(`${x},${y.toFixed(1)}`);
    }
    return `M${pts.join(' L')} L${VBW * 2},${VBH} L0,${VBH} Z`;
  }

  const dividers = [];
  document.querySelectorAll('.ocean-divider').forEach(el => {
    const svgNS = 'http://www.w3.org/2000/svg';
    const layers = [
      { a1: 16, a2: 6, phase: 0.8, mid: 56, opacity: 0.4,  speed: 26, scroll: 0.22 },
      { a1: 12, a2: 8, phase: 2.6, mid: 68, opacity: 0.65, speed: -38, scroll: -0.3 },
      { a1: 9,  a2: 5, phase: 4.4, mid: 80, opacity: 1,    speed: 52, scroll: 0.42 },
    ].map(cfg => {
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${VBW * 2} ${VBH}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', wavePath(cfg.a1, cfg.a2, cfg.phase, cfg.mid));
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('fill-opacity', cfg.opacity);
      svg.appendChild(path);
      el.appendChild(svg);
      return { svg, ...cfg };
    });
    dividers.push({ el, layers, visible: false });
  });

  // ── Photo scroll parallax ─────────────────────────────────
  const pImgs = [];
  document.querySelectorAll('.img-overflow img, .collection-card img').forEach(img => {
    pImgs.push({ img, visible: false });
  });

  // Only animate what's on screen.
  const vis = new IntersectionObserver(entries => {
    for (const e of entries) {
      const item = [...heroes, ...dividers, ...pImgs].find(o =>
        (o.el || o.img) === e.target);
      if (item) item.visible = e.isIntersecting;
    }
  }, { rootMargin: '80px' });
  heroes.forEach(o => vis.observe(o.el));
  dividers.forEach(o => vis.observe(o.el));
  pImgs.forEach(o => vis.observe(o.img));

  // ── Card tilt + sheen position ────────────────────────────
  if (FINE.matches) {
    document.querySelectorAll('.collection-card, .img-overflow').forEach(card => {
      card.addEventListener('pointermove', e => {
        const r = card.getBoundingClientRect();
        const nx = (e.clientX - r.left) / r.width;
        const ny = (e.clientY - r.top) / r.height;
        card.style.setProperty('--px', (nx * 100).toFixed(1) + '%');
        card.style.setProperty('--py', (ny * 100).toFixed(1) + '%');
        if (card.classList.contains('collection-card')) {
          card.style.setProperty('--tilt-y', ((nx - 0.5) * 5).toFixed(2) + 'deg');
          card.style.setProperty('--tilt-x', ((0.5 - ny) * 5).toFixed(2) + 'deg');
        }
      }, { passive: true });
      card.addEventListener('pointerleave', () => {
        card.style.setProperty('--tilt-x', '0deg');
        card.style.setProperty('--tilt-y', '0deg');
      });
    });
  }

  // ── Main loop ─────────────────────────────────────────────
  let lastScroll = scrollY;
  let running = true;
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) requestAnimationFrame(tick);
  });

  function tick(now) {
    if (!running) return;
    const t = now / 1000;

    ptr.x = lerp(ptr.x, ptr.tx, 0.06);
    ptr.y = lerp(ptr.y, ptr.ty, 0.06);
    scrollY = window.scrollY;
    scrollVel = lerp(scrollVel, scrollY - lastScroll, 0.12);
    lastScroll = scrollY;

    root.style.setProperty('--mx', ptr.x.toFixed(4));
    root.style.setProperty('--my', ptr.y.toFixed(4));
    root.style.setProperty('--sp', clamp(scrollY / docH, 0, 1).toFixed(4));

    for (const hero of heroes) {
      if (hero.visible) drawHero(hero, t);
    }

    for (const d of dividers) {
      if (!d.visible) continue;
      // One wave tile renders at the divider's width (svg is 200% wide,
      // two tiles), so that width is the seamless-loop period.
      const period = d.el.clientWidth || VBW;
      for (const L of d.layers) {
        const shift = ((t * L.speed + scrollY * L.scroll) % period + period) % period;
        L.svg.style.transform = `translate3d(${(-shift).toFixed(1)}px, 0, 0)`;
      }
    }

    const mid = innerHeight / 2;
    for (const p of pImgs) {
      if (!p.visible) continue;
      const r = p.img.getBoundingClientRect();
      const off = clamp((r.top + r.height / 2 - mid) * -0.05, -26, 26);
      p.img.style.setProperty('--oc-py', off.toFixed(1) + 'px');
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
