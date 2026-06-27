/* =========================================================
   LEAVE ATLAS — Application Logic
   Author: Built for Abdulla Al Babul's workforce-mgmt stack
   ========================================================= */

/* ---------- 1. CONSTANTS ---------- */
const POLICY = {
  Casual:    { cap: 10,  paid: true },
  Sick:      { cap: 14,  paid: true },
  Annual:    { cap: 20,  paid: true },     // typical Bangladesh Labour Act allowance
  Maternity: { cap: 120, paid: true },
  Others:    { cap: 999, paid: false }
};

// Bangladesh public / festival holidays for the current+next year.
// Lunar dates are approximated — operators can edit before deployment.
const HOLIDAYS_BD = [
  // 2026
  { date: '2026-02-21', name: 'International Mother Language Day' },
  { date: '2026-03-17', name: 'Birthday of Sheikh Mujib / National Children\'s Day' },
  { date: '2026-03-19', name: 'Shab-e-Qadr' },
  { date: '2026-03-20', name: 'Eid-ul-Fitr (approx.)' },
  { date: '2026-03-21', name: 'Eid-ul-Fitr (approx.)' },
  { date: '2026-03-22', name: 'Eid-ul-Fitr (approx.)' },
  { date: '2026-03-26', name: 'Independence Day' },
  { date: '2026-04-14', name: 'Pohela Boishakh' },
  { date: '2026-05-01', name: 'May Day' },
  { date: '2026-05-25', name: 'Buddha Purnima' },
  { date: '2026-05-27', name: 'Eid-ul-Adha (approx.)' },
  { date: '2026-05-28', name: 'Eid-ul-Adha (approx.)' },
  { date: '2026-05-29', name: 'Eid-ul-Adha (approx.)' },
  { date: '2026-06-25', name: 'Ashura (approx.)' },
  { date: '2026-08-15', name: 'National Mourning Day' },
  { date: '2026-08-26', name: 'Janmashtami' },
  { date: '2026-08-26', name: 'Eid-e-Miladunnabi (approx.)' },
  { date: '2026-10-20', name: 'Durga Puja - Bijoya Dashami (approx.)' },
  { date: '2026-12-16', name: 'Victory Day' },
  { date: '2026-12-25', name: 'Christmas Day' },
  // 2027 placeholders
  { date: '2027-02-21', name: 'International Mother Language Day' },
  { date: '2027-03-26', name: 'Independence Day' },
  { date: '2027-04-14', name: 'Pohela Boishakh' },
  { date: '2027-05-01', name: 'May Day' },
  { date: '2027-12-16', name: 'Victory Day' },
  { date: '2027-12-25', name: 'Christmas Day' }
];
const HOLIDAY_SET = new Set(HOLIDAYS_BD.map(h => h.date));

const STORAGE_KEY = 'leave-atlas-projectA-db-v1';
const SETTINGS_KEY = 'leave-atlas-projectA-settings-v1';

/* ---------- 2. STATE / DB ---------- */
let DB = {
  employees: [],
  applications: []  // {id, empId, type, start, end, days, paid, unpaid, holidays, reason, status, decidedBy, decidedAt, remarks, payrollDone, counselDone, appliedAt}
};

let SETTINGS = { apiUrl: '', useRemote: false };
let CURRENT_MODULE = 'apply';
let CURRENT_ROLE   = 'employee';

/* ---------- 3. UTILS ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const fmtDate = d => {
  if (!d) return '—';
  const D = (d instanceof Date) ? d : new Date(d);
  return D.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const ymd = d => {
  const D = (d instanceof Date) ? d : new Date(d);
  return D.toISOString().slice(0, 10);
};
const parseYMD = s => {
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
};
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const daysBetween = (a, b) => Math.round((parseYMD(b) - parseYMD(a)) / 86400000) + 1;

function eachDateInRange(startYMD, endYMD) {
  const out = [];
  let cur = parseYMD(startYMD);
  const end = parseYMD(endYMD);
  while (cur <= end) {
    out.push(ymd(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

function serviceLength(dojYMD) {
  if (!dojYMD) return '—';
  const start = parseYMD(dojYMD);
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (months < 0) { years--; months += 12; }
  return `${years}y ${months}m`;
}

function uid() { return 'A' + Math.random().toString(36).slice(2, 9).toUpperCase(); }

function toast(msg, kind = '') {
  const t = $('#toast');
  $('#toastMsg').textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3000);
}

/* ---------- 4. STORAGE ---------- */
function loadDB() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) DB = JSON.parse(raw);
  } catch(e) { console.warn('load failed', e); }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) SETTINGS = JSON.parse(raw);
  } catch(e) {}
  migrateEmployees();
}

/* Backfill new schema fields onto employees stored under older versions. */
function migrateEmployees() {
  let dirty = false;
  // Fields that should be cleaned of  / NBSP / zero-width chars
  const TEXT_FIELDS = ['name','designation','department','section','subSection',
                       'line','unit','building','floor','mobile','nid'];
  for (const e of (DB.employees || [])) {
    if (!e.status) { e.status = 'Active'; dirty = true; }
    if (!e.docs)   { e.docs = {}; dirty = true; }
    if (e.nid == null) { e.nid = ''; dirty = true; }
    if (e.dob == null) { e.dob = ''; dirty = true; }
    if (e.gender == null) {
      // best-effort: infer from common BD female name fragments used in seed
      e.gender = /Begum|Khatun|Sultana|Akter|Sumi|Fatima|Rina|Salma|Ayesha|Ruma|Selina|Kohinoor|Tania/.test(e.name||'') ? 'F' : 'M';
      dirty = true;
    }
    if (e.customAllocation == null) { e.customAllocation = null; dirty = true; }
    if (e.terminatedAt == null) { e.terminatedAt = ''; dirty = true; }
    if (e.terminationReason == null) { e.terminationReason = ''; dirty = true; }
    if (e.createdAt == null) { e.createdAt = e.doj || ymd(new Date()); dirty = true; }
    if (e.building == null) { e.building = ''; dirty = true; }
    if (e.floor == null) { e.floor = ''; dirty = true; }
    // Scrub  replacement chars and NBSP/zero-width that survived an earlier bad import
    for (const k of TEXT_FIELDS) {
      const v = e[k];
      if (typeof v !== 'string') continue;
      if (/[\uFFFD\u00A0\u2007\u202F\u200B-\u200D\u2060\uFEFF]/.test(v) ||
          /\s{2,}/.test(v)) {
        e[k] = cleanLegacyText(v);
        dirty = true;
      }
    }
  }
  if (dirty) saveDB();
}

/* Repair text fields that were imported under the broken decoder.
   Treats every  as a missing space (almost always correct for this dataset). */
function cleanLegacyText(s) {
  return String(s)
    .replace(/\uFEFF/g, '')
    .replace(/\uFFFD/g, ' ')                  // replacement → space
    .replace(/[\u00A0\u2007\u202F]/g, ' ')    // NBSPs → space
    .replace(/[\u200B-\u200D\u2060]/g, '')    // zero-width → drop
    .replace(/[ \t]+/g, ' ')
    .trim();
}
function saveDB() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(DB));
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS));
}

/* Remote sync (optional). Apps Script endpoint accepts JSON. */
async function remoteCall(action, payload) {
  if (!SETTINGS.useRemote || !SETTINGS.apiUrl) return null;
  try {
    const res = await fetch(SETTINGS.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload })
    });
    return await res.json();
  } catch(e) {
    console.warn('Remote call failed:', e);
    toast('Remote sync failed — staying local', 'error');
    return null;
  }
}

/* Pull the full roster + applications from Google Sheets and replace local
   state. This is what makes the system cross-device-safe: localStorage is
   only a cache, the Sheet is the source of truth. */
async function remotePullAll(silent = false) {
  if (!SETTINGS.useRemote || !SETTINGS.apiUrl) return false;
  if (!silent) toast('Syncing from Google Sheets…', 'ok');
  try {
    const empsRes = await remoteCall('listEmployees', {});
    const appsRes = await remoteCall('listApps', {});
    if (empsRes && empsRes.ok && Array.isArray(empsRes.data)) {
      DB.employees = empsRes.data.map(normaliseRemoteEmp);
    }
    if (appsRes && appsRes.ok && Array.isArray(appsRes.data)) {
      DB.applications = appsRes.data.map(normaliseRemoteApp);
    }
    saveDB();
    SETTINGS.lastSync = new Date().toISOString();
    saveSettings();
    if (!silent) toast(`Synced ${DB.employees.length} employees · ${DB.applications.length} apps`, 'ok');
    return true;
  } catch (e) {
    console.error('Pull failed:', e);
    if (!silent) toast('Could not pull from Sheet — check Settings & deploy URL', 'error');
    return false;
  }
}

/* Apps Script returns JSON-encoded objects for `docs` and `customAllocation`
   as plain strings. Decode them so the dashboard works against them. */
function normaliseRemoteEmp(r) {
  const out = { ...r };
  if (typeof out.docs === 'string' && out.docs.startsWith('{')) {
    try { out.docs = JSON.parse(out.docs); } catch (_) { out.docs = {}; }
  }
  if (typeof out.customAllocation === 'string' && out.customAllocation.startsWith('{')) {
    try { out.customAllocation = JSON.parse(out.customAllocation); } catch (_) { out.customAllocation = null; }
  }
  if (!out.docs) out.docs = {};
  if (out.customAllocation === '' || out.customAllocation === undefined) out.customAllocation = null;
  return out;
}
function normaliseRemoteApp(r) { return { ...r }; }


/* ---------- 6. LEAVE MATH ---------- */
function isWeekend(ymdStr) {
  // Company week-off: Saturday only
  const d = parseYMD(ymdStr);
  return d.getDay() === 6;
}

function calcLeaveSplit(startYMD, endYMD, leaveType) {
  const dates = eachDateInRange(startYMD, endYMD);
  let working = 0, holidays = 0;
  for (const d of dates) {
    if (HOLIDAY_SET.has(d) || isWeekend(d)) holidays++;
    else working++;
  }
  // Bangladesh Labour Act § 115 (Casual) and § 116 (Sick):
  // a weekly holiday or festival holiday falling WITHIN the leave period
  // is counted as part of the leave. For Annual (§ 117) and Maternity,
  // intervening holidays do NOT count against the leave balance.
  const countsIntervening = (leaveType === 'Casual' || leaveType === 'Sick');
  const total = countsIntervening ? dates.length : working;
  return {
    total,
    paid: total,
    unpaid: 0,
    holidays,
    working,
    calendar: dates.length,
    countsIntervening
  };
}

function balanceFor(empId) {
  const year = new Date().getFullYear();
  const used = { Casual: 0, Sick: 0, Annual: 0, Maternity: 0 };
  for (const a of DB.applications) {
    if (a.empId !== empId) continue;
    if (a.status !== 'Approved') continue;
    if (new Date(a.start).getFullYear() !== year) continue;
    if (used[a.type] != null) used[a.type] += a.days;
  }
  return used;
}

