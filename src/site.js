/* TNMM Benchmarking app UI */
(function () {
  'use strict';
  const T = window.TNMM;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '–' : (Math.abs(v) < 0.005 && d === 2 ? '–' : (v < 0 ? '(' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) + ')' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })));
  const pct = v => (v === null || v === undefined || !isFinite(v)) ? '–' : (v < 0 ? '(' + (Math.abs(v) * 100).toFixed(2) + '%)' : (v * 100).toFixed(2) + '%');
  const mult = v => (v === null || v === undefined || !isFinite(v)) ? '–' : v.toFixed(2) + 'x';
  const PLI = { om: { label: 'Operating margin', f: pct }, ncp: { label: 'Net cost plus margin', f: pct }, berry: { label: 'Berry ratio', f: mult } };

  const state = {
    jobs: [], job: null, tab: 'upload', isExample: false, going: false, errors: {},
    sb: null, user: null, profile: null, ocr: {},
    saveState: 'idle', files: {}, busy: {}, aborts: {}, why: {}
  };

  /* ---------------- persistence ---------------- */
  let saveTimer = null, saving = false, saveAgain = false;
  function touch() {
    if (!state.job) return;
    state.job.updatedAt = Date.now();
    if (state.isExample) { setSave('Example: changes are not saved. Use “Save as new job” to keep it.'); return; }
    clearTimeout(saveTimer); setSave('Unsaved changes…');
    saveTimer = setTimeout(saveNow, 900);
  }
  async function saveNow() {
    const job = state.job; if (!job || state.isExample) return;
    if (!state.sb || !state.user) return;
    if (saving) { saveAgain = true; return; }
    if (!state.jobs.some(x => x.id === job.id)) state.jobs.unshift(JSON.parse(JSON.stringify(job)));
    saving = true; setSave('Saving…');
    try {
      const body = JSON.parse(JSON.stringify(job));
      await api('save', { id: job.id, title: job.title || '', job: body });
      const i = state.jobs.findIndex(x => x.id === job.id); if (i >= 0) state.jobs[i] = JSON.parse(JSON.stringify(job)); else state.jobs.unshift(JSON.parse(JSON.stringify(job)));
      renderRail();
      setSave('All changes saved');
    } catch (e) {
      setSave('Could not save: ' + (e && e.message || 'check your connection and try again'), true);
    } finally {
      saving = false;
      if (saveAgain) { saveAgain = false; saveNow(); }
    }
  }
  function localSave() { try { const all = JSON.parse(localStorage.getItem('tnmm-jobs') || '{}'); all[state.job.id] = state.job; localStorage.setItem('tnmm-jobs', JSON.stringify(all)); } catch (e) { /* storage unavailable */ } }
  function localLoad() { try { return Object.values(JSON.parse(localStorage.getItem('tnmm-jobs') || '{}')); } catch (e) { return []; } }
  function setSave(t, err) { const el = $('#save'); if (el) { el.textContent = t; el.classList.toggle('err', !!err); } }

  /* ---------------- sign-in through CCTaxLab ---------------- */
  // The CCTaxLab portal and this app share the address clowws-byte.github.io, so the portal's
  // stored sign-in is read here. The TNMM server re-checks it with CCTaxLab on every call.
  async function initAuth() {
    const cfg = window.TNMM_CONFIG;
    if (!window.supabase) { showAuth('The sign-in service could not load. Check your connection and refresh.'); return; }
    state.sb = window.supabase.createClient(cfg.cctUrl, cfg.cctKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    const { data } = await state.sb.auth.getSession();
    await onSession(data.session);
    state.sb.auth.onAuthStateChange((ev, session) => {
      if (ev === 'SIGNED_OUT' || (ev === 'SIGNED_IN' && (!state.user || state.user.id !== (session && session.user.id)))) onSession(session);
    });
  }
  async function api(action, body, opts = {}) {
    const { data: sess } = await state.sb.auth.getSession();
    const token = sess.session && sess.session.access_token;
    const raw = body instanceof Blob;
    const r = await fetch(window.TNMM_CONFIG.apiUrl + '?action=' + action, {
      method: 'POST', signal: opts.signal,
      headers: { Authorization: 'Bearer ' + (token || ''), apikey: window.TNMM_CONFIG.apiKey, 'Content-Type': raw ? body.type : 'application/json', ...(opts.headers || {}) },
      body: raw ? body : JSON.stringify(body || {})
    });
    const out = await r.json().catch(() => ({}));
    if (r.status === 401) { onSession(null); }
    if (!r.ok) throw new Error(out.error || ('Request failed (' + r.status + ')'));
    return out;
  }
  async function onSession(session) {
    state.user = session ? session.user : null; state.profile = null;
    if (!state.user) return showAuth();
    let me;
    try { me = await api('me'); } catch (e) { return showAuth('The TNMM server could not be reached. Refresh to try again.'); }
    if (!me.ok) return me.reason === 'signin' ? showAuth() : showNoAccess(me.reason);
    state.profile = me.profile;
    showApp();
    try {
      const out = await api('list');
      onJobsLoaded((out.jobs || []).map(r => { const j = T.normaliseJob(r.job || {}); j.id = r.id; j.title = r.title || j.title; j.updatedAt = Date.parse(r.updated_at) || j.updatedAt; return j; }));
    } catch (e) { setSave('Saved jobs could not be loaded', true); onJobsLoaded([]); }
  }
  function showApp() {
    $('#authview').hidden = true; $('.shell').hidden = false; $('#dl').hidden = false; $('#who').hidden = false;
    $('#whoname').innerHTML = `<b>${esc(state.profile.name || '')}</b><small>${esc(state.profile.email || state.user.email || '')}</small>`;
    render();
  }
  function hideApp() { $('.shell').hidden = true; $('#dl').hidden = true; $('#who').hidden = true; $('#authview').hidden = false; }
  function showAuth(msg) {
    hideApp();
    $('#authview').innerHTML = `<div class="authbox">${MASCOT}<h1>Sign in through CCTaxLab</h1>
      <p>TNMM Benchmarking uses your CCTaxLab account. Sign in to the portal, then open TNMM Benchmarking from your applications.</p>
      <p class="autherr" role="alert">${esc(msg || '')}</p>
      <a class="btn primary" href="${esc(window.TNMM_CONFIG.portalUrl)}">Go to CCTaxLab</a>
      <button class="btn ghost" data-act="recheck">I've signed in, check again</button></div>`;
  }
  function showNoAccess(reason) {
    hideApp();
    $('#authview').innerHTML = `<div class="authbox">${MASCOT}<h1>${reason === 'not_approved' ? 'Account not approved' : 'No access yet'}</h1>
      <p>${reason === 'not_approved' ? 'Your CCTaxLab account is waiting for approval.' : 'Your CCTaxLab account does not have access to TNMM Benchmarking. Ask an admin to grant it in CCTaxLab → Admin → Access.'}</p>
      <p class="meta">${esc(state.user && state.user.email)}</p>
      <a class="btn" href="${esc(window.TNMM_CONFIG.portalUrl)}">Back to CCTaxLab</a>
      <button class="btn ghost" data-act="recheck">Check again</button></div>`;
  }
  let firstLoad = true;
  function onJobsLoaded(jobs) {
    firstLoad = true;
    state.jobs = jobs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (firstLoad) {
      firstLoad = false;
      if (state.jobs.length) openJob(state.jobs[0].id); else startFresh();
    } else if (state.job && !state.isExample && !saving) {
      // keep the open job; refresh only the list
    }
    renderRail();
  }

  /* ---------------- job actions ---------------- */
  /* A blank job kept in memory; it is saved on the first change. */
  function startFresh() { const j = T.blankJob(); j.id = crypto.randomUUID(); j.title = 'New benchmarking'; j.basis = 'YA2023'; j.windowMode = '6-6'; state.job = j; state.isExample = false; state.tab = 'upload'; render(); }
  function openJob(id) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(); }
    const cur = state.job && !state.isExample ? state.jobs.findIndex(x => x.id === state.job.id) : -1;
    if (cur >= 0) state.jobs[cur] = state.job;
    const j = state.jobs.find(x => x.id === id); if (!j) return;
    state.job = T.normaliseJob(JSON.parse(JSON.stringify(j))); state.isExample = false; state.files = {}; state.ocr = {}; state.errors = {};
    state.tab = (j.tp && T.num(j.tp.pl.rev)) || (j.comps || []).length ? 'results' : 'upload'; render();
  }
  function newJob() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(); }
    startFresh();
  }
  function saveExampleAsNew() {
    const j = T.normaliseJob(JSON.parse(JSON.stringify(state.job))); j.id = crypto.randomUUID(); j.title = (j.title || 'Benchmarking').replace(/\s*\(example\)\s*/i, '') + ' (copy)';
    state.jobs.unshift(j); state.job = j; state.isExample = false; touch(); render(); toast('Saved as a new job');
  }
  function duplicateJob() {
    const j = T.normaliseJob(JSON.parse(JSON.stringify(state.job))); j.id = crypto.randomUUID(); j.title = (j.title || '') + ' (copy)'; j.createdAt = Date.now();
    state.jobs.unshift(j); state.job = j; state.isExample = false; touch(); render(); toast('Job duplicated');
  }
  function deleteJob() {
    const j = state.job; if (!j || state.isExample) return;
    confirmBox('Delete this job?', `“${esc(j.title)}” and its figures will be removed. Uploaded PDFs are never stored, so nothing else is affected.`, 'Delete job', async () => {
      state.jobs = state.jobs.filter(x => x.id !== j.id);
      try { await api('delete', { id: j.id }); } catch (e) { toast('Could not delete the job: ' + e.message); }
      if (state.jobs.length) openJob(state.jobs[0].id); else startFresh();
    });
  }

  /* ---------------- rendering ---------------- */
  function render() {
    const fid = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fid : null;
    renderRail(); renderMain();
    if (fid) { const el = document.querySelector(`[data-fid="${CSS.escape(fid)}"]`); if (el) { el.focus(); if (el.select) try { el.select(); } catch (e) { /* not selectable */ } } }
  }

  /* Same rule as the database clean-up: removed after 3 full working days (Mon-Fri) since the last change. */
  function deleteDate(ts) {
    const d = new Date(ts || Date.now()); d.setHours(0, 0, 0, 0);
    let n = 0; while (n < 3) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  const MASCOT = document.querySelector('.mascot') ? document.querySelector('.mascot').outerHTML : '';
  const ICON_TP = '<svg viewBox="0 0 48 48" width="40" height="40"><rect x="9" y="5" width="30" height="38" rx="7" fill="#fff" stroke="currentColor" stroke-width="3"/><path d="M17 17h14M17 24h14M17 31h8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="36" cy="36" r="8" fill="currentColor"/><path d="M36 32v8M32 36h8" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>';
  const ICON_CP = '<svg viewBox="0 0 48 48" width="40" height="40"><rect x="14" y="4" width="26" height="33" rx="6" fill="#fff" stroke="currentColor" stroke-width="3" opacity=".55"/><rect x="8" y="10" width="26" height="33" rx="6" fill="#fff" stroke="currentColor" stroke-width="3"/><path d="M14 21h14M14 28h14M14 35h7" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
  function renderRail() {
    const list = $('#jobs'); if (!list) return;
    const items = state.jobs.map(j => `<button class="job ${state.job && !state.isExample && state.job.id === j.id ? 'on' : ''}" data-job="${esc(j.id)}"><b>${esc(j.title || 'Untitled')}</b><small>${esc(j.tp && j.tp.name || 'No tested party yet')}</small><small class="del">Deletes ${esc(deleteDate(j.updatedAt))}</small></button>`).join('');
    list.innerHTML = (items || '<p class="empty" style="padding:12px">No saved jobs yet. Your jobs appear here once you start one.</p>')
      + '<p class="railnote">Jobs are deleted automatically 3 working days after their last change. Download the Excel to keep a copy.</p>';
  }

  function renderMain() {
    const m = $('#main'); const job = state.job; if (!job) { m.innerHTML = '<p class="empty">Loading…</p>'; return; }
    const R = T.results(job);
    const accN = R.acc.length;
    m.innerHTML = `
      ${headerHtml(job)}
      ${hasFigures(job) ? tilesHtml(R) : ''}
      <div class="tabs" role="tablist">
        ${[['upload', 'Upload & Go'], ['companies', 'Companies', 1 + job.comps.length], ['calc', 'Calculation'], ['reject', 'Rejection', hasFigures(job) && job.comps.length ? accN + '/' + job.comps.length + ' accepted' : undefined], ['results', 'Results']]
          .map(([k, l, c]) => { const ok = stepDone(job, R, k); return `<button role="tab" data-tab="${k}" class="${state.tab === k ? 'on' : ''} ${ok ? 'done' : ''}">${ok ? '<span class="tick" aria-label="done">✓</span>' : ''}${l}${c !== undefined ? `<span class="count">${esc(c)}</span>` : ''}</button>`; }).join('')}
      </div>
      <section id="tabbody">${state.tab === 'upload' ? uploadHtml(job) : state.tab === 'companies' ? companiesHtml(job) : state.tab === 'calc' ? calcHtml(job, R) : state.tab === 'reject' ? rejectHtml(job, R) : resultsHtml(job, R)}</section>`;
    $('#dl').disabled = !job.tp.name && !job.comps.length;
  }

  function headerHtml(job) {
    return `<div class="head"><div class="headttl"><span class="stepno">1</span><b>Set up</b></div>
      <div class="field wide"><label for="f-title">Job title</label><input id="f-title" data-fid="title" data-job-field="title" value="${esc(job.title)}"></div>
      <div class="field"><label for="f-tpfye">Tested party FYE</label><input id="f-tpfye" type="date" data-fid="tpfye" data-fyedate="1" value="${esc(fyeIso(job))}"></div>
      <div class="field wide"><label>Arm's length range</label><div class="seg" role="group">
        <button data-basis="PRE_YA2023" class="${job.basis === 'PRE_YA2023' ? 'on' : ''}">25th – 75th percentile</button>
        <button data-basis="YA2023" class="${job.basis === 'YA2023' ? 'on' : ''}">37.5th – 62.5th percentile</button></div></div>
      <div class="field wide"><label>Comparable period</label><div class="seg" role="group">
        <button data-wmode="6-6" class="${(job.windowMode || '6-6') === '6-6' ? 'on' : ''}">−6 / +6 months</button>
        <button data-wmode="7-5" class="${job.windowMode === '7-5' ? 'on' : ''}">−7 / +5 months</button></div>
        ${job.windowFrom && job.windowTo ? `<div class="row period"><label for="f-wfrom" class="meta">From</label><input id="f-wfrom" type="date" data-fid="wfrom" data-job-field="windowFrom" value="${esc(isoDay(job.windowFrom, false))}">
          <label for="f-wto" class="meta">to</label><input id="f-wto" type="date" data-fid="wto" data-job-field="windowTo" value="${esc(isoDay(job.windowTo, true))}"></div>` : '<small class="meta">Pick the tested party FYE to set the period</small>'}</div>
      <div class="field"><label for="f-rpt">RPT threshold</label><div class="row"><input id="f-rpt" class="num" data-fid="rpt" data-job-field="rptThreshold" value="${esc(Math.round(T.num(job.rptThreshold) * 100))}" inputmode="decimal"><span>%</span></div></div>
    </div>`;
  }

  function concChip(c) { return c === 'Within range' ? `<span class="chip good">${c}</span>` : c === 'n/a' ? `<span class="chip mute">Not enough data</span>` : `<span class="chip ${c === 'Below range' ? 'bad' : 'warn'}">${c}</span>`; }
  function tilesHtml(R) {
    return `<div class="tiles">${Object.entries(PLI).map(([k, p]) => {
      const s = R.stat[k];
      return `<div class="tile"><h3>${p.label}</h3><div class="lcd"><div class="big">${p.f(s.tp)}</div>
        <div class="rng">Range ${p.f(s.lo)} – ${p.f(s.hi)}${s.med !== null ? ' · median ' + p.f(s.med) : ''} · n = ${s.n}</div></div>${concChip(s.concl)}</div>`;
    }).join('')}</div>`;
  }

  /* ---- companies tab ---- */
  function companiesHtml(job) {
    const canRead = !!state.user;
    const cards = [job.tp, ...job.comps].map(c => companyCard(c, canRead)).join('');
    return `<div class="cards" style="margin-top:12px">${cards}<button class="card add" data-act="add-comp">+ Add comparable</button></div>`;
  }
  function statusChip(c) {
    if (state.busy[c.id]) return '<span class="chip warn">Reading…</span>';
    if (c.extraction && c.extraction.at) return c.extraction.checked ? '<span class="chip good">Checked</span>' : '<span class="chip warn">Read by OCR · check figures</span>';
    if (T.num(c.pl.rev)) return '<span class="chip mute">Entered manually</span>';
    return '<span class="chip mute">No figures yet</span>';
  }
  function companyCard(c, canRead) {
    const k = T.calcCompany(c);
    const f = state.files[c.id];
    const busy = state.busy[c.id];
    const tie = k.pbtCheck === null ? '' : k.pbtCheck ? '<span class="ok">✓ PBT agrees to accounts</span>' : `<span class="no">✗ PBT ${fmt(k.pbt)} differs from accounts ${fmt(T.num(c.pbtReported))}</span>`;
    const warns = (c.warnings || []).map(w => `<li>${esc(w)}</li>`).join('');
    const kept = (c.keptIn || []).map(w => `<li>${esc(w.item)}${w.amount ? ' (' + fmt(T.num(w.amount)) + ')' : ''}: ${esc(w.reason || 'kept in operating profit')}</li>`).join('');
    return `<div class="card ${c.isTested ? 'tp' : ''}" data-cid="${esc(c.id)}">
      <div class="ttl"><div><div class="meta">${c.isTested ? 'Tested party' : 'Comparable'}</div><b>${esc(c.name || (c.isTested ? 'Tested party' : 'New comparable'))}</b></div>${statusChip(c)}</div>
      <div class="kv"><span>Reg. no.</span><span>${esc(c.regno || '–')}</span><span>FYE</span><span>${esc(c.fye || '–')}</span>
        <span>Revenue</span><span class="num">${fmt(k.rev)}</span><span>Operating margin</span><span class="num">${pct(k.om)}</span></div>
      ${tie ? `<div style="font-size:12.5px">${tie}</div>` : ''}
      ${canRead ? (busy ? `<div class="progress"><span>${esc(busy.msg)}</span><button class="btn sm" data-act="stop" data-id="${esc(c.id)}">Stop</button></div><div class="bar"><i style="width:${Math.round((busy.p || 0.05) * 100)}%"></i></div>`
        : `<label class="drop" data-drop="${esc(c.id)}">${f ? `<b>${esc(f.name)}</b> · ${(f.size / 1048576).toFixed(1)} MB<br>Drop another file to replace` : 'Upload audited accounts (PDF or page images)<br>or drop the file here'}<input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.pptx,.xlsx,.xlsm,.csv,.txt" ${f ? '' : ''} data-file="${esc(c.id)}"></label>
        ${f ? `<button class="btn primary" data-act="extract" data-id="${esc(c.id)}">Read figures</button>` : ''}${state.ocr[c.id] ? ` <button class="btn sm" data-act="view-ocr" data-id="${esc(c.id)}">View OCR text</button>` : ''}`) : ''}
      ${warns ? `<div><div class="meta">Points to check</div><ul class="notes">${warns}</ul></div>` : ''}
      ${kept ? `<div><div class="meta">Kept in operating profit</div><ul class="notes">${kept}</ul></div>` : ''}
      <div class="row" style="justify-content:space-between">
        ${c.extraction && c.extraction.at && !c.extraction.checked ? `<button class="btn sm" data-act="mark-checked" data-id="${esc(c.id)}">Mark figures as checked</button>` : '<span></span>'}
        ${c.isTested ? '' : `<button class="btn sm ghost danger" data-act="remove-comp" data-id="${esc(c.id)}">Remove</button>`}
      </div>
    </div>`;
  }

  /* ---- calculation tab ---- */
  function calcHtml(job, R) {
    const cs = [job.tp, ...job.comps];
    const K = Object.fromEntries(cs.map(c => [c.id, T.calcCompany(c)]));
    const head = `<tr><th>Line</th>${cs.map(c => `<th>${esc(c.name || (c.isTested ? 'Tested party' : 'Comparable'))}${c.isTested ? '<br><small style="color:#9fd8f2">Tested party</small>' : ''}</th>`).join('')}</tr>`;
    const txtRow = (label, key) => `<tr><td>${label}</td>${cs.map(c => `<td class="in"><input class="cell txt" data-fid="${c.id}-${key}" data-c="${c.id}" data-k="${key}" value="${esc(c[key])}"></td>`).join('')}</tr>`;
    const inRow = (label, key, group) => `<tr><td>${label}</td>${cs.map(c => {
      const v = group === 'pl' ? c.pl[key] : c.adj[key];
      const note = group === 'adj' && c.adjNotes && c.adjNotes[key];
      const sgn = group === 'adj' ? T.ADJ_SIGN[key] : 0; const n = T.num(v);
      const bad = (sgn < 0 && n > 0) || (sgn > 0 && n < 0);
      return `<td class="in ${note ? 'flag' : ''} ${bad ? 'signbad' : ''}" ${note ? `title="${esc(note)}"` : bad ? 'title="Check the sign of this adjustment"' : ''}><input class="cell" inputmode="decimal" data-fid="${c.id}-${group}-${key}" data-c="${c.id}" data-g="${group}" data-k="${key}" value="${n ? fmt(n) : ''}" placeholder="–"></td>`;
    }).join('')}</tr>`;
    const cRow = (label, fn, cls = 'tot') => `<tr class="${cls}"><td>${label}</td>${cs.map(c => `<td class="v num">${fn(K[c.id], c)}</td>`).join('')}</tr>`;
    const sec = t => `<tr class="sec"><td>${t}</td>${cs.map(() => '<td></td>').join('')}</tr>`;
    const P = T.PL_LABELS;
    return `<p class="basisnote">Blue figures are inputs from the audited accounts; type over any of them. Black figures are calculated. A dot marks an adjustment with a reason from the reading step (hover to read it).</p>
    <div class="gridwrap"><table class="g"><thead>${head}</thead><tbody>
      ${txtRow('Company name', 'name')}${txtRow('Registration no.', 'regno')}${txtRow('Business activity', 'activity')}${txtRow('Financial year end', 'fye')}
      ${sec('1.  Statement of profit or loss')}
      ${inRow(P.rev, 'rev', 'pl')}${inRow(P.cos, 'cos', 'pl')}${cRow(P.gp, k => fmt(k.gp))}
      ${['ooi', 'dist', 'admin', 'staff', 'ooe', 'fv'].map(k => inRow(P[k], k, 'pl')).join('')}
      ${cRow(P.pfo, k => fmt(k.pfo))}
      ${['intinc', 'invinc', 'fin'].map(k => inRow(P[k], k, 'pl')).join('')}
      ${cRow(P.pbt, k => fmt(k.pbt))}
      <tr><td>PBT per audited accounts (check)</td>${cs.map(c => { const k = K[c.id]; return `<td class="in"><input class="cell" inputmode="decimal" data-fid="${c.id}-pbtrep" data-c="${c.id}" data-k="pbtReported" value="${c.pbtReported === null || c.pbtReported === '' || c.pbtReported === undefined ? '' : fmt(T.num(c.pbtReported))}" placeholder="optional" title="${k.pbtCheck === null ? '' : k.pbtCheck ? 'Agrees' : 'Does not agree'}" style="${k.pbtCheck === false ? 'color:var(--bad)' : ''}"></td>`; }).join('')}</tr>
      ${inRow(P.tax, 'tax', 'pl')}${cRow(P.pat, k => fmt(k.pat))}
      ${sec('2.  TNMM adjustments')}
      ${cRow('Profit / (loss) before taxation', k => fmt(k.pbt), '')}
      ${cRow('Add back: Finance costs', k => fmt(-k.fin), '')}
      ${T.ADJ_KEYS.map(k => inRow(T.ADJ_LABELS[k], k, 'adj')).join('')}
      ${sec('3.  Normalised operating profit')}
      ${cRow('Normalised operating profit', k => fmt(k.normop), 'tot key')}
      ${cRow('Total operating expenses', k => fmt(k.opex), '')}
      ${sec('4.  Profit level indicators')}
      ${cRow('Operating margin  (NormOP / Revenue)', k => pct(k.om), '')}
      ${cRow('Net cost plus margin  (NormOP / (Revenue − NormOP))', k => pct(k.ncp), '')}
      ${cRow('Berry ratio  (Gross profit / Operating expenses)', k => mult(k.berry), '')}
    </tbody></table></div>`;
  }

  /* ---- rejection tab ---- */
  function rejectHtml(job, R) {
    if (!job.comps.length) return '<p class="empty">Add comparables in the Companies tab first.</p>';
    const thr = Math.round(T.num(job.rptThreshold) * 100);
    const sel = (c, k) => `<select data-fid="${c.id}-t-${k}" data-c="${c.id}" data-test="${k}"><option ${c.tests[k] === 'Pass' ? 'selected' : ''}>Pass</option><option ${c.tests[k] === 'Fail' ? 'selected' : ''}>Fail</option></select>`;
    return `<div class="gridwrap" style="margin-top:12px"><table class="r"><thead><tr>
      <th>Comparable</th><th>Turnover</th><th>≥ 10% of tested party?</th><th>RPT sales</th><th>RPT purchases</th><th>RPT ≤ ${thr}%?</th>
      <th>Functional comparability</th><th>Sufficient & verifiable data</th><th>No start-up / bankrupt / dormant</th><th>Reason (for your file)</th><th>Conclusion</th></tr></thead><tbody>
      ${R.rows.map(({ c, rej }) => `<tr>
        <td><b>${esc(c.name || 'Comparable')}</b><br><small class="meta">${esc(c.regno)}</small></td>
        <td class="num" style="text-align:right">${fmt(T.num(c.pl.rev), 0)}</td>
        <td>${rej.sizePass ? '<span class="chip good">Pass</span>' : '<span class="chip bad">Fail</span>'}<br><label style="font-size:11.5px"><input type="checkbox" data-c="${c.id}" data-k="sizeAcceptedByIrbm" ${c.sizeAcceptedByIrbm ? 'checked' : ''}> Accepted by IRBM</label></td>
        <td><input type="text" class="amt" data-fid="${c.id}-rs" data-c="${c.id}" data-rpt="sales" value="${T.num(c.rpt.sales) ? fmt(T.num(c.rpt.sales), 0) : ''}" placeholder="0"><small class="num">${pct(rej.rptSalesPct)}</small></td>
        <td><input type="text" class="amt" data-fid="${c.id}-rp" data-c="${c.id}" data-rpt="purchases" value="${T.num(c.rpt.purchases) ? fmt(T.num(c.rpt.purchases), 0) : ''}" placeholder="0"><small class="num">${pct(rej.rptPurchPct)}</small></td>
        <td>${rej.rptPass ? '<span class="chip good">Pass</span>' : '<span class="chip bad">Fail</span>'}</td>
        <td>${sel(c, 'activity')}</td><td>${sel(c, 'data')}</td><td>${sel(c, 'special')}</td>
        <td><textarea data-fid="${c.id}-reason" data-c="${c.id}" data-reason="1" placeholder="Why it was accepted or rejected">${esc(Object.values(c.reasons || {}).join(' '))}</textarea></td>
        <td>${rej.accepted ? '<span class="chip good">Accepted</span>' : `<span class="chip bad">Rejected</span><br><small class="meta">${esc(rej.failed.join('; '))}</small>`}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  /* ---- results tab ---- */
  function resultsHtml(job, R) {
    const b = R.basis;
    return `<p class="basisnote">${esc(b.label)}${b.median ? '; median is the mid-point of the 37.5th and 62.5th percentiles.' : '. No median is shown for this basis.'} ${R.acc.length} of ${job.comps.length} comparables accepted.</p>
    <div class="res">${Object.entries(PLI).map(([k, p]) => {
      const s = R.stat[k];
      return `<div class="panel"><div class="row" style="justify-content:space-between"><h3>${p.label}</h3>${concChip(s.concl)}</div>
        ${stripSvg(R, k, p.f)}
        <div class="stat"><span>Minimum</span><span>${p.f(s.min)}</span>
          <span>Lower quartile (${b.lo * 100}th)</span><span class="hl">${p.f(s.lo)}</span>
          ${b.median ? `<span>Median</span><span class="hl">${p.f(s.med)}</span>` : ''}
          <span>Upper quartile (${b.hi * 100}th)</span><span class="hl">${p.f(s.hi)}</span>
          <span>Maximum</span><span>${p.f(s.max)}</span><span>Accepted comparables</span><span>${s.n}</span>
          <span>Tested party</span><span class="hl">${p.f(s.tp)}</span></div></div>`;
    }).join('')}</div>
    ${R.rows.some(r => !r.rej.accepted) ? `<div class="panel" style="margin-top:12px"><h3>Rejected comparables</h3><ul class="notes">${R.rows.filter(r => !r.rej.accepted).map(r => `<li><b>${esc(r.c.name)}</b>: ${esc(r.rej.failed.join('; '))}${Object.values(r.c.reasons || {}).length ? ' · ' + esc(Object.values(r.c.reasons).join(' ')) : ''}</li>`).join('')}</ul></div>` : ''}`;
  }
  function stripSvg(R, k, f) {
    const s = R.stat[k]; const pts = R.acc.map(r => ({ v: r.calc[k], n: r.c.name })).filter(x => x.v !== null && isFinite(x.v));
    if (!pts.length) return '<p class="empty" style="padding:10px">Accept at least one comparable to see the range.</p>';
    const vals = pts.map(p => p.v).concat(s.tp !== null && isFinite(s.tp) ? [s.tp] : []);
    let mn = Math.min(...vals), mx = Math.max(...vals); const pad = (mx - mn || Math.abs(mx) || 1) * 0.08; mn -= pad; mx += pad;
    const W = 320, H = 92, L = 10, Rr = 10, x = v => L + (v - mn) / (mx - mn) * (W - L - Rr);
    const ticks = [mn + pad, (mn + mx) / 2, mx - pad];
    return `<svg class="strip" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(PLI[k].label)} of accepted comparables against the arm's length range">
      <rect x="${x(s.lo)}" y="18" width="${Math.max(1, x(s.hi) - x(s.lo))}" height="34" fill="var(--band)" rx="3"></rect>
      <line x1="${L}" x2="${W - Rr}" y1="35" y2="35" stroke="var(--line)"></line>
      ${s.med !== null ? `<line x1="${x(s.med)}" x2="${x(s.med)}" y1="16" y2="54" stroke="var(--accent-ink)" stroke-dasharray="3 2"></line>` : ''}
      ${pts.map(p => `<circle cx="${x(p.v)}" cy="35" r="4.5" fill="var(--surface)" stroke="var(--muted)" stroke-width="1.5"><title>${esc(p.n)}: ${esc(f(p.v))}</title></circle>`).join('')}
      ${s.tp !== null && isFinite(s.tp) ? `<path d="M${x(s.tp)} 12 l6 -9 h-12 z" fill="var(--accent)"></path><line x1="${x(s.tp)}" x2="${x(s.tp)}" y1="12" y2="56" stroke="var(--accent)" stroke-width="2"></line>` : ''}
      ${ticks.map(t => `<text x="${x(t)}" y="74" text-anchor="middle">${esc(f(t))}</text>`).join('')}
      <text x="${L}" y="${H - 2}">Range ${esc(f(s.lo))} – ${esc(f(s.hi))}</text>
    </svg>`;
  }

  /* ---------------- edits ---------------- */
  function findCo(id) { const j = state.job; return j.tp.id === id ? j.tp : j.comps.find(c => c.id === id); }
  function onChange(e) {
    const t = e.target, job = state.job; if (!job) return;
    if (t.dataset.jobField) {
      const f = t.dataset.jobField; job[f] = f === 'rptThreshold' ? (T.num(t.value) / 100 || 0.2) : t.value;
    } else if (t.dataset.fyedate) {
      job.tp.fyeDate = t.value; job.tp.fye = t.value ? fmtFye(t.value) : ''; suggestWindow(true);
    } else if (t.dataset.tpField) { job.tp[t.dataset.tpField] = t.value;
    } else if (t.dataset.c) {
      const c = findCo(t.dataset.c); if (!c) return;
      if (t.dataset.g === 'pl') c.pl[t.dataset.k] = T.num(t.value);
      else if (t.dataset.g === 'adj') c.adj[t.dataset.k] = T.num(t.value);
      else if (t.dataset.k === 'pbtReported') c.pbtReported = t.value.trim() === '' ? null : T.num(t.value);
      else if (t.dataset.k === 'sizeAcceptedByIrbm') c.sizeAcceptedByIrbm = t.checked;
      else if (t.dataset.rpt) c.rpt[t.dataset.rpt] = T.num(t.value);
      else if (t.dataset.test) c.tests[t.dataset.test] = t.value;
      else if (t.dataset.reason) c.reasons = { note: t.value };
      else if (t.dataset.k) c[t.dataset.k] = t.value;
    } else return;
    touch(); render();
  }
  async function onClick(e) {
    const b = e.target.closest('button, [data-drop]'); if (!b) return;
    if (b.dataset.auth) return showAuth(b.dataset.auth);
    if (b.dataset.job) return openJob(b.dataset.job);
    if (b.dataset.tab) { state.tab = b.dataset.tab; return render(); }
    if (b.dataset.basis) { state.job.basis = b.dataset.basis; touch(); return render(); }
    if (b.dataset.wmode) { state.job.windowMode = b.dataset.wmode; suggestWindow(true); touch(); return render(); }
    const act = b.dataset.act; if (!act) return;
    const id = b.dataset.id;
    if (act === 'recheck') { const { data } = await state.sb.auth.getSession(); return onSession(data.session); }
    if (act === 'new') return newJob();
    if (act === 'dup') return duplicateJob();
    if (act === 'del') return deleteJob();
    if (act === 'download') return downloadExcel();
    if (act === 'add-comp') { state.job.comps.push(T.blankCompany(false)); touch(); return render(); }
    if (act === 'remove-comp') { const c = findCo(id); return confirmBox('Remove comparable?', `${esc(c.name || 'This comparable')} will be removed from this job.`, 'Remove', () => { state.job.comps = state.job.comps.filter(x => x.id !== id); delete state.files[id]; touch(); render(); }); }
    if (act === 'suggest-window') return suggestWindow();
    if (act === 'extract') return extract(id);
    if (act === 'go') return goAll();
    if (act === 'drop-file') { const c = findCo(id); delete state.files[id]; delete state.errors[id]; if (c && !c.isTested && !T.num(c.pl.rev)) state.job.comps = state.job.comps.filter(x => x.id !== id); touch(); return render(); }
    if (act === 'view-ocr') return viewOcr(id);
    if (act === 'stop') { const a = state.aborts[id]; if (a) a.abort(); return; }
    if (act === 'mark-checked') { const c = findCo(id); c.extraction.checked = true; touch(); return render(); }
  }
  function fyeIso(job) {
    if (job.tp.fyeDate) return job.tp.fyeDate;
    const d = parseFye(job.tp.fye); if (!d) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  /* windows saved before dates were used are 'YYYY-MM'; show them as the first or last day of the month */
  function isoDay(v, end) { if (!v) return ''; if (/^\d{4}-\d{2}$/.test(v)) { const [y, m] = v.split('-').map(Number); return end ? `${v}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` : `${v}-01`; } return v; }
  function fmtFye(iso) { const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  /* Comparable FYE window: -6/+6 months (MTPG 2024 para 4.7) or -7/+5 months (Example 4.2) around the tested party FYE. */
  function suggestWindow(silent) {
    const iso = fyeIso(state.job); const d = iso ? new Date(iso + 'T00:00:00') : null;
    if (!d || isNaN(d)) { if (!silent) toast('Pick the tested party FYE first.'); return; }
    const [before, after] = state.job.windowMode === '7-5' ? [7, 5] : [6, 6];
    const from = new Date(d.getFullYear(), d.getMonth() - (before - 1), 1), to = new Date(d.getFullYear(), d.getMonth() + after, 1);
    const day = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    state.job.windowFrom = day(from); state.job.windowTo = day(new Date(to.getFullYear(), to.getMonth() + 1, 0));
    if (silent) return;
    touch(); render();
  }
  function parseFye(s) { if (!s) return null; const d = new Date(String(s).replace(/(\d+)(st|nd|rd|th)/, '$1')); return isNaN(d) ? null : d; }

  /* ---------------- files & extraction (read in the browser; Gemini on the server as fallback) ---------------- */
  const EXT_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  /* How a file is read: 'ocr' (read in the browser, else server OCR), 'sheet' (Excel, read here), 'text' (CSV / text, read here). */
  function fileMode(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (EXT_MIME[ext]) return { mode: 'ocr', mime: EXT_MIME[ext] };
    if (['xlsx', 'xlsm'].includes(ext)) return { mode: 'sheet' };
    if (['csv', 'txt', 'tsv', 'md'].includes(ext)) return { mode: 'text' };
    if (['xls', 'doc', 'ppt'].includes(ext)) return { error: `${f.name}: this older format can't be read. Save it as .${ext}x or PDF and upload again.` };
    if (/^image\//.test(f.type)) return { error: `${f.name}: save the image as PNG or JPEG and upload again.` };
    return { error: `${f.name}: this file type can't be read. Use PDF, Word, PowerPoint, Excel, CSV or an image.` };
  }
  function okFile(f) {
    const m = fileMode(f); if (m.error) { toast(m.error); return false; }
    if (f.size > 50 * 1048576) { toast(`${f.name} is over 50 MB. Upload only the financial statements pages.`); return false; }
    return true;
  }
  async function localPages(f) {
    const m = fileMode(f);
    if (m.mode === 'text') { const t = await f.text(); return [{ index: 0, markdown: t.slice(0, 200000) }]; }
    const wb = new window.ExcelJS.Workbook(); await wb.xlsx.load(await f.arrayBuffer());
    const pages = [];
    wb.eachSheet((ws, i) => {
      const lines = [];
      ws.eachRow({ includeEmpty: false }, row => {
        const cells = []; row.eachCell({ includeEmpty: true }, c => { let v = c.value; if (v && typeof v === 'object') v = v.result ?? v.text ?? (v.richText ? v.richText.map(r => r.text).join('') : ''); cells.push(v === null || v === undefined ? '' : String(v)); });
        if (cells.some(x => x.trim())) lines.push('| ' + cells.join(' | ') + ' |');
      });
      if (lines.length) pages.push({ index: pages.length, markdown: `Sheet: ${ws.name}\n` + lines.join('\n') });
    });
    return pages;
  }
  function onFile(id, fileList) {
    if (id === 'tp') id = state.job.tp.id;
    if (id === 'comps') {
      const files = Array.from(fileList || []).filter(okFile);
      files.forEach(f => {
        const c = T.blankCompany(false); c.name = f.name.replace(/\.(pdf|png|jpe?g|webp)$/i, ''); c.source = { file: f.name };
        state.job.comps.push(c); state.files[c.id] = { file: f, name: f.name, size: f.size };
      });
      if (files.length) { touch(); render(); }
      return;
    }
    const f = (fileList || [])[0]; if (!f) return;
    if (!okFile(f)) return;
    state.files[id] = { file: f, name: f.name, size: f.size };
    delete state.ocr[id];
    const c = findCo(id); c.source = { file: f.name }; touch(); render();
  }
  function setBusy(id, msg, p) { state.busy[id] = { msg, p }; if (state.tab === 'companies' || state.tab === 'upload') renderMain(); }

  /* Pick the pages that matter from the OCR text: the profit or loss statement and the notes behind it. */
  function scorePage(md, i) {
    const t = md.toLowerCase(); let s = 0;
    if (/statements? of (profit or loss|comprehensive income)|income statement/.test(t) && /revenue/.test(t) && /before tax/.test(t)) s += 10;
    if (/(profit|loss) before tax/.test(t) && /(after charging|arrived at|crediting)/.test(t)) s += 8;
    if (/related part/.test(t)) s += 7;
    if (/other (operating )?income/.test(t)) s += 3;
    if (/income tax expense|tax expense|taxation/.test(t)) s += 2;
    if (/finance costs?|interest income|finance income/.test(t)) s += 2;
    if (/revenue|cost of sales/.test(t)) s += 1;
    if (i < 3 && /(registration no|company no|\(\d{5,7}-[a-z]\))/.test(t)) s += 5;
    if (/principal activit/.test(t)) s += 4;
    if (/statements? of financial position/.test(t) && s < 10) s -= 2;
    if (/statements? of (changes in equity|cash flows)/.test(t) && s < 10) s -= 3;
    return s;
  }
  // Upload straight to private Storage with a one-time link (shows progress; does not pass through the API).
  function uploadDirect(url, blob, signal, onPct) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('apikey', window.TNMM_CONFIG.apiKey);
      x.setRequestHeader('Content-Type', blob.type);
      x.setRequestHeader('x-upsert', 'true');
      x.upload.onprogress = e => { if (e.lengthComputable) onPct(Math.round(e.loaded / e.total * 100)); };
      x.onload = () => x.status >= 200 && x.status < 300 ? resolve() : reject(new Error('Upload failed (' + x.status + '): ' + (x.responseText || '').slice(0, 160)));
      x.onerror = () => reject(new Error('Upload failed. Check your internet connection and try again.'));
      x.ontimeout = () => reject(new Error('Upload timed out. Try again.'));
      signal.addEventListener('abort', () => { x.abort(); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
      x.send(blob);
    });
  }

  /* ---------- Free reading in the browser ----------
     1) Digital PDFs: read the text layer with pdf.js (exact, instant, free).
     2) Scanned pages / images: free OCR with Tesseract.js, in the browser.
     Returns null when the result looks too poor, so the caller can fall back to server OCR (Gemini). */
  const LIB = {
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    tess: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'
  };
  const scripts = {};
  function loadScript(src) {
    return scripts[src] || (scripts[src] = new Promise((res, rej) => {
      const el = document.createElement('script'); el.src = src; el.async = true;
      el.onload = res; el.onerror = () => { delete scripts[src]; rej(new Error('Could not load ' + src)); };
      document.head.appendChild(el);
    }));
  }
  // A small pool of free OCR workers (2-3, by CPU) so several pages are read at the same time.
  let poolP = null;
  function tessPool() {
    return poolP || (poolP = (async () => {
      await loadScript(LIB.tess);
      const n = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
      const ws = await Promise.all(Array.from({ length: n }, async () => {
        const w = await window.Tesseract.createWorker('eng');
        await w.setParameters({ preserve_interword_spaces: '1' });
        return w;
      }));
      const idle = [...ws], waiting = [];
      return {
        size: n,
        async run(fn) {
          const w = idle.pop() || await new Promise(r => waiting.push(r));
          try { return await fn(w); } finally { const nx = waiting.shift(); if (nx) nx(w); else idle.push(w); }
        }
      };
    })().catch(e => { poolP = null; throw e; }));
  }
  async function ocrPage(doc, i, scale, w) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    const { data } = await w.recognize(cv);
    cv.width = cv.height = 0; page.cleanup();
    return data;
  }
  function goodText(t) {
    const s = String(t || '').replace(/\s/g, '');
    if (s.length < 60) return false;
    const ok = (s.match(/[A-Za-z0-9.,()%\-'&:\/]/g) || []).length;
    return ok / s.length > 0.85;
  }
  // rebuild lines (and keep column gaps) from pdf.js text items
  function linesFromItems(items) {
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || 8;
      let r = rows.find(r => Math.abs(r.y - y) < Math.max(r.h, h) * 0.5);
      if (!r) { r = { y, h, items: [] }; rows.push(r); }
      r.items.push({ x, w: it.width || 0, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      for (const t of r.items) {
        if (end !== null) { const gap = t.x - end; out += gap > r.h * 1.2 ? '    ' : gap > r.h * 0.15 ? ' ' : ''; }
        out += t.s; end = t.x + t.w;
      }
      return out;
    }).join('\n');
  }
  /* Text already read from a file is kept in this browser for 3 days (keyed by the file's fingerprint),
     so reading the same file again, even after a refresh, is instant and free. */
  const IDB = { db: null };
  function idb() {
    return IDB.db || (IDB.db = new Promise((res, rej) => {
      const r = indexedDB.open('tnmm-reads', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('pages');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  }
  async function cacheGet(key) {
    try {
      const db = await idb();
      const v = await new Promise((res, rej) => { const q = db.transaction('pages').objectStore('pages').get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      return v && Date.now() - v.at < 3 * 86400000 ? v.pages : null;
    } catch (e) { return null; }
  }
  async function cachePut(key, pages) {
    try {
      const db = await idb();
      const tx = db.transaction('pages', 'readwrite'), st = tx.objectStore('pages');
      st.put({ at: Date.now(), pages }, key);
      const all = st.openCursor(); // drop entries older than 3 days
      all.onsuccess = () => { const c = all.result; if (!c) return; if (Date.now() - (c.value.at || 0) > 3 * 86400000) c.delete(); c.continue(); };
    } catch (e) { /* storage not available: just skip the cache */ }
  }
  async function fileKey(file) {
    const buf = await file.arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  const stopIf = signal => { if (signal.aborted) throw new DOMException('Stopped', 'AbortError'); };
  async function browserRead(file, mime, id, signal) {
    try {
      if (mime.startsWith('image/')) {
        setBusy(id, 'Free OCR on the image…', 0.2);
        const pool = await tessPool(); stopIf(signal);
        const data = await pool.run(async w => (await w.recognize(file)).data);
        if (data.confidence >= 55 && goodText(data.text)) return [{ index: 0, markdown: data.text }];
        state.why[id] = `image too unclear for free OCR (confidence ${Math.round(data.confidence)}%)`; return null;
      }
      setBusy(id, 'Opening the PDF…', 0.08);
      await loadScript(LIB.pdf);
      const pdfjs = window.pdfjsLib; pdfjs.GlobalWorkerOptions.workerSrc = LIB.pdfWorker;
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const n = Math.min(doc.numPages, 150);
      const pages = [], scanned = [], layer = {};
      for (let i = 0; i < n; i++) {
        stopIf(signal);
        const page = await doc.getPage(i + 1);
        const text = linesFromItems((await page.getTextContent()).items);
        // a page with only a little text (e.g. a scanner stamp or header over a scanned image) is treated as scanned
        const chars = text.replace(/\s/g, '').length;
        if (goodText(text) && chars >= 400) pages.push({ index: i, markdown: text }); else { scanned.push(i); layer[i] = text; }
        if (i % 5 === 0) setBusy(id, `Reading page ${i + 1} of ${n}…`, 0.08 + 0.1 * i / n);
      }
      // digital text already has the profit or loss statement: no need to OCR the odd scanned page (e.g. signatures)
      const hasPL = pages.some(p => scorePage(p.markdown, p.index) >= 10);
      if (scanned.length && !hasPL) {
        /* Scanned: two passes so only the pages that matter get the slow, sharp OCR.
           Pass 1 reads every scanned page quickly at low resolution just to find the statements and notes.
           Pass 2 reads the top pages again at high resolution. */
        const todo = scanned.slice(0, 120), t0 = Date.now();
        setBusy(id, 'Scanned PDF. Loading free OCR…', 0.2);
        const pool = await tessPool();
        const quick = {}; let done = 0;
        await Promise.all(todo.map(i => pool.run(async w => {
          stopIf(signal);
          quick[i] = (await ocrPage(doc, i, 1.5, w)).text || '';
          done++; setBusy(id, `Free OCR, finding the statements: page ${done} of ${todo.length} (${Math.round((Date.now() - t0) / 1000)}s)…`, 0.2 + 0.2 * done / todo.length);
        })));
        const ranked = todo.map(i => ({ i, s: scorePage(quick[i], i) })).sort((a, b) => b.s - a.s);
        const found = ranked[0] && ranked[0].s >= 5;
        const sharp = found ? ranked.filter(x => x.s > 0).slice(0, 12).map(x => x.i) : todo.slice(0, 40);
        let conf = 0, good = 0; done = 0;
        await Promise.all(sharp.map(i => pool.run(async w => {
          stopIf(signal);
          const d = await ocrPage(doc, i, 2, w);
          if (goodText(d.text)) { quick[i] = d.text; conf += d.confidence || 0; good++; }
          done++; setBusy(id, `Free OCR, reading the statements: page ${done} of ${sharp.length} (${Math.round((Date.now() - t0) / 1000)}s)…`, 0.4 + 0.2 * done / sharp.length);
        })));
        if (!good || conf / good < 50) { state.why[id] = good ? `scan too unclear for free OCR (confidence ${Math.round(conf / good)}%)` : 'no readable text found on the scanned pages'; return null; }
        todo.forEach(i => { const t = goodText(quick[i]) ? quick[i] : layer[i]; if (goodText(t)) pages.push({ index: i, markdown: t }); });
        pages.sort((a, b) => a.index - b.index);
      }
      // P&L found in the digital text: keep any short pages' own text too (covers, headings)
      if (hasPL) scanned.forEach(i => { if (goodText(layer[i])) pages.push({ index: i, markdown: layer[i] }); });
      pages.sort((a, b) => a.index - b.index);
      doc.destroy();
      if (!pages.length) state.why[id] = 'no readable text in the PDF';
      return pages.length ? pages : null;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      console.warn('Free reading failed, using server OCR instead:', e);
      state.why[id] = 'free reader error: ' + String((e && e.message) || e).slice(0, 120);
      return null;
    }
  }
  /* Paid fallback: OCR on the server (Gemini) (used only when the free reading in the browser isn't good enough). */
  async function serverOcr(id, f, fm, ctl) {
    setBusy(id, 'Checking the file…', 0.08);
    const buf = await f.file.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map(x => x.toString(16).padStart(2, '0')).join('');
    const why = state.why[id] || 'server OCR';
    const st = await api('ocr_start', { name: f.name, mime: fm.mime, size: f.file.size, hash, why }, { signal: ctl.signal });
    if (st.reused) setBusy(id, 'This file was already read today. Reusing that OCR, no new charge…', 0.5);
    else {
      await uploadDirect(st.upload, new Blob([buf], { type: fm.mime }), ctl.signal, pct => setBusy(id, `Uploading the file (${pct}%)…`, 0.08 + pct / 100 * 0.12));
      await api('ocr_go', { run: st.run }, { signal: ctl.signal });
    }
    const t0 = Date.now();
    for (;;) {
      await new Promise((res, rej) => { const tm = setTimeout(res, 3000); ctl.signal.addEventListener('abort', () => { clearTimeout(tm); rej(new DOMException('Stopped', 'AbortError')); }, { once: true }); });
      const secs = Math.round((Date.now() - t0) / 1000);
      if (!st.reused) setBusy(id, `Free reading not possible (${why}). Using Gemini OCR (${secs}s)…`, Math.min(0.55, 0.2 + secs / 400));
      const r = await api('ocr_status', { run: st.run }, { signal: ctl.signal });
      if (r.status === 'done') return r.pages || [];
      if (r.status === 'error') throw new Error(`Free reading not possible (${why}), and paid OCR failed: ${r.error || 'unknown error'}`);
      if (secs > 600) throw new Error('OCR is taking too long. Try a smaller file with only the financial statements pages.');
    }
  }
  async function extract(id, quiet) {
    const job = state.job, c = findCo(id), f = state.files[id];
    if (!c || !f || state.busy[id]) return;
    const ctl = new AbortController(); state.aborts[id] = ctl;
    try {
      let pages = state.ocr[id] ? state.ocr[id].pages : null;
      const key = pages ? null : await fileKey(f.file).catch(() => null);
      if (!pages && key) { pages = await cacheGet(key); if (pages) { setBusy(id, 'Already read on this computer. Using the saved text…', 0.6); state.ocr[id] = { file: f.name, pages }; } }
      if (!pages) {
        const fm = fileMode(f.file);
        if (fm.mode === 'ocr' && (fm.mime === 'application/pdf' || fm.mime.startsWith('image/'))) {
          delete state.why[id];
          pages = await browserRead(f.file, fm.mime, id, ctl.signal);
          if (!pages) pages = await serverOcr(id, f, fm, ctl);
        } else if (fm.mode === 'ocr') {
          pages = await serverOcr(id, f, fm, ctl);
        } else {
          setBusy(id, 'Reading the spreadsheet…', 0.3);
          pages = await localPages(f.file);
        }
        if (!pages.length) throw new Error('OCR returned no text. Check the file is the audited accounts.');
        state.ocr[id] = { file: f.name, pages };
        if (key) cachePut(key, pages);
      }
      const ranked = pages.map((p, i) => ({ p, s: scorePage(p.markdown, i) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 14).map(x => x.p);
      const pick = (ranked.length ? ranked : pages.slice(0, 14)).sort((a, b) => a.index - b.index);
      setBusy(id, `Mapping figures from page${pick.length === 1 ? '' : 's'} ${pick.map(p => p.index + 1).join(', ')}…`, 0.65);
      const win = job.windowFrom && job.windowTo ? `between ${fmtFye(isoDay(job.windowFrom, false))} and ${fmtFye(isoDay(job.windowTo, true))}` : '';
      const out = await api('extract', { pages: pick, role: c.isTested ? 'tested' : 'comparable', fye: job.tp.fye, window: win, kind: c.docKind === 'management' ? 'management' : 'audited' }, { signal: ctl.signal });
      applyExtraction(c, out.result, pick.map(p => p.index + 1));
      delete state.errors[id];
      if (!quiet) toast(`${c.name || 'Company'}: figures read. Please check them against the accounts.`);
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? 'Stopped.' : (e && e.message) || 'Reading failed. Try again.';
      state.errors[id] = msg;
      if (!quiet) toast(msg);
    } finally {
      delete state.busy[id]; delete state.aborts[id]; render();
    }
  }
  async function goAll() {
    const job = state.job;
    const ids = [job.tp, ...job.comps].filter(c => state.files[c.id] && !(c.extraction && c.extraction.at)).map(c => c.id);
    if (!state.files[job.tp.id] && !T.num(job.tp.pl.rev)) return toast('Upload the tested party accounts first.');
    if (!job.comps.length) return toast('Upload at least one comparable.');
    if (!ids.length) { state.tab = 'results'; return render(); }
    state.going = true; render();
    let i = 0;
    const worker = async () => { while (i < ids.length) { const id = ids[i++]; await extract(id, true); } };
    await Promise.all([worker(), worker()]);
    state.going = false;
    const failed = ids.filter(id => state.errors[id]).length;
    if (!failed) state.tab = 'results';
    render();
    toast(failed ? `${ids.length - failed} read, ${failed} could not be read. See the list for details.` : 'All figures read. Check them in Companies and Calculation.');
  }
  /* A step is done when: files all read (Upload), every company has figures (Companies), every PBT check that was entered agrees
     (Calculation), at least one comparable is accepted (Rejection), and a range exists (Results). */
  function stepDone(job, R, k) {
    const all = [job.tp, ...job.comps];
    const filled = job.comps.length > 0 && all.every(c => T.num(c.pl.rev) !== 0);
    if (k === 'upload') return filled && !all.some(c => state.files[c.id] && !(c.extraction && c.extraction.at)) && !Object.keys(state.errors).length;
    if (k === 'companies') return filled;
    if (k === 'calc') return filled && all.every(c => T.calcCompany(c).pbtCheck !== false);
    if (k === 'reject') return filled && R.acc.length > 0;
    if (k === 'results') return filled && R.stat.om.n > 0 && R.stat.om.lo !== null;
    return false;
  }
  function hasFigures(job) { return T.num(job.tp.pl.rev) !== 0 || job.comps.some(c => T.num(c.pl.rev) !== 0); }
  function queueRow(c) {
    const f = state.files[c.id], busy = state.busy[c.id], err = state.errors[c.id];
    const done = c.extraction && c.extraction.at;
    const st = busy ? `<span class="chip warn">${esc(busy.msg.split('.')[0])}</span>` : err ? `<span class="chip bad" title="${esc(err)}">Not read</span>` : done ? '<span class="chip good">Read</span>' : f ? '<span class="chip mute">Ready</span>' : T.num(c.pl.rev) ? '<span class="chip mute">Entered</span>' : '<span class="chip mute">No file</span>';
    return `<li class="${c.isTested ? 'q-tp' : 'q-cp'}"><span class="qtag">${c.isTested ? 'Tested party' : 'Comparable'}</span><span class="qname"><b>${esc(c.name || (c.isTested ? 'Tested party' : 'Comparable'))}</b><small>${esc(f ? f.name : (c.source && c.source.file) || '')}${err ? ' · ' + esc(err) : ''}</small></span>
      <select class="qkind" data-c="${esc(c.id)}" data-k="docKind" aria-label="Type of accounts" ${busy || state.going ? 'disabled' : ''}><option value="audited" ${c.docKind !== 'management' ? 'selected' : ''}>Audited</option><option value="management" ${c.docKind === 'management' ? 'selected' : ''}>Management</option></select>${st}
      ${!busy && f && !state.going ? `<button class="btn sm ghost" data-act="drop-file" data-id="${esc(c.id)}" aria-label="Remove ${esc(c.name || 'file')}">✕</button>` : ''}</li>`;
  }
  function uploadHtml(job) {
    const tpFile = state.files[job.tp.id];
    const pending = [job.tp, ...job.comps].filter(c => state.files[c.id] && !(c.extraction && c.extraction.at)).length;
    return `<div class="steps">
      <div class="step">
        <div class="headttl"><span class="stepno s2">2</span><b>Upload accounts</b></div>
        <div class="ups">
          <label class="up tp" data-drop="tp"><input type="file" data-file="tp" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.pptx,.xlsx,.xlsm,.csv,.txt">
            <span class="upicon" aria-hidden="true">${ICON_TP}</span><b>Tested party</b>
            <span>Audited or management accounts</span><em>Any format · click or drop</em></label>
          <label class="up cp" data-drop="comps"><input type="file" data-file="comps" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.pptx,.xlsx,.xlsm,.csv,.txt">
            <span class="upicon" aria-hidden="true">${ICON_CP}</span><b>Comparables</b>
            <span>Audited or management accounts</span><em>One file per company · pick several</em></label>
        </div>
        ${(tpFile || job.comps.length || T.num(job.tp.pl.rev)) ? `<ul class="queue">${[job.tp, ...job.comps].filter(c => c.isTested ? (tpFile || T.num(c.pl.rev) || state.errors[c.id]) : true).map(queueRow).join('')}</ul>` : ''}
      </div>
      <div class="step gostep">
        <div class="headttl"><span class="stepno s3">3</span><b>Calculate</b></div>
        <button class="go" data-act="go" ${state.going ? 'disabled' : ''}><span aria-hidden="true">=</span> ${state.going ? 'Working…' : 'Go'}</button>
        <p class="meta">${state.going ? 'Reading each file with OCR and mapping the figures. Keep this tab open.' : pending ? `${pending} file${pending === 1 ? '' : 's'} to read. Go reads them, then shows the arm's length range.` : hasFigures(job) ? 'All files read. Go shows the results.' : 'Upload the files, then press Go.'}</p>
      </div>
    </div>`;
  }
  function viewOcr(id) {
    const o = state.ocr[id]; if (!o) return;
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="box" role="dialog" aria-modal="true" style="max-width:860px;max-height:86vh"><div class="row" style="justify-content:space-between"><h3>OCR text · ${esc(o.file)}</h3><button class="btn sm" data-x="no">Close</button></div>
      <div style="overflow:auto;font:12px/1.5 var(--font-num);white-space:pre-wrap;border:1px solid var(--line);border-radius:6px;padding:10px">${o.pages.map(p => `<b>— Page ${p.index + 1} —</b>\n${esc(p.markdown)}`).join('\n\n')}</div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', ev => { if (ev.target.dataset.x === 'no' || ev.target === m) m.remove(); });
  }
  function applyExtraction(c, out, pages) {
    if (!out || typeof out !== 'object' || !out.pl) throw { code: 'invalid_json' };
    ['name', 'regno', 'activity', 'fye'].forEach(k => { if (out[k]) c[k] = String(out[k]).trim(); });
    T.PL_KEYS.forEach(k => c.pl[k] = T.num(out.pl[k]));
    c.pbtReported = out.pbt_reported === undefined || out.pbt_reported === null ? null : T.num(out.pbt_reported);
    T.ADJ_KEYS.forEach(k => c.adj[k] = 0); c.adjNotes = {};
    (out.adjustments || []).forEach(a => {
      if (!a || !T.ADJ_KEYS.includes(a.key)) return;
      const v = T.num(a.amount); if (!v) return;
      c.adj[a.key] = T.num(c.adj[a.key]) + v;
      c.adjNotes[a.key] = [c.adjNotes[a.key], (a.reason || '') + (a.page ? ` (page ${a.page})` : '')].filter(Boolean).join('; ');
    });
    if (out.rpt) c.rpt = { sales: T.num(out.rpt.sales), purchases: T.num(out.rpt.purchases) };
    c.keptIn = (out.kept_in || []).filter(x => x && x.item).slice(0, 12).map(x => ({ item: String(x.item), amount: T.num(x.amount), reason: String(x.reason || '') }));
    const w = (out.warnings || []).filter(x => x && String(x).trim()).map(String).slice(0, 10);
    // Rental income taken out => its investment property depreciation comes out too (safety net if the AI left it in)
    if (T.num(c.adj.less_rental_nonop) < 0 && !T.num(c.adj.add_ip_depreciation)) {
      const i = c.keptIn.findIndex(x => /depreciation/i.test(x.item) && /investment propert/i.test(x.item));
      if (i >= 0) {
        c.adj.add_ip_depreciation = Math.abs(c.keptIn[i].amount);
        c.adjNotes.add_ip_depreciation = c.keptIn[i].item + ' (rental income excluded, so its depreciation is added back)';
        c.keptIn.splice(i, 1);
      } else w.push('Rental income was excluded. If the company has investment properties, add back their depreciation.');
    }
    if (T.num(c.adj.add_ip_depreciation) && !T.num(c.adj.less_rental_nonop)) w.push('Investment property depreciation is added back but no rental income was excluded. Check both lines.');
    const k = T.calcCompany(c);
    if (Math.abs(k.gp - (k.rev + k.cos)) > 1) w.push('Gross profit does not agree.');
    if (k.pbtCheck === false) w.push(`Computed PBT ${fmt(k.pbt)} does not agree to the accounts (${fmt(T.num(c.pbtReported))}). Check the line mapping.`);
    c.warnings = w;
    c.extraction = { at: Date.now(), pages, checked: false };
    const job = state.job;
    if (c.isTested && (!job.title || job.title === 'New benchmarking') && c.name) job.title = c.name + (c.fye ? ' – FYE ' + c.fye : '');
    if (c.isTested && c.fye && !job.tp.fyeDate) { const d = parseFye(c.fye); if (d) { job.tp.fyeDate = fyeIso({ tp: { fye: c.fye } }); suggestWindow(true); } }
    touch();
  }

  /* ---------------- excel ---------------- */
  async function downloadExcel() {
    const job = state.job; if (!job) return;
    try {
      const wb = await T.buildWorkbook(window.ExcelJS, job);
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const name = `TNMM Benchmarking - ${(job.tp.name || job.title || 'job').replace(/[\\/:*?"<>|]/g, '')} - FYE ${(job.tp.fye || '').replace(/[\\/:*?"<>|]/g, '')}.xlsx`.replace(/\s+/g, ' ');
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    } catch (e) {
      if (e && e.code === 'declined') return;
      toast(e && e.code ? 'The download could not be saved.' : 'The workbook could not be built.');
    }
  }

  /* ---------------- small ui helpers ---------------- */
  let toastTimer;
  function toast(t) { let el = $('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); } el.textContent = t; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), 4200); }
  function confirmBox(title, html, okLabel, onOk) {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="box" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p style="margin:0">${html}</p><div class="acts"><button class="btn" data-x="no">Cancel</button><button class="btn primary" data-x="ok">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', ev => { const x = ev.target.dataset.x; if (x === 'ok') { m.remove(); onOk(); } else if (x === 'no' || ev.target === m) m.remove(); });
    $('[data-x="ok"]', m).focus();
  }

  /* ---------------- boot ---------------- */
  document.addEventListener('change', e => {
    if (e.target.dataset.file) return onFile(e.target.dataset.file, e.target.files);
    onChange(e);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input.cell, .head input')) { e.preventDefault(); e.target.blur(); } });
  document.addEventListener('click', onClick);
  document.addEventListener('dragover', e => { const d = e.target.closest('[data-drop]'); if (d) { e.preventDefault(); d.classList.add('over'); } });
  document.addEventListener('dragleave', e => { const d = e.target.closest('[data-drop]'); if (d) d.classList.remove('over'); });
  document.addEventListener('drop', e => { const d = e.target.closest('[data-drop]'); if (d) { e.preventDefault(); onFile(d.dataset.drop, e.dataTransfer.files); } });

  initAuth();
})();
