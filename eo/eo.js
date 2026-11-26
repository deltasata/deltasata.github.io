/* EO-Agent live page. Source: eo_page/eo.js (CV project); copied to website/eo/ by build.py site.
 * Live questions over Ably (free plan; request 14 in notes/REQUESTS_to_eo.md): the page publishes on
 * "eo-live-req" (message name = action, data = the object) and listens on "eo-live-status".
 * The page key below is public by design: it may only publish requests and read replies.
 * Every visitor uses the same clientId "visitor" (the app needs one; one id keeps the monthly user count at 1).
 *   server up  = the worker ("eo-worker") is in the presence set of eo-live-status, data {queue, claude, local, model}
 *   request    {action:"parse", id, model, text}  ->  {id, type:"parsed", fields:{kind,lat,lon,event_date,place}}
 *              {action:"ask", id, model, kind, lat, lon, event_date, size_km, text?, before?:[s,e], after?:[s,e]}
 *              (construction: two periods, June to August of the two years, so seasons do not count as change)
 *   replies    {id, type:"queued", position} | {id, type:"step", step, state:"start"|"done", seconds?, note?}
 *              {id, type:"done", answer, rule, before_period, after_period, figure_parts?}
 *              {id, type:"figure", part, parts, mime, b64}  (the figure in parts, sent before "done")
 *              {id, type:"refused"|"failed"|"error", reason}
 *              {id, type:"progress", position?, steps:[{step, state, seconds?, note?}, ...]}   all steps so far, sent a few times per run
 *              "done" may carry the same full steps list; the page shows only what changed, new steps one by one
 * Worker not in presence (or no connection to Ably) = the server is down: the live box is greyed out and the replays carry the page.
 * The connection closes while the tab is hidden for 3 minutes (free plan: 200 connections at once) and reopens when it is shown.
 * A run in progress survives a reload: its id and question are kept in sessionStorage and the replies so far
 * are read back from the channel history (Ably keeps it about 2 minutes).
 * ?mock simulates a live worker (tests); the page then says so.
 */
