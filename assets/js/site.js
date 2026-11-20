/* Personal website behaviour. Source: templates/site/js/site.js (copied into website/ by build.py site).
 *
 * ANIMATION SLOTS
 * Every element with data-anim="<name>" is a slot. It shows a static picture until an animation is
 * registered for its name; the animation starts the first time the slot scrolls into view.
 *
 *   SiteAnims.register('eo-flood-map', (el) => {
 *     const c = document.createElement('canvas'); el.appendChild(c);
 *     // ... draw; return a function that stops the animation (optional)
 *   });
 *
 * Put the code in its own file (e.g. assets/js/anim-eo-flood-map.js) and load it after site.js.
 * Slots: hero-orbit, eo-flood-map, oasis-story, pipeline-dashboard, hidden-echo, vit-attention, project-<id>, life-gallery.
 * Add ?dev to the URL to see every slot labelled; ?static shows the page without scroll effects.
 */
(() => {
  const root = document.documentElement;
  const q = new URLSearchParams(location.search);
  if (q.has('dev')) root.classList.add('dev');
  const isStatic = q.has('static');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------ animation slot registry */
  const registry = new Map();
  const started = new WeakSet();
  const slotObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) start(e.target); });
  }, { rootMargin: '120px' }) : null;
  function start(el) {
    const fn = registry.get(el.dataset.anim);
    if (!fn || started.has(el)) return;
    started.add(el);
    el.classList.add('is-live');
    try { fn(el, { reduce }); } catch (err) { console.error('animation', el.dataset.anim, err); el.classList.remove('is-live'); }
  }
  window.SiteAnims = {
    register(name, fn) {
      registry.set(name, fn);
      document.querySelectorAll(`[data-anim="${name}"]`).forEach((el) => (slotObserver ? slotObserver.observe(el) : start(el)));
    },
    slots: () => [...document.querySelectorAll('[data-anim]')].map((el) => el.dataset.anim),
  };

  /* ------------------------------------------------------------ hidden-echo video: play only while visible */
  const playWhenVisible = (el, { reduce }) => {
    const v = el.querySelector('video');
    if (!v) return;
    if (reduce || isStatic) { v.controls = true; return; }   // no autoplay: poster + controls
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) v.play().catch(() => { v.controls = true; }); else v.pause(); },
                                        { threshold: 0.25 });
    io.observe(el);
  };
  SiteAnims.register('hidden-echo', playWhenVisible);
  SiteAnims.register('oasis-story', playWhenVisible);

  /* ------------------------------------------------------------ starfield */
  const canvas = document.getElementById('sky');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, stars = [], shoot = null, mx = 0, my = 0, scrollY = 0, raf = 0;
  const palette = ['255,255,255', '200,225,255', '255,236,210', '170,255,240'];
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.width = Math.floor(innerWidth * dpr);
    H = canvas.height = Math.floor(innerHeight * dpr);
    const n = Math.min(520, Math.floor((innerWidth * innerHeight) / 3200));
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      z: Math.random() ** 2.2,                       // depth: most stars far away and faint
      r: 0.35 + Math.random() * 1.1,
      t: Math.random() * Math.PI * 2, s: 0.004 + Math.random() * 0.018,
      c: palette[(Math.random() * palette.length) | 0],
    }));
    if (reduce || isStatic) draw(0);
  }
  function draw(time) {
    ctx.clearRect(0, 0, W, H);
    const nebula = ctx.createRadialGradient(W * 0.78, H * 0.18, 0, W * 0.78, H * 0.18, W * 0.55);
    nebula.addColorStop(0, 'rgba(110, 90, 255, 0.10)');
    nebula.addColorStop(0.5, 'rgba(40, 160, 200, 0.05)');
    nebula.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = nebula; ctx.fillRect(0, 0, W, H);
    for (const s of stars) {
      const depth = 0.15 + s.z * 0.85;
      const px = (s.x - mx * 18 * depth * dpr) % W;
      const py = ((s.y - scrollY * 0.12 * depth * dpr) % H + H) % H;
      const tw = reduce ? 1 : 0.55 + 0.45 * Math.sin(s.t + time * s.s * 0.06);
      const a = (0.25 + 0.75 * s.z) * tw;
      ctx.beginPath();
      ctx.fillStyle = `rgba(${s.c},${a.toFixed(3)})`;
      ctx.arc((px + W) % W, py, s.r * dpr * (0.6 + s.z * 0.8), 0, Math.PI * 2);
      ctx.fill();
      if (s.z > 0.92) {                              // a few bright stars get a soft glow
        ctx.fillStyle = `rgba(${s.c},${(a * 0.12).toFixed(3)})`;
        ctx.beginPath(); ctx.arc((px + W) % W, py, s.r * dpr * 4, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (!reduce && !isStatic) {                      // shooting star now and then
      if (!shoot && Math.random() < 0.0035) {
        shoot = { x: Math.random() * W * 0.7 + W * 0.2, y: Math.random() * H * 0.35, l: 0, v: (9 + Math.random() * 6) * dpr };
      }
      if (shoot) {
        shoot.l += 1;
        const x = shoot.x - shoot.l * shoot.v, y = shoot.y + shoot.l * shoot.v * 0.45;
        const g = ctx.createLinearGradient(x, y, x + 140 * dpr, y - 63 * dpr);
        const fade = Math.max(0, 1 - shoot.l / 55);
        g.addColorStop(0, `rgba(255,255,255,${0.9 * fade})`); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = g; ctx.lineWidth = 1.4 * dpr;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 140 * dpr, y - 63 * dpr); ctx.stroke();
        if (shoot.l > 55) shoot = null;
      }
    }
  }
  function loop(t) { draw(t); raf = requestAnimationFrame(loop); }
  resize();
  addEventListener('resize', resize);
  if (!reduce && !isStatic) {
    raf = requestAnimationFrame(loop);
    document.addEventListener('visibilitychange', () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(loop);
    });
    addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; }, { passive: true });
  }

  /* ------------------------------------------------------------ scroll: progress, horizon, nav */
  const nav = document.querySelector('.nav');
  const links = [...document.querySelectorAll('.nav__links a[href^="#"]')];
  const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  function onScroll() {
    scrollY = window.scrollY;
    const max = document.documentElement.scrollHeight - innerHeight;
    root.style.setProperty('--scroll', max > 0 ? (scrollY / max).toFixed(4) : 0);
    nav.classList.toggle('is-scrolled', scrollY > 20);
    let current = null;
    for (const s of sections) if (s.getBoundingClientRect().top < innerHeight * 0.4) current = s;
    links.forEach((a) => a.classList.toggle('is-active', current && a.getAttribute('href') === '#' + current.id));
    if (reduce) draw(0);
  }
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ------------------------------------------------------------ mobile menu */
  const toggle = document.querySelector('.nav__toggle');
  const menu = document.getElementById('nav-links');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', open);
    menu.classList.toggle('is-open', open);
  });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) { toggle.setAttribute('aria-expanded', 'false'); menu.classList.remove('is-open'); }
  });

  /* ------------------------------------------------------------ reveal + counters */
  function count(el) {
    const end = parseFloat(el.dataset.count), suffix = el.dataset.suffix || '';
    if (reduce || isStatic || !isFinite(end)) return;
    const t0 = performance.now(), dur = 1600;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
      el.textContent = Math.round(end * e).toLocaleString('en-US') + suffix;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const reveals = document.querySelectorAll('.reveal');
  if (isStatic || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('is-in'));
  } else {
    // stagger siblings that enter together
    const io = new IntersectionObserver((entries) => {
      let i = 0;
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.style.setProperty('--d', `${Math.min(i++ * 0.08, 0.4)}s`);
        e.target.classList.add('is-in');
        e.target.querySelectorAll('[data-count]').forEach(count);
        io.unobserve(e.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    reveals.forEach((el) => io.observe(el));
  }

  /* ------------------------------------------------------------ card spotlight */
  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });

  /* ------------------------------------------------------------ copy email */
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.setAttribute('role', 'status');
  document.body.appendChild(toast);
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast.textContent = 'Email copied'; }
    catch { toast.textContent = b.dataset.copy; }
    toast.classList.add('is-on'); setTimeout(() => toast.classList.remove('is-on'), 1800);
  }));
})();
