/* Live dashboard in the real-time pipeline box (animation slot "pipeline-dashboard").
 * Source: dashboard/pipeline-dashboard.js in the CV project; copied to website/assets/js/ by build.py site.
 *
 * Data: the numbers file written by the pipeline's dashboard job and published to a
 * data-only GitHub repo (format: dashboard/README.md in the CV project).
 * Visitor runs: a POST to an ntfy.sh topic; replies on a second topic are hints only, the numbers
 * always come from the numbers file.
 * Fallback: if the numbers file cannot be read, nightly alert counts straight from Fink's public
 * statistics, plus a link to Rubin's public board.
 *
 * Test hooks: ?dashdata=<url> overrides the data URL.
 */
(() => {
  if (!window.SiteAnims) return;
  const q = new URLSearchParams(location.search);

  const STEPS = [
    ['A0', 'Alerts in the window', 'alerts'],
    ['A', 'New objects that pass the filter', 'objects'],
    ['B', 'Objects linked in space and time', 'objects'],
    ['C', 'Light-curve points fetched', 'alerts'],
  ];
  const FINK = 'https://api.lsst.fink-portal.org/api/v1/statistics';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (d) => `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  const hm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const ago = (t) => {
    const s = (Date.now() - t) / 1000;
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 172800) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  };
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

  function windowText(w) {
    const a = new Date(w.start_utc), b = new Date(new Date(w.end_utc) - 1);
    if (w.hours < 24) return `${day(a)} ${a.getUTCFullYear()}, ${hm(a)} – ${hm(new Date(w.end_utc))} UTC`;
    if (w.days === 1 || day(a) === day(b)) return `${day(a)} ${a.getUTCFullYear()} (UTC)`;
    return `${day(a)} – ${day(b)} ${b.getUTCFullYear()} (${w.days} days, UTC)`;
  }

  function chart(days) {
    if (!days || !days.length) return '';
    const max = Math.max(1, ...days.map((d) => d.alerts || 0));
    const bars = days.map((d) => {
      const h = d.alerts ? Math.max(3, (100 * d.alerts) / max) : 0;
      const cls = d.in_window ? 'is-in' : d.skipped ? 'is-skip' : '';
      const tip = `${day(new Date(d.date + 'T00:00:00Z'))}: ${d.alerts == null ? 'no alerts reported' : num(d.alerts) + ' alerts'}${d.in_window ? ' (in the window)' : d.skipped ? ' (skipped: too few alerts)' : ''}`;
      return `<span class="pd-chart__col ${cls}" title="${esc(tip)}"><span class="pd-chart__bar" style="height:${h}%"></span>${d.alerts == null ? '<span class="pd-chart__none"></span>' : ''}</span>`;
    }).join('');
    const first = day(new Date(days[0].date + 'T00:00:00Z')), last = day(new Date(days[days.length - 1].date + 'T00:00:00Z'));
    return `<figure class="pd-chart" aria-label="Alerts per night over the last ${days.length} days">
        <div class="pd-chart__plot">${bars}</div>
        <figcaption><span>${first}</span><span>alerts per night · <i class="k k--in"></i>window <i class="k k--skip"></i>skipped</span><span>${last}</span></figcaption>
      </figure>`;
  }

  function funnel(d) {
    const top = Math.log10((d.counts.A0 || 1) + 1);
    const routes = Object.fromEntries((d.routes || []).map((r) => [r.step, r]));
    return `<ol class="pd-funnel">${STEPS.map(([k, label, unit]) => {
      const n = d.counts[k], r = routes[k] || {};
      const w = n ? Math.max(4, (100 * Math.log10(n + 1)) / top) : 0;
      const sec = d.timings_s && d.timings_s[k] != null ? `${d.timings_s[k].toFixed(1)} s` : '';
      return `<li class="pd-step">
          <span class="pd-step__key">${k}</span>
          <span class="pd-step__main"><span class="pd-step__label">${label}</span><span class="pd-step__route">${esc(r.route || '')}</span>
            <span class="pd-step__track"><span class="pd-step__fill" style="--w:${w}%"></span></span></span>
          <span class="pd-step__num">${num(n)}<small>${(d.units && d.units[k]) || unit}${sec ? ` · <b>${sec}</b>` : ''}</small></span>
        </li>`;
    }).join('')}</ol>`;
  }

  function render(body, d, cfg) {
    const w = d.window || {};
    const failed = d.status === 'failed';
    const pub = (d.public_sources || [])[0];
    body.innerHTML = `
      <p class="pd-window"><span>Time window</span> ${esc(windowText(w))}</p>
      ${w.shifted ? `<p class="pd-notice">${esc(w.note || 'LSST is running at reduced capacity, so the window was moved back or widened.')}</p>` : ''}
      ${failed ? `<p class="pd-notice pd-notice--fail">The latest run did not finish: ${esc(String(d.error || 'unknown error').replace(/\s*\([A-Za-z]+Error\)/g, '').replace(/[.\s]+$/, ''))}. Showing the last complete run.</p>` : ''}
      ${funnel(d)}
      ${chart(d.daily_alerts)}
      <div class="pd-foot">
        ${pub ? `<a class="pd-rubin" href="${esc(pub.url)}" target="_blank" rel="noopener"><i class="${pub.alert_servers_up === pub.alert_servers ? 'ok' : 'warn'}"></i>Rubin alert servers ${num(pub.alert_servers_up)}/${num(pub.alert_servers)} up <span aria-hidden="true">↗</span></a>` : '<span></span>'}
        <span class="pd-run">${cfg.request ? '<button type="button" class="pd-btn" disabled>Run the pipeline now</button>' : ''}<span class="pd-run__msg" aria-live="polite"></span></span>
      </div>`;
    if (cfg.request) runButton(body, d, cfg);
  }

  /* Fallback: no numbers file. Nightly counts from Fink (public, browser-readable). */
  async function fallback(body, cfg) {
    body.innerHTML = `<p class="pd-notice">The pipeline's numbers are not reachable right now. Nightly alert counts straight from the Fink broker:</p><div class="pd-fb">loading…</div>`;
    try {
      const now = new Date();
      const months = [0, 1].map((k) => { const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)); return `${m.getUTCFullYear()}${String(m.getUTCMonth() + 1).padStart(2, '0')}`; });
      const rows = (await Promise.all(months.map((m) => fetch(FINK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: m }) }).then((r) => (r.ok ? r.json() : []))))).flat();
      const days = rows.map((r) => ({ date: `${String(r['f:night']).slice(0, 4)}-${String(r['f:night']).slice(4, 6)}-${String(r['f:night']).slice(6, 8)}`, alerts: Number(r['f:alerts']) || null }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-14);
      body.querySelector('.pd-fb').outerHTML = days.length ? chart(days) : '<p class="pd-age">No counts available.</p>';
    } catch (e) {
      const fb = body.querySelector('.pd-fb'); if (fb) fb.outerHTML = '<p class="pd-age">No counts available.</p>';
    }
    body.insertAdjacentHTML('beforeend', `<div class="pd-foot"><a class="pd-rubin" href="${esc(cfg.rubin)}" target="_blank" rel="noopener">Rubin's public alert board <span aria-hidden="true">↗</span></a><span></span></div>`);
  }

  /* Visitor runs through ntfy.sh (no account). Replies are hints; numbers come from the file. */
  function runButton(body, d, cfg) {
    const btn = body.querySelector('.pd-btn'), msg = body.querySelector('.pd-run__msg');
    const say = (t) => { msg.textContent = t; };
    let next = new Date(d.next_visitor_run_possible_utc || 0);
    const parse = (line) => { try { const m = JSON.parse(line); return { t: m.time * 1000, e: JSON.parse(m.message) }; } catch { return null; } };
    const refresh = () => {
      if (Date.now() < next) { btn.disabled = true; say(`next run possible at ${hm(next)} UTC`); return false; }
      return true;
    };
    fetch(`https://ntfy.sh/${cfg.status}/json?poll=1&since=2h`).then((r) => r.text()).then((txt) => {
      const msgs = txt.split('\n').filter(Boolean).map(parse).filter(Boolean);
      const alive = msgs.some((m) => Date.now() - m.t < 70 * 60 * 1000);
      msgs.forEach((m) => { if (m.e.next_visitor_run_possible_utc) next = new Date(Math.max(next, new Date(m.e.next_visitor_run_possible_utc))); });
      if (!alive) { btn.disabled = true; say('the pipeline is offline right now; automatic runs resume when it is back'); return; }
      if (refresh()) { btn.disabled = false; say(''); }
    }).catch(() => { btn.disabled = true; say(''); });

    btn.addEventListener('click', () => {
      btn.disabled = true; say('request sent…');
      let es;
      try {
        es = new EventSource(`https://ntfy.sh/${cfg.status}/sse`);
        es.onmessage = (ev) => {
          let e; try { e = JSON.parse(JSON.parse(ev.data).message); } catch { return; }
          if (e.event === 'accepted') say('accepted, starting…');
          else if (e.event === 'started') say('running now…');
          else if (e.event === 'refused') { say(e.reason === 'too soon' && e.next_visitor_run_possible_utc ? `too soon: next run at ${hm(new Date(e.next_visitor_run_possible_utc))} UTC` : 'a run is already in progress'); es.close(); }
          else if (e.event === 'finished' || e.event === 'failed') {
            es.close(); say(e.event === 'finished' ? 'done, loading the new numbers…' : 'the run failed; the last complete numbers stay');
            // the commit-pinned address cannot be stale (main/latest.json is cached up to 5 min by GitHub)
            const src = e.commit && cfg.src.includes('/main/') ? cfg.src.replace('/main/', `/${e.commit}/`) : null;
            setTimeout(() => load(body.closest('.dash'), src ? { ...cfg, src } : cfg, !src), src ? 0 : 20000);
          }
        };
      } catch { /* no EventSource: the reload below still happens */ }
      fetch(`https://ntfy.sh/${cfg.request}`, { method: 'POST', body: '{"action":"run"}' })
        .catch(() => { say('could not reach the request service'); if (es) es.close(); });
      setTimeout(() => { if (es && es.readyState !== 2) { es.close(); load(body.closest('.dash'), cfg, true); } }, 180000);
    });
  }

  async function load(el, cfg, bust) {
    const body = el.querySelector('.dash__body');
    try {
      const url = cfg.src + (bust ? (cfg.src.includes('?') ? '&' : '?') + 't=' + Date.now() : '');
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (!d || !d.counts || !d.window) throw new Error('format');
      render(body, d, cfg);
      const bar = el.querySelector('.dash__bar span'), gen = new Date(d.last_good_utc || d.generated_utc);
      if (bar) bar.textContent = 'live dashboard';
      let age = el.querySelector('.pd-age--bar');
      if (!age) { age = document.createElement('em'); age.className = 'pd-age pd-age--bar'; el.querySelector('.dash__bar').insertBefore(age, el.querySelector('.dash__bar .pulse')); }
      const tot = d.timings_s && d.timings_s.total != null ? ` · run ${d.timings_s.total.toFixed(0)} s` : '';
      age.textContent = d.status === 'running' ? 'a run is in progress…' : `updated ${ago(gen)}${tot}`;
      age.classList.toggle('is-warn', d.status === 'failed' || Date.now() - gen > 30 * 3600 * 1000);
    } catch (e) {
      await fallback(body, cfg);
    }
  }

  SiteAnims.register('pipeline-dashboard', (el) => {
    el.removeAttribute('aria-hidden');
    const cfg = {
      src: q.get('dashdata') || el.dataset.src,
      request: el.dataset.request, status: el.dataset.statusTopic,
      rubin: el.dataset.rubin,
    };
    if (!cfg.src) return;
    el.querySelector('.dash__body').innerHTML = '<p class="pd-age pd-loading">Loading the latest run…</p>';
    load(el, cfg, false);
  });
})();