/* Return the allocated cap for an employee + leave type.
   If emp.customAllocation has the type → use that.
   Else for paid types (CL/SL/AL), pro-rate from DOJ if joined this year.
   Maternity & Others always use POLICY default.
*/
function allocationFor(emp, type) {
  if (!emp) return POLICY[type] ? POLICY[type].cap : 0;
  const custom = emp.customAllocation || {};
  if (custom[type] != null && custom[type] !== '') return Number(custom[type]);
  if (type === 'Maternity' || type === 'Others') return POLICY[type].cap;
  if (!emp.doj) return POLICY[type].cap;
  const year = new Date().getFullYear();
  const doj = parseYMD(emp.doj);
  if (doj.getFullYear() < year) return POLICY[type].cap;
  if (doj.getFullYear() > year) return 0;
  // Joined this year — pro-rate by remaining months (inclusive of join month)
  const monthsRemaining = 12 - doj.getMonth();
  return Math.round(POLICY[type].cap * monthsRemaining / 12);
}

/* Convenience: full allocation snapshot {CL, SL, AL} for display */
function allocSnapshot(emp) {
  return {
    Casual: allocationFor(emp, 'Casual'),
    Sick:   allocationFor(emp, 'Sick'),
    Annual: allocationFor(emp, 'Annual')
  };
}

function overlappingApplications(empId, startYMD, endYMD, excludeId = null) {
  return DB.applications.filter(a =>
    a.empId === empId &&
    a.id !== excludeId &&
    a.status !== 'Declined' &&
    !(a.end < startYMD || a.start > endYMD)
  );
}

/* ---------- 7. NAV / ROLE ---------- */
function setRole(role) {
  CURRENT_ROLE = role;
  // re-evaluate nav visibility & default module
  const items = $$('#nav a');
  let firstVisible = null;
  items.forEach(a => {
    const roles = (a.dataset.roles || '').split(/\s+/);
    const ok = roles.includes(role) || role === 'hr' && a.dataset.module === 'reports' || role === 'forecast' && a.dataset.module === 'forecast';
    // Be permissive — every role can browse any module, but we'll highlight the relevant one
    a.style.display = '';
  });
  // pick default module per role
  const def = {
    employee:  'apply',
    dept_head: 'approval',
    payroll:   'payroll',
    welfare:   'welfare',
    hr:        'reports',
    forecast:  'forecast',
    hradmin:   'employees'
  }[role] || 'apply';
  navigate(def);
}

function navigate(mod) {
  CURRENT_MODULE = mod;
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.module === mod));
  $$('.module').forEach(m => m.hidden = m.id !== ('mod-' + mod));
  const titles = {
    apply: 'Apply for Leave',
    approval: 'Approval Queue',
    payroll: 'Payroll Entry',
    welfare: 'Welfare & Counseling',
    reports: 'HR Reports',
    forecast: 'Forecast Trends',
    myfile: 'My Leave File',
    employees: 'Employee Admin'
  };
  $('#crumbName').textContent = titles[mod] || '';
  // refresh whichever module was just opened
  if (mod === 'approval') renderApproval();
  if (mod === 'payroll')  renderPayroll();
  if (mod === 'welfare')  renderWelfare();
  if (mod === 'reports')  renderReports();
  if (mod === 'forecast') renderForecast();
  if (mod === 'employees') renderEmployees();
}

/* ---------- 8. MODULE A: APPLY ---------- */
let selectedLeaveType = null;

function bindApply() {
  $$('#leaveTypeChips .chip').forEach(c => c.addEventListener('click', () => {
    $$('#leaveTypeChips .chip').forEach(x => x.classList.remove('selected'));
    c.classList.add('selected');
    selectedLeaveType = c.dataset.type;
    updateInspector();
  }));
  $('#lookupBtn').addEventListener('click', lookupEmployee);
  $('#f-empId').addEventListener('change', lookupEmployee);
  $('#f-start').addEventListener('change', updateInspector);
  $('#f-end').addEventListener('change', updateInspector);
  $('#submitLeaveBtn').addEventListener('click', submitApplication);
  $('#resetFormBtn').addEventListener('click', resetApplyForm);
}

function lookupEmployee() {
  const id = $('#f-empId').value.trim().toUpperCase();
  if (!id) return;
  const emp = DB.employees.find(e => e.id.toUpperCase() === id);
  if (!emp) {
    toast('No employee with that ID', 'error');
    return;
  }
  $('#f-empId').value = emp.id;
  $('#f-name').value  = emp.name;
  $('#f-desig').value = emp.designation;
  $('#f-dept').value  = emp.department;
  $('#f-sec').value   = emp.section;
  $('#f-subsec').value= emp.subSection;
  $('#f-line').value  = emp.line + ' · ' + emp.unit;
  updateInspector();
}

function updateInspector() {
  const start = $('#f-start').value;
  const end   = $('#f-end').value;
  const empId = $('#f-empId').value.trim();
  const findings = $('#findings');
  findings.innerHTML = '';

  // balance bars even without dates
  if (empId) {
    const empRec = DB.employees.find(e => e.id === empId);
    const used = balanceFor(empId);
    setBar('cl', used.Casual,    allocationFor(empRec, 'Casual'));
    setBar('sl', used.Sick,      allocationFor(empRec, 'Sick'));
    setBar('al', used.Annual,    allocationFor(empRec, 'Annual'));
    setBar('ml', used.Maternity, allocationFor(empRec, 'Maternity'));
  } else {
    ['cl','sl','al','ml'].forEach(k => setBar(k, 0, 1, true));
  }

  if (!start || !end) {
    $('#ins-days').textContent = '—';
    $('#ins-daysMeta').textContent = 'Pick dates to compute';
    $('#paid-days').textContent = $('#unpaid-days').textContent = $('#holi-days').textContent = '—';
    addFinding(findings, 'empty');
    return;
  }
  if (start > end) {
    $('#ins-days').textContent = '!';
    $('#ins-daysMeta').textContent = 'End must be on/after start';
    addFinding(findings, 'error', 'End date is before start date.');
    return;
  }

  const split = calcLeaveSplit(start, end, selectedLeaveType);
  $('#ins-days').textContent = split.total;
  $('#ins-daysMeta').textContent = split.countsIntervening
    ? `${split.calendar} calendar days · ${split.holidays} intervening holiday(s) counted as ${selectedLeaveType} (§ 115/116)`
    : `${daysBetween(start,end)} calendar days · ${split.holidays} non-working excluded`;

  let paid = split.paid, unpaid = 0;

  // Policy + balance check
  if (empId && selectedLeaveType) {
    const empRec = DB.employees.find(e => e.id === empId);
    const used = balanceFor(empId);
    const cap  = allocationFor(empRec, selectedLeaveType);
    const taken = used[selectedLeaveType] || 0;
    const remaining = cap - taken;

    if (POLICY[selectedLeaveType].paid && remaining < split.total) {
      const overflow = Math.min(split.total - remaining, split.total);
      paid = Math.max(0, split.total - overflow);
      unpaid = overflow;
      addFinding(findings, 'warn',
        `${selectedLeaveType} balance has ${Math.max(remaining,0)} day(s) left — ${overflow} day(s) will be unpaid.`);
    } else if (POLICY[selectedLeaveType].paid) {
      addFinding(findings, 'ok',
        `Within ${selectedLeaveType} balance · ${remaining - split.total} day(s) remaining after this leave.`);
    } else {
      paid = 0; unpaid = split.total;
      addFinding(findings, 'warn', `"${selectedLeaveType}" is treated as unpaid by policy.`);
    }
  } else if (!selectedLeaveType) {
    addFinding(findings, 'warn', 'Pick a leave type.');
  }

  // Overlap check
  if (empId) {
    const overlaps = overlappingApplications(empId, start, end);
    if (overlaps.length) {
      addFinding(findings, 'error',
        `Overlaps with ${overlaps.length} existing record(s): ` +
        overlaps.map(o => `${o.type} ${o.start}→${o.end} (${o.status})`).join(', '));
    }
  }

  // Holidays in range
  const holisInRange = eachDateInRange(start, end).filter(d => HOLIDAY_SET.has(d));
  if (holisInRange.length) {
    const names = HOLIDAYS_BD.filter(h => holisInRange.includes(h.date)).map(h => h.name).slice(0,3);
    addFinding(findings, 'ok',
      `Range covers ${holisInRange.length} govt./festival holiday(s): ${names.join(', ')}${holisInRange.length>3 ? '…' : ''}. These are excluded from the count.`);
  }

  // Service length finding
  if (empId) {
    const e = DB.employees.find(x => x.id === empId);
    if (e) addFinding(findings, 'ok', `Service length: ${serviceLength(e.doj)} (DOJ ${fmtDate(e.doj)}).`);
  }

  $('#paid-days').textContent   = paid;
  $('#unpaid-days').textContent = unpaid;
  $('#holi-days').textContent   = split.holidays;
}

function setBar(key, used, cap, neutral = false) {
  const pct = Math.min(100, (used / cap) * 100);
  const bar = $(`#bar-${key}`);
  const val = $(`#val-${key}`);
  bar.style.width = pct + '%';
  bar.classList.remove('warn','over');
  if (!neutral) {
    if (pct >= 100) bar.classList.add('over');
    else if (pct >= 70) bar.classList.add('warn');
  }
  val.textContent = neutral ? `— / ${cap}` : `${used} / ${cap}`;
}

function addFinding(el, kind, msg) {
  if (kind === 'empty') {
    el.innerHTML = '<div class="finding-empty">Fill dates and pick a leave type to see findings.</div>';
    return;
  }
  const d = document.createElement('div');
  d.className = 'finding ' + kind;
  const icon = { ok: '✓', warn: '!', error: '×' }[kind] || '·';
  d.innerHTML = `<span class="finding-icon">${icon}</span><span>${msg}</span>`;
  el.appendChild(d);
}

async function submitApplication() {
  const empId = $('#f-empId').value.trim();
  const start = $('#f-start').value;
  const end   = $('#f-end').value;
  const reason= $('#f-reason').value.trim();

  const empRec = DB.employees.find(e => e.id === empId);
  if (!empId || !empRec) return toast('Invalid Employee ID', 'error');
  if (empRec.status === 'Terminated') return toast(`${empId} is marked Terminated — cannot file leave`, 'error');
  if (!selectedLeaveType) return toast('Pick a leave type', 'error');
  if (!start || !end)     return toast('Pick start and end dates', 'error');
  if (start > end)        return toast('End date must be after start', 'error');
  if (overlappingApplications(empId, start, end).length) {
    return toast('Application overlaps existing record', 'error');
  }
  const split = calcLeaveSplit(start, end, selectedLeaveType);
  const used = balanceFor(empId);
  const cap  = allocationFor(empRec, selectedLeaveType);
  let paid = split.paid, unpaid = 0;
  if (POLICY[selectedLeaveType].paid) {
    const remaining = cap - (used[selectedLeaveType] || 0);
    if (remaining < split.total) {
      const overflow = split.total - Math.max(remaining, 0);
      paid = Math.max(0, split.total - overflow);
      unpaid = overflow;
    }
  } else {
    paid = 0; unpaid = split.total;
  }

  const app = {
    id: uid(),
    empId, type: selectedLeaveType,
    start, end,
    days: split.total,
    paid, unpaid,
    holidays: split.holidays,
    reason,
    status: 'Pending',
    remarks: '',
    payrollDone: false,
    counselDone: false,
    appliedAt: ymd(new Date())
  };
  DB.applications.push(app);
  saveDB();
  remoteCall('submit', app);
  toast('Application submitted — routed to Department Head', 'ok');
  resetApplyForm();
  refreshBadges();
}

