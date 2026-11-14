/* TNMM core: model, calculation and Excel export (one benchmark year, v3 rules). */
(function (root) {
  'use strict';

  const PL_KEYS = ['rev','cos','ooi','dist','admin','staff','ooe','fv','intinc','invinc','fin','tax'];
  const PL_LABELS = {
    rev:'Revenue / Turnover', cos:'Cost of sales', gp:'Gross profit',
    ooi:'Other operating income', dist:'Distribution / selling expenses',
    admin:'Administrative expenses', staff:'Staff costs',
    ooe:'Other operating expenses', fv:'Fair value changes on investments',
    pfo:'Profit from operations', intinc:'Interest income',
    invinc:'Investing income', fin:'Finance costs',
    pbt:'Profit / (loss) before taxation', tax:'Income tax expense',
    pat:'Profit / (loss) after taxation'
  };
  const ADJ_KEYS = ['less_interest','less_dividend','adj_invest_disposal','adj_invest_fv',
    'less_rental_nonop','add_ip_depreciation','adj_nontrade_forex','less_exceptional_income','add_exceptional_expense'];
  const ADJ_LABELS = {
    less_interest:'Less: Interest income',
    less_dividend:'Less: Dividend income',
    adj_invest_disposal:'Less / add: (Gain) / loss on disposal of investments',
    adj_invest_fv:'Less / add: Fair value (gain) / loss on investments',
    less_rental_nonop:'Less: Rental income (non-operating)',
    add_ip_depreciation:'Add back: Depreciation of investment properties',
    adj_nontrade_forex:'Less / add: Non-trade foreign exchange (gain) / loss',
    less_exceptional_income:'Less: Exceptional non-recurring income',
    add_exceptional_expense:'Add back: Exceptional non-recurring expense'
  };
  /* Expected sign of each adjustment as a contribution to NormOP: -1 only negative, +1 only positive, 0 either */
  const ADJ_SIGN = { less_interest:-1, less_dividend:-1, adj_invest_disposal:0, adj_invest_fv:0,
    less_rental_nonop:-1, add_ip_depreciation:1, adj_nontrade_forex:0, less_exceptional_income:-1, add_exceptional_expense:1 };
  const BASIS = {
    YA2023:     { lo:0.375, hi:0.625, median:true,  label:'YA 2023 onwards: 37.5th - 62.5th percentile' },
    PRE_YA2023: { lo:0.25,  hi:0.75,  median:false, label:'Before YA 2023: interquartile range (25th - 75th percentile)' }
  };
  const TESTS = [
    { key:'activity', label:'Functional comparability' },
    { key:'data',     label:'Sufficient & verifiable data' },
    { key:'special',  label:'No start-up / bankrupt / dormant' }
  ];

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[,\s]/g, '')); return isFinite(n) ? n : 0; };

  function blankCompany(isTested) {
    const pl = {}; PL_KEYS.forEach(k => pl[k] = 0);
    const adj = {}; ADJ_KEYS.forEach(k => adj[k] = 0);
    return {
      id: uid(), isTested: !!isTested, name: '', regno: '', activity: '', fye: '', fyeDate: '',
      pl, adj, adjNotes: {}, pbtReported: null,
      rpt: { sales: 0, purchases: 0 },
      tests: { activity: 'Pass', data: 'Pass', special: 'Pass' },
      reasons: {}, sizeAcceptedByIrbm: false,
      source: null, extraction: null, keptIn: [], warnings: []
    };
  }

  const LEGACY = { less_gain_quoted:'adj_invest_disposal', less_fvgain:'adj_invest_fv', add_fvloss:'adj_invest_fv', less_rental:'less_rental_nonop' };
  /* Bring a stored or imported company up to the current shape; legacy adjustment keys are mapped, unknown ones dropped. */
  function normaliseCompany(c, isTested) {
    const base = blankCompany(isTested);
    const out = { ...base, ...c, pl: { ...base.pl }, adj: { ...base.adj },
      rpt: { ...base.rpt, ...(c.rpt || {}) }, tests: { ...base.tests, ...(c.tests || {}) } };
    PL_KEYS.forEach(k => out.pl[k] = num(c.pl && c.pl[k]));
    Object.entries(c.adj || {}).forEach(([k, v]) => { const k2 = LEGACY[k] || k; if (ADJ_KEYS.includes(k2)) out.adj[k2] = num(out.adj[k2]) + num(v); });
    return out;
  }
  function normaliseJob(j) {
    const base = blankJob();
    return { ...base, ...j, tp: normaliseCompany(j.tp || {}, true), comps: (j.comps || []).map(c => normaliseCompany(c, false)) };
  }

  function blankJob() {
    return { id: uid(), title: 'New benchmarking', basis: 'YA2023', rptThreshold: 0.2,
      windowFrom: '', windowTo: '', tp: blankCompany(true), comps: [], createdAt: Date.now(), updatedAt: Date.now() };
  }

  /* ---------- calculation ---------- */
  function calcCompany(c) {
    const p = {}; PL_KEYS.forEach(k => p[k] = num(c.pl[k]));
    const gp = p.rev + p.cos;
    const pfo = gp + p.ooi + p.dist + p.admin + p.staff + p.ooe + p.fv;
    const pbt = pfo + p.intinc + p.invinc + p.fin;
    const pat = pbt + p.tax;
    const adjTotal = ADJ_KEYS.reduce((s, k) => s + num(c.adj[k]), 0);
    const normop = pbt - p.fin + adjTotal;
    const opex = -(p.dist + p.admin + p.staff + p.ooe);
    const om = p.rev === 0 ? null : normop / p.rev;
    const ncp = (p.rev - normop) === 0 ? null : normop / (p.rev - normop);
    const berry = opex === 0 ? null : gp / opex;
    const pbtCheck = (c.pbtReported === null || c.pbtReported === undefined || c.pbtReported === '')
      ? null : Math.abs(num(c.pbtReported) - pbt) < 1.5;
    return { ...p, gp, pfo, pbt, pat, adjTotal, normop, opex, om, ncp, berry, pbtCheck };
  }

  /* ---------- dates: FYE and the comparable FYE window (MTPG 2024 paras 4.5-4.7) ---------- */
  const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const pad2 = n => String(n).padStart(2, '0');
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const isIso = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  /* "31 Dec 2023", "31st December 2023", "2023-12-31", "31/12/2023" -> "2023-12-31" ('' if unreadable) */
  function toIso(s) {
    s = String(s || '').trim(); if (!s) return '';
    if (isIso(s)) return s;
    let m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-.]+([A-Za-z]{3,})[\s\-.,]+(\d{4})$/);
    if (m && MON[m[2].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad2(MON[m[2].slice(0, 3).toLowerCase()])}-${pad2(+m[1])}`;
    m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m && MON[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad2(MON[m[1].slice(0, 3).toLowerCase()])}-${pad2(+m[2])}`;
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
    if (m) return `${m[3]}-${pad2(+m[2])}-${pad2(+m[1])}`;
    return '';
  }
  const fyeDateOf = c => (isIso(c.fyeDate) ? c.fyeDate : toIso(c.fye));
  /* Windows saved as 'YYYY-MM' (older jobs) mean the first / last day of that month. */
  function isoDay(v, end) {
    if (!v) return '';
    if (/^\d{4}-\d{2}$/.test(v)) { const [y, m] = v.split('-').map(Number); return `${v}-${pad2(end ? lastDay(y, m) : 1)}`; }
    return isIso(v) ? v : '';
  }
  /* Comparable FYE window: the job's saved dates, otherwise -6/+6 (or -7/+5) months around the tested party FYE. */
  function windowOf(job) {
    const f = isoDay(job.windowFrom, false), t = isoDay(job.windowTo, true);
    if (f && t) return { from: f, to: t };
    const tp = fyeDateOf(job.tp); if (!tp) return { from: '', to: '' };
    const [before, after] = job.windowMode === '7-5' ? [7, 5] : [6, 6];
    const [y, mo] = tp.split('-').map(Number);
    const s = new Date(Date.UTC(y, mo - 1 + 1 - before, 1)), e = new Date(Date.UTC(y, mo - 1 + after, 1));
    return { from: `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-01`,
      to: `${e.getUTCFullYear()}-${pad2(e.getUTCMonth() + 1)}-${pad2(lastDay(e.getUTCFullYear(), e.getUTCMonth() + 1))}` };
  }

  function rejection(job, c) {
    const tpRev = num(job.tp.pl.rev), rev = num(c.pl.rev), cos = num(c.pl.cos), thr = num(job.rptThreshold) || 0.2;
    const sizePass = c.sizeAcceptedByIrbm || rev >= 0.1 * tpRev;
    // RPT sales / turnover; RPT purchases / cost of sales (if no cost of sales, / total costs = turnover - NormOP)
    const rptSalesPct = rev === 0 ? 0 : num(c.rpt.sales) / rev;
    const totalCost = rev - calcCompany(c).normop;
    const rptPurchBase = cos !== 0 ? 'cos' : 'total costs';
    const rptPurchPct = cos !== 0 ? num(c.rpt.purchases) / -cos : (totalCost === 0 ? 0 : num(c.rpt.purchases) / totalCost);
    const rptPass = !(rptSalesPct > thr || rptPurchPct > thr);
    const win = windowOf(job), fd = fyeDateOf(c);
    const fyePass = !!(fd && win.from && win.to && fd >= win.from && fd <= win.to);
    const t = c.tests || {};
    const failed = [];
    if (!sizePass) failed.push('Turnover below 10% of tested party');
    if (!rptPass) failed.push('Related-party transactions above ' + Math.round(thr * 100) + '%');
    if (!fyePass) failed.push(!fd ? 'FYE date missing' : !win.from ? 'Comparable period not set' : 'FYE outside comparable period');
    TESTS.forEach(x => { if ((t[x.key] || 'Pass') !== 'Pass') failed.push(x.label); });
    return { sizePass, rptSalesPct, rptPurchPct, rptPurchBase, rptPass, fyeDate: fd, window: win, fyePass, accepted: failed.length === 0, failed };
  }

  /* Excel PERCENTILE.INC (linear interpolation) */
  function percentile(vals, p) {
    const a = vals.slice().sort((x, y) => x - y), n = a.length;
    if (!n) return null;
    const h = (n - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
    return a[lo] + (h - lo) * (a[hi] - a[lo]);
  }

  function results(job) {
    const b = BASIS[job.basis] || BASIS.YA2023;
    const tp = calcCompany(job.tp);
    const rows = job.comps.map(c => ({ c, calc: calcCompany(c), rej: rejection(job, c) }));
    const acc = rows.filter(r => r.rej.accepted);
    const stat = {};
    ['om', 'ncp', 'berry'].forEach(k => {
      const v = acc.map(r => r.calc[k]).filter(x => x !== null && isFinite(x));
      const lo = percentile(v, b.lo), hi = percentile(v, b.hi);
      const med = b.median && lo !== null ? (lo + hi) / 2 : null;
      const t = tp[k];
      let concl = 'n/a';
      if (t !== null && lo !== null) concl = (t >= lo && t <= hi) ? 'Within range' : (t < lo ? 'Below range' : 'Above range');
      // Adjustment to the median (YA 2023+, TP Rules 2023 r.13(2)(b)): only when Below range; never downwards.
      let alp = null, actual = null, adj = 0;
      if (b.median && med !== null && concl === 'Below range') {
        const base = k === 'om' ? tp.rev : k === 'ncp' ? tp.rev - tp.normop : tp.opex;
        actual = k === 'berry' ? tp.gp : tp.normop;
        alp = med * base; adj = alp - actual;
      }
      stat[k] = { n: v.length, min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null, lo, hi, med, tp: t, concl, values: v, alp, actual, adj };
    });
    return { basis: b, tp, rows, acc, stat };
  }

  /* ---------- Excel export (mirrors tnmm-benchmarking-v3 build_benchmark.py: FYE window test, RPT purchases / cost of sales, adjustment to median) ---------- */
  const colL = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  async function buildWorkbook(ExcelJS, job) {
    const b = BASIS[job.basis] || BASIS.YA2023;
    const thr = num(job.rptThreshold) || 0.2;
    const comps = [job.tp, ...job.comps];
    const cols = comps.map((_, i) => colL(i + 1));      // B, C, ...
    const tpCol = cols[0], compCols = cols.slice(1);
    const by = {}; comps.forEach((c, i) => by[cols[i]] = c);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'TNMM Benchmarking'; wb.calcProperties.fullCalcOnLoad = true;
    const ws = wb.addWorksheet('Calculation', { views: [{ showGridLines: false, state: 'frozen', xSplit: 1 }] });

    const F = (o = {}) => ({ name: 'Arial', size: 10, ...o });
    const BLUE = F({ color: { argb: 'FF0000FF' } }), BLACK = F(), BLACKB = F({ bold: true });
    const GREEN = F({ color: { argb: 'FF008000' } }), WHITEB = F({ bold: true, color: { argb: 'FFFFFFFF' } });
    const TITLE = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF1F3864' } };
    const fill = hex => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + hex } });
    const HDRF = fill('1F3864'), SECF = fill('D9E1F2'), ACCF = fill('E2EFDA'), STATF = fill('FFF2CC'), CONCF = fill('E2EFDA'), SUBHF = fill('2F5597');
    const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } }, BORD = { top: thin, left: thin, bottom: thin, right: thin };
    const NUM2 = '#,##0.00;(#,##0.00);"-"', NUM = '#,##0;(#,##0);"-"', PCT = '0.00%;(0.00%);"-"', MULT = '0.00"x"';

    function setc(sheet, coord, val, font = BLACK, fmt, fl, align, wrap, bord) {
      const c = sheet.getCell(coord);
      c.value = (typeof val === 'string' && val.startsWith('=')) ? { formula: val.slice(1) } : val;
      c.font = font;
      if (fmt) c.numFmt = fmt;
      if (fl) c.fill = fl;
      if (align || wrap) c.alignment = { horizontal: align, wrapText: !!wrap, vertical: 'middle' };
      if (bord) c.border = BORD;
      return c;
    }
    const S = (coord, val, o = {}) => setc(ws, coord, val, o.font, o.fmt, o.fill, o.align, o.wrap, o.bord);
    function section(r, text, fl = SECF, font = BLACKB, extra = []) {
      S('A' + r, text, { font, fill: fl });
      new Set([...cols, ...extra]).forEach(col => { ws.getCell(col + r).fill = fl; });
    }

    let r = 1;
    S('A' + r, 'TRANSFER PRICING BENCHMARKING ANALYSIS - TNMM', { font: TITLE }); r++;
    const sub = `Tested Party: ${job.tp.name || ''}${job.tp.regno ? ' (' + String(job.tp.regno).split(' ')[0] + ')' : ''} | FYE ${job.tp.fye || ''}`;
    S('A' + r, sub, { font: { name: 'Arial', size: 9, italic: true } }); r += 2;
    const W = windowOf(job);
    const win = (W.from && W.to) ? ` (comparable FYE within ${fmtMonth(W.from)} - ${fmtMonth(W.to)})` : '';
    section(r, `BENCHMARK YEAR - Tested Party FYE ${job.tp.fye || ''}${win}`, HDRF, WHITEB); r += 2;
    const DATE = 'dd mmm yyyy';
    const xdate = iso => { if (!isIso(iso)) return null; const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

    [['Company name', 'name', true], ['Registration No.', 'regno', false], ['Business activity', 'activity', false]].forEach(([label, key, isname]) => {
      S('A' + r, label, { font: isname ? BLACKB : BLACK });
      cols.forEach(col => S(col + r, String(by[col][key] || ''), { font: (isname && col === tpCol) ? BLACKB : BLACK, align: 'center', wrap: isname || key === 'activity' }));
      if (isname || key === 'activity') ws.getRow(r).height = 42;
      r++;
    });
    S('A' + r, 'Financial year end');
    cols.forEach(col => S(col + r, String(by[col].fye || ''), { align: 'center' }));
    r++;
    S('A' + r, 'FYE date');
    cols.forEach(col => S(col + r, xdate(fyeDateOf(by[col])), { font: BLUE, fmt: DATE, align: 'center' }));
    const fyedateRow = r; r++;
    S('A' + r, 'Comparable FYE period (from / to)');
    S('B' + r, xdate(W.from), { font: BLUE, fmt: DATE, align: 'center' });
    S('C' + r, xdate(W.to), { font: BLUE, fmt: DATE, align: 'center' });
    const WFROM = `$B$${r}`, WTO = `$C$${r}`;
    r += 2;

    const rows = {};
    section(r, '1.  STATEMENT OF PROFIT OR LOSS'); r++;
    const inrow = k => { S('A' + r, PL_LABELS[k]); cols.forEach(col => S(col + r, num(by[col].pl[k]), { font: BLUE, fmt: NUM2, bord: true })); rows[k] = r++; };
    const frow = (k, fn) => { S('A' + r, PL_LABELS[k], { font: BLACKB }); cols.forEach(col => S(col + r, fn(col), { font: BLACKB, fmt: NUM2, bord: true })); rows[k] = r++; };
    inrow('rev'); inrow('cos');
    frow('gp', c => `=${c}${rows.rev}+${c}${rows.cos}`);
    ['ooi', 'dist', 'admin', 'staff', 'ooe', 'fv'].forEach(inrow);
    frow('pfo', c => '=' + ['gp', 'ooi', 'dist', 'admin', 'staff', 'ooe', 'fv'].map(k => c + rows[k]).join('+'));
    ['intinc', 'invinc', 'fin'].forEach(inrow);
    frow('pbt', c => '=' + ['pfo', 'intinc', 'invinc', 'fin'].map(k => c + rows[k]).join('+'));
    inrow('tax');
    frow('pat', c => `=${c}${rows.pbt}+${c}${rows.tax}`);
    r++;

    section(r, '2.  TNMM ADJUSTMENTS'); r++;
    S('A' + r, 'Profit / (loss) before taxation'); cols.forEach(col => S(col + r, `=${col}${rows.pbt}`, { fmt: NUM2, bord: true }));
    const adjrows = [r]; r++;
    S('A' + r, 'Add back: Finance costs'); cols.forEach(col => S(col + r, `=-${col}${rows.fin}`, { fmt: NUM2, bord: true }));
    adjrows.push(r); r++;
    ADJ_KEYS.forEach(k => { S('A' + r, ADJ_LABELS[k]); cols.forEach(col => S(col + r, num(by[col].adj[k]), { font: BLUE, fmt: NUM2, bord: true })); adjrows.push(r); r++; });
    r++;

    section(r, '3.  NORMALISED OPERATING PROFIT'); r++;
    S('A' + r, 'Normalised operating profit', { font: BLACKB });
    cols.forEach(col => S(col + r, '=' + adjrows.map(x => col + x).join('+'), { font: BLACKB, fmt: NUM2, bord: true, fill: ACCF }));
    rows.normop = r++;
    S('A' + r, 'Total operating expenses');
    cols.forEach(col => S(col + r, `=-(${col}${rows.dist}+${col}${rows.admin}+${col}${rows.staff}+${col}${rows.ooe})`, { fmt: NUM2, bord: true }));
    rows.opex = r; r += 2;

    section(r, '4.  PROFIT LEVEL INDICATORS'); r++;
    S('A' + r, 'Operating margin  (NormOP / Revenue)');
    cols.forEach(col => S(col + r, `=IF(${col}${rows.rev}=0,"",${col}${rows.normop}/${col}${rows.rev})`, { fmt: PCT, bord: true }));
    rows.ros = r++;
    S('A' + r, 'Net cost plus margin  (NormOP / (Revenue - NormOP))');
    cols.forEach(col => S(col + r, `=IF((${col}${rows.rev}-${col}${rows.normop})=0,"",${col}${rows.normop}/(${col}${rows.rev}-${col}${rows.normop}))`, { fmt: PCT, bord: true }));
    rows.ncpm = r++;
    S('A' + r, 'Berry ratio  (Gross profit / Operating expenses)');
    cols.forEach(col => S(col + r, `=IF(${col}${rows.opex}=0,"",${col}${rows.gp}/${col}${rows.opex})`, { fmt: MULT, bord: true }));
    rows.berry = r; r += 3;

    // Rejection criteria (v3): A-K, with the RPT amounts in helper columns M-N
    const hcols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
    section(r, '5.  REJECTION CRITERIA', HDRF, WHITEB, hcols.slice(1)); r += 2;
    const heads = ['Comparable', 'Turnover', "Turnover >= 10% of tested party's revenue?",
      'RPT sales % (of turnover)', 'RPT purchases % (of cost of sales)',
      `RPT sales and purchases each <= ${Math.round(thr * 100)}%?`, 'FYE within comparable period?',
      'Functional comparability?', 'Sufficient & verifiable data?', 'No start-up / bankrupt / dormant?', 'CONCLUSION'];
    hcols.forEach((hc, i) => S(hc + r, heads[i], { font: WHITEB, fill: SUBHF, wrap: true, align: 'center', bord: true }));
    [['M', 'RPT sales'], ['N', 'RPT purchases']].forEach(([hc, t]) => S(hc + r, t, { font: WHITEB, fill: SUBHF, wrap: true, align: 'center', bord: true }));
    ws.getRow(r).height = 48;
    r++;
    const TPrev = `$${tpCol}$${rows.rev}`;
    const rej = {};
    compCols.forEach(col => {
      const cc = by[col];
      S('A' + r, `${cc.name || ''}  (${String(cc.regno || '').split(' ')[0]})`, { wrap: true, bord: true });
      S('B' + r, `=${col}${rows.rev}`, { fmt: NUM, bord: true });
      if (cc.sizeAcceptedByIrbm) S('C' + r, 'Pass', { font: BLUE, align: 'center', bord: true });
      else S('C' + r, `=IF(B${r}>=0.1*${TPrev},"Pass","Fail")`, { align: 'center', bord: true });
      S('M' + r, num(cc.rpt.sales), { font: BLUE, fmt: NUM, bord: true });
      S('N' + r, num(cc.rpt.purchases), { font: BLUE, fmt: NUM, bord: true });
      const cos = `${col}${rows.cos}`, nop = `${col}${rows.normop}`;
      S('D' + r, `=IF(B${r}=0,0,M${r}/B${r})`, { fmt: PCT, bord: true });
      // RPT purchases / cost of sales; if no cost of sales line, / total costs (turnover - NormOP)
      S('E' + r, `=IF(${cos}<>0,N${r}/-${cos},IF((B${r}-${nop})=0,0,N${r}/(B${r}-${nop})))`, { fmt: PCT, bord: true });
      S('F' + r, `=IF(OR(D${r}>${thr},E${r}>${thr}),"Fail","Pass")`, { align: 'center', bord: true });
      const fd = `${col}${fyedateRow}`;
      S('G' + r, `=IF(AND(ISNUMBER(${fd}),${fd}>=${WFROM},${fd}<=${WTO}),"Pass","Fail")`, { align: 'center', bord: true });
      [['H', 'activity'], ['I', 'data'], ['J', 'special']].forEach(([hc, k]) => S(hc + r, (cc.tests && cc.tests[k]) || 'Pass', { font: BLUE, align: 'center', bord: true }));
      S('K' + r, `=IF(AND(C${r}="Pass",F${r}="Pass",G${r}="Pass",H${r}="Pass",I${r}="Pass",J${r}="Pass"),"ACCEPTED","REJECTED")`, { font: BLACKB, align: 'center', bord: true });
      rej[col] = r++;
    });

    ws.getColumn('A').width = 52;
    new Set([...cols, ...hcols.slice(1)]).forEach(col => { ws.getColumn(col).width = 16; });
    ['M', 'N'].forEach(col => { ws.getColumn(col).width = 14; });

    /* Summary */
    const s = wb.addWorksheet('Summary of Interquartile', { views: [{ showGridLines: false }] });
    const SS = (coord, val, o = {}) => setc(s, coord, val, o.font, o.fmt, o.fill, o.align, o.wrap, o.bord);
    SS('A1', "SUMMARY OF ARM'S LENGTH RANGE - TNMM", { font: TITLE });
    r = 3;
    SS('A' + r, `ARM'S LENGTH RANGE - TESTED PARTY FYE ${String(job.tp.fye || '').toUpperCase()}`, { font: WHITEB, fill: HDRF });
    ['B', 'C', 'D', 'E'].forEach(col => { s.getCell(col + r).fill = HDRF; });
    r++;
    SS('A' + r, 'Range basis', { font: BLACKB }); SS('B' + r, b.label); r++;
    SS('A' + r, 'Lower percentile', { font: BLACKB }); SS('B' + r, b.lo, { font: BLUE, fmt: '0.0%' }); const loCell = `$B$${r}`;
    SS('C' + r, 'Upper percentile', { font: BLACKB }); SS('D' + r, b.hi, { font: BLUE, fmt: '0.0%' }); const hiCell = `$D$${r}`;
    r += 2;
    ['Comparable', 'Accepted?', 'Operating margin', 'Net cost plus margin', 'Berry ratio'].forEach((h, i) =>
      SS(['A', 'B', 'C', 'D', 'E'][i] + r, h, { font: WHITEB, fill: SUBHF, wrap: true, align: 'center', bord: true }));
    s.getRow(r).height = 30; r++;
    const first = r;
    compCols.forEach(col => {
      const cc = by[col];
      SS('A' + r, `${cc.name || ''} (${String(cc.regno || '').split(' ')[0]})`, { bord: true });
      SS('B' + r, `=IF(Calculation!K${rej[col]}="ACCEPTED","Yes","No")`, { font: GREEN, align: 'center', bord: true });
      SS('C' + r, `=IF($B${r}="Yes",Calculation!${col}${rows.ros},"")`, { font: GREEN, fmt: PCT, bord: true });
      SS('D' + r, `=IF($B${r}="Yes",Calculation!${col}${rows.ncpm},"")`, { font: GREEN, fmt: PCT, bord: true });
      SS('E' + r, `=IF($B${r}="Yes",Calculation!${col}${rows.berry},"")`, { font: GREEN, fmt: MULT, bord: true });
      r++;
    });
    const last = Math.max(first, r - 1);
    const rng = c => `${c}${first}:${c}${last}`;
    const lines = [['Minimum', 'min'], [`Lower quartile (${b.lo * 100}th percentile)`, 'lo']];
    if (b.median) lines.push(['Median', 'med']);
    lines.push([`Upper quartile (${b.hi * 100}th percentile)`, 'hi'], ['Maximum', 'max']);
    const st = {};
    lines.forEach(([lab, k]) => { SS('A' + r, lab, { font: BLACKB, fill: STATF }); st[k] = r++; });
    [['C', PCT], ['D', PCT], ['E', MULT]].forEach(([col, fmt]) => {
      const o = { font: BLACKB, fmt, fill: STATF, bord: true };
      SS(col + st.min, `=MIN(${rng(col)})`, o);
      SS(col + st.lo, `=PERCENTILE(${rng(col)},${loCell})`, o);
      SS(col + st.hi, `=PERCENTILE(${rng(col)},${hiCell})`, o);
      SS(col + st.max, `=MAX(${rng(col)})`, o);
      if (st.med) SS(col + st.med, `=(${col}${st.lo}+${col}${st.hi})/2`, o);
    });
    SS('A' + r, 'Number of accepted comparables');
    ['C', 'D', 'E'].forEach(col => SS(col + r, `=COUNT(${rng(col)})`, { fmt: '0', bord: true }));
    r++;
    SS('A' + r, `TESTED PARTY - ${job.tp.name || ''}`, { font: BLACKB, fill: CONCF }); SS('B' + r, 'Tested', { font: BLACKB, align: 'center', fill: CONCF });
    SS('C' + r, `=Calculation!${tpCol}${rows.ros}`, { font: GREEN, fmt: PCT, fill: CONCF, bord: true });
    SS('D' + r, `=Calculation!${tpCol}${rows.ncpm}`, { font: GREEN, fmt: PCT, fill: CONCF, bord: true });
    SS('E' + r, `=Calculation!${tpCol}${rows.berry}`, { font: GREEN, fmt: MULT, fill: CONCF, bord: true });
    const tpr = r++;
    SS('A' + r, 'Conclusion', { font: BLACKB });
    ['C', 'D', 'E'].forEach(col => {
      const lo = col + st.lo, hi = col + st.hi;
      SS(col + r, `=IF(${col}${tpr}="","n/a",IF(AND(${col}${tpr}>=${lo},${col}${tpr}<=${hi}),"Within range",IF(${col}${tpr}<${lo},"Below range","Above range")))`, { font: BLACKB, align: 'center', bord: true });
    });
    const concl = r; r++;

    // Adjustment to the median (YA 2023+ only; TP Rules 2023 r.13(2)(b)). Only when Below range.
    if (st.med) {
      r++;
      const t = k => `Calculation!${tpCol}${rows[k]}`;
      const base = { C: t('rev'), D: `(${t('rev')}-${t('normop')})`, E: t('opex') };   // PLI denominator
      const actual = { C: t('normop'), D: t('normop'), E: t('gp') };                    // PLI numerator
      SS('A' + r, 'ADJUSTMENT TO MEDIAN (if below range)', { font: WHITEB, fill: HDRF });
      ['B', 'C', 'D', 'E'].forEach(col => { s.getCell(col + r).fill = HDRF; });
      r++;
      SS('A' + r, "Arm's length profit at median (operating profit; gross profit for Berry ratio)", { wrap: true });
      ['C', 'D', 'E'].forEach(col => SS(col + r, `=IF(${col}${concl}="Below range",${col}${st.med}*${base[col]},"")`, { fmt: NUM2, bord: true }));
      const alp = r++;
      SS('A' + r, 'Actual (normalised operating profit; gross profit for Berry ratio)', { wrap: true });
      ['C', 'D', 'E'].forEach(col => SS(col + r, `=IF(${col}${concl}="Below range",${actual[col]},"")`, { font: GREEN, fmt: NUM2, bord: true }));
      const act = r++;
      SS('A' + r, 'Transfer pricing adjustment (RM)', { font: BLACKB, fill: CONCF });
      ['C', 'D', 'E'].forEach(col => SS(col + r, `=IF(${col}${concl}="Below range",${col}${alp}-${col}${act},0)`, { font: BLACKB, fmt: NUM2, fill: CONCF, bord: true }));
      r++;
    }
    s.getColumn('A').width = 46;
    ['B', 'C', 'D', 'E'].forEach(col => { s.getColumn(col).width = 22; });

    return wb;
  }

  function fmtMonth(iso) {
    if (!iso) return '';
    const d = new Date(iso + (iso.length === 7 ? '-01' : ''));
    return isNaN(d) ? iso : d.toLocaleString('en-GB', { month: 'short', year: 'numeric' });
  }

  const api = { PL_KEYS, PL_LABELS, ADJ_KEYS, ADJ_LABELS, ADJ_SIGN, BASIS, TESTS, uid, num, blankCompany, blankJob, normaliseCompany, normaliseJob,
    calcCompany, rejection, percentile, results, buildWorkbook, fmtMonth, toIso, fyeDateOf, isoDay, windowOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TNMM = api;
})(typeof window !== 'undefined' ? window : globalThis);
