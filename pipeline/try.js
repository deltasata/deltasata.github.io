/* Pipeline playground page. Source: dashboard/page2/try.js (CV project); copied to website/pipeline/.
 * Data: explore.json, timings.json, latest.json from the pipeline's data repo (made by the last main run).
 * Visitor run: POST {"action":"try", id, start_utc, hours} to the ntfy request topic; replies with the same
 * id arrive on the status topic (try_started / try_refused / try_finished / try_failed). Replies are only shown,
 * never trusted beyond display; every number is checked before use (finite, whole, >= 0).
 * Last good copies of the files are kept in localStorage and shown with their time if a fetch fails.
 */
(() => {
  const q = new URLSearchParams(location.search);
  const BASE = q.get('data') || 'https://raw.githubusercontent.com/deltasata/pipeline-dashboard-data/main/';
  const NTFY = 'https://ntfy.sh/';
  const REQ = 'lsn-dash-req-7f3k9q2xw8', STATUS = 'lsn-dash-status-7f3k9q2xw8';
  const $ = (id) => document.getElementById(id);

  /* ---------- safe values ---------- */
  const ok = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const N = (x) => (ok(x) ? x : null);
  const fmt = (x) => (ok(x) ? Math.round(x).toLocaleString('en-US') : '–');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const D = (s) => new Date(s);
  const day = (d) => `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  const hm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const when = (d) => `${day(d)}, ${hm(d)} UTC`;
  const dur = (s) => {
    if (!ok(s)) return '–';
    if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    return m < 60 ? `${m} min${r ? ` ${r} s` : ''}` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

  /* ---------- fetch with last-good fallback ---------- */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('pp:' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('pp:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  async function getJSON(name, check) {
    try {
      const r = await fetch(BASE + name, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (!check(d)) throw new Error('format');
      store.set(name, { at: Date.now(), d });
      return { d, old: null };
    } catch (e) {
      const c = store.get(name);
      return c && check(c.d) ? { d: c.d, old: c.at } : { d: null, old: null };
    }
  }

  /* ---------- 0. what LSST is doing now ---------- */
  function renderNow(ex) {
    const n = ex && ex.now;
    if (!n || !n.message) return;
    const pill = $('now-pill');
    const label = { observing: 'observing', daytime: 'daytime in Chile', twilight: 'twilight', off: 'LSST off' }[n.state] || n.state;
    pill.textContent = label; pill.className = 'now__pill is-' + esc(n.state);
    $('now-msg').textContent = `${n.message} (as of ${when(D(n.checked_utc || ex.generated_utc))})`;
    $('now').hidden = false;
  }

  /* ---------- 2. days ---------- */
  function renderDays(ex) {
    const b = ex && ex.box;
    if (!b || !Array.isArray(b.days) || !b.days.length) { $('days-chart').innerHTML = '<p class="note">No daily counts available right now.</p>'; return; }
    const thr = N(b.day_min_alerts) || 50000;
    const max = Math.max(thr * 1.15, ...b.days.map((d) => N(d.alerts) || 0));
    $('days-chart').innerHTML = b.days.map((d) => {
      const a = N(d.alerts), h = a ? Math.max(1.5, (100 * a) / max) : 0;
      return `<div class="day ${d.enough ? 'is-ok' : ''}" title="${esc(day(D(d.date + 'T00:00:00Z')))}: ${a == null ? 'no alerts reported' : fmt(a) + ' alerts'}">
        <span class="day__n">${a == null ? '–' : short(a)}</span><span class="day__bar" style="height:${h}%"></span><span class="day__d">${esc(day(D(d.date + 'T00:00:00Z')))}</span></div>`;
    }).join('') + `<span class="days__line" style="bottom:calc(${(100 * thr) / max}% * (190 - 18 - 36) / 190 + 24px)"><em>${short(thr)}</em></span>`;
    // place the 50k line on the bar scale (bars live in the area between the labels)
    requestAnimationFrame(() => {
      const bar = $('days-chart').querySelector('.day__bar'), line = $('days-chart').querySelector('.days__line');
      if (!bar || !line) return;
      const col = bar.parentElement, top = col.querySelector('.day__n').offsetHeight + 5, bottom = col.querySelector('.day__d').offsetHeight + 6;
      const area = col.offsetHeight - top - bottom;
      line.style.bottom = `${bottom + (area * thr) / max}px`;
    });
    if (b.note) { $('days-note').textContent = `Note: ${b.note}.`; $('days-note').hidden = false; }
    const t = ex.tonight;
    if (t && Array.isArray(t.bins) && t.bins.length && ok(t.alerts_received)) {
      $('tonight').innerHTML = `Tonight so far (Babamul's live count, updated ${esc(when(D(t.updated_utc)))}): <b>${fmt(t.alerts_received)}</b> alerts.`;
      $('tonight').hidden = false;
    }
  }

  /* ---------- 3. picker, instant counts, visitor run ---------- */
  let EX = null, hours = [], hourIndex = new Map(), classes = {};
  const sel = { day: null, hour: 0, len: 24 };
  const KINDS = ['asteroid', 'fainter_than_reference', 'dipole', 'satellite_glint'];
  const RELI = ['reliability_ge_0_9', 'reliability_0_5_to_0_9', 'reliability_lt_0_5'];
  const BANDS = ['band_u', 'band_g', 'band_r', 'band_i', 'band_z', 'band_y'];

  function startUTC() { return new Date(Date.parse(sel.day + 'T00:00:00Z') + sel.hour * 3600e3); }

  function setupPicker(ex) {
    const wc = ex && ex.window_choice, hr = ex && ex.hourly;
    if (!wc || !Array.isArray(wc.start_on) || !wc.start_on.length || !hr || !Array.isArray(hr.hours)) {
      $('preview').innerHTML = '<p class="note">The hourly counts are not available right now; please try again later.</p>';
      return false;
    }
    classes = ex.alert_classes || {};
    hours = hr.hours.filter((h) => h && h.hour_utc && ok(h.alerts));
    hourIndex = new Map(hours.map((h) => [Date.parse(h.hour_utc), h]));
    const maxH = N(wc.max_hours) || 360;
    $('pick-len').max = String(maxH);
    $('pick-day').innerHTML = wc.start_on.map((d) => `<option value="${esc(d)}">${esc(day(D(d + 'T00:00:00Z')))} ${D(d + 'T00:00:00Z').getUTCFullYear()}</option>`).join('');
    $('pick-hour').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('');
    sel.day = wc.start_on.includes('2026-11-15') ? '2026-11-15' : wc.start_on[wc.start_on.length - 1];
    $('pick-day').value = sel.day;
    const pres = [[1, '1 h'], [6, '6 h'], [24, '1 day'], [72, '3 days'], [168, '7 days'], [maxH, '15 days']];
    $('presets').innerHTML = pres.map(([h, l]) => `<button type="button" data-h="${h}">${l}</button>`).join('');
    $('presets').addEventListener('click', (e) => { const h = Number(e.target.dataset.h); if (h) { sel.len = h; $('pick-len').value = h; update(); } });
    $('pick-day').addEventListener('change', (e) => { sel.day = e.target.value; update(); });
    $('pick-hour').addEventListener('change', (e) => { sel.hour = Number(e.target.value); update(); });
    $('pick-len').addEventListener('input', (e) => { sel.len = Number(e.target.value); update(); });
    drawTimeline(hr);
    update();
    return true;
  }

  // the whole hourly series as thin bars; the chosen window is outlined
  let tl = null;
  function drawTimeline(hr) {
    const t0 = Date.parse(hr.start_utc), last = Date.parse(hr.latest_alert_utc || hr.end_utc);
    const t1 = Math.ceil((Math.min(Date.parse(hr.end_utc), last + 24 * 3600e3)) / 3600e3) * 3600e3;
    const n = Math.max(1, Math.round((t1 - t0) / 3600e3));
    const max = Math.max(1, ...hours.map((h) => h.alerts));
    const bars = [];
    for (let i = 0; i < n; i++) { const h = hourIndex.get(t0 + i * 3600e3); bars.push(`<i style="height:${h ? Math.max(4, Math.sqrt(h.alerts / max) * 100) : 0}%"></i>`); }
    $('timeline').innerHTML = bars.join('') + '<span class="timeline__sel" id="tl-sel"></span>';
    $('timeline-axis').innerHTML = `<span>${esc(day(new Date(t0)))}</span><span>alerts per hour (square-root scale) · your window outlined</span><span>${esc(day(new Date(t1 - 1)))}</span>`;
    tl = { t0, t1, n };
  }

  function sumWindow() {
    const s = startUTC().getTime(), e = s + sel.len * 3600e3;
    const tot = { alerts: 0, visits: 0, hours: 0 };
    [...KINDS, ...RELI, ...BANDS].forEach((k) => (tot[k] = 0));
    for (const h of hours) {
      const t = Date.parse(h.hour_utc);
      if (t < s || t >= e) continue;
      tot.hours++; tot.alerts += h.alerts; tot.visits += N(h.visits) || 0;
      [...KINDS, ...RELI, ...BANDS].forEach((k) => { tot[k] += N(h[k]) || 0; });
    }
    return tot;
  }

  const rows = (keys, obj, total, cls = '') => `<ul class="rows ${cls}">${keys.filter((k) => obj[k] > 0 || !k.startsWith('band_')).map((k) => {
    const v = N(obj[k]) || 0, w = total ? (100 * v) / total : 0;
    return `<li><span>${esc(classes[k] || k)}</span><b>${fmt(v)}</b><span class="bar"><i style="--w:${w}%"></i></span></li>`;
  }).join('')}</ul>`;

  function update() {
    const dd = +(sel.len / 24).toFixed(1);
    $('pick-len-out').textContent = sel.len < 24 ? `${sel.len} h` : `${sel.len} h (${dd} day${dd === 1 ? '' : 's'})`;
    document.querySelectorAll('#presets button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.h) === sel.len)));
    const s = startUTC(), e = new Date(s.getTime() + sel.len * 3600e3);
    if (tl) {
      const a = Math.max(0, (s - tl.t0) / (tl.t1 - tl.t0)), b = Math.min(1, (e - tl.t0) / (tl.t1 - tl.t0));
      const el = $('tl-sel'); el.style.left = `${a * 100}%`; el.style.width = `${Math.max(0.4, (b - a) * 100)}%`;
    }
    const t = sumWindow();
    $('preview').innerHTML = `
      <div class="tile"><h3>Alerts in your window <span class="tag tag--m">measured</span></h3>
        <p class="big">${fmt(t.alerts)}<small>alerts</small></p>
        <p class="note">${esc(when(s))} → ${esc(when(e))}<br>${fmt(t.visits)} telescope visits in ${t.hours} hours with alerts. From the last main run's hourly counts (Pitt-Google).</p></div>
      <div class="tile"><h3>What kind of alerts</h3>${rows(KINDS, t, t.alerts)}${rows(RELI, t, t.alerts, 'teal')}</div>
      <div class="tile"><h3>Colour band</h3>${rows(BANDS, t, t.alerts)}</div>`;
    if (!t.alerts) $('preview').insertAdjacentHTML('beforeend', '<p class="note warn">No alerts in this window. Pick another start, or make it longer.</p>');
    runState();
  }

  /* visitor run */
  let busyUntil = 0, running = false;
  function runState() {
    const btn = $('run');
    if (running) return;
    const wait = Math.ceil((busyUntil - Date.now()) / 1000);
    btn.disabled = !EX || wait > 0 || !sumWindow().alerts;
    if (wait > 0) $('run-msg').textContent = `The cluster is busy with other visitors' runs; try again in ${dur(wait)}.`;
  }
  setInterval(() => { if (busyUntil && Date.now() >= busyUntil) { busyUntil = 0; $('run-msg').textContent = ''; } runState(); }, 1000);

  function runTry() {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
    const body = { action: 'try', id, start_utc: startUTC().toISOString().replace('.000Z', 'Z'), hours: sel.len };
    running = true; $('run').disabled = true; $('run-msg').textContent = 'Request sent…';
    let done = false, es = null;
    const t0 = Date.now();
    const finish = () => { done = true; running = false; if (es) es.close(); clearInterval(tick); runState(); };
    const tick = setInterval(() => { if (!done && $('run-msg').dataset.state === 'run') $('run-msg').textContent = `Running on the cluster… ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
    const handle = (m) => {
      if (!m || m.id !== id || done) return;
      if (m.event === 'try_started') { $('run-msg').dataset.state = 'run'; $('run-msg').textContent = 'Running on the cluster…'; }
      else if (m.event === 'try_refused') {
        finish(); $('run-msg').dataset.state = '';
        if (m.reason === 'busy' && ok(m.retry_after_s)) { busyUntil = Date.now() + m.retry_after_s * 1000; runState(); }
        else $('run-msg').textContent = `Not run: ${String(m.reason || 'the window is not allowed')}.`;
      } else if (m.event === 'try_failed') { finish(); $('run-msg').dataset.state = ''; $('run-msg').textContent = `The run did not finish: ${String(m.reason || 'unknown reason')}. Please try again later.`; }
      else if (m.event === 'try_finished') { finish(); $('run-msg').dataset.state = ''; $('run-msg').textContent = `Done in ${Math.round((Date.now() - t0) / 1000)} s.`; renderResult(m); }
    };
    const parse = (raw) => { try { const o = JSON.parse(raw); return typeof o.message === 'string' ? JSON.parse(o.message) : o; } catch { return null; } };
    try { es = new EventSource(`${NTFY}${STATUS}/sse`); es.onmessage = (ev) => handle(parse(ev.data)); } catch { es = null; }
    const send = () => fetch(NTFY + REQ, { method: 'POST', body: JSON.stringify(body) })
      .catch(() => { finish(); $('run-msg').textContent = 'Could not reach the request service. Please try again later.'; });
    // give the event stream a moment to connect before asking, so no reply is missed
    if (es) { let sent = false; es.onopen = () => { if (!sent) { sent = true; send(); } }; setTimeout(() => { if (!sent) { sent = true; send(); } }, 2500); } else send();
    // fallback: if no reply came by event stream, look up the replies once
    setTimeout(async () => {
      if (done) return;
      try {
        const txt = await (await fetch(`${NTFY}${STATUS}/json?poll=1&since=5m`)).text();
        txt.split('\n').filter(Boolean).map(parse).forEach(handle);
      } catch { /* ignore */ }
      if (!done) { finish(); $('run-msg').textContent = 'No answer from the cluster within 2 minutes. It may be offline; the counts above still come from the last main run.'; }
    }, 120000);
  }

  function renderResult(m) {
    const a = m.A0 || {}, no = m.new_objects || {}, sa = m.set_a_cheap || {}, ts = m.timings_s || {}, w = m.window || {};
    // checks: whole, non-negative numbers; classes add up
    const whole = (x) => ok(x) && Math.round(x) === x;
    const byc = Array.isArray(no.by_class) ? no.by_class.filter((c) => c && whole(c.one) && whole(c.two_or_more)) : [];
    const sac = Array.isArray(sa.by_class) ? sa.by_class.filter((c) => c && whole(c.objects)) : [];
    if (!whole(a.alerts) || !whole(no.objects) || !whole(sa.objects)) { $('run-msg').textContent = 'The answer failed a check, so it is not shown. Please try again.'; return; }
    const kinds = {}; (Array.isArray(a.kinds) ? a.kinds : []).forEach((k) => { if (k && k.key && whole(k.alerts)) kinds[k.key] = k.alerts; });
    const pre = sumWindow();
    const s = D(w.start_utc), e = D(w.end_utc);
    const maxNo = Math.max(1, ...byc.map((c) => c.one + c.two_or_more));
    $('result').innerHTML = `
      <h3 class="res">Your run: ${esc(when(s))} → ${esc(when(e))}</h3>
      <p class="sub">${m.stale ? `<span class="tag tag--old">earlier answer</span> The cluster could not complete a fresh run, so this is its last good answer for the same window (as of ${esc(when(D(m.as_of_utc)))}). ${esc(m.note || '')}` : `<span class="tag tag--m">measured</span> Counted on the cluster just now in ${dur(N(ts.total))}: A0 ${dur(N(ts.A0))}, quick Set A ${dur(N(ts['A (ALeRCE)']))}.`}</p>
      <div class="funnel">
        <div class="tile"><h3>A0 · alerts, counted again</h3><p class="big">${fmt(a.alerts)}</p>
          <p class="note">${fmt(a.visits)} visits. ${pre.alerts === a.alerts ? 'Same as the instant count above.' : `The instant count above says ${fmt(pre.alerts)}: the hourly table is from the last main run, this one is from now.`}</p></div>
        <div class="tile"><h3>New objects in the window</h3><p class="big">${fmt(no.objects)}</p>
          <p class="note">first detected in your window; ${fmt(no.with_2_or_more_detections)} seen at least twice.</p></div>
        <div class="tile"><h3>Quick Set A</h3><p class="big">${fmt(sa.objects)}</p>
          <p class="note">seen at least twice, and not classed as an active galaxy (AGN) or a variable star.</p></div>
      </div>
      <div class="preview">
        <div class="tile"><h3>New objects by class (ALeRCE, beta)</h3><ul class="rows">${byc.map((c) => `<li><span>${esc(c.class)}</span><b>${fmt(c.one + c.two_or_more)}</b><span class="bar"><i style="--w:${(100 * (c.one + c.two_or_more)) / maxNo}%"></i></span></li>`).join('')}</ul>
          <p class="note">${esc(no.classifier || '')}</p></div>
        <div class="tile"><h3>Quick Set A by class</h3><ul class="rows teal">${sac.map((c) => `<li><span>${esc(c.class)}</span><b>${fmt(c.objects)}</b><span class="bar"><i style="--w:${(100 * c.objects) / Math.max(1, sa.objects)}%"></i></span></li>`).join('')}</ul>
          <p class="note">The main run is stricter (Lasair + Sherlock's catalogue filter), so its Set A is much smaller.</p></div>
        <div class="tile"><h3>What kind of alerts (now)</h3>${rows(KINDS, kinds, a.alerts)}${rows(BANDS, kinds, a.alerts)}</div>
      </div>
      ${m.differences ? `<p class="note">${esc(m.differences)}</p>` : ''}`;
    $('result').hidden = false;
  }

  /* ---------- 4. pairs ---------- */
  function setupPairs(ex) {
    const p = ex && ex.pairs;
    if (!p || !Array.isArray(p.pairs) || !Array.isArray(p.object_in_set_a) || !ok(p.set_a_objects)) { $('pairs-out').innerHTML = '<p class="note">No pairs available right now.</p>'; return; }
    const pairs = p.pairs.filter((r) => Array.isArray(r) && r.length >= 4 && ok(r[2]) && ok(r[3]));
    const inA = p.object_in_set_a;
    const draw = () => {
      const x = Number($('px').value), t = Number($('pt').value);
      $('px-out').textContent = `${x.toFixed(1)}″`; $('pt-out').textContent = `${t} d`;
      const kept = pairs.filter((r) => r[2] <= x && r[3] <= t);
      const extra = new Set(); kept.forEach((r) => { [r[0], r[1]].forEach((o) => { if (!inA[o]) extra.add(o); }); });
      const B = p.set_a_objects + extra.size;
      // a small sky sketch: each pair drawn at its real separation; circle = x
      const n = Math.max(1, pairs.length), cell = 92, W = cell * n, H = 128, sc = (cell / 2 - 8) / 10;
      const svg = pairs.map((r, i) => {
        const cx = cell * (i + 0.5), cy = 50, k = r[2] <= x && r[3] <= t, dx = r[2] * sc;
        return `<circle cx="${cx - dx / 2}" cy="${cy}" r="${Math.max(0.5, x * sc)}" fill="rgba(62,230,200,.06)" stroke="rgba(62,230,200,.4)" stroke-dasharray="3 3"/>
          <line x1="${cx - dx / 2}" y1="${cy}" x2="${cx + dx / 2}" y2="${cy}" stroke="${k ? '#3ee6c8' : 'rgba(255,255,255,.18)'}" stroke-width="1.5"/>
          <circle cx="${cx - dx / 2}" cy="${cy}" r="5" fill="#3ee6c8"/>
          <circle cx="${cx + dx / 2}" cy="${cy}" r="5" fill="${k ? '#9b8cff' : 'rgba(155,140,255,.25)'}"/>
          <text x="${cx}" y="${cy + 64}" text-anchor="middle" fill="#8a93a9" font-size="10" font-family="JetBrains Mono, monospace">${r[2].toFixed(1)}″ · ${r[3].toFixed(1)} d</text>`;
      }).join('');
      $('pairs-out').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${pairs.length} pairs, ${kept.length} kept">${svg}</svg>
        <div><p class="big">${fmt(B)}<small>objects in Set B</small></p>
        <p class="note">${fmt(p.set_a_objects)} new objects (Set A, teal) + ${extra.size} neighbour${extra.size === 1 ? '' : 's'} outside Set A (violet) within ${x.toFixed(1)}″ and ${t} days. ${kept.length} of ${pairs.length} pairs kept. ${pairs.length < 10 ? 'Few pairs tonight because LSST sent few alerts; on a full night there are thousands.' : ''} The main run uses 10″ and 100 days.</p></div>`;
    };
    $('px').addEventListener('input', draw); $('pt').addEventListener('input', draw); draw();
  }

  /* ---------- 5. timings and forecast ---------- */
  const STEP = { A: 'Part A · find new objects', B: 'Part B · link in space and time', 'C-lightcurves': 'Part C · light curves', 'C-stamps': 'Part C · full alerts with images', 'C-forced': 'Part C · forced photometry', stream: 'Stream mode · minutes after the exposure' };
  function renderSpeed(tm, latest) {
    const out = $('speed-out');
    if (!tm || !Array.isArray(tm.rows)) { out.innerHTML = '<p class="note">Timings are not available right now.</p>'; }
    else {
      if (tm.full_size) $('speed-sub').textContent = `Each broker can do each part; they differ in speed and limits. ${tm.full_size}.${tm.kind ? ' ' + tm.kind.charAt(0).toUpperCase() + tm.kind.slice(1) + '.' : ''}`;
      const groups = {};
      tm.rows.forEach((r) => { (groups[r.step] = groups[r.step] || []).push(r); });
      const maxLog = Math.log10(1 + Math.max(...tm.rows.map((r) => N(r.seconds) || 0)));
      out.innerHTML = Object.keys(groups).map((g) => {
        // "fastest" only among rows that did the same job (same input), never in stream mode
        const rs = groups[g], cnt = {};
        rs.forEach((r) => { cnt[r.input] = (cnt[r.input] || 0) + 1; });
        const common = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
        const comparable = g === 'stream' ? [] : rs.filter((r) => ok(r.seconds) && r.input === common);
        const best = comparable.length > 1 ? comparable.reduce((a, b) => (b.seconds < a.seconds ? b : a)) : null;
        return `<div class="speed__group"><h3>${esc(STEP[g] || g)}</h3>${rs.map((r) => `
          <div class="speed__row ${r === best ? 'is-best' : ''}"><span class="r">${esc(r.route)}${r === best ? ' <em class="best">fastest</em>' : ''}<small>${esc([r.input, r.output].filter(Boolean).join(' → '))}${r.note ? ' · ' + esc(r.note) : ''}</small></span>
          <span class="track"><i style="--w:${ok(r.seconds) ? Math.max(1.5, (100 * Math.log10(1 + r.seconds)) / maxLog) : 0}%"></i></span>
          <span class="t">${ok(r.seconds) ? dur(r.seconds) : 'not timed'}</span></div>`).join('')}</div>`;
      }).join('') + '<p class="note">Bars on a log scale. One evening, one machine; broker speed varies from day to day.</p>';
    }
    const f = latest && latest.forecast_full_alerts, fb = tm && tm.full_alerts_best;
    let html = '';
    if (f && f.best && ok(f.alerts) && ok(f.best.seconds)) {
      html += `<p><span class="tag tag--f">forecast</span> Downloading the full alerts, with images, for the latest Set B (${fmt(f.alerts)} alerts) would take about <b>${dur(f.best.seconds)}</b> through ${esc(f.best.route)} (from ${esc(f.best.based_on)}). Not downloaded. ${f.note ? esc(f.note.charAt(0).toUpperCase() + f.note.slice(1)) + '.' : ''}</p>`;
    }
    if (fb && ok(fb.alerts) && ok(fb.seconds)) {
      html += `<p><span class="tag tag--m">measured</span> A full-size set: ${fmt(fb.alerts)} alerts in <b>${dur(fb.seconds)}</b> through ${esc(fb.route)} (${esc(fb.measured || '')}; ${esc(fb.how || '')}).</p>`;
    }
    $('forecast').innerHTML = html; $('forecast').hidden = !html;
  }

  /* ---------- explainer height (same origin only) ---------- */
  function fitExplainer() {
    const f = $('explainer');
    const fit = () => { try { const w = f.contentDocument.querySelector('.wrap'); const h = w ? Math.ceil(w.getBoundingClientRect().bottom) + 8 : 0; if (h > 200) f.style.height = h + 'px'; } catch { /* other origin: keep the CSS height */ } };
    f.addEventListener('load', () => { fit(); setTimeout(fit, 600); });
    window.addEventListener('resize', () => setTimeout(fit, 200));
  }

  /* ---------- go ---------- */
  async function main() {
    fitExplainer();
    const isEx = (d) => d && typeof d === 'object' && d.box && d.hourly;
    const [ex, tm, lt] = await Promise.all([
      getJSON('explore.json', isEx),
      getJSON('timings.json', (d) => d && Array.isArray(d.rows)),
      getJSON('latest.json', (d) => d && d.counts),
    ]);
    EX = ex.d;
    renderNow(EX); renderDays(EX);
    if (setupPicker(EX)) $('run').addEventListener('click', runTry);
    setupPairs(EX); renderSpeed(tm.d, lt.d);
    if (EX) {
      const stale = EX.stale && typeof EX.stale === 'object' ? Object.keys(EX.stale) : [];
      $('asof').textContent = `Statistics made by the last main run, ${when(D(EX.generated_utc))}${ex.old ? ` (shown from this browser's copy of ${when(new Date(ex.old))}: the latest file could not be read)` : ''}${stale.length ? `; kept from an earlier run: ${stale.join(', ')}` : ''}.`;
    } else {
      $('asof').textContent = 'The published statistics could not be read right now.';
    }
    if (lt.d && lt.d.counts) $('differ-note').textContent = `Example, the last main run: Set A ${fmt(lt.d.counts.A)} objects from ${fmt(lt.d.counts.A0)} alerts (Lasair + Sherlock). A quick run on the same day finds far more, because it skips the catalogue filter.`;
  }
  main();
})();