function resetApplyForm() {
  ['f-empId','f-name','f-desig','f-dept','f-sec','f-subsec','f-line','f-start','f-end','f-reason'].forEach(id => $('#'+id).value='');
  $$('#leaveTypeChips .chip').forEach(c => c.classList.remove('selected'));
  selectedLeaveType = null;
  updateInspector();
}

/* ---------- 9. MODULE B: APPROVAL ---------- */
function renderApproval() {
  const tbody = $('#approval-body');
  const deptSel = $('#approval-dept');
  const search = $('#approval-search').value.trim().toLowerCase();
  const deptFilter = deptSel.value;

  // populate dept dropdown
  const depts = Array.from(new Set(DB.employees.map(e => e.department))).sort();
  const cur = deptSel.value;
  deptSel.innerHTML = '<option value="">All</option>' + depts.map(d => `<option ${d===cur?'selected':''}>${d}</option>`).join('');

  const pending = DB.applications
    .filter(a => a.status === 'Pending')
    .map(a => ({ a, e: DB.employees.find(e => e.id === a.empId) }))
    .filter(({a, e}) => e && (!deptFilter || e.department === deptFilter))
    .filter(({a, e}) => !search || (e.name.toLowerCase().includes(search) || e.id.toLowerCase().includes(search) || e.designation.toLowerCase().includes(search)));

  $('#approvalSummary').textContent = `${pending.length} pending`;

  // shortage check: count approved + pending leaves overlapping today by department
  const todayStr = ymd(new Date());
  const deptHeads = {};
  DB.employees.forEach(e => {
    const key = e.department;
    deptHeads[key] = deptHeads[key] || { total: 0, on: 0 };
    deptHeads[key].total++;
  });
  DB.applications.forEach(a => {
    if (a.status === 'Declined') return;
    if (a.start <= todayStr && a.end >= todayStr) {
      const e = DB.employees.find(x => x.id === a.empId);
      if (e && deptHeads[e.department]) deptHeads[e.department].on++;
    }
  });
  // critical = > 12% absent
  const critical = Object.entries(deptHeads).filter(([k,v]) => v.total > 0 && v.on / v.total > 0.12);
  if (critical.length) {
    $('#shortageBanner').hidden = false;
    $('#sb-detail').textContent = critical
      .map(([k,v]) => `${k} (${v.on}/${v.total} on leave, ${Math.round(v.on/v.total*100)}%)`).join(' · ');
  } else {
    $('#shortageBanner').hidden = true;
  }

  tbody.innerHTML = '';
  if (!pending.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:30px;color:var(--ink-3);font-style:italic">No pending requests.</td></tr>`;
    return;
  }
  pending.forEach(({a, e}, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = a.id;
    const altDates = suggestAlternativeDates(a, e);
    tr.innerHTML = `
      <td>${i+1}</td>
      <td><strong>${e.id}</strong></td>
      <td>
        <span class="tbl-name">${e.name}</span>
        <span class="tbl-meta"><span class="pill ${a.type}">${a.type}</span> · ${a.days}d · paid ${a.paid} / unpaid ${a.unpaid}</span>
      </td>
      <td>${fmtDate(e.doj)}</td>
      <td>${serviceLength(e.doj)}</td>
      <td><strong>${a.days}</strong></td>
      <td>${fmtDate(a.start)}</td>
      <td>${fmtDate(a.end)}</td>
      <td>${e.designation}</td>
      <td class="row-loc">
        <strong>${e.department}</strong> / ${e.section} / ${e.subSection}<br/>
        ${e.line} · ${e.unit}
      </td>
      <td class="actions">
        <button class="tbl-btn approve">Approve</button>
        <button class="tbl-btn decline">Decline</button>
        ${altDates ? `<div class="ai-suggest"><b>AI suggests:</b> ${altDates}</div>` : ''}
      </td>
    `;
    tr.querySelector('.approve').addEventListener('click', () => decide(a.id, 'Approved', tr));
    tr.querySelector('.decline').addEventListener('click', () => {
      const remark = prompt('Reason for decline:', 'Critical manpower shortage');
      if (remark === null) return;
      decide(a.id, 'Declined', tr, remark || 'Declined');
    });
    tbody.appendChild(tr);
  });

  // bind filters once
  if (!$('#approval-dept').dataset.bound) {
    deptSel.addEventListener('change', renderApproval);
    $('#approval-search').addEventListener('input', renderApproval);
    deptSel.dataset.bound = '1';
  }
}

function decide(appId, status, tr, remarks = '') {
  const a = DB.applications.find(x => x.id === appId);
  if (!a) return;
  a.status = status;
  a.remarks = remarks;
  a.decidedAt = ymd(new Date());
  saveDB();
  remoteCall('decide', { id: appId, status, remarks });
  tr.classList.add('vanishing');
  setTimeout(() => { renderApproval(); refreshBadges(); }, 550);
  toast(`${status}: ${a.empId}`, status === 'Approved' ? 'ok' : '');
}

function suggestAlternativeDates(a, e) {
  // For sewing operators in same line, suggest dates with fewer concurrent leaves
  if (!e) return '';
  const sameLine = DB.employees.filter(x => x.line === e.line && x.unit === e.unit).map(x => x.id);
  if (sameLine.length < 3) return '';
  // count concurrent approved/pending in next 30 days
  const today = new Date();
  const conflicts = {};
  for (let d = 0; d < 30; d++) {
    const dt = ymd(addDays(today, d));
    let c = 0;
    DB.applications.forEach(app => {
      if (app.status === 'Declined' || app.id === a.id) return;
      if (!sameLine.includes(app.empId)) return;
      if (app.start <= dt && app.end >= dt) c++;
    });
    conflicts[dt] = c;
  }
  // find earliest gap with same length and no conflicts
  const need = a.days;
  for (let d = 0; d < 25; d++) {
    let ok = true;
    for (let i = 0; i < need; i++) {
      const dt = ymd(addDays(new Date(), d+i));
      if (HOLIDAY_SET.has(dt) || isWeekend(dt)) { ok = false; break; }
      if ((conflicts[dt] || 0) > 0) { ok = false; break; }
    }
    if (ok) {
      const s = ymd(addDays(new Date(), d));
      const en = ymd(addDays(new Date(), d+need-1));
      return `Lower-impact window: ${fmtDate(s)} → ${fmtDate(en)} (line ${e.line} has 0 conflicts)`;
    }
  }
  return '';
}

/* ---------- 10. MODULE C: PAYROLL ---------- */
function renderPayroll() {
  const tbody = $('#payroll-body');
  const search = $('#payroll-search').value.trim().toLowerCase();
  const typeF  = $('#payroll-type').value;

  const items = DB.applications
    .filter(a => a.status === 'Approved' && !a.payrollDone)
    .filter(a => !typeF || a.type === typeF)
    .map(a => ({ a, e: DB.employees.find(e => e.id === a.empId) }))
    .filter(({a, e}) => e && (!search || e.name.toLowerCase().includes(search) || e.id.toLowerCase().includes(search)));

  tbody.innerHTML = '';
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--ink-3);font-style:italic">No approved leaves awaiting entry.</td></tr>`;
    return;
  }
  items.forEach(({a, e}, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = a.id;
    tr.innerHTML = `
      <td>${i+1}</td>
      <td><strong>${e.id}</strong></td>
      <td>${e.name}<span class="tbl-meta">${e.department} · ${e.designation}</span></td>
      <td><span class="pill ${a.type}">${a.type}</span></td>
      <td>${fmtDate(a.start)}</td>
      <td>${fmtDate(a.end)}</td>
      <td><strong>${a.days}</strong> <span class="tbl-meta">P:${a.paid} / U:${a.unpaid}</span></td>
      <td><div class="tick" data-id="${a.id}" role="checkbox" aria-label="Mark entered"></div></td>
    `;
    tr.querySelector('.tick').addEventListener('click', e2 => {
      const t = e2.currentTarget;
      t.classList.add('on');
      setTimeout(() => {
        const ap = DB.applications.find(x => x.id === a.id);
        ap.payrollDone = true; saveDB();
        remoteCall('payrollTick', { id: a.id });
        tr.classList.add('vanishing');
        setTimeout(() => { renderPayroll(); refreshBadges(); }, 550);
      }, 200);
    });
    tbody.appendChild(tr);
  });

  if (!$('#payroll-search').dataset.bound) {
    $('#payroll-search').addEventListener('input', renderPayroll);
    $('#payroll-type').addEventListener('change', renderPayroll);
    $('#payrollCsvBtn').addEventListener('click', () => exportApproved('csv'));
    $('#payrollXlsxBtn').addEventListener('click', () => exportApproved('xlsx'));
    $('#payroll-search').dataset.bound = '1';
  }
}

function exportApproved(kind) {
  const rows = DB.applications
    .filter(a => a.status === 'Approved')
    .map(a => {
      const e = DB.employees.find(x => x.id === a.empId) || {};
      return {
        ID: e.id, Name: e.name, Department: e.department, Section: e.section,
        Designation: e.designation, LeaveType: a.type,
        Start: a.start, End: a.end,
        Days: a.days, Paid: a.paid, Unpaid: a.unpaid,
        EntryDone: a.payrollDone ? 'Yes' : 'No'
      };
    });
  exportRows(rows, 'approved-leaves', kind);
}

