/* OASIS explorer. Vanilla JS, no dependencies.
   All numbers come from data/*.json (test-set statistics from arXiv:2610.17168).
   There are NO per-stream model scores anywhere on this page, by design. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const qs = new URLSearchParams(location.search);
  if (qs.has('static')) document.documentElement.classList.add('static');   // test/screenshot mode: no transitions
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches || qs.has('static');
  const NT = 14;
  const BANDS = ['g', 'r', 'i', 'z'];
  const STEP_MS = 1300;
  const NAMES = {
    quad: 'Lensed SN · quad', double: 'Lensed SN · double',
    lookalike_a: 'Look-alike A', lookalike_b: 'Look-alike B', lookalike_c: 'Look-alike C'
  };
  const POP_LABEL = {
    'HSC variables': 'Real variable sources (HSC survey)',
    'SN in lens galaxies': 'Unlensed SN in a lens galaxy',
    'SN in LRGs': 'Unlensed SN in a red galaxy (LRG)',
    'SN in spirals': 'Unlensed SN in a spiral galaxy'
  };
  const SERIES = [   // draw order: joint, baseline, factorized (A2 last, on top)
    { k: 'B1', c: '#6f64cf', w: 1.2, o: 0.6, fam: 'joint' },
    { k: 'B2w', c: '#9b8cff', w: 1.2, o: 0.6, fam: 'joint' },
    { k: 'B2d', c: '#bdb3ff', w: 1.2, o: 0.6, fam: 'joint' },
    { k: 'B3', c: '#8478ee', w: 1.2, o: 0.6, fam: 'joint' },
    { k: 'baseline', c: '#d98a76', w: 1.8, o: 1, fam: 'baseline', dash: '5 3' },
    { k: 'A1', c: '#25ae96', w: 1.4, o: 0.9, fam: 'factorized' },
    { k: 'A3', c: '#9af5e4', w: 1.4, o: 0.9, fam: 'factorized' },
    { k: 'A2', c: '#3ee6c8', w: 2.6, o: 1, fam: 'factorized' }
  ];
  const PATCHES = [[4, 4], [5, 3], [3, 5], [4, 2], [6, 4], [2, 4], [4, 6], [5, 5]];   // schematic highlighted patch (col,row)

  // ---------- debug overlay (only with ?debug) ----------
  function dbg(m) {
    let d = $('#dbg');
    if (!d) { d = document.createElement('div'); d.id = 'dbg'; document.body.appendChild(d); }
    d.textContent += m + '\n';
  }
  if (qs.has('debug')) {
    window.addEventListener('error', (e) => dbg('ERROR: ' + e.message + ' @' + e.lineno + ':' + e.colno));
    window.addEventListener('unhandledrejection', (e) => dbg('PROMISE: ' + e.reason));
  }

  // ---------- helpers ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, cls, parent, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  }
  const pathD = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
  function fmtPct(v) {            // v in percent
    if (v >= 10) return v.toFixed(0) + '%';
    if (v >= 1) return v.toFixed(1) + '%';
    return String(+v.toPrecision(2)) + '%';
  }
  function fmtTPR(f) {            // f fraction
    const p = f * 100;
    return (p < 1 ? p.toFixed(2) : p.toFixed(1)) + '%';
  }
  function oneIn(v) {             // v in percent
    const x = Number((100 / v).toPrecision(2));
    return '1 in ' + x.toLocaleString('en-US');
  }
  const fmtR = (r) => (r < 10 ? r.toFixed(1) : String(Math.round(r)));
  const plural = (n) => (n === 1 ? '' : 's');
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const anims = new Map();
  function animate(key, from, to, fn, dur) {
    cancelAnimationFrame(anims.get(key));
    if (REDUCED || from == null || from === to) { fn(to); return; }
    const t0 = performance.now(), d = dur || 450;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - p, 3);
      fn(from + (to - from) * e);
      if (p < 1) anims.set(key, requestAnimationFrame(step));
    };
    anims.set(key, requestAnimationFrame(step));
  }

  async function getJSON(u) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(u + ': HTTP ' + r.status);
    const t = await r.text();
    return JSON.parse(t.replace(/\bNaN\b/g, 'null').replace(/-?\bInfinity\b/g, 'null'));   // python json writes NaN
  }

  Promise.all(['data/systems.json', 'data/a2_roc.json', 'data/fpr_at_tpr80.json', 'data/auc_vs_nobs.json'].map(getJSON))
    .then(([sys, roc, fpr, auc]) => init(sys, roc, fpr, auc))
    .catch((err) => {
      const e = $('#loaderr');
      e.hidden = false;
      e.textContent = 'Could not load the data (' + err.message + '). If you opened this file directly from disk, serve the folder over http instead (e.g. python -m http.server).';
      if (qs.has('debug')) dbg('LOAD: ' + err.message + '\n' + (err.stack || ''));
    });

  // =====================================================================
  function init(SYS, ROC, FPR, AUC) {
    const TPR4 = [], TPR3 = [];
    for (let n = 1; n <= NT; n++) { TPR4.push(ROC[String(n)]['tpr_1e-4']); TPR3.push(ROC[String(n)]['tpr_1e-3']); }
    const POPS = Object.keys(FPR);
    // FPR(%) at 80% TPR; a missing N means no false positive of that population survived in the test set
    function fa(pop, model, n) {
      const d = FPR[pop][model], i = d.N.findIndex((x) => Math.round(x) === n);
      return i < 0 ? 0 : d.fpr_pct[i];
    }
    const aucAt = (k, n) => AUC[k].auc[AUC[k].N.findIndex((x) => Math.round(x) === n)];
    const isRare = (s) => /^lensed/i.test(s.kind);
    const frameURL = (s, k) => 'data/systems/' + s.name + '/epoch_' + String(k).padStart(2, '0') + '.png';

    // preload frames: current stream first, then the rest
    const cache = {};
    function preload(s) { if (cache[s.name]) return; cache[s.name] = s.t_days.map((_, k) => { const im = new Image(); im.src = frameURL(s, k); return im; }); }

    const S = { i: 0, n: 1, playing: false, view: 'grid', guess: false, deck: [], guessed: false, right: 0, total: 0, mystery: 0 };
    const startName = qs.get('s');
    if (startName) { const j = SYS.findIndex((s) => s.name === startName); if (j >= 0) S.i = j; }

    // ---------- chips ----------
    const chips = $('#chips');
    SYS.forEach((s, j) => {
      const b = h('button', 'chip', chips, '<span class="dot' + (isRare(s) ? ' rare' : '') + '"></span>' + (NAMES[s.name] || s.name));
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.addEventListener('click', () => { if (S.guess) return; S.i = j; buildStream(); setN(1); autoPlay(); });
    });

    // ---------- static scaffolding ----------
    const ticks14 = $('#ticks14');
    for (let k = 0; k < NT; k++) h('span', '', ticks14);
    const gm = $('#gm'), tok = $('#tok'), tracks = $('#tracks'), axis = $('#axis');
    let thumbs = [], cells = [], heads = [], tiles = [];
    let front = $('#imgA'), back = $('#imgB');

    function buildStream() {
      const s = SYS[S.i];
      preload(s);
      SYS.forEach(preload);
      [...chips.children].forEach((c, j) => c.setAttribute('aria-checked', String(j === S.i && !S.guess)));
      updateTitle();

      // band lanes on a true time axis
      const tmaxRaw = Math.max(...s.t_days);
      const tmax = Math.max(10, Math.ceil(tmaxRaw / 10) * 10);
      const pos = (t) => 'calc(' + (t / tmax).toFixed(4) + ' * (100% - var(--tw)))';
      const posC = (t) => 'calc(' + (t / tmax).toFixed(4) + ' * (100% - var(--tw)) + var(--tw) / 2)';
      S.posC = posC;
      thumbs.forEach((t) => t.remove());
      thumbs = s.t_days.map((t, k) => {
        const b = s.band[k], bi = BANDS.indexOf(b);
        const el = h('button', 'thumb', tracks, '<img alt="" src="' + frameURL(s, k) + '">');
        el.style.left = pos(t);
        el.style.top = 'calc(' + bi + ' * var(--lh) + (var(--lh) - var(--tw)) / 2)';
        el.style.zIndex = String(k + 1);
        el.dataset.b = b;
        el.setAttribute('aria-label', 'Jump to image ' + (k + 1) + ', ' + b + '-band, day ' + t.toFixed(1));
        el.tabIndex = -1;
        el.addEventListener('click', () => { pause(); setN(k + 1); });
        return el;
      });
      axis.innerHTML = '';
      const stepT = tmax > 70 ? 20 : 10;
      for (let t = 0; t <= tmax + 1e-6; t += stepT) {
        const tk = h('span', 'tk', axis, String(t));
        tk.style.left = posC(t);
      }

      // grid model view
      gm.innerHTML = '';
      h('span', '', gm);
      heads = [];
      for (let k = 0; k < NT; k++) heads.push(h('span', 'ch', gm, String(k + 1)));
      cells = BANDS.map((b) => {
        h('span', 'rl b-' + b, gm, b);
        const row = [];
        for (let k = 0; k < NT; k++) {
          const c = h('span', 'cell fut', gm);
          if (s.band[k] === b) h('img', '', c).src = frameURL(s, k);
          row.push(c);
        }
        return row;
      });

      // OASIS view
      tok.innerHTML = '';
      tiles = s.t_days.map((t, k) => {
        const el = h('div', 'tile', tok, '<img alt="" src="' + frameURL(s, k) + '"><span class="tb b-' + s.band[k] + '">' + s.band[k] + '</span>');
        return el;
      });
      front.src = frameURL(s, 0);
      front.style.opacity = 1;
      back.style.opacity = 0;
    }

    function updateTitle() {
      const s = SYS[S.i], nm = $('#sName'), kd = $('#sKind');
      if (S.guess && !S.guessed) {
        nm.textContent = 'Mystery stream #' + S.mystery;
        nm.className = 'nm mystery';
        kd.textContent = 'identity hidden';
      } else {
        nm.textContent = NAMES[s.name] || s.name;
        nm.className = 'nm' + (isRare(s) ? ' rare' : '');
        kd.textContent = isRare(s) ? 'the rare event: a ' + s.kind.replace(/^lensed SN, /, 'supernova lensed into ') : 'not a lensed SN (a negative)';
      }
    }

    // ---------- the frame stage ----------
    function showFrame(url, alt) {
      if (front.getAttribute('src') === url) { front.alt = alt; return; }
      back.src = url;
      back.alt = alt; back.removeAttribute('aria-hidden');
      front.alt = ''; front.setAttribute('aria-hidden', 'true');
      back.style.opacity = 1; front.style.opacity = 0;
      [front, back] = [back, front];
      if (!REDUCED) { const sc = $('#scan'); sc.classList.remove('go'); void sc.offsetWidth; sc.classList.add('go'); }
    }

    // ---------- render everything for the current N ----------
    let lastN = null;
    function render() {
      const s = SYS[S.i], n = S.n, k = n - 1, b = s.band[k], t = s.t_days[k];
      const alt = 'Image ' + n + ' of ' + NT + ': ' + b + '-band, day ' + t.toFixed(1) + ' (simulated survey image)';
      showFrame(frameURL(s, k), alt);
      const badge = $('#badge');
      badge.className = 'badge b-' + b; badge.textContent = b;
      $('#tDay').textContent = 'day ' + t.toFixed(1);
      $('#nPill').textContent = 'image ' + n + ' / ' + NT;

      thumbs.forEach((el, j) => { el.classList.toggle('in', j < n); el.classList.toggle('new', j === k); el.tabIndex = -1; });
      $('#cursor').style.left = S.posC(t);
      $('#scrub').value = String(n);
      [...ticks14.children].forEach((e, j) => e.classList.toggle('on', j < n));
      $('#rN').textContent = String(n);
      $('#play').disabled = false;

      $('#live').innerHTML = '<span>After <b>' + n + '</b> image' + plural(n) + ', OASIS flags</span><b>' + fmtTPR(TPR4[k]) +
        '</b><span>of lensed SNe at 1-in-10,000 false alarms</span><span class="src">test-set average</span>';

      // grid view
      cells.forEach((row, bi) => row.forEach((c, j) => {
        const real = s.band[j] === BANDS[bi];
        c.className = 'cell ' + (j < n ? (real ? 'real' : 'pad') : 'fut') + (j === k && real ? ' newc' : '');
      }));
      heads.forEach((e, j) => e.classList.toggle('now', j === k));
      $('#gSlots').textContent = String(4 * n);
      $('#gReal').textContent = String(n);
      $('#gRealL').textContent = 'real image' + plural(n);
      $('#gPad').textContent = String(3 * n);
      const gmeter = $('#gMeter');
      gmeter.style.width = (4 * n / (4 * NT) * 100).toFixed(2) + '%';
      gmeter.style.background = 'linear-gradient(90deg, var(--teal) 0 25%, var(--base) 25% 100%)';

      // OASIS view
      tiles.forEach((el, j) => { el.classList.toggle('in', j < n); el.classList.toggle('new', j === k); });
      $('#oImg').textContent = String(n);
      $('#oImgL').textContent = 'image' + plural(n);
      $('#oTok').textContent = String(81 * n);
      $('#oMeter').style.width = (n / NT * 100).toFixed(2) + '%';
      drawLinks();

      // results
      $('#resN').textContent = String(n);
      $('#resS').textContent = plural(n);
      animate('big', lastN == null ? null : TPR4[lastN - 1], TPR4[k], (v) => { $('#bigNum').textContent = fmtTPR(v); }, 500);
      ew.update(n);
      updateFA(n);
      aucC.update(n);
      lastN = n;

      if (!S.playing) {
        $('#status').textContent = 'Image ' + n + ' of 14, ' + b + '-band, day ' + t.toFixed(1) + '. After ' + n + ' images OASIS flags ' +
          fmtTPR(TPR4[k]) + ' of lensed supernovae at one false alarm per 10,000 (test-set average).';
      }
    }

    function setN(n) { S.n = clamp(n, 1, NT); render(); }

    // ---------- attention links (schematic) ----------
    const linksSvg = $('#links'), ovWrap = $('#ovWrap');
    function drawLinks() {
      if (S.view !== 'oasis' || !tiles.length) return;
      const W = ovWrap.clientWidth, H = ovWrap.clientHeight;
      linksSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      linksSvg.innerHTML = '';
      const k = S.n - 1, P = PATCHES[k % PATCHES.length];
      const geo = (j) => {
        const el = tiles[j], w = el.offsetWidth, x0 = tok.offsetLeft + el.offsetLeft, y0 = tok.offsetTop + el.offsetTop, ps = w / 9;
        return { x: x0 + (P[0] + 0.5) * ps, y: y0 + (P[1] + 0.5) * ps, ps, top: y0 };
      };
      const src = geo(k);
      const gl = svgEl('g', {}, linksSvg);
      for (let j = 0; j < k; j++) {
        const g = geo(j);
        const dx = Math.abs(src.x - g.x);
        const topY = Math.min(src.top, g.top);
        const apex = topY - clamp(10 + dx * 0.09, 10, topY - 8);      // arc apex height grows with distance
        const cx = (src.x + g.x) / 2, cy = 2 * apex - (src.y + g.y) / 2;   // quadratic: apex = mean(ends)/2 + cy/2
        svgEl('path', { d: 'M' + g.x.toFixed(1) + ',' + g.y.toFixed(1) + ' Q' + cx.toFixed(1) + ',' + cy.toFixed(1) + ' ' + src.x.toFixed(1) + ',' + src.y.toFixed(1) }, gl);
        svgEl('rect', { x: (g.x - g.ps / 2).toFixed(1), y: (g.y - g.ps / 2).toFixed(1), width: g.ps.toFixed(1), height: g.ps.toFixed(1), rx: 1 }, linksSvg);
      }
      svgEl('rect', { class: 'src', x: (src.x - src.ps / 2).toFixed(1), y: (src.y - src.ps / 2).toFixed(1), width: src.ps.toFixed(1), height: src.ps.toFixed(1), rx: 1 }, linksSvg);
    }
    if ('ResizeObserver' in window) new ResizeObserver(() => drawLinks()).observe(ovWrap);
    else window.addEventListener('resize', drawLinks);

    // ---------- responsive SVG chart helper: redraws at the container's pixel width ----------
    function chart(box, H, draw) {
      const tip = h('div', 'tip', box);
      let svg = null, lastW = 0, api = {};
      function build() {
        const W = Math.max(260, Math.round(box.clientWidth));
        if (W === lastW && svg) return;
        lastW = W;
        if (svg) svg.remove();
        svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H }, null);
        box.insertBefore(svg, tip);
        api = draw(svg, W, tip) || {};
        if (api.redraw) api.redraw();
      }
      build();
      if ('ResizeObserver' in window) new ResizeObserver(build).observe(box);
      else window.addEventListener('resize', build);
      return { get: () => api };
    }
    function tipAt(tip, box, px, py) {
      tip.classList.add('on');
      const tw = tip.offsetWidth, bx = box.clientWidth;
      let lx = px + 14; if (lx + tw > bx) lx = px - tw - 14;
      tip.style.transform = 'translate(' + Math.max(0, lx) + 'px,' + Math.max(0, py) + 'px)';
    }

    // ---------- chart: early-warning curve ----------
    const ew = (() => {
      let cur = null;
      const H = 200, L = 40, R = 12, T = 12, B = 36;
      const box = $('#ewChart');
      const c = chart(box, H, (svg, W, tip) => {
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Line chart: share of lensed supernovae flagged at a false-alarm rate of 1 in 10,000 versus number of images seen, rising from 0.44% after 1 image to 96% after 14.');
        const x = (n) => L + (n - 1) / (NT - 1) * (W - L - R);
        const y = (v) => T + (1 - v) * (H - T - B);
        const defs = svgEl('defs', {}, svg);
        const gr = svgEl('linearGradient', { id: 'ewG', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        svgEl('stop', { offset: '0', 'stop-color': '#3ee6c8', 'stop-opacity': '0.32' }, gr);
        svgEl('stop', { offset: '1', 'stop-color': '#3ee6c8', 'stop-opacity': '0' }, gr);
        const clip = svgEl('clipPath', { id: 'ewClip' }, defs);
        const clipR = svgEl('rect', { x: 0, y: 0, width: x(1), height: H }, clip);
        [0, 0.25, 0.5, 0.75, 1].forEach((v) => {
          svgEl('line', { class: 'gridl', x1: L, x2: W - R, y1: y(v), y2: y(v) }, svg);
          svgEl('text', { x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, svg).textContent = (v * 100) + '%';
        });
        for (let n = 1; n <= NT; n++) svgEl('text', { x: x(n), y: H - B + 15, 'text-anchor': 'middle' }, svg).textContent = String(n);
        svgEl('text', { x: W - R, y: H - 4, 'text-anchor': 'end' }, svg).textContent = 'images seen →';
        const pts = TPR4.map((v, i) => [x(i + 1), y(v)]);
        const line = pathD(pts);
        svgEl('path', { d: line + 'L' + x(NT) + ',' + y(0) + 'L' + x(1) + ',' + y(0) + 'Z', fill: 'url(#ewG)', 'clip-path': 'url(#ewClip)' }, svg);
        svgEl('path', { d: line, fill: 'none', stroke: '#3ee6c8', 'stroke-opacity': 0.3, 'stroke-width': 2, 'stroke-dasharray': '2 4', 'stroke-linecap': 'round' }, svg);
        svgEl('path', { d: line, fill: 'none', stroke: '#3ee6c8', 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'clip-path': 'url(#ewClip)' }, svg);
        pts.forEach((p) => svgEl('circle', { cx: p[0], cy: p[1], r: 2.2, fill: '#3ee6c8', 'fill-opacity': 0.45 }, svg));
        const guide = svgEl('line', { y1: T, y2: H - B, stroke: 'rgba(62,230,200,.45)', 'stroke-dasharray': '3 3' }, svg);
        const halo = svgEl('circle', { r: 11, fill: '#3ee6c8', 'fill-opacity': 0.16 }, svg);
        const dot = svgEl('circle', { r: 5.5, fill: '#3ee6c8', stroke: '#05070f', 'stroke-width': 2 }, svg);
        const hov = svgEl('circle', { r: 5, fill: 'none', stroke: '#eef1f8', 'stroke-width': 1.5, opacity: 0 }, svg);
        const hit = svgEl('rect', { x: L - 12, y: 0, width: W - L - R + 24, height: H - B + 6, fill: 'transparent', style: 'cursor:pointer' }, svg);
        const nAt = (e) => { const r = svg.getBoundingClientRect(); return clamp(Math.round((e.clientX - r.left - L) / (W - L - R) * (NT - 1)) + 1, 1, NT); };
        hit.addEventListener('pointermove', (e) => {
          const n = nAt(e);
          hov.setAttribute('cx', x(n)); hov.setAttribute('cy', y(TPR4[n - 1])); hov.setAttribute('opacity', 1);
          tip.innerHTML = '<div class="tt">after ' + n + ' image' + plural(n) + '</div>' +
            '<div class="r hl"><span>at 1 in 10,000 false alarms</span><span>' + fmtTPR(TPR4[n - 1]) + '</span></div>' +
            '<div class="r"><span>at 1 in 1,000 false alarms</span><span>' + fmtTPR(TPR3[n - 1]) + '</span></div>';
          tipAt(tip, box, x(n), Math.min(H - B - 70, Math.max(0, y(TPR4[n - 1]) - 70)));
        });
        hit.addEventListener('pointerleave', () => { tip.classList.remove('on'); hov.setAttribute('opacity', 0); });
        hit.addEventListener('click', (e) => { pause(); setN(nAt(e)); });
        function place(v) {
          const lo = clamp(Math.floor(v), 1, NT), hi = clamp(Math.ceil(v), 1, NT);
          const tv = TPR4[lo - 1] + (TPR4[hi - 1] - TPR4[lo - 1]) * (v - lo);
          clipR.setAttribute('width', x(v) + 1);
          guide.setAttribute('x1', x(v)); guide.setAttribute('x2', x(v));
          dot.setAttribute('cx', x(v)); dot.setAttribute('cy', y(tv));
          halo.setAttribute('cx', x(v)); halo.setAttribute('cy', y(tv));
        }
        return { place, redraw: () => place(cur == null ? S.n : cur) };
      });
      return {
        update(n) {
          if (cur == null) { cur = n; c.get().place(n); return; }
          animate('ew', cur, n, (v) => { cur = v; c.get().place(v); }, 500);
        }
      };
    })();

    // ---------- false alarms at 80% detection ----------
    const faBox = $('#fa');
    const LMIN = -3, LMAX = 2;   // 0.001% .. 100%
    const lpos = (v) => clamp((Math.log10(v) - LMIN) / (LMAX - LMIN), 0, 1);
    const faRows = POPS.map((pop) => {
      const row = h('div', 'fa-row', faBox);
      const top = h('div', 'top', row);
      h('span', 'pop', top, POP_LABEL[pop] || pop);
      const tag = h('span', 'tag', top);
      const mk = (cls, who) => {
        const bar = h('div', 'bar ' + cls, row);
        h('span', 'who', bar, who);
        const trk = h('div', 'trk', bar);
        return { bar, fill: h('span', 'fill', trk), zero: h('span', 'zero', trk), val: h('span', 'val', trk) };
      };
      return { pop, tag, o: mk('o', 'OASIS'), b: mk('b', 'baseline') };
    });
    function setBar(B, v, who) {
      if (v > 0) {
        const p = lpos(v);
        B.fill.style.width = (p * 100).toFixed(2) + '%';
        B.fill.style.display = '';
        B.zero.style.display = 'none';
        B.val.textContent = fmtPct(v) + (v < 10 ? '  ≈ ' + oneIn(v) : '');
        if (p > 0.6) { B.val.style.left = 'calc(' + (p * 100).toFixed(2) + '% - 6px)'; B.val.style.transform = 'translateX(-100%)'; B.val.style.color = '#05070f'; }
        else { B.val.style.left = 'calc(' + (p * 100).toFixed(2) + '% + 6px)'; B.val.style.transform = 'none'; B.val.style.color = ''; }
        B.bar.title = who + ': ' + fmtPct(v) + ' of these look-alikes flagged (' + oneIn(v) + ')';
      } else {
        B.fill.style.width = '0'; B.fill.style.display = 'none';
        B.zero.style.display = '';
        B.val.textContent = 'none in test set';
        B.val.style.left = '18px'; B.val.style.transform = 'none'; B.val.style.color = '';
        B.bar.title = who + ': no look-alike of this population passed the threshold in the test set';
      }
    }
    function updateFA(n) {
      $('#faN').textContent = String(n);
      faRows.forEach((R) => {
        const a = fa(R.pop, 'A2', n), b = fa(R.pop, 'baseline', n);
        setBar(R.o, a, 'OASIS'); setBar(R.b, b, 'Baseline');
        let cls = 'eq', txt = 'both zero';
        if (a > 0 && b > 0) {
          const r = b / a;
          if (r >= 1.15) { cls = 'win'; txt = fmtR(r) + '× fewer'; }
          else if (r <= 1 / 1.15) { cls = 'lose'; txt = 'baseline lower'; }
          else { cls = 'eq'; txt = 'about equal'; }
        } else if (a === 0 && b > 0) { cls = 'zero'; txt = 'OASIS: zero'; }
        else if (a > 0 && b === 0) { cls = 'lose'; txt = 'baseline: zero'; }
        R.tag.className = 'tag ' + cls; R.tag.textContent = txt;
      });
    }

    // ---------- chart: AUC vs N for 7 architectures + baseline ----------
    const aucC = (() => {
      let cur = null;
      const H = 230, L = 42, R = 12, T = 10, B = 36, Y0 = 0.8, Y1 = 1.0;
      const box = $('#aucChart');
      const interp = (k, v) => { const lo = clamp(Math.floor(v), 1, NT), hi = clamp(Math.ceil(v), 1, NT); return aucAt(k, lo) + (aucAt(k, hi) - aucAt(k, lo)) * (v - lo); };
      const c = chart(box, H, (svg, W, tip) => {
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Line chart of AUC versus images seen for seven OASIS architectures and the ConvLSTM+LSTM baseline. From the second image on the factorized designs are highest; the baseline is lowest for the first images.');
        const x = (n) => L + (n - 1) / (NT - 1) * (W - L - R);
        const y = (v) => T + (1 - (v - Y0) / (Y1 - Y0)) * (H - T - B);
        [0.8, 0.85, 0.9, 0.95, 1].forEach((v) => {
          svgEl('line', { class: 'gridl', x1: L, x2: W - R, y1: y(v), y2: y(v) }, svg);
          svgEl('text', { x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, svg).textContent = v.toFixed(2);
        });
        for (let n = 1; n <= NT; n++) svgEl('text', { x: x(n), y: H - B + 15, 'text-anchor': 'middle' }, svg).textContent = String(n);
        svgEl('text', { x: W - R, y: H - 4, 'text-anchor': 'end' }, svg).textContent = 'images seen →';
        const guide = svgEl('line', { y1: T, y2: H - B, stroke: 'rgba(255,255,255,.28)', 'stroke-dasharray': '3 3' }, svg);
        SERIES.forEach((S2) => {
          const a = { d: pathD(AUC[S2.k].auc.map((v, i) => [x(i + 1), y(v)])), fill: 'none', stroke: S2.c, 'stroke-width': S2.w, 'stroke-opacity': S2.o, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
          if (S2.dash) a['stroke-dasharray'] = S2.dash;
          svgEl('path', a, svg);
        });
        // direct labels at the first point, where the curves are furthest apart
        svgEl('text', { x: x(1) + 8, y: y(aucAt('baseline', 1)) + 4, class: 'lab' }, svg).textContent = 'baseline';
        const dB = svgEl('circle', { r: 4.5, fill: '#d98a76', stroke: '#05070f', 'stroke-width': 2 }, svg);
        const dA = svgEl('circle', { r: 5, fill: '#3ee6c8', stroke: '#05070f', 'stroke-width': 2 }, svg);
        const hit = svgEl('rect', { x: L - 12, y: 0, width: W - L - R + 24, height: H - B + 6, fill: 'transparent' }, svg);
        hit.addEventListener('pointermove', (e) => {
          const r = svg.getBoundingClientRect();
          const n = clamp(Math.round((e.clientX - r.left - L) / (W - L - R) * (NT - 1)) + 1, 1, NT);
          const rows = SERIES.map((S2) => ({ S2, v: aucAt(S2.k, n) })).sort((p, q) => q.v - p.v);
          tip.innerHTML = '<div class="tt">AUC after ' + n + ' image' + plural(n) + '</div>' + rows.map((o) =>
            '<div class="r' + (o.S2.k === 'A2' ? ' hl' : '') + '"><span><i style="background:' + o.S2.c + '"></i>' + (o.S2.k === 'baseline' ? 'baseline' : o.S2.k + ' · ' + o.S2.fam) + '</span><span>' + o.v.toFixed(4) + '</span></div>').join('');
          tipAt(tip, box, x(n), 0);
        });
        hit.addEventListener('pointerleave', () => tip.classList.remove('on'));
        function place(v) {
          guide.setAttribute('x1', x(v)); guide.setAttribute('x2', x(v));
          dA.setAttribute('cx', x(v)); dA.setAttribute('cy', y(interp('A2', v)));
          dB.setAttribute('cx', x(v)); dB.setAttribute('cy', y(interp('baseline', v)));
        }
        return { place, redraw: () => place(cur == null ? S.n : cur) };
      });
      return {
        update(n) {
          if (cur == null) { cur = n; c.get().place(n); }
          else animate('auc', cur, n, (v) => { cur = v; c.get().place(v); }, 500);
          const joint = ['B1', 'B2w', 'B2d', 'B3'].map((k) => [k, aucAt(k, n)]).sort((p, q) => q[1] - p[1])[0];
          $('#aucAt').innerHTML = 'after ' + n + ' image' + plural(n) + ': A2 <b class="t">' + aucAt('A2', n).toFixed(4) + '</b> · best joint <b>' +
            joint[1].toFixed(4) + '</b> (' + joint[0] + ') · baseline <b>' + aucAt('baseline', n).toFixed(4) + '</b>';
        }
      };
    })();

    // ---------- data tables (the numbers behind the charts) ----------
    (function tables() {
      let html = '<table><caption>Lensed SNe flagged by OASIS (A2) at a fixed false-alarm rate</caption><tr><th>images seen</th><th>at 1 in 10,000</th><th>at 1 in 1,000</th></tr>';
      for (let n = 1; n <= NT; n++) html += '<tr><td>' + n + '</td><td>' + fmtTPR(TPR4[n - 1]) + '</td><td>' + fmtTPR(TPR3[n - 1]) + '</td></tr>';
      html += '</table>';
      html += '<table><caption>False alarms (% of each look-alike population) at 80% detection; "none" = no false positive left in the test set</caption><tr><th>images seen</th>' +
        POPS.map((p) => '<th>' + p + '<br>OASIS</th><th>' + p + '<br>baseline</th>').join('') + '</tr>';
      const cell = (v) => (v > 0 ? fmtPct(v) : 'none');
      for (let n = 1; n <= NT; n++) html += '<tr><td>' + n + '</td>' + POPS.map((p) => '<td>' + cell(fa(p, 'A2', n)) + '</td><td>' + cell(fa(p, 'baseline', n)) + '</td>').join('') + '</tr>';
      html += '</table>';
      const ks = ['A1', 'A2', 'A3', 'B1', 'B2w', 'B2d', 'B3', 'baseline'];
      html += '<table><caption>AUC vs images seen (A = factorized, B = joint attention)</caption><tr><th>images seen</th>' + ks.map((k) => '<th>' + k + '</th>').join('') + '</tr>';
      for (let n = 1; n <= NT; n++) html += '<tr><td>' + n + '</td>' + ks.map((k) => '<td>' + aucAt(k, n).toFixed(4) + '</td>').join('') + '</tr>';
      html += '</table>';
      $('#tables').innerHTML = html;
    })();

    // ---------- playback ----------
    let timer = null;
    const ICON_PLAY = '<path d="M4 2l10 6-10 6z"/>', ICON_PAUSE = '<path d="M3 2h3.5v12H3zM9.5 2H13v12H9.5z"/>';
    function play() {
      if (S.playing) return;
      if (S.n >= NT) setN(1);
      S.playing = true;
      $('#playIcon').innerHTML = ICON_PAUSE;
      $('#play').setAttribute('aria-label', 'Pause');
      timer = setInterval(() => {
        if (S.n >= NT) { pause(); return; }
        setN(S.n + 1);
        if (S.n >= NT) pause();
      }, STEP_MS);
    }
    function pause() {
      if (!S.playing) return;
      S.playing = false;
      clearInterval(timer);
      $('#playIcon').innerHTML = ICON_PLAY;
      $('#play').setAttribute('aria-label', 'Play');
      render();
    }
    const toggle = () => (S.playing ? pause() : play());
    let autoTimer = null;
    function autoPlay() {
      clearTimeout(autoTimer);
      if (REDUCED || qs.has('static')) return;
      autoTimer = setTimeout(play, 500);
    }

    $('#play').addEventListener('click', toggle);
    $('#prev').addEventListener('click', () => { pause(); setN(S.n - 1); });
    $('#next').addEventListener('click', () => { pause(); setN(S.n + 1); });
    $('#scrub').addEventListener('input', (e) => { pause(); setN(+e.target.value); });
    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (t.id === 'scrub' && e.key === ' ') { e.preventDefault(); toggle(); }
        return;
      }
      if (e.key === ' ' || e.key === 'Spacebar') {
        if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A') return;
        e.preventDefault(); toggle();
      } else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); setN(S.n + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); setN(S.n - 1); }
      else if (e.key === 'Home') { e.preventDefault(); pause(); setN(1); }
      else if (e.key === 'End') { e.preventDefault(); pause(); setN(NT); }
    });

    // ---------- view toggle ----------
    function setView(v) {
      S.view = v;
      $('#vGrid').setAttribute('aria-pressed', String(v === 'grid'));
      $('#vOasis').setAttribute('aria-pressed', String(v === 'oasis'));
      $('#viewGrid').hidden = v !== 'grid';
      $('#viewOasis').hidden = v !== 'oasis';
      drawLinks();
    }
    $('#vGrid').addEventListener('click', () => setView('grid'));
    $('#vOasis').addEventListener('click', () => setView('oasis'));

    // ---------- guess mode ----------
    const guessBtn = $('#guessBtn'), GUESS_LABEL = guessBtn.innerHTML;
    function scoreText() { return S.total ? 'score ' + S.right + ' / ' + S.total : ''; }
    function nextMystery() {
      if (!S.deck.length) S.deck = shuffle(SYS.map((_, j) => j).filter((j) => j !== S.i));
      S.i = S.deck.pop();
      S.guessed = false;
      S.mystery += 1;
      $('#guessAsk').hidden = false;
      $('#guessReveal').hidden = true;
      $('#score1').textContent = scoreText();
      buildStream();
      setN(1);
      autoPlay();
    }
    function enterGuess() {
      pause();
      S.guess = true; S.deck = shuffle(SYS.map((_, j) => j)); S.mystery = 0;
      guessBtn.setAttribute('aria-pressed', 'true');
      guessBtn.textContent = '✕ Exit guess mode';
      chips.classList.add('locked');
      $('#guessBox').hidden = false;
      nextMystery();
    }
    function exitGuess() {
      S.guess = false; S.guessed = false;
      guessBtn.setAttribute('aria-pressed', 'false');
      guessBtn.innerHTML = GUESS_LABEL;
      chips.classList.remove('locked');
      $('#guessBox').hidden = true;
      [...chips.children].forEach((c, j) => c.setAttribute('aria-checked', String(j === S.i)));
      updateTitle();
    }
    guessBtn.addEventListener('click', () => (S.guess ? exitGuess() : enterGuess()));
    function makeGuess(saysRare) {
      if (!S.guess || S.guessed) return;
      pause();
      const s = SYS[S.i], truth = isRare(s), ok = saysRare === truth, n = S.n;
      S.guessed = true; S.total += 1; if (ok) S.right += 1;
      const what = truth ? 'a lensed supernova (' + s.kind.replace(/^lensed SN, /, '') + ').' : 'a look-alike, not a lensed SN.';
      const v = $('#rvV');
      v.className = 'v ' + (ok ? 'ok' : 'no');
      v.textContent = (ok ? 'Correct: ' : 'Not this time: ') + 'it was ' + what;
      let p = 'You decided after <b>' + n + '</b> image' + plural(n) + '. ';
      if (truth) {
        p += 'At that point, OASIS flags <b>' + fmtTPR(TPR4[n - 1]) + '</b> of all lensed SNe at 1-in-10,000 false alarms';
      } else {
        const vals = POPS.map((pp) => fa(pp, 'A2', n)), lo = Math.min(...vals), hi = Math.max(...vals);
        const f = (x) => (x > 0 ? fmtPct(x) : 'none');
        p += 'At that point, OASIS tuned to catch 80% of lensed SNe wrongly flags ' + (lo === hi ? '<b>' + f(lo) + '</b>' : 'between <b>' + f(lo) + '</b> and <b>' + f(hi) + '</b>') + ' of look-alikes, depending on the population';
      }
      p += ' (test-set statistics; no per-stream score is shown here).';
      $('#rvP').innerHTML = p;
      $('#score2').textContent = scoreText();
      $('#guessAsk').hidden = true;
      $('#guessReveal').hidden = false;
      updateTitle();
      $('#gNext').focus({ preventScroll: true });
    }
    $('#gRare').addEventListener('click', () => makeGuess(true));
    $('#gLook').addEventListener('click', () => makeGuess(false));
    $('#gNext').addEventListener('click', nextMystery);

    // ---------- start ----------
    buildStream();
    setView(qs.get('view') === 'oasis' ? 'oasis' : 'grid');
    setN(parseInt(qs.get('n'), 10) || 1);
    if (qs.has('guess')) enterGuess();
    else if (!qs.has('n')) {
      // start playing once the player is on screen
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) { io.disconnect(); autoPlay(); } }, { threshold: 0.35 });
        io.observe($('#stage'));
      } else autoPlay();
    }
    if (qs.has('debug')) setTimeout(() => dbg('init ok · scrollWidth ' + document.documentElement.scrollWidth + ' / clientWidth ' + document.documentElement.clientWidth), 300);
  }
})();
