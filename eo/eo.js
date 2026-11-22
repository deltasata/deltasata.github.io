/* EO-Agent live page. Source: eo_page/eo.js (CV project); copied to website/eo/ by build.py site.
 * Live questions: the page POSTs JSON to an ntfy.sh request topic; a worker on the cluster answers on the
 * status topic. Protocol (agreed with the EO side, notes/REQUESTS_to_eo.md):
 *   heartbeat  {type:"heartbeat", ts, queue, claude:bool, local:bool}           every 60 s while the worker is up
 *   request    {action:"parse", id, model, text}  ->  {id, type:"parsed", fields:{kind,lat,lon,event_date,place}}
 *              {action:"ask", id, model, kind, lat, lon, event_date, size_km, text?}
 *   replies    {id, type:"queued", position} | {id, type:"step", step, state:"start"|"done", seconds?, note?}
 *              {id, type:"done", answer, rule, before_period, after_period}  (image = the message's ntfy attachment)
 *              {id, type:"refused"|"failed", reason}
 * No heartbeat for 3 minutes = the server is down: the live box is greyed out and the replays carry the page.
 * ?mock simulates a live worker (tests).
 */
(function () {
  'use strict';
  const NTFY = 'https://ntfy.sh/';
  const REQ = 'eo-live-req-9a22f3caa7', STATUS = 'eo-live-status-9a22f3caa7';
  const MOCK = /[?&]mock\b/.test(location.search);
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const KIND = { flood: 'flood', vegetation_loss: 'wildfire or forest clearing', construction: 'construction' };
  const STEP = {
    start_model: 'Start the model', read: 'Read the question', check_dates: 'Check the dates',
    images_before: 'Images before', images_after: 'Images after', measure: 'Measure', decide: 'Decide',
    radar: 'Radar', figure: 'Figure', reply: 'Reply'
  };
  const fmtS = s => s == null ? '' : (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s';
  const ll = (lat, lon) => `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
  const pct = f => (f * 100).toFixed(f < 0.1 ? 1 : 0) + '%';

  /* ---------------------------------------------------------------- run view (shared) */
  function runView(el, question) {
    el.innerHTML = `<p class="q"></p>
      <div class="run__grid"><ol class="steps"></ol>
        <div><div class="evidence"><div class="wait">The evidence appears here.</div><img alt=""></div>
        <div class="answer"><span class="badge"></span><p></p></div></div></div>
      <div class="progress"><i></i></div>`;
    const v = {
      q: $('.q', el), steps: $('.steps', el), ev: $('.evidence', el), img: $('.evidence img', el),
      ans: $('.answer', el), bar: $('.progress i', el), items: {},
      async type(text, cancelled) {
        if (reduce) { v.q.textContent = text; return; }
        v.q.innerHTML = '<span></span><i class="caret"></i><span style="visibility:hidden"></span>';
        const s = v.q.firstChild, rest = v.q.lastChild;
        for (let i = 1; i <= text.length; i++) { if (cancelled()) return; s.textContent = text.slice(0, i); rest.textContent = text.slice(i); await sleep(18); }
        v.q.textContent = text;
      },
      step(key, label, note, seconds, state) {
        let li = v.items[key];
        if (!li) {
          li = document.createElement('li'); li.className = 'step';
          li.innerHTML = '<i></i><b></b><em></em><small></small>';
          v.steps.appendChild(li); v.items[key] = li;
        }
        if (label) $('b', li).textContent = label;
        if (note != null) $('small', li).textContent = note;
        if (seconds != null) $('em', li).textContent = fmtS(seconds);
        li.className = 'step' + (state === 'on' ? ' is-on' : state === 'done' ? ' is-done' : state === 'bad' ? ' is-done is-bad' : '');
        return li;
      },
      show(src, alt) { v.img.alt = alt || ''; v.img.onload = () => v.ev.classList.add('is-shown'); v.img.src = src; },
      answer(ans, text, sub, hold) {
        const b = $('.badge', v.ans);
        b.textContent = ans === 'cannot_tell' ? 'cannot tell' : ans;
        b.className = 'badge' + (ans === 'cannot_tell' ? ' cannot' : ans === 'no' ? ' no' : '');
        $('p', v.ans).innerHTML = esc(text) + (sub ? `<small>${esc(sub)}</small>` : '');
        if (!hold) v.ans.classList.add('is-shown');
      }
    };
    if (question) v.q.textContent = question;
    return v;
  }

  /* ---------------------------------------------------------------- recorded runs */
  const tidy = s => s ? s.replace(/\s*\((milestones?|B\d)[^)]*\)/g, '').replace(/,? minus/, ', minus') : s;
  function stepsOfRun(r) {
    const a = r.args, res = r.result, tc = r.tool_calls;
    const out = [];
    const when = a.event_date ? `around ${a.event_date}` : `${a.before_start} to ${a.before_end} against ${a.after_start} to ${a.after_end}`;
    out.push(['read', `${KIND[a.kind] || a.kind} · ${ll(a.lat, a.lon)} · ${+a.size_km} km × ${+a.size_km} km · ${when}`, null]);
    out.push(['check_dates', `before ${res.before_period.join(' to ')} · after ${res.after_period.join(' to ')}`, null]);
    const st = tc.filter(c => c.tool === 'cloud_mask_and_stack');
    if (st[0]) out.push(['images_before', `${st[0].images} Sentinel-2 images, ${st[0].clear_images} clear after cloud masking`, st[0].seconds]);
    if (st[1]) out.push(['images_after', `${st[1].images} image${st[1].images === 1 ? '' : 's'}, ${st[1].clear_images} clear`, st[1].seconds]);
    const d = tc.find(c => c.tool === 'detect_change');
    if (d) {
      let note;
      if (d.status !== 'ok') note = 'not enough clear ground to measure';
      else if (a.kind === 'flood') note = `${tidy(res.water_detector) || 'water detector'}: water ${pct(d.water_fraction_before)} of the area before, ${pct(d.water_fraction_after)} after`;
      else note = `${tidy(res.change_detector).replace(/, burnt pixels$/, '') || 'change detector'}: ${pct(d.changed_fraction)} of the area ${a.kind === 'vegetation_loss' ? 'burnt or cleared' : 'changed'}`;
      out.push(['measure', note, d.seconds, d.status === 'ok' ? 'done' : 'bad']);
    }
    out.push(['decide', res.rule, null, res.answer === 'cannot_tell' ? 'bad' : 'done']);
    const radar = (res.steps || []).filter(s => s.startsWith('radar'));
    if (radar.length) out.push(['radar', `Sentinel-1 radar sees through cloud: ${res.n_radar_days_after ? res.n_radar_days_after + ' days' : 'no scene'} in the period after`, null, res.n_radar_days_after ? 'done' : 'bad']);
    const f = tc.find(c => c.tool === 'render_evidence');
    if (f) out.push(['figure', 'before and after, with the detection drawn on the after image', f.seconds]);
    if (r.reply) out.push(['reply', r.reply, null]);
    /* real seconds and states recorded per step (language-model steps included) */
    (r.replay || []).forEach(x => { const o = out.find(y => y[0] === x.step); if (o) { if (x.seconds != null) o[2] = x.seconds; if (x.state) o[3] = x.state; } });
    return out;
  }
  function answerText(r) {
    const res = r.result;
    if (res.answer === 'cannot_tell') return ['Cannot tell: clouds hide the ground after the event, and no radar scene exists.', 'The agent says so instead of guessing.'];
    return [res.answer === 'yes' ? 'Yes.' : 'No.', res.rule];
  }

  async function replays() {
    const box = $('#replay'), tabs = $('#replay-tabs');
    let runs;
    try { runs = await (await fetch('runs/runs.json')).json(); } catch (e) { box.textContent = 'The recorded runs could not be loaded.'; return; }
    const names = { conselice_flood: 'Flood · Italy 2023', jasper_fire: 'Wildfire · Canada 2024', tsmc_construction: 'Construction · Arizona 2020–23', paraguay_cloud: 'Under cloud · Paraguay 2018' };
    let cur = 0, token = 0, visible = true, paused = false;
    runs.forEach((r, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab');
      b.textContent = names[r.id] || r.id;
      b.onclick = () => { cur = i; play(); };
      tabs.appendChild(b);
    });
    if ('IntersectionObserver' in window) new IntersectionObserver(es => { visible = es[0].isIntersecting; }, { threshold: .15 }).observe(box);
    document.addEventListener('visibilitychange', () => { paused = document.hidden; });
    const wait = async (ms, t) => { let left = ms; while (left > 0) { if (t !== token) return false; if (visible && !paused) left -= 100; await sleep(100); } return t === token; };

    function fill(v, r) {
      stepsOfRun(r).forEach(([k, note]) => v.step(k, STEP[k], note, null, ''));
      const [txt, sub] = answerText(r);
      v.answer(r.result.answer, txt, (sub || '') + ` · measured in ${fmtS(r.seconds_total)}`, true);
    }
    function measure() {   /* reserve the height of the tallest run, so the page never jumps */
      box.style.minHeight = '';
      let h = 0;
      runs.forEach(r => { const v = runView(box, r.question); fill(v, r); h = Math.max(h, box.offsetHeight); });
      box.style.minHeight = h + 'px';
    }
    try { await document.fonts.ready; } catch (e) { /* older browsers */ }
    measure();
    let rw = innerWidth;
    addEventListener('resize', () => { if (Math.abs(innerWidth - rw) > 40) { rw = innerWidth; measure(); play(); } });
    async function play() {
      const t = ++token, r = runs[cur];
      [...tabs.children].forEach((b, i) => b.setAttribute('aria-pressed', i === cur));
      const v = runView(box);
      const steps = stepsOfRun(r);
      fill(v, r);
      const total = steps.reduce((s, x) => s + (x[2] || 4), 0);
      let done = 0;
      await v.type(r.question, () => t !== token);
      if (!(await wait(500, t))) return;
      for (const [k, note, sec, state] of steps) {
        v.step(k, null, null, null, 'on');
        const dur = reduce ? 300 : Math.min(3200, Math.max(900, (sec || 4) * 60));
        if (!(await wait(dur, t))) return;
        v.step(k, null, null, sec, state || 'done');
        done += sec || 4; v.bar.style.width = (100 * done / total) + '%';
      }
      v.show(r.image, `Before and after images for: ${r.question}`);
      v.ans.classList.add('is-shown');
      if (!(await wait(9000, t))) return;
      cur = (cur + 1) % runs.length; play();
    }
    play();
  }

  /* ---------------------------------------------------------------- live */
  const live = $('#live'), status = $('#live-status'), statusMsg = $('#live-status-msg');
  const askBtn = $('#ask'), askMsg = $('#ask-msg'), askLabel = $('#ask-label');
  let mode = 'form', up = false, claudeOK = true, busy = false, map, marker, square, parsedFields = null;

  function setUp(isUp, hb) {
    up = isUp;
    live.classList.toggle('is-down', !isUp);
    status.className = 'live__status ' + (isUp ? 'is-up' : 'is-down');
    if (isUp) {
      const q = hb && hb.queue ? ` · ${hb.queue} question${hb.queue === 1 ? '' : 's'} waiting` : '';
      statusMsg.textContent = 'The server is up' + q + '.';
      claudeOK = !hb || hb.claude !== false;
      const c = $('input[name=model][value=claude]');
      c.disabled = !claudeOK; c.closest('.model').classList.toggle('is-off', !claudeOK);
      $('small', c.closest('.model')).textContent = claudeOK ? 'fast to start' : 'not available right now (usage limit reached)';
      if (!claudeOK && c.checked) $('input[name=model][value=local]').checked = true;
    } else {
      statusMsg.innerHTML = 'The server is down right now. See the <a href="#replays">recorded runs</a> below.';
    }
    validate();
  }

  async function heartbeat() {
    if (MOCK) { setUp(true, { queue: 0, claude: true }); return; }
    try {
      const txt = await (await fetch(`${NTFY}${STATUS}/json?poll=1&since=4m`, { cache: 'no-store' })).text();
      let last = null;
      txt.split('\n').forEach(line => {
        if (!line.trim()) return;
        try { const ev = JSON.parse(line); const m = JSON.parse(ev.message || '{}'); if (m.type === 'heartbeat') last = Object.assign({ t: ev.time }, m); } catch (e) { /* not ours */ }
      });
      setUp(!!last && (Date.now() / 1000 - last.t) < 180, last);
    } catch (e) { setUp(false); }
  }

  function validate() {
    let ok = up && !busy, msg = '';
    if (mode === 'form') {
      const lat = parseFloat($('#f-lat').value), lon = parseFloat($('#f-lon').value), d = $('#f-date').value;
      if (!(lat >= -80 && lat <= 80 && lon >= -180 && lon <= 180)) { ok = false; msg = up ? 'Click the map or pick an example.' : ''; }
      else if (!d) { ok = false; msg = up ? 'Choose the date of the event.' : ''; }
      else if (new Date(d) > new Date()) { ok = false; msg = 'The date is in the future.'; }
      else if (d < '2017-04-01') { ok = false; msg = 'Sentinel-2 images in this form start in 2017.'; }
      askLabel.textContent = 'Ask';
    } else {
      const t = $('#f-text').value.trim();
      if (t.length < 8) { ok = false; msg = ''; }
      askLabel.textContent = parsedFields ? 'Yes, run it' : 'Read my question';
    }
    askBtn.disabled = !ok;
    if (!busy) askMsg.textContent = msg;
  }

  function setPoint(lat, lon, fly) {
    $('#f-lat').value = lat.toFixed(4); $('#f-lon').value = lon.toFixed(4);
    if (map && window.L) {
      const dLat = 2.5 / 111.32, dLon = 2.5 / (111.32 * Math.cos(lat * Math.PI / 180));
      const b = [[lat - dLat, lon - dLon], [lat + dLat, lon + dLon]];
      if (!square) square = L.rectangle(b, { color: '#3ee6c8', weight: 2, fillOpacity: .12 }).addTo(map); else square.setBounds(b);
      if (fly) map.flyToBounds(b, { padding: [60, 60], duration: reduce ? 0 : 1.2 });
    }
    validate();
  }

  function initMap() {
    if (!window.L) { $('#map').innerHTML = '<p class="hint" style="padding:14px">The map could not load; type the latitude and longitude instead.</p>'; return; }
    map = L.map('map', { worldCopyJump: true, scrollWheelZoom: false }).setView([30, 10], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    map.on('click', e => setPoint(e.latlng.lat, ((e.latlng.lng + 540) % 360) - 180, false));
  }

  function wireForm() {
    const ex = [
      { name: 'Flood · Conselice 2023', kind: 'flood', lat: 44.5063, lon: 11.8276, date: '2023-05-23' },
      { name: 'Wildfire · Jasper 2024', kind: 'vegetation_loss', lat: 52.8730, lon: -118.0800, date: '2024-07-24' },
      { name: 'Flood under cloud · Paraguay 2018', kind: 'flood', lat: -24.8596, lon: -56.9633, date: '2018-10-31' }
    ];
    const box = $('#examples');
    ex.forEach(e => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = e.name;
      b.onclick = () => { $('#f-kind').value = e.kind; $('#f-date').value = e.date; setPoint(e.lat, e.lon, true); [...box.children].forEach(x => x.setAttribute('aria-pressed', x === b)); };
      box.appendChild(b);
    });
    $('#f-date').max = new Date().toISOString().slice(0, 10);
    ['#f-lat', '#f-lon'].forEach(s => $(s).addEventListener('change', () => { const a = parseFloat($('#f-lat').value), o = parseFloat($('#f-lon').value); if (isFinite(a) && isFinite(o)) setPoint(a, o, true); }));
    ['#f-date', '#f-kind'].forEach(s => $(s).addEventListener('input', validate));
    $('#f-text').addEventListener('input', () => { parsedFields = null; $('#parsed').hidden = true; validate(); });
    document.querySelectorAll('.modes button').forEach(b => b.onclick = () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.modes button').forEach(x => x.setAttribute('aria-selected', x === b));
      $('#mode-form').hidden = mode !== 'form'; $('#mode-text').hidden = mode !== 'text';
      if (mode === 'form' && map) map.invalidateSize();
      validate();
    });
    askBtn.onclick = onAsk;
  }

  /* transport */
  function listen(id, onMsg) {
    if (MOCK) return { close() {} };
    const es = new EventSource(`${NTFY}${STATUS}/sse?since=${Math.floor(Date.now() / 1000) - 5}`);
    es.onmessage = ev => {
      try {
        const e = JSON.parse(ev.data); const m = JSON.parse(e.message || '{}');
        if (m.id === id) onMsg(m, e.attachment && e.attachment.url);
      } catch (err) { /* ignore other messages */ }
    };
    return es;
  }
  async function send(body) {
    if (MOCK) return mockWorker(body);
    const r = await fetch(NTFY + REQ, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) throw new Error('request not accepted (' + r.status + ')');
  }
  const newId = () => Math.random().toString(36).slice(2, 10);
  const model = () => $('input[name=model]:checked').value;

  async function onAsk() {
    if (mode === 'text' && !parsedFields) return parseText();
    const f = mode === 'form'
      ? { kind: $('#f-kind').value, lat: +$('#f-lat').value, lon: +$('#f-lon').value, event_date: $('#f-date').value, text: null }
      : Object.assign({ text: $('#f-text').value.trim() }, parsedFields);
    const question = f.text || `Was there ${f.kind === 'flood' ? 'flooding' : f.kind === 'construction' ? 'construction' : 'a wildfire or forest clearing'} in the 5 km × 5 km area around ${ll(f.lat, f.lon)}, around ${f.event_date}?`;
    const id = newId();
    busy = true; validate(); askMsg.textContent = 'Sending…';
    const box = $('#live-run'); box.hidden = false;
    const v = runView(box, question);
    let lastKey = null, finished = false;
    const timer = setTimeout(() => { if (!finished) { finish(); askMsg.textContent = 'No answer after 8 minutes. The server may be busy; please try again later.'; } }, 8 * 60 * 1000);
    const handle = (m, att) => {
      if (m.type === 'queued') askMsg.textContent = m.position ? `In the queue: ${m.position} ahead of you.` : 'Running…';
      else if (m.type === 'step') {
        askMsg.textContent = 'Running…';
        if (m.state === 'start' && lastKey && lastKey !== m.step) v.step(lastKey, null, null, null, 'done');
        v.step(m.step, STEP[m.step] || m.step, m.note == null ? (m.step === 'start_model' && m.state === 'start' ? 'starting the open model on our GPU, about 4 to 5 minutes' : null) : m.note, m.seconds, m.state === 'start' ? 'on' : (m.state === 'bad' ? 'bad' : 'done'));
        lastKey = m.step;
      } else if (m.type === 'done') {
        if (lastKey) v.step(lastKey, null, null, null, 'done');
        if (att) v.show(att, 'Before and after images for your question');
        v.answer(m.answer, m.answer === 'cannot_tell' ? 'Cannot tell.' : (m.answer === 'yes' ? 'Yes.' : 'No.'), m.rule || m.reason || '');
        v.bar.style.width = '100%'; finish(); askMsg.textContent = 'Done.';
      } else if (m.type === 'refused' || m.type === 'failed') {
        finish(); askMsg.textContent = (m.type === 'refused' ? 'Not run: ' : 'Something went wrong: ') + (m.reason || '');
      }
    };
    const es = listen(id, handle);
    function finish() { finished = true; clearTimeout(timer); es.close(); busy = false; parsedFields = null; $('#parsed').hidden = true; validate(); }
    try {
      await send(Object.assign({ action: 'ask', id, model: model(), size_km: 5 }, f), handle);
      if (MOCK) mockRun(id, handle);
      else askMsg.textContent = 'Sent. Waiting for the server…';
    } catch (e) { finish(); askMsg.textContent = 'Could not send the question: ' + e.message; }
  }

  async function parseText() {
    const id = newId(), text = $('#f-text').value.trim();
    busy = true; validate(); askMsg.textContent = 'Reading your question…';
    let done = false;
    const handle = m => {
      if (done) return;
      if (m.type === 'parsed') {
        done = true; es.close(); parsedFields = m.fields; busy = false;
        const p = $('#parsed'); p.hidden = false;
        p.innerHTML = `Understood as:<dl><dt>Event</dt><dd>${esc(KIND[m.fields.kind] || m.fields.kind)}</dd><dt>Place</dt><dd>${esc(m.fields.place || '')} (${ll(m.fields.lat, m.fields.lon)}), 5 km × 5 km</dd><dt>Date</dt><dd>${esc(m.fields.event_date)}</dd></dl>`;
        askMsg.textContent = 'Is this right? Edit the question to change it.';
        validate();
      } else if (m.type === 'refused' || m.type === 'failed') {
        done = true; es.close(); busy = false; validate(); askMsg.textContent = 'Not run: ' + (m.reason || '');
      }
    };
    const es = listen(id, handle);
    setTimeout(() => { if (!done) { done = true; es.close(); busy = false; validate(); askMsg.textContent = 'No reply in 3 minutes. Please try again later.'; } }, 180000);
    try { await send({ action: 'parse', id, model: model(), text }); if (MOCK) setTimeout(() => handle({ id, type: 'parsed', fields: { kind: 'flood', lat: 44.5063, lon: 11.8276, event_date: '2023-05-23', place: 'Conselice, Italy' } }), 1500); }
    catch (e) { done = true; es.close(); busy = false; validate(); askMsg.textContent = 'Could not send the question: ' + e.message; }
  }

  /* mock worker: replays the Conselice run through the live code path (tests only) */
  function mockWorker() { return Promise.resolve(); }
  async function mockRun(id, handle) {
    const seq = [['queued', { position: 0 }], ['read', 'flood · 44.5063° N, 11.8276° E', 1.8], ['check_dates', 'before 2023-03-24 to 2023-05-13 · after 2023-05-20 to 2023-05-26', 0.1],
      ['images_before', '11 images, 4 clear', 42.1], ['images_after', '1 image, 1 clear', 4.0], ['measure', 'water 0.1% before, 19.6% after', 3.3],
      ['decide', 'new water = 0.1956 - 0.0006 = 0.1950, which is at least the threshold 0.05', 0], ['figure', '', 9.3], ['reply', '', 2.2]];
    for (const [k, note, s] of seq) {
      await sleep(700);
      if (k === 'queued') { handle(Object.assign({ id, type: 'queued' }, note)); continue; }
      handle({ id, type: 'step', step: k, state: 'start', note });
      await sleep(700);
      handle({ id, type: 'step', step: k, state: 'done', seconds: s });
    }
    handle({ id, type: 'done', answer: 'yes', rule: 'new water = 0.1956 - 0.0006 = 0.1950, which is at least the threshold 0.05' }, 'runs/conselice_flood.jpg');
  }

  /* ---------------------------------------------------------------- videos: play only while visible */
  function videos() {
    document.querySelectorAll('video').forEach(vd => {
      if (reduce) { vd.removeAttribute('autoplay'); vd.pause(); vd.controls = true; return; }
      if (!('IntersectionObserver' in window)) return;
      new IntersectionObserver(es => { es[0].isIntersecting ? vd.play().catch(() => {}) : vd.pause(); }, { threshold: .35 }).observe(vd);
    });
  }

  function start() {
    wireForm(); initMap(); heartbeat(); setInterval(heartbeat, 60000);
    replays(); videos();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