/* ---------- 11. MODULE D: WELFARE ---------- */
function renderWelfare() {
  const search = $('#welfare-search').value.trim().toLowerCase();

  const queue = DB.applications
    .filter(a => a.status === 'Declined' && !a.counselDone)
    .map(a => ({ a, e: DB.employees.find(e => e.id === a.empId) }))
    .filter(({a, e}) => e && (!search || e.name.toLowerCase().includes(search) || e.id.toLowerCase().includes(search)));

  const tbody = $('#welfare-body');
  tbody.innerHTML = '';
  if (!queue.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--ink-3);font-style:italic">No active counseling cases.</td></tr>`;
  }
  queue.forEach(({a, e}, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = a.id;
    tr.innerHTML = `
      <td>${i+1}</td>
      <td><strong>${e.id}</strong></td>
      <td>${e.name}<span class="tbl-meta">DOJ ${fmtDate(e.doj)}</span></td>
      <td>${fmtDate(e.doj)}</td>
      <td class="row-loc"><strong>${e.department}</strong> / ${e.section} / ${e.subSection}</td>
      <td>${fmtDate(a.start)}</td>
      <td>${fmtDate(a.end)}</td>
      <td>${a.remarks || '—'}</td>
      <td><div class="tick" role="checkbox"></div></td>
    `;
    tr.querySelector('.tick').addEventListener('click', evt => {
      evt.currentTarget.classList.add('on');
      setTimeout(() => {
        const ap = DB.applications.find(x => x.id === a.id);
        ap.counselDone = true; ap.counseledAt = ymd(new Date()); saveDB();
        remoteCall('welfareTick', { id: a.id });
        tr.classList.add('vanishing');
        setTimeout(() => { renderWelfare(); refreshBadges(); }, 550);
      }, 200);
    });
    tbody.appendChild(tr);
  });

  // historical
  const hist = DB.applications.filter(a => a.status === 'Declined' && a.counselDone);
  const hb = $('#welfare-history-body');
  hb.innerHTML = '';
  hist.forEach(a => {
    const e = DB.employees.find(x => x.id === a.empId) || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${e.id||'—'}</strong></td>
      <td>${e.name||'—'}</td>
      <td>${e.department||'—'}</td>
      <td>${fmtDate(a.start)}</td>
      <td>${fmtDate(a.end)}</td>
      <td>${a.remarks||'—'}</td>
      <td>${fmtDate(a.counseledAt || a.decidedAt)}</td>
    `;
    hb.appendChild(tr);
  });

  if (!$('#welfare-search').dataset.bound) {
    $('#welfare-search').addEventListener('input', renderWelfare);
    $('#welfareCsvBtn').addEventListener('click', () => exportDeclined('csv'));
    $('#welfareXlsxBtn').addEventListener('click', () => exportDeclined('xlsx'));
    $('#welfare-search').dataset.bound = '1';
  }
}

function exportDeclined(kind) {
  const rows = DB.applications
    .filter(a => a.status === 'Declined')
    .map(a => {
      const e = DB.employees.find(x => x.id === a.empId) || {};
      return {
        ID: e.id, Name: e.name, DOJ: e.doj, Department: e.department,
        Section: e.section, SubSection: e.subSection,
        Start: a.start, End: a.end,
        Reason: a.remarks,
        Counseled: a.counselDone ? 'Yes' : 'No',
        CounseledOn: a.counseledAt || ''
      };
    });
  exportRows(rows, 'declined-leaves-history', kind);
}

/* ---------- 12. MODULE E: REPORTS ---------- */
let _charts = {};

function renderReports() {
  const window_ = $('#reportWindow').value;
  const [from, to] = windowRange(window_);
  const inRange = DB.applications.filter(a => a.start <= to && a.end >= from);

  // KPIs
  const apps = inRange.length;
  const days = inRange.reduce((s,a) => s + a.days, 0);
  const decided = inRange.filter(a => a.status !== 'Pending');
  const approved = inRange.filter(a => a.status === 'Approved');
  const apr = decided.length ? Math.round(approved.length / decided.length * 100) : 0;
  const unpaid = inRange.reduce((s,a) => s + (a.unpaid||0), 0);

  $('#kpi-apps').textContent = apps;
  $('#kpi-days').textContent = days;
  $('#kpi-approved').textContent = apr + '%';
  $('#kpi-unpaid').textContent = unpaid;
  $('#reportSummary').textContent = `${fmtDate(from)} → ${fmtDate(to)}`;

  // aggregations
  const byDept = {}, byDesig = {}, byType = {};
  inRange.forEach(a => {
    const e = DB.employees.find(x => x.id === a.empId);
    if (!e) return;
    byDept[e.department]    = (byDept[e.department]    || 0) + a.days;
    byDesig[e.designation]  = (byDesig[e.designation]  || 0) + a.days;
    byType[a.type]          = (byType[a.type]          || 0) + a.days;
  });

  // daily trend over the range
  const trend = {};
  const days_ = eachDateInRange(from, to);
  days_.forEach(d => trend[d] = 0);
  inRange.forEach(a => {
    eachDateInRange(a.start > from ? a.start : from, a.end < to ? a.end : to)
      .forEach(d => { if (trend[d] != null) trend[d]++; });
  });

  drawBar('chart-dept',  Object.keys(byDept),  Object.values(byDept),  '#7A2230');
  const desigTop = Object.entries(byDesig).sort((a,b)=>b[1]-a[1]).slice(0,8);
  drawBar('chart-desig', desigTop.map(x=>x[0]), desigTop.map(x=>x[1]), '#C18A2C');
  drawDoughnut('chart-type', Object.keys(byType), Object.values(byType));
  drawLine('chart-trend', Object.keys(trend), Object.values(trend), '#4D6B4B');

  if (!$('#reportWindow').dataset.bound) {
    $('#reportWindow').addEventListener('change', renderReports);
    $('#reportWindow').dataset.bound = '1';
  }
}

function windowRange(w) {
  const now = new Date();
  let from, to;
  if (w === 'day')     { from = to = ymd(now); }
  else if (w === 'week')    { const d = now.getDay(); from = ymd(addDays(now, -d)); to = ymd(addDays(now, 6-d)); }
  else if (w === 'month')   { from = ymd(new Date(now.getFullYear(), now.getMonth(), 1)); to = ymd(new Date(now.getFullYear(), now.getMonth()+1, 0)); }
  else if (w === 'quarter') { const q = Math.floor(now.getMonth()/3); from = ymd(new Date(now.getFullYear(), q*3, 1)); to = ymd(new Date(now.getFullYear(), q*3+3, 0)); }
  else                      { from = ymd(new Date(now.getFullYear(), 0, 1)); to = ymd(new Date(now.getFullYear(), 11, 31)); }
  return [from, to];
}

function destroyChart(id) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}

function drawBar(id, labels, data, color) {
  destroyChart(id);
  _charts[id] = new Chart($('#'+id), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: color, borderRadius: 2, borderWidth: 0 }] },
    options: chartCommon({ legend: false })
  });
}
function drawDoughnut(id, labels, data) {
  destroyChart(id);
  const palette = ['#7A2230','#C18A2C','#4D6B4B','#2B3A6B','#5C5F66'];
  _charts[id] = new Chart($('#'+id), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: palette, borderWidth: 0 }] },
    options: { ...chartCommon({ legend: true }), cutout: '60%' }
  });
}
function drawLine(id, labels, data, color) {
  destroyChart(id);
  _charts[id] = new Chart($('#'+id), {
    type: 'line',
    data: { labels, datasets: [{
      data, borderColor: color, backgroundColor: 'rgba(77,107,75,.15)',
      fill: true, tension: .3, pointRadius: 0, borderWidth: 2
    }]},
    options: chartCommon({ legend: false })
  });
}
function chartCommon({ legend }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: legend ? { position: 'right', labels: { font: { family: 'Manrope', size: 11 }, color: '#34363B' } } : { display: false },
      tooltip: { backgroundColor: '#1B1C1F', titleFont: { family: 'Manrope' }, bodyFont: { family: 'JetBrains Mono' } }
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { family: 'Manrope', size: 10 }, color: '#5C5F66', maxRotation: 40, minRotation: 0 } },
      y: { grid: { color: 'rgba(0,0,0,.06)' }, ticks: { font: { family: 'JetBrains Mono', size: 10 }, color: '#5C5F66' }, beginAtZero: true }
    }
  };
}

/* ---------- 13. MODULE F: FORECAST ---------- */
function renderForecast() {
  // Absenteeism next 30 days — combines current pipeline + simple seasonal expected baseline
  const today = new Date();
  const labels = [], pipeline = [], baseline = [];
  for (let d = 0; d < 30; d++) {
    const date = ymd(addDays(today, d));
    labels.push(fmtDate(date).slice(0, 6));
    // pipeline = currently approved + pending overlapping that date
    let count = 0;
    DB.applications.forEach(a => {
      if (a.status === 'Declined') return;
      if (a.start <= date && a.end >= date) count++;
    });
    pipeline.push(count);
    // baseline = historical average for that weekday + festival surge
    const wd = parseYMD(date).getDay();
    let base = 3 + (wd === 6 ? 2 : 0) + (wd === 0 ? 1 : 0);
    if (HOLIDAY_SET.has(date) ||
        HOLIDAY_SET.has(ymd(addDays(parseYMD(date), 1))) ||
        HOLIDAY_SET.has(ymd(addDays(parseYMD(date), -1)))) base += 6;
    baseline.push(base);
  }

  destroyChart('chart-absent');
  _charts['chart-absent'] = new Chart($('#chart-absent'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Pipeline (approved+pending)', data: pipeline, borderColor: '#7A2230', backgroundColor: 'rgba(122,34,48,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 },
      { label: 'Baseline expected',            data: baseline, borderColor: '#C18A2C', borderDash: [4,3], pointRadius: 0, borderWidth: 2, fill: false }
    ]},
    options: chartCommon({ legend: true })
  });
  const peakIdx = pipeline.indexOf(Math.max(...pipeline));
  $('#absent-note').textContent =
    pipeline.some(v => v > 0)
      ? `Highest projected absence: ${pipeline[peakIdx]} on ${labels[peakIdx]}. Baseline assumes pre-/post-holiday surges and weekend lift.`
      : 'No leave currently in the 30-day pipeline; baseline shown for planning only.';

  // Seasonal pattern — leave days per month (year so far + projection for remaining months)
  const monthDays = new Array(12).fill(0);
  DB.applications.forEach(a => {
    if (a.status === 'Declined') return;
    const m = parseYMD(a.start).getMonth();
    monthDays[m] += a.days;
  });
  const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  destroyChart('chart-season');
  _charts['chart-season'] = new Chart($('#chart-season'), {
    type: 'bar',
    data: { labels: monthLabels, datasets: [{ data: monthDays, backgroundColor: monthLabels.map((_,i)=>festivalMonthColor(i)), borderRadius: 2 }] },
    options: chartCommon({ legend: false })
  });

  // Festival pressure cards
  const festivals = [
    { name: 'Eid-ul-Fitr',   keys: ['Eid-ul-Fitr'] },
    { name: 'Eid-ul-Adha',   keys: ['Eid-ul-Adha'] },
    { name: 'Pohela Boishakh', keys: ['Pohela Boishakh'] },
    { name: 'Durga Puja',    keys: ['Durga Puja'] },
    { name: 'Victory Day',   keys: ['Victory Day'] }
  ];
  const fc = $('#festival-cards');
  fc.innerHTML = '';
  const nowYr = today.getFullYear();
  festivals.forEach(f => {
    const dates = HOLIDAYS_BD.filter(h => f.keys.some(k => h.name.includes(k)) && h.date.startsWith(nowYr)).map(h => h.date);
    if (!dates.length) return;
    const first = dates[0];
    const last  = dates[dates.length-1];
    // pressure = total employees with overlapping or adjacent leave (±5 days)
    const winStart = ymd(addDays(parseYMD(first), -5));
    const winEnd   = ymd(addDays(parseYMD(last),  5));
    const involved = DB.applications.filter(a => a.status !== 'Declined' && a.start <= winEnd && a.end >= winStart).length;
    const pctOfWorkforce = DB.employees.length ? Math.round(involved / DB.employees.length * 100) : 0;
    const d = document.createElement('div');
    d.className = 'festival';
    d.innerHTML = `
      <div class="festival-name">${f.name}</div>
      <div class="festival-date">${first}${last !== first ? ' → ' + last : ''}</div>
      <div class="festival-pressure">${involved}</div>
      <div class="festival-sub">people on leave in surge window · ${pctOfWorkforce}% of workforce</div>
    `;
    fc.appendChild(d);
  });

  // Production risk heatmap by department (next 14 days, value 0-5)
  const heat = $('#prodHeat');
  heat.innerHTML = '';
  const depts = Array.from(new Set(DB.employees.map(e => e.department))).sort();
  depts.forEach(dep => {
    const total = DB.employees.filter(e => e.department === dep).length;
    if (!total) return;
    const row = document.createElement('div');
    row.className = 'heat-row';
    row.innerHTML = `<div class="heat-label">${dep}</div><div class="heat-cells"></div>`;
    const cells = row.querySelector('.heat-cells');
    for (let d = 0; d < 14; d++) {
      const date = ymd(addDays(today, d));
      let on = 0;
      DB.applications.forEach(a => {
        if (a.status === 'Declined') return;
        if (a.start <= date && a.end >= date) {
          const e = DB.employees.find(x => x.id === a.empId);
          if (e && e.department === dep) on++;
        }
      });
      const pct = on / total;
      let v = 0;
      if (pct > 0)    v = 1;
      if (pct >= .05) v = 2;
      if (pct >= .10) v = 3;
      if (pct >= .15) v = 4;
      if (pct >= .20) v = 5;
      const c = document.createElement('div');
      c.className = 'heat-cell';
      c.dataset.v = v;
      c.title = `${dep} on ${date}: ${on}/${total} (${Math.round(pct*100)}%)`;
      cells.appendChild(c);
    }
    heat.appendChild(row);
  });

  // Manpower gap by department (next 30 days projected)
  const gapLabels = [], gapData = [];
  depts.forEach(dep => {
    const total = DB.employees.filter(e => e.department === dep).length;
    if (!total) return;
    let peakOn = 0;
    for (let d = 0; d < 30; d++) {
      const date = ymd(addDays(today, d));
      let on = 0;
      DB.applications.forEach(a => {
        if (a.status === 'Declined') return;
        if (a.start <= date && a.end >= date) {
          const e = DB.employees.find(x => x.id === a.empId);
          if (e && e.department === dep) on++;
        }
      });
      if (on > peakOn) peakOn = on;
    }
    gapLabels.push(dep);
    gapData.push(peakOn);
  });
  drawBar('chart-gap', gapLabels, gapData, '#2B3A6B');
}

function festivalMonthColor(monthIdx) {
  // mark festival-heavy months in oxblood, others in sage tone
  const festMonths = [2,3,4,5,9,11]; // Mar/Apr/May/Jun/Oct/Dec roughly
  return festMonths.includes(monthIdx) ? '#7A2230' : '#4D6B4B';
}

/* ---------- 14. MODULE G: MY FILE ---------- */
function bindMyFile() {
  $('#openFileBtn').addEventListener('click', () => {
    const mob = $('#mobile-input').value.trim();
    const picked = $('#mobile-empPick').value;
    let emp = null;
    if (picked) emp = DB.employees.find(e => e.id === picked);
    if (!emp && mob) {
      emp = DB.employees.find(e => (e.mobile || '').replace(/\D/g,'').endsWith(mob.replace(/\D/g,'').slice(-9)));
    }
    if (!emp) { toast('No matching employee found', 'error'); return; }
    renderMyFile(emp);
  });
  $('#closeFileBtn').addEventListener('click', () => {
    $('#mobileFile').hidden = true;
    $('#mobileGate').hidden = false;
  });
}

function populateMobilePicker() {
  const sel = $('#mobile-empPick');
  sel.innerHTML = '<option value="">— select —</option>' +
    DB.employees.slice(0, 30).map(e => `<option value="${e.id}">${e.id} · ${e.name}</option>`).join('');
}

function renderMyFile(emp) {
  $('#mobileGate').hidden = true;
  $('#mobileFile').hidden = false;
  $('#prof-mark').textContent = emp.name[0];
  $('#prof-name').textContent = emp.name;
  $('#prof-meta').textContent = `${emp.id} · ${emp.designation} · ${emp.department} / ${emp.section} · DOJ ${fmtDate(emp.doj)} · Service ${serviceLength(emp.doj)}`;

  const used = balanceFor(emp.id);
  $('#q-cl').textContent = used.Casual    || 0;
  $('#q-sl').textContent = used.Sick      || 0;
  $('#q-al').textContent = used.Annual    || 0;
  $('#q-ml').textContent = used.Maternity || 0;

  const records = DB.applications.filter(a => a.empId === emp.id).sort((a,b) => b.start.localeCompare(a.start));
  const tb = $('#myfile-body');
  tb.innerHTML = '';
  if (!records.length) {
    tb.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--ink-3);font-style:italic">No records yet.</td></tr>`;
    return;
  }
  records.forEach(a => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDate(a.appliedAt)}</td>
      <td><span class="pill ${a.type}">${a.type}</span></td>
      <td>${fmtDate(a.start)}</td>
      <td>${fmtDate(a.end)}</td>
      <td><strong>${a.days}</strong></td>
      <td>P:${a.paid} / U:${a.unpaid}</td>
      <td>${a.status}${a.remarks ? ' · ' + a.remarks : ''}</td>
    `;
    tb.appendChild(tr);
  });
}

/* ---------- 15. EXPORTS ---------- */
function exportRows(rows, name, kind) {
  if (!rows.length) return toast('Nothing to export', 'error');
  if (kind === 'xlsx') {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 30));
    XLSX.writeFile(wb, `${name}.xlsx`);
  } else {
    const head = Object.keys(rows[0]);
    const csv  = [head.join(',')]
      .concat(rows.map(r => head.map(h => `"${String(r[h] ?? '').replace(/"/g,'""')}"`).join(',')))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.csv`;
    a.click();
  }
  toast(`Downloaded ${name}.${kind}`, 'ok');
}

