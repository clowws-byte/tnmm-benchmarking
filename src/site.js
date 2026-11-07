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
  const EXAMPLE = window.EXAMPLE_JOB;

  const state = {
    jobs: [], job: null, tab: 'companies', isExample: false,
    sb: null, user: null, profile: null, ocr: {},
    saveState: 'idle', files: {}, busy: {}, aborts: {}
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
    saving = true; setSave('Saving…');
    try {
      const body = JSON.parse(JSON.stringify(job));
      const { error } = await state.sb.from('tnmm_jobs').upsert({ id: job.id, owner: state.user.id, title: job.title || '', job: body, updated_at: new Date(job.updatedAt).toISOString() });
      if (error) throw error;
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

  /* ---------------- sign-in, approval and admin ---------------- */
  async function initAuth() {
    const cfg = window.TNMM_CONFIG;
    if (!window.supabase) { showAuth('signin', 'The sign-in service could not load. Check your connection and refresh.'); return; }
    state.sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await state.sb.auth.getSession();
    await onSession(data.session);
    state.sb.auth.onAuthStateChange((ev, session) => {
      if (ev === 'SIGNED_OUT' || (ev === 'SIGNED_IN' && (!state.user || state.user.id !== (session && session.user.id)))) onSession(session);
    });
  }
  async function onSession(session) {
    state.user = session ? session.user : null; state.profile = null;
    if (!state.user) return showAuth('signin');
    const { data: prof } = await state.sb.from('tp_profiles').select('*').eq('id', state.user.id).maybeSingle();
    state.profile = prof;
    if (!prof || prof.status !== 'approved') return showPending(prof);
    showApp();
    const { data: rows, error } = await state.sb.from('tnmm_jobs').select('id,title,job,updated_at').eq('owner', state.user.id).order('updated_at', { ascending: false });
    if (error) { setSave('Saved jobs could not be loaded', true); onJobsLoaded([]); return; }
    onJobsLoaded((rows || []).map(r => { const j = T.normaliseJob(r.job || {}); j.id = r.id; j.title = r.title || j.title; j.updatedAt = Date.parse(r.updated_at) || j.updatedAt; return j; }));
  }
  function showApp() {
    $('#authview').hidden = true; $('.shell').hidden = false; $('#dl').hidden = false; $('#who').hidden = false;
    $('#whoname').textContent = (state.profile.full_name || state.profile.email);
    $('#adminbtn').hidden = state.profile.role !== 'admin';
    render();
  }
  function hideApp() { $('.shell').hidden = true; $('#dl').hidden = true; $('#who').hidden = true; $('#authview').hidden = false; }
  function showAuth(mode, msg) {
    hideApp();
    const signup = mode === 'signup';
    $('#authview').innerHTML = `<form class="authbox" id="authform" novalidate>
      <h1>${signup ? 'Request access' : 'Sign in'}</h1>
      <p class="meta">${signup ? 'An admin approves new accounts before they can be used.' : 'Transfer Pricing · TNMM Benchmarking'}</p>
      ${signup ? `<div class="field"><label for="a-name">Full name</label><input id="a-name" autocomplete="name" required></div>` : ''}
      <div class="field"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="a-pass">Password</label><input id="a-pass" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" required></div>
      <p class="autherr" id="autherr" role="alert">${esc(msg || '')}</p>
      <button class="btn primary" type="submit">${signup ? 'Request access' : 'Sign in'}</button>
      <button class="btn ghost" type="button" data-auth="${signup ? 'signin' : 'signup'}">${signup ? 'I already have an account' : 'Request access'}</button>
    </form>`;
    $('#authform').addEventListener('submit', async ev => {
      ev.preventDefault();
      const email = $('#a-email').value.trim().toLowerCase(), password = $('#a-pass').value;
      const err = $('#autherr'); err.textContent = '';
      if (!email || password.length < 8) { err.textContent = 'Enter your email and a password of at least 8 characters.'; return; }
      if (signup) {
        const name = $('#a-name').value.trim();
        if (!name) { err.textContent = 'Enter your full name.'; return; }
        const { data, error } = await state.sb.auth.signUp({ email, password, options: { data: { full_name: name } } });
        if (error) { err.textContent = error.message; return; }
        if (!data.session) { showAuth('signin', 'Request sent. Once an admin approves it, sign in here. If asked, confirm your email first.'); return; }
        onSession(data.session);
      } else {
        const { data, error } = await state.sb.auth.signInWithPassword({ email, password });
        if (error) { err.textContent = error.message === 'Invalid login credentials' ? 'That email and password do not match.' : error.message; return; }
        onSession(data.session);
      }
    });
    $('#a-email').focus();
  }
  function showPending(prof) {
    hideApp();
    const susp = prof && prof.status === 'suspended';
    $('#authview').innerHTML = `<div class="authbox"><h1>${susp ? 'Account suspended' : 'Waiting for approval'}</h1>
      <p>${susp ? 'Your access has been suspended. Contact your admin.' : 'Your request has been received. An admin needs to approve your account before you can use the app.'}</p>
      <p class="meta">${esc(state.user.email)}</p>
      <button class="btn" data-act="recheck">Check again</button><button class="btn ghost" data-act="signout">Sign out</button></div>`;
  }
  async function openAdmin() {
    const { data: users, error } = await state.sb.from('tp_profiles').select('*').order('created_at', { ascending: true });
    const { data: pre } = await state.sb.from('tp_preapproved').select('*').order('email');
    if (error) return toast('Could not load users: ' + error.message);
    const m = document.createElement('div'); m.className = 'modal';
    const row = u => `<tr><td><b>${esc(u.full_name || '–')}</b><br><small class="meta">${esc(u.email)}</small></td>
      <td>${u.role === 'admin' ? 'Admin' : 'Staff'}</td><td>${u.status === 'approved' ? '<span class="chip good">Approved</span>' : u.status === 'pending' ? '<span class="chip warn">Pending</span>' : '<span class="chip bad">Suspended</span>'}</td>
      <td class="acts">${u.id === state.user.id ? '<small class="meta">You</small>' : `
        ${u.status !== 'approved' ? `<button class="btn sm primary" data-u="${u.id}" data-set='{"status":"approved"}'>Approve</button>` : `<button class="btn sm" data-u="${u.id}" data-set='{"status":"suspended"}'>Suspend</button>`}
        ${u.role === 'admin' ? `<button class="btn sm" data-u="${u.id}" data-set='{"role":"staff"}'>Make staff</button>` : `<button class="btn sm" data-u="${u.id}" data-set='{"role":"admin"}'>Make admin</button>`}`}</td></tr>`;
    m.innerHTML = `<div class="box" role="dialog" aria-modal="true" style="max-width:760px;max-height:88vh;overflow:auto">
      <div class="row" style="justify-content:space-between"><h3>Users</h3><button class="btn sm" data-x="no">Close</button></div>
      <table class="r"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${(users || []).map(row).join('')}</tbody></table>
      <h3>Pre-approved emails</h3><p class="meta" style="margin:0">People who sign up with these emails are approved straight away.</p>
      <ul class="notes">${(pre || []).map(p => `<li>${esc(p.email)} (${p.role})</li>`).join('') || '<li>None</li>'}</ul>
      <form class="row" id="preform"><input id="pre-email" type="email" placeholder="name@company.com" style="border:1px solid var(--line);border-radius:6px;padding:6px 8px;flex:1"><select id="pre-role" style="border:1px solid var(--line);border-radius:6px;padding:6px"><option value="staff">Staff</option><option value="admin">Admin</option></select><button class="btn sm primary" type="submit">Add</button></form>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', async ev => {
      if (ev.target.dataset.x === 'no' || ev.target === m) return m.remove();
      const b = ev.target.closest('[data-u]'); if (!b) return;
      const { error: e2 } = await state.sb.from('tp_profiles').update(JSON.parse(b.dataset.set)).eq('id', b.dataset.u);
      if (e2) return toast('Could not update: ' + e2.message);
      m.remove(); openAdmin();
    });
    $('#preform', m).addEventListener('submit', async ev => {
      ev.preventDefault();
      const email = $('#pre-email', m).value.trim().toLowerCase(); if (!email) return;
      const { error: e3 } = await state.sb.from('tp_preapproved').upsert({ email, role: $('#pre-role', m).value });
      if (e3) return toast('Could not add: ' + e3.message);
      m.remove(); openAdmin();
    });
  }
  let firstLoad = true;
  function onJobsLoaded(jobs) {
    firstLoad = true;
    state.jobs = jobs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (firstLoad) {
      firstLoad = false;
      if (state.jobs.length) openJob(state.jobs[0].id); else openExample();
    } else if (state.job && !state.isExample && !saving) {
      // keep the open job; refresh only the list
    }
    renderRail();
  }

  /* ---------------- job actions ---------------- */
  function openExample() { state.job = T.normaliseJob(JSON.parse(JSON.stringify(EXAMPLE))); state.isExample = true; state.tab = 'results'; render(); }
  function openJob(id) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(); }
    const cur = state.job && !state.isExample ? state.jobs.findIndex(x => x.id === state.job.id) : -1;
    if (cur >= 0) state.jobs[cur] = state.job;
    const j = state.jobs.find(x => x.id === id); if (!j) return;
    state.job = T.normaliseJob(JSON.parse(JSON.stringify(j))); state.isExample = false; render();
  }
  function newJob() {
    const j = T.blankJob(); j.id = crypto.randomUUID(); j.title = 'New benchmarking';
    state.jobs.unshift(j); state.job = j; state.isExample = false; state.tab = 'companies';
    touch(); render();
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
      const { error } = await state.sb.from('tnmm_jobs').delete().eq('id', j.id);
      if (error) toast('Could not delete the job: ' + error.message);
      if (state.jobs.length) openJob(state.jobs[0].id); else openExample();
    });
  }

  /* ---------------- rendering ---------------- */
  function render() {
    const fid = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fid : null;
    renderRail(); renderMain();
    if (fid) { const el = document.querySelector(`[data-fid="${CSS.escape(fid)}"]`); if (el) { el.focus(); if (el.select) try { el.select(); } catch (e) { /* not selectable */ } } }
  }

  function renderRail() {
    const list = $('#jobs'); if (!list) return;
    const items = state.jobs.map(j => `<button class="job ${state.job && !state.isExample && state.job.id === j.id ? 'on' : ''}" data-job="${esc(j.id)}"><b>${esc(j.title || 'Untitled')}</b><small>${esc(j.tp && j.tp.name || 'No tested party yet')} · ${new Date(j.updatedAt || Date.now()).toLocaleDateString('en-GB')}</small></button>`).join('');
    list.innerHTML = `<button class="job ${state.isExample ? 'on' : ''}" data-example="1"><b>Example: Pasti Seterus FY2023</b><small>Sample data, not saved</small></button>` + (items || '<p class="empty" style="padding:12px">No saved jobs yet.</p>');
  }

  function renderMain() {
    const m = $('#main'); const job = state.job; if (!job) { m.innerHTML = '<p class="empty">Loading…</p>'; return; }
    const R = T.results(job);
    const accN = R.acc.length;
    m.innerHTML = `
      ${state.isExample ? `<div class="banner">You are viewing the example job. Edits here are not saved; it shows how a finished job looks. <button class="btn sm primary" data-act="save-example">Save as new job</button></div>` : ''}
      ${headerHtml(job)}
      ${tilesHtml(R)}
      <div class="tabs" role="tablist">
        ${[['companies', 'Companies', 1 + job.comps.length], ['calc', 'Calculation'], ['reject', 'Rejection', accN + '/' + job.comps.length + ' accepted'], ['results', 'Results']]
          .map(([k, l, c]) => `<button role="tab" data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${l}${c !== undefined ? `<span class="count">${esc(c)}</span>` : ''}</button>`).join('')}
      </div>
      <section id="tabbody">${state.tab === 'companies' ? companiesHtml(job) : state.tab === 'calc' ? calcHtml(job, R) : state.tab === 'reject' ? rejectHtml(job, R) : resultsHtml(job, R)}</section>`;
    $('#dl').disabled = !job.tp.name && !job.comps.length;
  }

  function headerHtml(job) {
    return `<div class="head">
      <div class="field wide"><label for="f-title">Job title</label><input id="f-title" data-fid="title" data-job-field="title" value="${esc(job.title)}"></div>
      <div class="field"><label for="f-tpfye">Tested party FYE</label><input id="f-tpfye" data-fid="tpfye" data-tp-field="fye" placeholder="31 Dec 2023" value="${esc(job.tp.fye)}"></div>
      <div class="field"><label>Arm's length range basis</label><div class="seg" role="group">
        <button data-basis="YA2023" class="${job.basis === 'YA2023' ? 'on' : ''}">YA 2023 onwards</button>
        <button data-basis="PRE_YA2023" class="${job.basis === 'PRE_YA2023' ? 'on' : ''}">Before YA 2023</button></div></div>
      <div class="field wide"><label for="f-wfrom">Comparable FYE window</label><div class="row">
        <input id="f-wfrom" type="month" data-fid="wfrom" data-job-field="windowFrom" value="${esc(job.windowFrom)}">
        <span>to</span>
        <input id="f-wto" type="month" data-fid="wto" data-job-field="windowTo" value="${esc(job.windowTo)}">
        <button class="btn sm" data-act="suggest-window" title="Six months before and after the tested party FYE">±6 months</button></div></div>
      <div class="field"><label for="f-rpt">RPT threshold</label><div class="row"><input id="f-rpt" class="num" data-fid="rpt" data-job-field="rptThreshold" value="${esc(Math.round(T.num(job.rptThreshold) * 100))}" inputmode="decimal"><span>%</span></div></div>
    </div>`;
  }

  function concChip(c) { return c === 'Within range' ? `<span class="chip good">${c}</span>` : c === 'n/a' ? `<span class="chip mute">Not enough data</span>` : `<span class="chip ${c === 'Below range' ? 'bad' : 'warn'}">${c}</span>`; }
  function tilesHtml(R) {
    return `<div class="tiles">${Object.entries(PLI).map(([k, p]) => {
      const s = R.stat[k];
      return `<div class="tile"><h3>${p.label} · tested party</h3><div class="big num">${p.f(s.tp)}</div>
        <div class="rng num">Range ${p.f(s.lo)} – ${p.f(s.hi)}${s.med !== null ? ' · median ' + p.f(s.med) : ''} · n = ${s.n}</div>${concChip(s.concl)}</div>`;
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
        : `<label class="drop" data-drop="${esc(c.id)}">${f ? `<b>${esc(f.name)}</b> · ${(f.size / 1048576).toFixed(1)} MB<br>Drop another file to replace` : 'Upload audited accounts (PDF or page images)<br>or drop the file here'}<input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" ${f ? '' : ''} data-file="${esc(c.id)}"></label>
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
    if (b.dataset.example) return openExample();
    if (b.dataset.tab) { state.tab = b.dataset.tab; return render(); }
    if (b.dataset.basis) { state.job.basis = b.dataset.basis; touch(); return render(); }
    const act = b.dataset.act; if (!act) return;
    const id = b.dataset.id;
    if (act === 'signout') { await state.sb.auth.signOut(); return; }
    if (act === 'recheck') { const { data } = await state.sb.auth.getSession(); return onSession(data.session); }
    if (act === 'admin') return openAdmin();
    if (act === 'new') return newJob();
    if (act === 'dup') return duplicateJob();
    if (act === 'del') return deleteJob();
    if (act === 'save-example') return saveExampleAsNew();
    if (act === 'download') return downloadExcel();
    if (act === 'add-comp') { state.job.comps.push(T.blankCompany(false)); touch(); return render(); }
    if (act === 'remove-comp') { const c = findCo(id); return confirmBox('Remove comparable?', `${esc(c.name || 'This comparable')} will be removed from this job.`, 'Remove', () => { state.job.comps = state.job.comps.filter(x => x.id !== id); delete state.files[id]; touch(); render(); }); }
    if (act === 'suggest-window') return suggestWindow();
    if (act === 'extract') return extract(id);
    if (act === 'view-ocr') return viewOcr(id);
    if (act === 'stop') { const a = state.aborts[id]; if (a) a.abort(); return; }
    if (act === 'mark-checked') { const c = findCo(id); c.extraction.checked = true; touch(); return render(); }
  }
  function suggestWindow() {
    const d = parseFye(state.job.tp.fye);
    if (!d) return toast('Enter the tested party FYE first, e.g. 31 Dec 2023');
    const from = new Date(d.getFullYear(), d.getMonth() - 5, 1), to = new Date(d.getFullYear(), d.getMonth() + 6, 1);
    const m = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0');
    state.job.windowFrom = m(from); state.job.windowTo = m(to);
    if (!state.job.basis || state.job.basis === 'YA2023' || state.job.basis === 'PRE_YA2023') state.job.basis = d.getFullYear() >= 2023 ? 'YA2023' : 'PRE_YA2023';
    touch(); render();
  }
  function parseFye(s) { if (!s) return null; const d = new Date(String(s).replace(/(\d+)(st|nd|rd|th)/, '$1')); return isNaN(d) ? null : d; }

  /* ---------------- files & extraction (Mistral OCR via the tnmm-ocr Edge Function) ---------------- */
  function onFile(id, fileList) {
    const f = (fileList || [])[0]; if (!f) return;
    if (!/^(application\/pdf|image\/(png|jpeg|webp))$/.test(f.type)) return toast('Upload a PDF or a PNG/JPEG page image.');
    if (f.size > 50 * 1048576) return toast('That file is over 50 MB. Split it or upload only the financial statements.');
    state.files[id] = { file: f, name: f.name, size: f.size };
    delete state.ocr[id];
    const c = findCo(id); c.source = { file: f.name }; touch(); render();
  }
  function setBusy(id, msg, p) { state.busy[id] = { msg, p }; if (state.tab === 'companies') renderMain(); }

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
  async function callFn(body, signal) {
    const { data: sess } = await state.sb.auth.getSession();
    const token = sess.session && sess.session.access_token;
    const r = await fetch(window.TNMM_CONFIG.url + '/functions/v1/tnmm-ocr', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: window.TNMM_CONFIG.key },
      body: JSON.stringify(body)
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || ('Request failed (' + r.status + ')'));
    return out;
  }
  async function extract(id) {
    const job = state.job, c = findCo(id), f = state.files[id];
    if (!c || !f || state.busy[id]) return;
    const ctl = new AbortController(); state.aborts[id] = ctl;
    try {
      let pages = state.ocr[id] ? state.ocr[id].pages : null;
      if (!pages) {
        setBusy(id, 'Uploading the accounts…', 0.1);
        const ext = f.file.type === 'application/pdf' ? 'pdf' : f.file.type.split('/')[1];
        const path = state.user.id + '/' + crypto.randomUUID() + '.' + ext;
        const up = await state.sb.storage.from('tnmm-uploads').upload(path, f.file, { contentType: f.file.type, upsert: false });
        if (up.error) throw new Error('Upload failed: ' + up.error.message);
        setBusy(id, 'Running OCR on every page. Large scans can take a minute…', 0.3);
        const o = await callFn({ action: 'ocr', path }, ctl.signal);
        pages = o.pages || [];
        if (!pages.length) throw new Error('OCR returned no text. Check the file is the audited accounts.');
        state.ocr[id] = { file: f.name, pages };
      }
      const ranked = pages.map((p, i) => ({ p, s: scorePage(p.markdown, i) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 14).map(x => x.p);
      const pick = (ranked.length ? ranked : pages.slice(0, 14)).sort((a, b) => a.index - b.index);
      setBusy(id, `Mapping figures from page${pick.length === 1 ? '' : 's'} ${pick.map(p => p.index + 1).join(', ')}…`, 0.65);
      const win = job.windowFrom && job.windowTo ? `between ${T.fmtMonth(job.windowFrom)} and ${T.fmtMonth(job.windowTo)}` : '';
      const out = await callFn({ action: 'extract', pages: pick, role: c.isTested ? 'tested' : 'comparable', fye: job.tp.fye, window: win }, ctl.signal);
      applyExtraction(c, out.result, pick.map(p => p.index + 1));
      toast(`${c.name || 'Company'}: figures read. Please check them against the accounts.`);
    } catch (e) {
      toast(e && e.name === 'AbortError' ? 'Stopped.' : (e && e.message) || 'Reading failed. Try again.');
    } finally {
      delete state.busy[id]; delete state.aborts[id]; render();
    }
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
    const k = T.calcCompany(c);
    const w = (out.warnings || []).filter(x => x && String(x).trim()).map(String).slice(0, 10);
    if (Math.abs(k.gp - (k.rev + k.cos)) > 1) w.push('Gross profit does not agree.');
    if (k.pbtCheck === false) w.push(`Computed PBT ${fmt(k.pbt)} does not agree to the accounts (${fmt(T.num(c.pbtReported))}). Check the line mapping.`);
    c.warnings = w;
    c.extraction = { at: Date.now(), pages, checked: false };
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

  openExample();
  initAuth();
})();