(function () {
  'use strict';
  const ABLY_KEY = 'xlh-2A.-16yqw:XOIZkfkwuzgduUQ8hdR3QHMCThrEnKws0MrWpf5vCAE';
  const CH_REQ = 'eo-live-req', CH_STATUS = 'eo-live-status', WORKER = 'eo-worker';
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
        <div><div class="evidence"><div class="wait">The evidence appears here.</div><a class="zoom" target="_blank" rel="noopener" tabindex="-1"><img alt=""></a></div>
        <div class="answer"><span class="badge"></span><p></p></div></div></div>
      <div class="progress"><i></i></div>`;
    const v = {
      q: $('.q', el), steps: $('.steps', el), ev: $('.evidence', el), img: $('.evidence img', el),
      ans: $('.answer', el), bar: $('.progress i', el), zoom: $('.zoom', el), items: {},
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
      show(src, alt) {
        v.img.alt = alt || ''; v.img.onload = () => v.ev.classList.add('is-shown'); v.img.src = src;
        v.zoom.href = src; v.zoom.removeAttribute('tabindex'); v.zoom.title = 'Open the full-size image';
        v.zoom.setAttribute('aria-label', 'Open the full-size image');
      },
      wait(text) { $('.wait', v.ev).textContent = text; },
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
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'replay');
      b.id = 'replay-tab-' + i; b.textContent = names[r.id] || r.id;
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
      [...tabs.children].forEach((b, i) => b.setAttribute('aria-selected', i === cur));
      box.setAttribute('aria-labelledby', 'replay-tab-' + cur);
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
  let mode = 'text', marked = null, up = false, claudeOK = true, busy = false, map, square, parsedFields = null, parsedWithPoint = false;
  const narrow = () => matchMedia('(max-width: 760px)').matches;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const fmtDay = d => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const todayISO = () => new Date().toISOString().slice(0, 10);
  /* the server's rule: floods from the event day + 5 days, fires from the last day of the fire + 9 days */
  const readyFrom = (day, kind) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (kind === 'flood' ? 5 : 9)); return d; };

  /* the message about a finished, failed or refused run stays until the visitor changes something;
     server status updates never erase it */
  let held = '';
  const say = t => { held = ''; askMsg.textContent = t; };
  const hold = t => { held = t; askMsg.textContent = t; };
  const touched = () => { if (held) { held = ''; validate(); } };

  function setUp(isUp, hb, why) {
    up = isUp;
    live.classList.toggle('is-down', !isUp && !busy);   /* a run in progress is never greyed out: it goes on at the server */
    status.className = 'live__status ' + (isUp ? 'is-up' : why === 'net' ? 'is-net' : 'is-down');
    const c = $('input[name=model][value=claude]'), l = $('input[name=model][value=local]');
    if (isUp) {
      const q = hb && hb.queue ? ` · ${hb.queue} question${hb.queue === 1 ? '' : 's'} waiting` : '';
      statusMsg.textContent = 'The server is up' + q + '.';
      claudeOK = !hb || hb.claude !== false;
      c.disabled = !claudeOK; c.closest('.model').classList.toggle('is-off', !claudeOK);
      $('small', c.closest('.model')).textContent = claudeOK ? 'fast to start' : 'not available right now; try the open model';
      const localOK = !hb || (hb.local !== false && hb.model !== null);
      l.disabled = !localOK; l.closest('.model').classList.toggle('is-off', !localOK);
      const name = hb && typeof hb.model === 'string' && hb.model ? hb.model.slice(0, 40) : 'Qwen3-8B';
      $('small', l.closest('.model')).textContent = localOK ? `${name}, ready now` : 'not available right now';
      if (!claudeOK && c.checked && localOK) l.checked = true;
      if (!localOK && l.checked && claudeOK) c.checked = true;
    } else {
      if (why === 'net') statusMsg.textContent = busy
        ? 'This page lost its connection. Your question keeps running at the server; the answer appears here when the connection is back.'
        : 'This page cannot reach the server right now (check your connection); trying again…';
      else statusMsg.innerHTML = 'The server is down right now. See the <a href="#replays">recorded runs</a> below.';
      [c, l].forEach(x => { $('small', x.closest('.model')).textContent = 'waiting for the server'; });
    }
    validate();
  }

  /* Server state = the worker's presence on the status channel (Ably drops it ~15 s after the worker's
     connection ends). The first check keeps "Checking…" until there is a verdict (no red flash on load);
     a short network blip on the visitor's side does not grey the page out at once, and a lost connection
     on the visitor's side is reported as such, not as "the server is down". */
  let rt = null, stCh = null, reqCh = null, worker = null, hideTimer = null, blipTimer = null, decided = false;
  const listeners = {};
  const asObj = d => { if (typeof d === 'string') { try { return JSON.parse(d); } catch (e) { return null; } } return d; };
  const quiet = p => { if (p && typeof p.catch === 'function') p.catch(() => {}); return p; };
  function judge() {
    const st = rt ? rt.connection.state : 'none';
    if (st === 'connected' && worker) { clearTimeout(blipTimer); blipTimer = null; decided = true; setUp(true, worker); return; }
    if (st === 'connected') { decided = true; setUp(false); return; }
    if (!decided && (st === 'initialized' || st === 'connecting')) return;
    if (up && (st === 'connecting' || st === 'disconnected')) {
      if (!blipTimer) blipTimer = setTimeout(() => { blipTimer = null; if (!(rt && rt.connection.state === 'connected' && worker)) { up = false; judge(); } }, 20000);
      return;
    }
    decided = true;
    setUp(false, null, (st === 'connecting' || st === 'disconnected' || st === 'suspended' || navigator.onLine === false) ? 'net' : '');
  }
  async function readPresence() {
    try {
      const members = await stCh.presence.get();
      const w = members.find(p => p.clientId === WORKER);
      worker = w ? (asObj(w.data) || {}) : null;
    } catch (e) { worker = null; }
    judge();
  }
  function connect() {
    if (MOCK) {
      setUp(true, { queue: 0, claude: true });
      statusMsg.textContent = 'Test mode: a simulated server. Every question gets the same recorded run; nothing is measured.';
      return;
    }
    const lib = window.AblyPubSub; if (!lib || !lib.createClient) { decided = true; setUp(false); return; }
    if (rt) { if (rt.connection.state !== 'connected') rt.connection.connect(); return; }
    rt = lib.createClient({ key: ABLY_KEY, clientId: 'visitor', echoMessages: false, logLevel: 0 });
    setTimeout(() => { if (!decided) { decided = true; setUp(false, null, 'net'); } }, 15000);
    stCh = rt.channels.get(CH_STATUS); reqCh = rt.channels.get(CH_REQ);
    rt.connection.on(ch => { if (ch.current === 'connected') readPresence(); else { if (ch.current !== 'connecting' && ch.current !== 'disconnected') worker = null; judge(); } });
    quiet(stCh.presence.subscribe(p => {
      if (p.clientId !== WORKER) return;
      worker = (p.action === 'leave' || p.action === 'absent') ? null : (asObj(p.data) || {});
      judge();
    }));
    quiet(stCh.subscribe(msg => {
      const m = asObj(msg.data);
      if (m && m.id && listeners[m.id]) listeners[m.id](m);
    }));
    resume();
  }
  /* free plan: at most 200 open connections, so a tab hidden for 3 minutes lets its connection go (never during a run) */
  document.addEventListener('visibilitychange', () => {
    if (MOCK || !rt) return;
    clearTimeout(hideTimer);
    if (document.hidden) hideTimer = setTimeout(() => { if (!busy && document.hidden) { quiet(rt.connection.close()); worker = null; setUp(false, null, 'net'); } }, 3 * 60000);
    else connect();
  });

  /* nothing can change while a question is read or run (a reading must belong to the question it answers) */
  function lockInputs(b) {
    $('#f-text').readOnly = b;
    document.querySelectorAll('#text-examples button, #examples button, .modes button, #clear-point, #f-kind, #f-date, #f-lat, #f-lon, #f-y0, #f-y1')
      .forEach(x => { x.disabled = b; });
  }

  function validate() {
    let ok = up && !busy, msg = '';
    lockInputs(busy);
    if (mode === 'form') {
      const latS = $('#f-lat').value, lonS = $('#f-lon').value, lat = parseFloat(latS), lon = parseFloat(lonS), d = $('#f-date').value;
      const kind = $('#f-kind').value, cons = kind === 'construction';
      $('#years').hidden = !cons; $('#lbl-date').hidden = cons; $('#veg-hint').hidden = kind !== 'vegetation_loss';
      if (latS === '' || lonS === '' || !isFinite(lat) || !isFinite(lon)) { ok = false; msg = up ? 'Click the map or pick an example.' : ''; }
      else if (!(lat >= -80 && lat <= 80)) { ok = false; msg = 'The latitude must be between -80 and 80 (80° S to 80° N).'; }
      else if (!(lon >= -180 && lon <= 180)) { ok = false; msg = 'The longitude must be between -180 and 180.'; }
      else if (cons && !(+$('#f-y0').value < +$('#f-y1').value)) { ok = false; msg = 'The "before" year must come before the "after" year.'; }
      else if (!cons && !d) { ok = false; msg = up ? 'Choose the date of the event.' : ''; }
      else if (!cons && d > todayISO()) { ok = false; msg = 'The date is in the future.'; }
      else if (!cons && d < '2017-04-01') { ok = false; msg = 'Sentinel-2 images in this form start in 2017.'; }
      else if (!cons && readyFrom(d, kind).toISOString().slice(0, 10) > todayISO()) {
        ok = false; msg = `This is too recent: the satellite images after the event are not all taken yet. Please ask again from ${fmtDay(readyFrom(d, kind))}.`;
      }
      askLabel.textContent = 'Ask';
    } else {
      const t = $('#f-text').value.trim();
      if (!t) ok = false;
      else if (t.length < 8) { ok = false; msg = 'Please write the whole question: the place, the event and the date.'; }
      else if (/\bhere\b/i.test(t) && !marked && !parsedFields) { ok = false; msg = 'Mark the place on the map first (click it), then ask.'; }
      else if (t.length >= 300) msg = 'The question has reached the limit of 300 characters.';
      askLabel.textContent = parsedFields ? 'Yes, run it' : 'Read my question';
    }
    const chosen = $('input[name=model]:checked');
    if (up && (!chosen || chosen.disabled)) { ok = false; msg = 'No language model is free right now. Please try again later.'; }
    askBtn.disabled = !ok;
    if (!busy && !(mode === 'text' && parsedFields)) askMsg.textContent = held || msg;
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

  /* text mode: a point the visitor marked on the map; sent with the question so "here" works.
     Clicking the map after a reading moves the place of that reading (to fix a wrong position). */
  function markPoint(lat, lon) {
    if (busy) return;
    if (Math.abs(lat) > 80) { hold('Points beyond 80° N or 80° S cannot be used; please mark a point closer to the equator.'); return; }
    touched();
    marked = { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
    setPoint(marked.lat, marked.lon, false);
    $('#marked').hidden = false; $('#marked-at').textContent = ll(marked.lat, marked.lon);
    if (parsedFields) { parsedFields = Object.assign({}, parsedFields, { lat: marked.lat, lon: marked.lon, place: `the marked point (${marked.lat}, ${marked.lon})` }); parsedWithPoint = true; showParsed(parsedFields); }
  }
  function clearPoint() {
    marked = null; $('#marked').hidden = true;
    if (square && map) { map.removeLayer(square); square = null; }
    /* a reading made with the point no longer holds; a reading of a named place keeps its square */
    if (parsedFields && parsedWithPoint) { parsedFields = null; $('#parsed').hidden = true; }
    else if (parsedFields) setPoint(+parsedFields.lat, +parsedFields.lon, false);
    touched(); validate();
  }
  function showParsed(f) {
    const p = $('#parsed'); p.hidden = false;
    const span = Array.isArray(f.event_span) && f.event_span.length === 2 && f.event_span[0] !== f.event_span[1] ? f.event_span : null;
    const when = f.before && f.after ? `<dt>Periods</dt><dd>${esc(f.before.join(' to '))} against ${esc(f.after.join(' to '))}</dd>`
      : span ? `<dt>Dates</dt><dd>${esc(span[0])} to ${esc(span[1])}</dd>` : `<dt>Date</dt><dd>${esc(f.event_date)}</dd>`;
    const notes = Array.isArray(f.notes) && f.notes.length ? `<dt>Note</dt><dd>${f.notes.map(esc).join('<br>')}</dd>` : '';
    p.innerHTML = `Understood as:<dl><dt>Event</dt><dd>${esc(KIND[f.kind] || f.kind)}</dd><dt>Place</dt><dd>${esc((f.place || '').replace(/\s*\(-?[\d.]+,\s*-?[\d.]+\)/, ''))} (${ll(f.lat, f.lon)}), 5 km × 5 km, shown on the map</dd>${when}${notes}</dl>`;
  }

  function initMap() {
    if (!window.L) { $('#map').innerHTML = '<p class="hint" style="padding:14px">The map could not load; type the latitude and longitude instead.</p>'; return; }
    map = L.map('map', { worldCopyJump: true, scrollWheelZoom: false }).setView([30, 10], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    const pick = (lat, lon) => {
      if (busy) return;
      lon = ((lon + 540) % 360) - 180;
      if (mode === 'text') markPoint(lat, lon); else { touched(); setPoint(lat, lon, false); }
    };
    map.on('click', e => pick(e.latlng.lat, e.latlng.lng));
    /* keyboard: the arrow keys move the map (Leaflet), Enter or Space marks its centre */
    map.getContainer().addEventListener('keydown', e => {
      if (e.target !== map.getContainer() || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault(); const c = map.getCenter(); pick(c.lat, c.lng);
    });
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
      b.onclick = () => { touched(); $('#f-kind').value = e.kind; $('#f-date').value = e.date; setPoint(e.lat, e.lon, true); [...box.children].forEach(x => x.setAttribute('aria-pressed', x === b)); };
      box.appendChild(b);
    });
    /* floods need the day (the server refuses a bare month: water shows for only a few days) */
    const tq = [
      'Was there flooding around Conselice, Italy, on 17 May 2023?',
      'Was there a wildfire near Jasper, Canada, in July 2024?',
      'Was there flooding here on 17 May 2023?'
    ];
    tq.forEach(q => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = /\bhere\b/.test(q) ? 'Mark a point, then: "…flooding here on 17 May 2023?"' : q.replace(/^Was there /, '').replace(/\?$/, '');
      b.onclick = () => { $('#f-text').value = q; $('#f-text').dispatchEvent(new Event('input')); $('#f-text').focus(); };
      $('#text-examples').appendChild(b);
    });
    $('#clear-point').onclick = () => { clearPoint(); };
    $('#f-date').max = todayISO();
    /* construction: whole summers (June to August) of two years; the last year only once its summer is over */
    const now = new Date(), lastY = now.getUTCFullYear() - (now.getUTCMonth() < 8 ? 1 : 0);
    const yopts = []; for (let y = 2017; y <= lastY; y++) yopts.push(`<option value="${y}">${y}</option>`);
    $('#f-y0').innerHTML = yopts.join(''); $('#f-y1').innerHTML = yopts.join('');
    $('#f-y0').value = String(Math.max(2017, lastY - 3)); $('#f-y1').value = String(lastY);
    ['#f-y0', '#f-y1', '#f-date', '#f-kind'].forEach(s => $(s).addEventListener('input', () => { touched(); validate(); }));
    ['#f-lat', '#f-lon'].forEach(s => {
      $(s).addEventListener('input', () => { touched(); validate(); });
      $(s).addEventListener('change', () => { const a = parseFloat($('#f-lat').value), o = parseFloat($('#f-lon').value); if (isFinite(a) && isFinite(o) && Math.abs(a) <= 80 && Math.abs(o) <= 180) setPoint(a, o, true); else validate(); });
    });
    $('#f-text').addEventListener('input', () => { parsedFields = null; $('#parsed').hidden = true; touched(); validate(); });
    /* Enter sends (as the button would), Shift+Enter starts a new line */
    $('#f-text').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!askBtn.disabled) onAsk(); }
    });
    document.querySelectorAll('.modes button').forEach(b => b.onclick = () => {
      mode = b.dataset.mode;
      document.querySelectorAll('.modes button').forEach(x => x.setAttribute('aria-selected', x === b));
      $('#mode-form').hidden = mode !== 'form'; $('#mode-text').hidden = mode !== 'text';
      parsedFields = null; $('#parsed').hidden = true;
      if (map) map.invalidateSize();
      touched(); validate();
    });
    askBtn.onclick = onAsk;
  }

  /* transport */
  /* replies for one request id; the figure comes in parts before "done" and is joined into an image */
  function listen(id, onMsg) {
    if (MOCK) return { close() {} };
    const parts = {}; let url = null;
    const figure = n => {
      const have = Object.keys(parts).length;
      if (!n || have < n) return null;
      if (url) return url;
      try {
        const bin = atob(Array.from({ length: n }, (_, i) => parts[i + 1].b64).join(''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        url = URL.createObjectURL(new Blob([bytes], { type: parts[1].mime || 'image/jpeg' }));
        return url;
      } catch (e) { return null; }
    };
    listeners[id] = m => {
      if (m.type === 'figure') { if (m.part >= 1) parts[m.part] = m; return; }
      if (m.type === 'done' && m.figure_parts) {
        /* parts are sent first; allow a moment for a late one, then answer without the figure */
        let tries = 0;
        const go = () => { const f = figure(m.figure_parts); if (f || tries++ >= 6) onMsg(m, f); else setTimeout(go, 500); };
        return go();
      }
      onMsg(m, null);
    };
    return { close() { delete listeners[id]; } };
  }
  async function send(body) {
    if (MOCK) return mockWorker(body);
    if (!rt) throw new Error('no connection to the server');
    await reqCh.publish(body.action, body);
  }
  const newId = () => Math.random().toString(36).slice(2, 10);
  const model = () => $('input[name=model]:checked').value;

  /* a run in progress, kept for a reload (this tab only) */
  const PENDING = 'eo-live-pending';
  const pending = {
    get() { try { return JSON.parse(sessionStorage.getItem(PENDING) || 'null'); } catch (e) { return null; } },
    set(x) { try { if (x) sessionStorage.setItem(PENDING, JSON.stringify(x)); else sessionStorage.removeItem(PENDING); } catch (e) { /* storage blocked */ } }
  };

  function formFields() {
    const k = $('#f-kind').value, f = { kind: k, lat: +$('#f-lat').value, lon: +$('#f-lon').value, text: null };
    if (k === 'construction') { const y0 = $('#f-y0').value, y1 = $('#f-y1').value; f.before = [`${y0}-06-01`, `${y0}-08-31`]; f.after = [`${y1}-06-01`, `${y1}-08-31`]; f.event_date = f.after[0]; }
    else f.event_date = $('#f-date').value;
    return f;
  }

  /* the run card for one request id: steps, figure, answer; used for a new run and after a reload */
  function follow(id, question, t0) {
    busy = true; validate();
    const box = $('#live-run'); box.hidden = false;
    const v = runView(box, question);
    let lastKey = null, finished = false;
    const seen = {}; let reveal = Promise.resolve();
    const oneStep = m => {
      if (m.state === 'start' && lastKey && lastKey !== m.step) v.step(lastKey, null, null, null, 'done');
      let note = m.note == null ? (m.step === 'start_model' && m.state === 'start' ? 'starting the open model on our GPU, about 4 to 5 minutes' : null) : m.note;
      if (m.step === 'reply' && note) note = 'written out next to the answer';   /* the reply is shown once, with the badge */
      v.step(m.step, STEP[m.step] || m.step, note, m.seconds, m.state === 'start' ? 'on' : (m.state === 'bad' ? 'bad' : 'done'));
      lastKey = m.step;
    };
    /* a compact message lists every step so far: show only what changed, new steps one after another */
    const steps = list => {
      const todo = (list || []).filter(x => x && x.step && seen[x.step] !== JSON.stringify(x));
      todo.forEach(x => { seen[x.step] = JSON.stringify(x); });
      reveal = reveal.then(async () => { for (let i = 0; i < todo.length; i++) { if (i) await sleep(reduce ? 0 : 280); oneStep(todo[i]); } });
      return reveal;
    };
    const es = listen(id, (m, att) => handle(m, att));
    const timer = setTimeout(() => fail('No answer after 8 minutes. The server may be busy; please try again later.'), Math.max(0, t0 + 8 * 60000 - Date.now()));
    function finish() {
      finished = true; clearTimeout(timer); es.close(); pending.set(null);
      busy = false; parsedFields = null; $('#parsed').hidden = true;
      live.classList.toggle('is-down', !up); validate();
    }
    function fail(text) {
      if (finished) return;
      if (lastKey) v.step(lastKey, null, null, null, 'bad');   /* no spinner left turning */
      v.wait('No evidence: this question was not answered.');
      finish(); hold(text);
    }
    function handle(m, att) {
      if (finished) return;
      if (m.type === 'queued') say(m.position ? `In the queue: ${m.position} ahead of you.` : 'Running…');
      else if (m.type === 'progress') {
        say(m.position ? `In the queue: ${m.position} ahead of you.` : 'Running…');
        steps(m.steps);
      } else if (m.type === 'step') {
        say('Running…');
        oneStep(m);
      } else if (m.type === 'done') {
        if (m.steps) { steps(m.steps).then(() => handle(Object.assign({}, m, { steps: null }), att)); return; }
        if (lastKey) v.step(lastKey, null, null, null, 'done');
        if (att) v.show(att, 'Before and after images for your question'); else v.wait('No figure came with this answer.');
        v.answer(m.answer, m.reply || (m.answer === 'cannot_tell' ? 'Cannot tell.' : (m.answer === 'yes' ? 'Yes.' : 'No.')), m.reply ? '' : (m.rule || m.reason || ''));
        v.bar.style.width = '100%'; finish();
        hold(`Done. The answer is ${m.answer === 'cannot_tell' ? '"cannot tell"' : m.answer === 'yes' ? 'yes' : 'no'}.`);
      } else if (m.type === 'refused' || m.type === 'failed' || m.type === 'error') {
        const r = (m.reason || '').trim();
        fail(m.type === 'refused' ? 'Not run: ' + r : /^something went wrong/i.test(r) ? r : 'Something went wrong: ' + (r || 'please try again.'));
      }
    }
    return { handle, fail, isFinished: () => finished };
  }

  async function onAsk() {
    if (mode === 'text' && !parsedFields) return parseText();
    touched();
    const f = mode === 'form'
      ? formFields()
      : Object.assign({ text: $('#f-text').value.trim() }, parsedFields);
    const question = f.text || `Was there ${f.kind === 'flood' ? 'flooding' : f.kind === 'construction' ? 'construction' : 'a wildfire or forest clearing'} in the 5 km × 5 km area around ${ll(f.lat, f.lon)}, ${f.before ? `between summer ${f.before[0].slice(0, 4)} and summer ${f.after[0].slice(0, 4)}` : `around ${f.event_date}`}?`;
    const id = newId(), t0 = Date.now();
    const run = follow(id, question, t0);
    say('Sending…');
    try {
      await send(Object.assign({ action: 'ask', id, model: model(), size_km: 5 }, f));
      if (MOCK) return mockRun(id, run.handle);
      pending.set({ id, question, t0 });
      if (!run.isFinished() && askMsg.textContent === 'Sending…') say('Sent. Waiting for the server…');
    } catch (e) { run.fail('Could not send the question: ' + e.message); }
  }

  /* after a reload during a run: follow the same run, with the replies so far from the channel history */
  async function resume() {
    const p = pending.get();
    if (!p || !p.id || !p.t0 || Date.now() - p.t0 > 8 * 60000) { pending.set(null); return; }
    const run = follow(p.id, p.question, p.t0);
    say('Your question from before the reload is still running at the server…');
    try {
      const page = await stCh.history({ limit: 100 });
      const mine = page.items.map(x => asObj(x.data)).filter(m => m && m.id === p.id).reverse();
      mine.forEach(m => { if (listeners[p.id]) listeners[p.id](m); });
    } catch (e) { /* no history: the live replies still arrive */ }
    return run;
  }

  async function parseText() {
    const id = newId(), text = $('#f-text').value.trim(), at = marked ? { lat: marked.lat, lon: marked.lon } : null;
    busy = true; validate(); say('Reading your question…');
    let done = false;
    const end = t => { done = true; es.close(); busy = false; validate(); if (t) hold(t); };
    const handle = m => {
      if (done) return;
      if (m.type === 'parsed') {
        /* inputs are locked while the question is read; a reading of another text is never used */
        if ($('#f-text').value.trim() !== text) { end('The question changed while it was read; please ask again.'); return; }
        done = true; es.close(); busy = false; parsedFields = m.fields; parsedWithPoint = !!at;
        showParsed(m.fields);
        if (isFinite(+m.fields.lat) && isFinite(+m.fields.lon)) setPoint(+m.fields.lat, +m.fields.lon, true);
        validate();
        say(`Is this right? Check the square on the map${narrow() ? ' below' : ''}: click the map to move it, or edit the question.`);
        if (narrow()) $('#parsed').scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      } else if (m.type === 'refused' || m.type === 'failed' || m.type === 'error') {
        end('Not run: ' + (m.reason || ''));
      }
    };
    const es = listen(id, handle);
    setTimeout(() => { if (!done) end('No reply in 3 minutes. Please try again later.'); }, 180000);
    const req = { action: 'parse', id, model: model(), text };
    if (at) { req.lat = at.lat; req.lon = at.lon; }
    try { await send(req); if (MOCK) setTimeout(() => handle({ id, type: 'parsed', fields: at ? { kind: 'flood', lat: at.lat, lon: at.lon, event_date: '2023-05-17', place: `the marked point (${at.lat}, ${at.lon})` } : /mosul/i.test(text) ? { kind: 'flood', lat: 36.347, lon: 42.667, event_date: '2023-05-15', place: "Mosul Dam, Iraq (the model's position, high confidence: check it on the map)" } : { kind: 'flood', lat: 44.5063, lon: 11.8276, event_date: '2023-05-17', place: 'Conselice, Italy' } }), 1500); }
    catch (e) { if (!done) end('Could not send the question: ' + e.message); }
  }

  /* mock worker: replays the Conselice run through the live code path (tests only) */
  function mockWorker() { return Promise.resolve(); }
  async function mockRun(id, handle) {
    if (/[?&]mock=compact\b/.test(location.search)) return mockCompact(id, handle);
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

  /* the same run with the compact protocol: 4 messages instead of ~19 (?mock=compact) */
  async function mockCompact(id, handle) {
    const all = [{ step: 'read', state: 'done', note: 'flood · 44.5063° N, 11.8276° E', seconds: 1.8 }, { step: 'check_dates', state: 'done', note: 'before 2023-03-24 to 2023-05-13 · after 2023-05-20 to 2023-05-26', seconds: 0.1 },
      { step: 'images_before', state: 'done', note: '11 images, 4 clear', seconds: 42.1 }, { step: 'images_after', state: 'done', note: '1 image, 1 clear', seconds: 4.0 },
      { step: 'measure', state: 'done', note: 'water 0.1% before, 19.6% after', seconds: 3.3 }, { step: 'decide', state: 'done', note: 'new water = 0.1956 - 0.0006 = 0.1950, which is at least the threshold 0.05', seconds: 0 },
      { step: 'figure', state: 'done', seconds: 9.3 }, { step: 'reply', state: 'done', seconds: 2.2 }];
    await sleep(700); handle({ id, type: 'progress', position: 0, steps: [Object.assign({}, all[0], { state: 'start', seconds: null })] });
    await sleep(1500); handle({ id, type: 'progress', steps: all.slice(0, 2).concat([{ step: 'images_before', state: 'start' }]) });
    await sleep(2500); handle({ id, type: 'progress', steps: all.slice(0, 5).concat([{ step: 'decide', state: 'start' }]) });
    await sleep(1500); handle({ id, type: 'done', steps: all, answer: 'yes', rule: all[5].note }, 'runs/conselice_flood.jpg');
  }

  /* ---------------------------------------------------------------- videos: play only while visible */
  function videos() {
    document.querySelectorAll('video').forEach(vd => {
      if (reduce) { vd.removeAttribute('autoplay'); vd.pause(); vd.controls = true; return; }
      if (!('IntersectionObserver' in window)) return;
      new IntersectionObserver(es => { es[0].isIntersecting && !vd.dataset.stopped ? vd.play().catch(() => {}) : vd.pause(); }, { threshold: .35 }).observe(vd);
    });
    /* the hero loop plays by itself, so it gets a pause button */
    const t = $('#loop-toggle'), lp = $('#loop');
    if (t && lp) {
      if (reduce) { t.hidden = true; return; }
      t.onclick = () => {
        const stop = !lp.dataset.stopped;
        if (stop) { lp.dataset.stopped = '1'; lp.pause(); } else { delete lp.dataset.stopped; lp.play().catch(() => {}); }
        t.textContent = stop ? 'Play the video' : 'Pause the video'; t.setAttribute('aria-pressed', stop);
      };
    }
  }

  function start() {
    wireForm(); initMap(); connect();
    replays(); videos();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