/* ---------- 16. BADGES & GLOBAL REFRESH ---------- */
function refreshBadges() {
  const pending  = DB.applications.filter(a => a.status === 'Pending').length;
  const payroll  = DB.applications.filter(a => a.status === 'Approved' && !a.payrollDone).length;
  const welfare  = DB.applications.filter(a => a.status === 'Declined' && !a.counselDone).length;
  // Pending docs = active employees with doc-completeness below threshold
  const pendingDocs = DB.employees.filter(e => e.status === 'Active' && docCompleteness(e).missing > 0).length;
  setBadge('badge-approval', pending);
  setBadge('badge-payroll',  payroll);
  setBadge('badge-welfare',  welfare);
  setBadge('badge-employees', pendingDocs);
}
function setBadge(id, n) {
  const el = $('#'+id);
  if (!el) return;
  el.textContent = n;
  el.classList.toggle('zero', n === 0);
}

function refreshAll() {
  refreshBadges();
  if (CURRENT_MODULE === 'apply')    updateInspector();
  if (CURRENT_MODULE === 'approval') renderApproval();
  if (CURRENT_MODULE === 'payroll')  renderPayroll();
  if (CURRENT_MODULE === 'welfare')  renderWelfare();
  if (CURRENT_MODULE === 'reports')  renderReports();
  if (CURRENT_MODULE === 'forecast') renderForecast();
  if (CURRENT_MODULE === 'employees') renderEmployees();
  populateMobilePicker();
  syncWelcomeBanner();
  updateSyncStatusLine();
}

/* ---------- 17. MODULE H: EMPLOYEE ADMIN ---------- */

const DOC_KEYS = [
  ['nid',           'NID / Birth Cert'],
  ['photo',         'Passport photos'],
  ['joiningLetter', 'Joining letter'],
  ['contract',      'Appointment / Contract'],
  ['bankAccount',   'Bank account'],
  ['medical',       'Medical fitness'],
  ['education',     'Educational certs'],
  ['release',       'Previous release'],
  ['serviceBook',   'Service book'],
  ['emergency',     'Emergency contact']
];

function docCompleteness(emp) {
  const docs = emp.docs || {};
  let have = 0;
  DOC_KEYS.forEach(([k]) => { if (docs[k]) have++; });
  return { have, total: DOC_KEYS.length, missing: DOC_KEYS.length - have };
}

function serviceLength(doj) {
  if (!doj) return '—';
  const a = parseYMD(doj), b = new Date();
  let y = b.getFullYear() - a.getFullYear();
  let m = b.getMonth() - a.getMonth();
  if (b.getDate() < a.getDate()) m--;
  if (m < 0) { y--; m += 12; }
  if (y < 0) return '—';
  if (y === 0 && m === 0) return '< 1 mo';
  return `${y}y ${m}m`;
}

function nextEmpId() {
  // EMP-#### scheme; bump above current max
  let max = 1000;
  DB.employees.forEach(e => {
    const m = /EMP-(\d+)/.exec(e.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'EMP-' + (max + 1);
}

function renderEmployees() {
  // KPI strip
  const today = new Date();
  const monthAgo = addDays(today, -30);
  const active = DB.employees.filter(e => e.status === 'Active');
  const joined = DB.employees.filter(e => e.doj && parseYMD(e.doj) >= monthAgo && parseYMD(e.doj) <= today);
  const terminated = DB.employees.filter(e => e.status === 'Terminated' && e.terminatedAt && parseYMD(e.terminatedAt) >= monthAgo);
  const pendingDocsCount = active.filter(e => docCompleteness(e).missing > 0).length;
  const totalMissingDocs = active.reduce((s,e) => s + docCompleteness(e).missing, 0);

  $('#empKpiActive').textContent = active.length;
  $('#empKpiJoined').textContent = joined.length;
  $('#empKpiTerminated').textContent = terminated.length;
  $('#empKpiPendingDocs').textContent = pendingDocsCount;
  $('#empKpiPendingMeta').textContent = totalMissingDocs ? `${totalMissingDocs} docs missing across roster` : 'roster complete';

  // populate dept filter
  const deptSel = $('#empDeptFilter');
  const depts = Array.from(new Set(DB.employees.map(e => e.department).filter(Boolean))).sort();
  const prev = deptSel.value;
  deptSel.innerHTML = '<option value="">All departments</option>' +
    depts.map(d => `<option value="${d}">${d}</option>`).join('');
  if (prev && depts.includes(prev)) deptSel.value = prev;

  // populate designation + dept datalist for the dialog
  $('#empF-department-list').innerHTML = depts.map(d => `<option value="${d}">`).join('');
  const desigs = Array.from(new Set(DB.employees.map(e => e.designation).filter(Boolean))).sort();
  $('#empF-designation-list').innerHTML = desigs.map(d => `<option value="${d}">`).join('');

  // table
  const status = $('#empStatusFilter').value;
  const dept   = deptSel.value;
  const q      = ($('#empSearch').value || '').trim().toLowerCase();

  let rows = DB.employees.slice();
  if (status) rows = rows.filter(e => e.status === status);
  if (dept)   rows = rows.filter(e => e.department === dept);
  if (q) {
    rows = rows.filter(e =>
      (e.id||'').toLowerCase().includes(q) ||
      (e.name||'').toLowerCase().includes(q) ||
      (e.mobile||'').toLowerCase().includes(q) ||
      (e.nid||'').toLowerCase().includes(q)
    );
  }
  rows.sort((a,b) => (b.doj||'').localeCompare(a.doj||''));

  const tbody = $('#emp-body');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="tbl-empty"><span class="big">No employees match.</span>Try a different filter, or use Add / Bulk Import.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(e => {
    const dc = docCompleteness(e);
    const pct = Math.round(dc.have / dc.total * 100);
    const ringCls = pct >= 90 ? '' : pct >= 60 ? 'partial' : 'low';
    const alloc = allocSnapshot(e);
    const used  = balanceFor(e.id);
    const remCL = Math.max(0, alloc.Casual - used.Casual);
    const remSL = Math.max(0, alloc.Sick - used.Sick);
    const remAL = Math.max(0, alloc.Annual - used.Annual);
    const selected = _empSelected.has(e.id) ? 'row-selected' : '';
    const checked  = _empSelected.has(e.id) ? 'checked' : '';
    return `<tr data-id="${e.id}" class="${selected}">
      <td class="emp-cb-col"><input type="checkbox" class="emp-cb" data-id="${e.id}" ${checked}/></td>
      <td><strong>${e.id}</strong></td>
      <td class="emp-name-cell">
        <strong>${escapeHtml(e.name)}</strong>
        <span class="emp-mobile">${escapeHtml(e.mobile || '—')}</span>
      </td>
      <td>${escapeHtml(e.designation || '—')}</td>
      <td>${escapeHtml(e.department || '—')}<span class="tbl-meta">${escapeHtml(e.section||'—')} · ${escapeHtml(e.line||'—')} · ${escapeHtml(e.unit||'—')}</span>${(e.building || e.floor) ? `<span class="tbl-meta">${escapeHtml(e.building||'—')} · ${escapeHtml(e.floor||'—')}</span>` : ''}</td>
      <td>${fmtDate(e.doj)}<span class="tbl-meta">${serviceLength(e.doj)}</span></td>
      <td><span class="emp-status emp-status-${e.status}">${e.status}</span>${e.terminatedAt ? `<span class="tbl-meta">${fmtDate(e.terminatedAt)}</span>` : ''}</td>
      <td>
        <span class="emp-doc-badge">
          <span class="emp-doc-ring ${ringCls}" style="--p:${pct}"><span class="emp-doc-ring-text">${dc.have}</span></span>
          /${dc.total}
        </span>
      </td>
      <td>
        <div class="emp-alloc">
          <span class="emp-alloc-cell"><span class="lbl">CL</span><span class="val">${remCL}/${alloc.Casual}</span></span>
          <span class="emp-alloc-cell"><span class="lbl">SL</span><span class="val">${remSL}/${alloc.Sick}</span></span>
          <span class="emp-alloc-cell"><span class="lbl">AL</span><span class="val">${remAL}/${alloc.Annual}</span></span>
        </div>
      </td>
      <td class="emp-actions-cell">
        <button class="emp-row-btn" data-act="edit" data-id="${e.id}">Edit</button>
        ${e.status === 'Active'
            ? `<button class="emp-row-btn warn" data-act="terminate" data-id="${e.id}">Terminate</button>`
            : `<button class="emp-row-btn ok" data-act="reactivate" data-id="${e.id}">Reactivate</button>`
        }
        <button class="emp-row-btn warn" data-act="delete" data-id="${e.id}" title="Permanently remove">Delete</button>
      </td>
    </tr>`;
  }).join('');

  // bind row checkboxes
  tbody.querySelectorAll('.emp-cb').forEach(cb => {
    cb.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = cb.dataset.id;
      if (cb.checked) _empSelected.add(id); else _empSelected.delete(id);
      const tr = cb.closest('tr');
      if (tr) tr.classList.toggle('row-selected', cb.checked);
      syncBulkBar();
    });
  });

  // bind action buttons
  tbody.querySelectorAll('.emp-row-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'edit')        openEmployeeDialog(id);
      if (act === 'terminate')   openTerminateDialog(id);
      if (act === 'reactivate')  reactivateEmployee(id);
      if (act === 'delete')      deleteSingleEmployee(id);
    });
  });
  syncBulkBar();
}

/* Empty-state tbody also has to span the right number of columns now (10) */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---- Add / Edit dialog ---- */
let _empEditingId = null;

function openEmployeeDialog(idOrNull) {
  const dlg = $('#empDialog');
  _empEditingId = idOrNull || null;
  const isEdit = !!idOrNull;
  $('#empDialogTitle').textContent = isEdit ? 'Edit Employee' : 'Add Employee';
  $('#empDialogSave').textContent  = isEdit ? 'Save Changes' : 'Save Employee';

  // reset
  const form = dlg.querySelector('form');
  form.reset();
  ['nid','photo','joiningLetter','contract','bankAccount','medical','education','release','serviceBook','emergency']
    .forEach(k => { const cb = form.querySelector(`[data-doc="${k}"]`); if (cb) cb.checked = false; });

  if (isEdit) {
    const e = DB.employees.find(x => x.id === idOrNull);
    if (!e) return;
    $('#empF-id').value = e.id;
    $('#empF-id').readOnly = true;
    $('#empF-name').value = e.name || '';
    $('#empF-mobile').value = e.mobile || '';
    $('#empF-nid').value = e.nid || '';
    $('#empF-dob').value = e.dob || '';
    $('#empF-gender').value = e.gender || '';
    $('#empF-doj').value = e.doj || '';
    $('#empF-designation').value = e.designation || '';
    $('#empF-department').value = e.department || '';
    $('#empF-section').value = e.section || '';
    $('#empF-subSection').value = e.subSection || '';
    $('#empF-line').value = e.line || '';
    $('#empF-unit').value = e.unit || '';
    $('#empF-building').value = e.building || '';
    $('#empF-floor').value = e.floor || '';
    // allocation
    if (e.customAllocation && (e.customAllocation.Casual != null)) {
      $('#allocCustom').checked = true;
      $('#empF-allocCL').value = e.customAllocation.Casual;
      $('#empF-allocSL').value = e.customAllocation.Sick;
      $('#empF-allocAL').value = e.customAllocation.Annual;
    } else {
      $('#allocAuto').checked = true;
      const snap = allocSnapshot(e);
      $('#empF-allocCL').value = snap.Casual;
      $('#empF-allocSL').value = snap.Sick;
      $('#empF-allocAL').value = snap.Annual;
    }
    // docs
    DOC_KEYS.forEach(([k]) => {
      const cb = form.querySelector(`[data-doc="${k}"]`);
      if (cb) cb.checked = !!(e.docs && e.docs[k]);
    });
  } else {
    $('#empF-id').readOnly = false;
    $('#empF-id').value = nextEmpId();
    $('#empF-doj').value = ymd(new Date());
    $('#allocAuto').checked = true;
    updateAllocFromDOJ();
  }

  syncAllocMode();
  dlg.showModal();
}

function syncAllocMode() {
  const auto = $('#allocAuto').checked;
  ['empF-allocCL','empF-allocSL','empF-allocAL'].forEach(id => {
    $('#' + id).disabled = auto;
  });
  if (auto) updateAllocFromDOJ();
}

function updateAllocFromDOJ() {
  if (!$('#allocAuto').checked) return;
  const doj = $('#empF-doj').value;
  if (!doj) return;
  const fakeEmp = { doj, customAllocation: null };
  const snap = allocSnapshot(fakeEmp);
  $('#empF-allocCL').value = snap.Casual;
  $('#empF-allocSL').value = snap.Sick;
  $('#empF-allocAL').value = snap.Annual;
  const year = new Date().getFullYear();
  const dy = parseYMD(doj).getFullYear();
  const hint = dy === year
    ? `(pro-rated: joined month ${parseYMD(doj).getMonth()+1}, ${12 - parseYMD(doj).getMonth()} mo remaining in ${year})`
    : dy > year ? '(future join — 0 days allocated this year)'
    : '(joined before this year — full allocation)';
  $('#allocAutoHint').textContent = hint;
}

function saveEmployeeFromDialog() {
  const id = $('#empF-id').value.trim();
  const name = $('#empF-name').value.trim();
  const mobile = $('#empF-mobile').value.trim();
  const doj = $('#empF-doj').value;
  const designation = $('#empF-designation').value.trim();
  const department = $('#empF-department').value.trim();
  if (!id) return toast('Employee ID required', 'error');
  if (!name) return toast('Name required', 'error');
  if (!mobile) return toast('Mobile required', 'error');
  if (!doj) return toast('Date of Joining required', 'error');
  if (!designation) return toast('Designation required', 'error');
  if (!department) return toast('Department required', 'error');

  const isEdit = !!_empEditingId;
  if (!isEdit && DB.employees.some(e => e.id === id)) {
    return toast(`Employee ID ${id} already exists`, 'error');
  }

  const docs = {};
  DOC_KEYS.forEach(([k]) => {
    docs[k] = !!$(`[data-doc="${k}"]`).checked;
  });

  const customAllocation = $('#allocCustom').checked ? {
    Casual: Number($('#empF-allocCL').value || 0),
    Sick:   Number($('#empF-allocSL').value || 0),
    Annual: Number($('#empF-allocAL').value || 0)
  } : null;

  const base = {
    id, name, mobile, doj, designation, department,
    nid: $('#empF-nid').value.trim(),
    dob: $('#empF-dob').value,
    gender: $('#empF-gender').value,
    section: $('#empF-section').value.trim(),
    subSection: $('#empF-subSection').value.trim(),
    line: $('#empF-line').value.trim(),
    unit: $('#empF-unit').value.trim(),
    building: $('#empF-building').value.trim(),
    floor: $('#empF-floor').value.trim(),
    customAllocation,
    docs,
    status: 'Active',
    terminatedAt: '',
    terminationReason: ''
  };

  if (isEdit) {
    const idx = DB.employees.findIndex(e => e.id === _empEditingId);
    if (idx === -1) return toast('Employee not found', 'error');
    // preserve termination if previously set + status
    const prev = DB.employees[idx];
    DB.employees[idx] = { ...prev, ...base, status: prev.status, terminatedAt: prev.terminatedAt, terminationReason: prev.terminationReason };
    remoteCall('updateEmployee', DB.employees[idx]);
    toast(`Updated ${id}`, 'ok');
  } else {
    base.createdAt = ymd(new Date());
    DB.employees.push(base);
    remoteCall('addEmployee', base);
    toast(`Added ${id} — ${name}`, 'ok');
  }
  saveDB();
  $('#empDialog').close();
  refreshAll();
}

/* ---- Terminate dialog ---- */
let _empTerminatingId = null;
function openTerminateDialog(id) {
  const e = DB.employees.find(x => x.id === id);
  if (!e) return;
  _empTerminatingId = id;
  $('#termSubject').textContent = `${id} · ${e.name} · ${e.designation || ''} · ${e.department || ''}`;
  $('#termF-date').value = ymd(new Date());
  $('#termF-reason').value = '';
  $('#termF-remarks').value = '';
  $('#termF-clearance').checked = false;
  $('#termDialog').showModal();
}
function confirmTermination() {
  const e = DB.employees.find(x => x.id === _empTerminatingId);
  if (!e) return;
  const date = $('#termF-date').value;
  const reason = $('#termF-reason').value;
  if (!date) return toast('Last working day required', 'error');
  if (!reason) return toast('Separation reason required', 'error');
  e.status = 'Terminated';
  e.terminatedAt = date;
  e.terminationReason = reason;
  e.terminationRemarks = $('#termF-remarks').value.trim();
  e.clearanceSettled = !!$('#termF-clearance').checked;
  saveDB();
  remoteCall('terminateEmployee', { id: e.id, terminatedAt: date, reason, remarks: e.terminationRemarks, clearance: e.clearanceSettled });
  toast(`${e.id} marked Terminated`, 'ok');
  $('#termDialog').close();
  refreshAll();
}
function reactivateEmployee(id) {
  if (!confirm('Reactivate this employee?')) return;
  const e = DB.employees.find(x => x.id === id);
  if (!e) return;
  e.status = 'Active';
  e.terminatedAt = '';
  e.terminationReason = '';
  saveDB();
  remoteCall('updateEmployee', e);
  toast(`${id} reactivated`, 'ok');
  refreshAll();
}

/* ---- Bulk import ---- */
const BULK_HEADERS = ['ID','Name','Designation','Department','Section','SubSection','Line','Unit','Building','Floor','DOJ','Mobile','NID','DOB','Gender','CL','SL','AL'];

function downloadTemplate() {
  const sample = [{
    ID: 'EMP-2001', Name: 'Example Joiner', Designation: 'Sewing Operator',
    Department: 'Sewing', Section: 'Sewing', SubSection: 'Sub-A', Line: 'L-01', Unit: 'Unit-1',
    Building: 'Bldg-A', Floor: '3rd Floor',
    DOJ: ymd(new Date()), Mobile: '+8801712345678', NID: '1990123456789', DOB: '1995-04-15',
    Gender: 'F', CL: '', SL: '', AL: ''
  }];
  // Build CSV explicitly so the column order is guaranteed and Building/Floor are always present.
  const headerLine = BULK_HEADERS.join(',');
  const dataLine = BULK_HEADERS.map(h => {
    const v = sample[0][h];
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
  const csv = headerLine + '\n' + dataLine + '\n';

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'leave-atlas-employees-template.csv';
  a.click();
  toast(`Template downloaded — ${BULK_HEADERS.length} columns inc. Building & Floor`, 'ok');
}

let _bulkParsed = [];
let _bulkValid  = [];

function openBulkDialog() {
  _bulkParsed = []; _bulkValid = [];
  $('#bulkStep1').hidden = false;
  $('#bulkStep2').hidden = true;
  $('#bulkBackBtn').hidden = true;
  $('#bulkCommitBtn').hidden = true;
  $('#bulkCommitBtn').disabled = true;
  $('#bulkFile').value = '';
  $('#bulkDialog').showModal();
}

function handleBulkFile(file) {
  if (!file) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      let rows = [];
      if (ext === 'csv') {
        // Read CSV bytes and decode with encoding fallback (UTF-8 → Windows-1252)
        const text = decodeCsvBytes(ev.target.result);
        const wb = XLSX.read(text, { type: 'string' });
        rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      } else {
        // XLSX/XLS — always Unicode internally, but still normalise cells
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      }
      rows = rows.map(normaliseRow);
      validateBulkRows(rows);
    } catch (e) {
      console.error(e);
      toast('Failed to parse file: ' + e.message, 'error');
    }
  };
  // Always read as bytes so we can pick the right text decoder
  reader.readAsArrayBuffer(file);
}

/* Decode a CSV byte buffer. Tries UTF-8 first; if it sees too many U+FFFD
   replacement characters, retries with Windows-1252 (common when CSVs are
   saved from Excel on Windows in Bangladesh / South-Asian locales). */
function decodeCsvBytes(buf) {
  const bytes = new Uint8Array(buf);
  // UTF-8 attempt
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const utf8Replacements = (text.match(/\uFFFD/g) || []).length;
  if (utf8Replacements > 2) {
    // Try Windows-1252 fallback
    try {
      const alt = new TextDecoder('windows-1252', { fatal: false }).decode(bytes);
      const altReplacements = (alt.match(/\uFFFD/g) || []).length;
      if (altReplacements < utf8Replacements) {
        toast(`File decoded as Windows-1252 (${utf8Replacements} bad UTF-8 chars detected) — re-save your file as UTF-8 next time`, 'warn');
        return alt;
      }
    } catch (_) { /* keep UTF-8 */ }
  }
  return text;
}

/* Normalise a parsed row: clean every key and string value. */
function normaliseRow(row) {
  const out = {};
  for (const k in row) {
    const cleanKey = normaliseString(k, /*forKey*/ true);
    out[cleanKey] = normaliseString(row[k], false);
  }
  return out;
}

/* Strip BOM, replacement chars (), and normalise non-breaking + zero-width
   spaces back to regular spaces; collapse runs of whitespace; trim. */
function normaliseString(v, forKey) {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  let s = String(v);
  s = s.replace(/\uFEFF/g, '');                 // BOM
  s = s.replace(/\uFFFD/g, ' ');                // � (replacement)
  s = s.replace(/[\u00A0\u2007\u202F]/g, ' ');  // non-breaking spaces → space
  s = s.replace(/[\u200B-\u200D\u2060]/g, '');  // zero-width chars → drop
  s = s.replace(/[ \t]+/g, ' ');                // collapse multiple spaces/tabs
  return s.trim();
}

function validateBulkRows(rows) {
  const seenIds = new Set(DB.employees.map(e => e.id));
  const idsInFile = new Set();
  _bulkParsed = rows.map((r, idx) => {
    const issues = [];
    const warnings = [];
    const get = k => String(r[k] == null ? '' : r[k]).trim();
    const id = get('ID');
    const name = get('Name');
    const doj = get('DOJ');
    const mobile = get('Mobile');
    const dept = get('Department');
    const desig = get('Designation');
    if (!id) issues.push('ID missing');
    if (!name) issues.push('Name missing');
    if (!doj) issues.push('DOJ missing');
    if (!mobile) issues.push('Mobile missing');
    if (!dept) issues.push('Department missing');
    if (!desig) issues.push('Designation missing');
    if (id && seenIds.has(id)) warnings.push('ID already in roster — will update if toggled');
    if (id && idsInFile.has(id)) issues.push('Duplicate in file');
    if (id) idsInFile.add(id);
    if (doj && !/^\d{4}-\d{2}-\d{2}$/.test(doj)) {
      const norm = normaliseDate(doj, r['DOJ']);
      if (norm) r._dojNorm = norm;
      else issues.push('DOJ format (use YYYY-MM-DD)');
    } else if (doj) {
      r._dojNorm = doj;
    }
    return { row: idx + 2, raw: r, id, name, designation: desig, department: dept, doj: r._dojNorm || doj, mobile, issues, warnings };
  });

  const hardValid = _bulkParsed.filter(p => p.issues.length === 0);
  _bulkValid = hardValid;
  const hasExisting = _bulkParsed.some(p => p.warnings.length);

  $('#bulkStep1').hidden = true;
  $('#bulkStep2').hidden = false;
  $('#bulkBackBtn').hidden = false;
  $('#bulkCommitBtn').hidden = false;
  $('#bulkCommitBtn').disabled = hardValid.length === 0;
  $('#bulkCommitBtn').textContent = `Import ${hardValid.length} Row${hardValid.length === 1 ? '' : 's'}`;
  // Show "Update existing" toggle only when there's overlap with the existing roster
  const toggleWrap = $('#bulkUpdateToggleWrap');
  if (toggleWrap) toggleWrap.hidden = !hasExisting;

  const invalid = _bulkParsed.length - valid.length;
  $('#bulkSummary').innerHTML = `
    <span class="bulk-summary-chip"><strong>${_bulkParsed.length}</strong>parsed</span>
    <span class="bulk-summary-chip ok"><strong>${valid.length}</strong>valid</span>
    <span class="bulk-summary-chip err"><strong>${invalid}</strong>need fixes</span>
  `;

  $('#bulkPreviewHead').innerHTML = `
    <tr>
      <th>Row</th><th>ID</th><th>Name</th><th>Designation</th>
      <th>Dept</th><th>DOJ</th><th>Mobile</th><th>Status</th>
    </tr>`;
  $('#bulkPreviewBody').innerHTML = _bulkParsed.map(p => {
    const cls = p.issues.length ? 'row-invalid' : (p.warnings && p.warnings.length ? 'row-warn' : '');
    const statusCell = p.issues.length
      ? `<span class="cell-err">✘</span><span class="row-issues">${p.issues.join(' · ')}</span>`
      : (p.warnings && p.warnings.length
          ? `<span style="color:var(--saffron)">⚠</span><span class="row-issues" style="color:var(--saffron)">${p.warnings.join(' · ')}</span>`
          : '<span style="color:var(--sage)">✓ ok</span>');
    return `<tr class="${cls}">
      <td>${p.row}</td>
      <td>${escapeHtml(p.id)}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.designation)}</td>
      <td>${escapeHtml(p.department)}</td>
      <td>${escapeHtml(p.doj)}</td>
      <td>${escapeHtml(p.mobile)}</td>
      <td>${statusCell}</td>
    </tr>`;
  }).join('');
}

function normaliseDate(s, raw) {
  // try dd/mm/yyyy
  let m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // try Excel serial
  if (typeof raw === 'number' && raw > 25000 && raw < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + raw * 86400000);
    return d.toISOString().slice(0, 10);
  }
  // try Date string
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}

function commitBulk() {
  if (!_bulkValid.length) return;
  const updateMode = !!$('#bulkUpdateMode')?.checked;
  let added = 0, updated = 0;
  const remoteRows = [];
  _bulkValid.forEach(p => {
    const r = p.raw;
    const customAllocation = (r.CL !== '' || r.SL !== '' || r.AL !== '')
      ? { Casual: Number(r.CL || 0), Sick: Number(r.SL || 0), Annual: Number(r.AL || 0) }
      : null;
    const newFields = {
      id: p.id,
      name: p.name,
      designation: p.designation,
      department: p.department,
      section: String(r.Section || '').trim(),
      subSection: String(r.SubSection || '').trim(),
      line: String(r.Line || '').trim(),
      unit: String(r.Unit || '').trim(),
      building: String(r.Building || '').trim(),
      floor: String(r.Floor || '').trim(),
      doj: p.doj,
      mobile: p.mobile,
      nid: String(r.NID || '').trim(),
      dob: String(r.DOB || '').trim(),
      gender: String(r.Gender || '').trim().toUpperCase().slice(0,1) || '',
      customAllocation
    };
    const existingIdx = DB.employees.findIndex(e => e.id === p.id);
    if (existingIdx >= 0 && updateMode) {
      // merge — keep status/docs/terminatedAt etc; overwrite from upload
      DB.employees[existingIdx] = { ...DB.employees[existingIdx], ...newFields };
      remoteRows.push(DB.employees[existingIdx]);
      updated++;
    } else if (existingIdx < 0) {
      const emp = { ...newFields, docs: {}, status: 'Active', terminatedAt: '', terminationReason: '', createdAt: ymd(new Date()) };
      DB.employees.push(emp);
      remoteRows.push(emp);
      added++;
    }
    // else: existing & not update mode → skip silently (already filtered in validate)
  });
  saveDB();
  // Single remote call for bulk efficiency
  if (remoteRows.length) {
    remoteCall(updateMode ? 'upsertEmployees' : 'bulkImportEmployees', { rows: remoteRows });
  }
  $('#bulkDialog').close();
  toast(`Imported ${added} new${updated ? `, updated ${updated}` : ''}`, 'ok');
  refreshAll();
}

function exportRoster() {
  if (!DB.employees.length) return toast('Roster is empty', 'error');
  const rows = DB.employees.map(e => {
    const a = allocSnapshot(e);
    const u = balanceFor(e.id);
    const dc = docCompleteness(e);
    return {
      ID: e.id, Name: e.name, Designation: e.designation, Department: e.department,
      Section: e.section, SubSection: e.subSection, Line: e.line, Unit: e.unit,
      Building: e.building || '', Floor: e.floor || '',
      DOJ: e.doj, ServiceLength: serviceLength(e.doj),
      Mobile: e.mobile, NID: e.nid, DOB: e.dob, Gender: e.gender,
      Status: e.status, TerminatedAt: e.terminatedAt || '', TerminationReason: e.terminationReason || '',
      Alloc_CL: a.Casual, Alloc_SL: a.Sick, Alloc_AL: a.Annual,
      Used_CL: u.Casual, Used_SL: u.Sick, Used_AL: u.Annual,
      Docs_Complete: `${dc.have}/${dc.total}`,
      Docs_Missing: DOC_KEYS.filter(([k]) => !(e.docs && e.docs[k])).map(([,label]) => label).join('; ')
    };
  });
  exportRows(rows, 'leave-atlas-roster-' + ymd(new Date()), 'xlsx');
}

/* ---- Bulk selection state + operations ---- */
const _empSelected = new Set();

function syncBulkBar() {
  const bar = $('#empBulkBar');
  const count = _empSelected.size;
  if (!bar) return;
  bar.hidden = count === 0;
  $('#empBulkCount').textContent = count;
  // sync select-all checkbox state
  const all = $('#empSelectAll');
  if (all) {
    const visibleCbs = $$('#emp-body .emp-cb');
    const checkedVisible = visibleCbs.filter(cb => cb.checked).length;
    all.checked = visibleCbs.length > 0 && checkedVisible === visibleCbs.length;
    all.indeterminate = checkedVisible > 0 && checkedVisible < visibleCbs.length;
  }
}

function toggleSelectAll(checked) {
  $$('#emp-body .emp-cb').forEach(cb => {
    cb.checked = checked;
    const id = cb.dataset.id;
    if (checked) _empSelected.add(id); else _empSelected.delete(id);
    const tr = cb.closest('tr');
    if (tr) tr.classList.toggle('row-selected', checked);
  });
  syncBulkBar();
}

function clearSelection() {
  _empSelected.clear();
  $$('#emp-body .emp-cb').forEach(cb => { cb.checked = false; });
  $$('#emp-body tr.row-selected').forEach(tr => tr.classList.remove('row-selected'));
  syncBulkBar();
}

function deleteSingleEmployee(id) {
  const e = DB.employees.find(x => x.id === id);
  if (!e) return;
  if (!confirm(`Permanently delete ${id} — ${e.name}?\n\nThis removes the record from the roster. Use Terminate instead if you want to keep history.`)) return;
  const idx = DB.employees.findIndex(x => x.id === id);
  if (idx >= 0) DB.employees.splice(idx, 1);
  _empSelected.delete(id);
  saveDB();
  remoteCall('deleteEmployee', { id });
  toast(`${id} deleted`, 'ok');
  refreshAll();
}

async function bulkDeleteSelected() {
  const ids = Array.from(_empSelected);
  if (!ids.length) return;
  if (!confirm(`Permanently delete ${ids.length} employee${ids.length===1?'':'s'}?\n\nThis is irreversible. Use Bulk Terminate instead to keep historical records.`)) return;
  DB.employees = DB.employees.filter(e => !_empSelected.has(e.id));
  saveDB();
  // remote bulk delete if available, fallback to individual calls
  const res = await remoteCall('bulkDeleteEmployees', { ids });
  if (!res) for (const id of ids) remoteCall('deleteEmployee', { id });
  clearSelection();
  toast(`Deleted ${ids.length} employee${ids.length===1?'':'s'}`, 'ok');
  refreshAll();
}

function bulkTerminateSelected() {
  const ids = Array.from(_empSelected);
  if (!ids.length) return;
  const date = prompt('Last working day for all selected (YYYY-MM-DD)?', ymd(new Date()));
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Invalid date — cancelled', 'error');
  const reason = prompt('Separation reason?\n(Resignation / Contract End / Termination / Retirement / Retrenchment / Death / Absconding)') || 'Bulk separation';
  let count = 0;
  ids.forEach(id => {
    const e = DB.employees.find(x => x.id === id);
    if (!e) return;
    e.status = 'Terminated';
    e.terminatedAt = date;
    e.terminationReason = reason;
    remoteCall('terminateEmployee', { id: e.id, terminatedAt: date, reason });
    count++;
  });
  saveDB();
  clearSelection();
  toast(`Terminated ${count} employee${count===1?'':'s'}`, 'ok');
  refreshAll();
}

function bulkReactivateSelected() {
  const ids = Array.from(_empSelected);
  if (!ids.length) return;
  if (!confirm(`Reactivate ${ids.length} employee${ids.length===1?'':'s'}?`)) return;
  let count = 0;
  ids.forEach(id => {
    const e = DB.employees.find(x => x.id === id);
    if (!e) return;
    e.status = 'Active';
    e.terminatedAt = '';
    e.terminationReason = '';
    remoteCall('updateEmployee', e);
    count++;
  });
  saveDB();
  clearSelection();
  toast(`Reactivated ${count} employee${count===1?'':'s'}`, 'ok');
  refreshAll();
}

/* ---- Sync status display ---- */
function updateSyncStatusLine() {
  const el = $('#empSyncStatus');
  if (!el) return;
  const remote = !!(SETTINGS.useRemote && SETTINGS.apiUrl);
  const n = DB.employees.length;
  if (!remote) {
    el.className = 'emp-sync-status warn';
    el.innerHTML = `⚠ Local-only mode — ${n} employee${n===1?'':'s'} in this browser only. Data will be lost if you switch browsers, clear cache, or this device fails. <strong>Open ⚙ Settings and connect Google Sheets immediately.</strong>`;
    return;
  }
  const last = SETTINGS.lastSync ? new Date(SETTINGS.lastSync) : null;
  const ago = last ? Math.round((Date.now() - last.getTime()) / 60000) : null;
  el.className = 'emp-sync-status ok';
  el.textContent = last
    ? `✓ Synced with Google Sheets · ${n} employees · last pull ${ago < 1 ? 'just now' : ago + ' min ago'}`
    : `Connected to Google Sheets · click ↻ Sync now to pull the latest roster.`;
}

function bindEmployees() {
  $('#empAddBtn').addEventListener('click', () => openEmployeeDialog(null));
  $('#empBulkBtn').addEventListener('click', openBulkDialog);
  $('#empTemplateBtn').addEventListener('click', downloadTemplate);
  $('#empExportBtn').addEventListener('click', exportRoster);
  $('#empSyncBtn').addEventListener('click', async () => {
    if (!SETTINGS.useRemote || !SETTINGS.apiUrl) {
      toast('Open Settings and connect to Google Sheets first', 'error');
      return openSettings();
    }
    await remotePullAll(false);
    refreshAll();
  });
  $('#empSearch').addEventListener('input', renderEmployees);
  $('#empStatusFilter').addEventListener('change', renderEmployees);
  $('#empDeptFilter').addEventListener('change', renderEmployees);

  // bulk select
  $('#empSelectAll').addEventListener('change', (e) => toggleSelectAll(e.target.checked));
  $('#empBulkClear').addEventListener('click', clearSelection);
  $('#empBulkDelete').addEventListener('click', bulkDeleteSelected);
  $('#empBulkTerminate').addEventListener('click', bulkTerminateSelected);
  $('#empBulkReactivate').addEventListener('click', bulkReactivateSelected);

  // dialog buttons
  $('#empDialogCancel').addEventListener('click', () => $('#empDialog').close());
  $('#empDialogSave').addEventListener('click', (e) => {
    e.preventDefault();
    saveEmployeeFromDialog();
  });
  $('#empF-doj').addEventListener('change', updateAllocFromDOJ);
  $('#allocAuto').addEventListener('change', syncAllocMode);
  $('#allocCustom').addEventListener('change', syncAllocMode);

  // termination dialog
  $('#termDialogCancel').addEventListener('click', () => $('#termDialog').close());
  $('#termDialogConfirm').addEventListener('click', (e) => {
    e.preventDefault();
    confirmTermination();
  });

  // bulk import
  $('#bulkDialogCancel').addEventListener('click', () => $('#bulkDialog').close());
  $('#bulkBackBtn').addEventListener('click', (e) => {
    e.preventDefault();
    $('#bulkStep1').hidden = false;
    $('#bulkStep2').hidden = true;
    $('#bulkBackBtn').hidden = true;
    $('#bulkCommitBtn').hidden = true;
  });
  $('#bulkCommitBtn').addEventListener('click', (e) => {
    e.preventDefault();
    commitBulk();
  });
  $('#bulkTemplateLink').addEventListener('click', (e) => { e.preventDefault(); downloadTemplate(); });

  const drop = $('#bulkDrop');
  const file = $('#bulkFile');
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', e => handleBulkFile(e.target.files[0]));
  ['dragover','dragenter'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.add('drag');
  }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); drop.classList.remove('drag');
  }));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleBulkFile(f);
  });
}

/* ---------- 18. SETTINGS DIALOG ---------- */
function openSettings() {
  const d = $('#settingsDialog');
  $('#apiUrl').value   = SETTINGS.apiUrl || '';
  $('#useRemote').checked = !!SETTINGS.useRemote;
  d.showModal();
}

function bindSettings() {
  const d = $('#settingsDialog');
  $('#settingsBtn').addEventListener('click', openSettings);
  d.addEventListener('close', () => {
    if (d.returnValue === 'save') {
      SETTINGS.apiUrl    = $('#apiUrl').value.trim();
      SETTINGS.useRemote = $('#useRemote').checked;
      saveSettings();
      updateConnIndicator();
      toast('Settings saved', 'ok');
    }
  });
}

function updateConnIndicator() {
  const remote = SETTINGS.useRemote && SETTINGS.apiUrl;
  const dot = $('#connStatus');
  const txt = $('#connText');
  if (remote) { dot.className = 'dot dot-remote'; txt.textContent = 'Synced to Sheets'; }
  else        { dot.className = 'dot dot-local';  txt.textContent = 'Local mode'; }
}

/* ---------- 18. INIT ---------- */
async function init() {
  loadDB();

  // today's date
  $('#todayDate').textContent = fmtDate(new Date());

  // nav clicks
  $$('#nav a').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    navigate(a.dataset.module);
  }));

  // role select
  $('#roleSelect').addEventListener('change', e => setRole(e.target.value));

  // reset
  $('#clearBtn').addEventListener('click', () => {
    if (!confirm('Reset all LOCAL data?\n\nThis clears the in-browser cache only. If you have Google Sheets sync ON, your Sheet is untouched and the next sync will repopulate this browser.')) return;
    DB = { employees: [], applications: [] };
    saveDB();
    refreshAll();
    syncWelcomeBanner();
    setRole('hradmin');
    toast('Local cache cleared — Sheet data is safe', 'ok');
  });

  bindApply();
  bindMyFile();
  bindSettings();
  bindEmployees();
  bindWelcomeBanner();
  updateConnIndicator();

  // PILOT MODE: no demo seed. If remote is configured, pull authoritative data
  // from the Sheet so this device always shows the latest state.
  if (SETTINGS.useRemote && SETTINGS.apiUrl) {
    await remotePullAll(true);
  }

  const isFreshPilot = !DB.employees.length;
  if (isFreshPilot) {
    $('#roleSelect').value = 'hradmin';
    setRole('hradmin');
  } else {
    setRole('employee');
  }
  syncWelcomeBanner();
  refreshAll();
}

/* Welcome banner — only visible when roster is empty. */
function syncWelcomeBanner() {
  const banner = $('#welcomeBanner');
  if (!banner) return;
  banner.hidden = DB.employees.length > 0;
}

function bindWelcomeBanner() {
  const banner = $('#welcomeBanner');
  if (!banner) return;
  banner.querySelectorAll('.welcome-link[data-act]').forEach(b => {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'openSettings') openSettings();
      if (act === 'gotoEmployees') {
        $('#roleSelect').value = 'hradmin';
        setRole('hradmin');
      }
    });
  });
  $('#welcomeGotoEmployees').addEventListener('click', () => {
    $('#roleSelect').value = 'hradmin';
    setRole('hradmin');
  });
  $('#welcomeOpenSettings').addEventListener('click', openSettings);
}

document.addEventListener('DOMContentLoaded', init);
