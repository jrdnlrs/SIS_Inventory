/* ─────────────────────────────────────────
   SIS — payroll.js  (Enhanced)
   Supreme InfoTech Solutions
   Payroll Management System

   Employee Types:
   • Regular     — fixed daily rate × days present
   • Event-based — flat pay per event/project

   Deduction Modes (togglable per payroll run):
   • BIR 2025 graduated withholding tax table
   • Flat % approximation (while awaiting BIR registration)

   Deductions (2025):
   • SSS        — official contribution table (EE share)
   • PhilHealth — 5% of basic, EE = 2.5% (max ₱5,000/mo)
   • Pag-IBIG   — ₱100 fixed EE contribution
   • Tax        — mode-dependent (see above)

   DB Tables (Supabase):
   • employees       — id, name, position, type (regular|event),
                       daily_rate, event_rate, sss_no, philhealth_no,
                       pagibig_no, status
   • payroll_periods — id, label, month, pay_type, employee_count,
                       total_gross, total_net, created_at
   • payroll_records — id, period_id, employee_id, employee_name,
                       emp_type, days_present, working_days,
                       event_name, gross_pay, sss, philhealth,
                       pagibig, tax, net_pay
   ───────────────────────────────────────── */

// ── SUPABASE ENDPOINTS ─────────────────────
const EMP_URL    = `${SUPABASE_URL}/rest/v1/employees`;
const PERIOD_URL = `${SUPABASE_URL}/rest/v1/payroll_periods`;
const RECORD_URL = `${SUPABASE_URL}/rest/v1/payroll_records`;

function makeDbHeaders(extra = {}) {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Prefer':        'return=representation',
    ...extra,
  };
}

// ── STATE ──────────────────────────────────
let employees      = [];
let dtrRows        = [];
let computedRows   = [];
let payrollHistory = [];
let taxMode        = 'bir';   // 'bir' | 'flat'
let flatTaxRate    = 0.10;    // default 10% flat (editable)
let currentPayType = 'regular'; // currently active DTR tab

// Government contribution toggles (off by default until company is registered)
let applySSS        = false;
let applyPhilHealth = false;
let applyPagIbig    = false;

// ── SUPABASE HELPERS ───────────────────────
async function sbGet(url) {
  const res = await fetch(url, { headers: makeDbHeaders() });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}
async function sbPost(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: makeDbHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.json();
}
async function sbPatch(url, body) {
  const res = await fetch(url, {
    method: 'PATCH', headers: makeDbHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${url} → ${res.status}`);
  return res.json();
}
async function sbDelete(url) {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: makeDbHeaders({ Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`DELETE ${url} → ${res.status}`);
}

// ── UI HELPERS ─────────────────────────────
function setLoading(on) {
  const bar = document.getElementById('loadingBar');
  if (bar) bar.style.display = on ? 'block' : 'none';
}

function toast(msg, type = 'info') {
  const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';
  const el   = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icon}</span> ${msg}`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut 0.3s ease-in forwards';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function peso(n) {
  return '₱' + (n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── TAB SWITCHING ──────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.ptab-content').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.ptab').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${name}`).style.display = 'block';
  btn.classList.add('active');
  if (name === 'history') loadHistory();
}

// ── PAYROLL TYPE SUB-TAB ───────────────────
function switchPayType(type, btn) {
  currentPayType = type;
  document.querySelectorAll('.pay-type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('dtrRegularSection').style.display = type === 'regular' ? 'block' : 'none';
  document.getElementById('dtrEventSection').style.display   = type === 'event'   ? 'block' : 'none';
  // Reset preview
  dtrRows = []; computedRows = [];
  document.getElementById('dtrPreview').style.display = 'none';
  document.getElementById('payrollSummaryBar').style.display = 'none';
}

// ═══════════════════════════════════════════
//  TAX MODE TOGGLE
// ═══════════════════════════════════════════

function setTaxMode(mode) {
  taxMode = mode;
  document.getElementById('btnTaxBir').classList.toggle('active', mode === 'bir');
  document.getElementById('btnTaxFlat').classList.toggle('active', mode === 'flat');
  document.getElementById('flatRateRow').style.display = mode === 'flat' ? 'flex' : 'none';
  toast(`Tax mode: ${mode === 'bir' ? 'BIR 2025 Graduated Table' : `Flat ${Math.round(flatTaxRate * 100)}%`}`, 'info');
}

function updateFlatRate(val) {
  flatTaxRate = Math.min(0.35, Math.max(0, parseFloat(val) / 100 || 0));
  document.getElementById('flatRateDisplay').textContent = `${Math.round(flatTaxRate * 100)}%`;
}

// ═══════════════════════════════════════════
//  GOVERNMENT CONTRIBUTION TOGGLES
// ═══════════════════════════════════════════

function toggleGovContrib(type, checkbox) {
  const on = checkbox.checked;
  if (type === 'sss')        applySSS        = on;
  if (type === 'philhealth') applyPhilHealth = on;
  if (type === 'pagibig')    applyPagIbig    = on;

  const labels = { sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG' };
  toast(`${labels[type]} deduction ${on ? 'enabled' : 'disabled'}.`, on ? 'success' : 'info');

  // Re-compute live if payroll is already on screen
  if (computedRows.length) computePayroll();
}

// ═══════════════════════════════════════════
//  DEDUCTION COMPUTATIONS
// ═══════════════════════════════════════════

/** SSS EE contribution (2025). MSC-based, max EE = ₱1,575. */
function computeSSS(monthlyGross) {
  const msc = Math.min(35000, Math.max(5000, Math.round(monthlyGross / 500) * 500));
  return Math.min(Math.round(msc * 0.045), 1575);
}

/** PhilHealth EE contribution (2025). 2.5% of monthly salary, max ₱2,500. */
function computePhilHealth(monthlyGross) {
  const total   = monthlyGross * 0.05;
  const capped  = Math.min(total, 5000);
  return Math.round(capped / 2);
}

/** Pag-IBIG EE contribution (2025). Fixed ₱100 if salary ≥ ₱1,500. */
function computePagIbig(monthlyGross) {
  return monthlyGross < 1500 ? Math.round(monthlyGross * 0.01) : 100;
}

/** BIR 2025 graduated monthly withholding tax. */
function computeBIRTax(monthlyGross, sss, philhealth, pagibig) {
  const taxable = Math.max(0, monthlyGross - sss - philhealth - pagibig);
  if (taxable <= 20833)  return 0;
  if (taxable <= 33332)  return (taxable - 20833) * 0.15;
  if (taxable <= 66666)  return 1875 + (taxable - 33333) * 0.20;
  if (taxable <= 166666) return 8541.80 + (taxable - 66667) * 0.25;
  if (taxable <= 666666) return 33541.80 + (taxable - 166667) * 0.30;
  return 183541.80 + (taxable - 666667) * 0.35;
}

/** Flat-rate withholding tax. Applied on gross (no deduction offset). */
function computeFlatTax(grossPay) {
  return grossPay * flatTaxRate;
}

/**
 * Master compute — works for both Regular and Event-based employees.
 * @param {object} emp          - employee record
 * @param {number} grossPay     - already-calculated gross (daily_rate × days OR event pay)
 * @param {number} monthlyEquiv - extrapolated monthly figure for SSS/PH/PAGIBIG brackets
 */
function computeDeductions(emp, grossPay, monthlyEquiv) {
  // Only apply gov contributions if their toggle is ON
  const sss        = applySSS        ? computeSSS(monthlyEquiv)        : 0;
  const philhealth = applyPhilHealth ? computePhilHealth(monthlyEquiv) : 0;
  const pagibig    = applyPagIbig    ? computePagIbig(monthlyEquiv)    : 0;
  const tax        = Math.round(
    (taxMode === 'bir'
      ? computeBIRTax(monthlyEquiv, sss, philhealth, pagibig)
      : computeFlatTax(grossPay)) * 100
  ) / 100;
  const totalDed = sss + philhealth + pagibig + tax;
  const net      = Math.round((grossPay - totalDed) * 100) / 100;
  return { sss, philhealth, pagibig, tax, totalDed, net };
}

/** For Regular employees: daily_rate × days present. */
function computeRegularPay(emp, daysPresent, workingDays) {
  const gross        = Math.round(emp.daily_rate * daysPresent * 100) / 100;
  const monthlyEquiv = workingDays > 0 ? (emp.daily_rate * workingDays) : gross;
  const ded          = computeDeductions(emp, gross, monthlyEquiv);
  return { gross, daysPresent, workingDays, empType: 'regular', ...ded };
}

/** For Event-based employees: flat pay per event. Monthly equiv = gross × 2 (semi-monthly proxy). */
function computeEventPay(emp, eventPay, eventName) {
  const gross        = Math.round(eventPay * 100) / 100;
  const monthlyEquiv = gross * 2; // assume ~2 events per month for bracket estimation
  const ded          = computeDeductions(emp, gross, monthlyEquiv);
  return { gross, daysPresent: 0, workingDays: 0, eventName, empType: 'event', ...ded };
}

// ═══════════════════════════════════════════
//  EMPLOYEES CRUD
// ═══════════════════════════════════════════

async function loadEmployees() {
  setLoading(true);
  try {
    employees = await sbGet(`${EMP_URL}?select=*&order=name.asc`);
    renderEmployees();
  } catch (err) {
    console.error(err);
    toast('Failed to load employees.', 'error');
  } finally {
    setLoading(false);
  }
}

function renderEmployees() {
  const tbody = document.getElementById('empTableBody');
  const count = document.getElementById('empCount');

  const regular = employees.filter(e => (e.type || 'regular') === 'regular');
  const event   = employees.filter(e => e.type === 'event');
  count.textContent = `${employees.length} total — ${regular.length} regular, ${event.length} event-based`;

  if (!employees.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40" style="opacity:.2;margin-bottom:12px"><circle cx="12" cy="8" r="5"/><path d="M3 21c0-4 4-7 9-7s9 3 9 7"/></svg>
      <p>No employees yet. Add one to get started.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = employees.map(e => {
    const isEvent   = e.type === 'event';
    const rateLabel = isEvent ? peso(e.event_rate || 0) + '/event' : peso(e.daily_rate || 0) + '/day';
    const typeBadge = isEvent
      ? `<span class="badge" style="background:rgba(167,139,250,0.12);color:#a78bfa;border:1px solid rgba(167,139,250,0.2);font-size:10px">Event</span>`
      : `<span class="badge" style="background:rgba(52,211,153,0.08);color:#34d399;border:1px solid rgba(52,211,153,0.15);font-size:10px">Regular</span>`;
    return `
    <tr>
      <td><strong>${e.name}</strong></td>
      <td style="color:var(--text-muted);font-size:12px">${e.position || '—'}</td>
      <td>${typeBadge}</td>
      <td class="mono" style="font-size:12px">${rateLabel}</td>
      <td class="mono" style="font-size:11px;color:var(--text-muted)">${e.sss_no || '—'}</td>
      <td class="mono" style="font-size:11px;color:var(--text-muted)">${e.philhealth_no || '—'}</td>
      <td class="mono" style="font-size:11px;color:var(--text-muted)">${e.pagibig_no || '—'}</td>
      <td><span class="badge ${e.status === 'active' ? 'badge-active' : 'badge-inactive'}">${e.status}</span></td>
      <td>
        <div class="td-actions">
          <button class="btn btn-edit" onclick="openEmpModal('${e.id}')">Edit</button>
          <button class="btn btn-danger" onclick="deleteEmployee('${e.id}')">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── EMPLOYEE MODAL ─────────────────────────
let editEmpId = null;

function openEmpModal(id = null) {
  editEmpId = id;
  document.getElementById('empModalTitle').textContent = id ? 'Edit Employee' : 'Add Employee';
  const emp = id ? employees.find(e => e.id === id) || {} : {};
  document.getElementById('efName').value        = emp.name          || '';
  document.getElementById('efPosition').value    = emp.position      || '';
  document.getElementById('efType').value        = emp.type          || 'regular';
  document.getElementById('efRate').value        = emp.daily_rate    || '';
  document.getElementById('efEventRate').value   = emp.event_rate    || '';
  document.getElementById('efSss').value         = emp.sss_no        || '';
  document.getElementById('efPhilhealth').value  = emp.philhealth_no || '';
  document.getElementById('efPagibig').value     = emp.pagibig_no    || '';
  document.getElementById('efStatus').value      = emp.status        || 'active';
  toggleEmpTypeFields();
  document.getElementById('empOverlay').classList.add('open');
  setTimeout(() => document.getElementById('efName').focus(), 100);
}

function toggleEmpTypeFields() {
  const type = document.getElementById('efType').value;
  document.getElementById('rateRegularGroup').style.display = type === 'regular' ? 'block' : 'none';
  document.getElementById('rateEventGroup').style.display   = type === 'event'   ? 'block' : 'none';
}

function closeEmpModal() {
  document.getElementById('empOverlay').classList.remove('open');
  editEmpId = null;
}

function closeEmpModalOutside(e) {
  if (e.target === document.getElementById('empOverlay')) closeEmpModal();
}

async function saveEmployee() {
  const name = document.getElementById('efName').value.trim();
  const type = document.getElementById('efType').value;
  const rate = parseFloat(document.getElementById('efRate').value);
  const eRate = parseFloat(document.getElementById('efEventRate').value);

  if (!name) { toast('Name is required.', 'error'); return; }
  if (type === 'regular' && (!rate || rate <= 0)) { toast('Daily rate is required.', 'error'); return; }
  if (type === 'event'   && (!eRate || eRate <= 0)) { toast('Event rate is required.', 'error'); return; }

  const data = {
    name,
    position:      document.getElementById('efPosition').value.trim(),
    type,
    daily_rate:    type === 'regular' ? rate : null,
    event_rate:    type === 'event'   ? eRate : null,
    sss_no:        document.getElementById('efSss').value.trim(),
    philhealth_no: document.getElementById('efPhilhealth').value.trim(),
    pagibig_no:    document.getElementById('efPagibig').value.trim(),
    status:        document.getElementById('efStatus').value,
  };

  setLoading(true);
  try {
    if (editEmpId) {
      await sbPatch(`${EMP_URL}?id=eq.${editEmpId}`, data);
      toast('Employee updated.', 'success');
    } else {
      data.id = uid();
      await sbPost(EMP_URL, data);
      toast('Employee added.', 'success');
    }
    closeEmpModal();
    await loadEmployees();
  } catch (err) {
    console.error(err);
    toast('Save failed. Check your connection.', 'error');
  } finally {
    setLoading(false);
  }
}

async function deleteEmployee(id) {
  if (!confirm('Delete this employee? Their payroll records will remain in history.')) return;
  setLoading(true);
  try {
    await sbDelete(`${EMP_URL}?id=eq.${id}`);
    toast('Employee deleted.', 'info');
    await loadEmployees();
  } catch (err) {
    console.error(err);
    toast('Delete failed.', 'error');
  } finally {
    setLoading(false);
  }
}

// ═══════════════════════════════════════════
//  DTR — REGULAR EMPLOYEES
// ═══════════════════════════════════════════

/**
 * Expected DTR columns (case-insensitive):
 *   Name | Days Present | Working Days (optional, default 26)
 */
function onDtrFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (evt) {
    try {
      let rows = [];

      if (file.name.endsWith('.csv')) {
        const lines   = evt.target.result.trim().split('\n');
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        rows = lines.slice(1).map(line => {
          const vals = line.split(',');
          const obj  = {};
          headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
          return obj;
        });
      } else {
        const wb = XLSX.read(evt.target.result, { type: 'binary' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: '' }).map(r => {
          const obj = {};
          Object.entries(r).forEach(([k, v]) => { obj[k.trim().toLowerCase()] = String(v).trim(); });
          return obj;
        });
      }

      if (!rows.length) { toast('DTR file appears empty.', 'error'); return; }

      dtrRows = rows.map((r, idx) => {
        const name     = r['name'] || r['employee'] || r['employee name'] || '';
        const days     = parseFloat(r['days present'] || r['days'] || r['present'] || 0);
        const workDays = parseFloat(r['working days'] || r['work days'] || 26);
        return { _row: idx + 2, name: name.trim(), daysPresent: days, workingDays: workDays };
      }).filter(r => r.name);

      if (!dtrRows.length) {
        toast('Could not find a "Name" column in your DTR. Check the template.', 'error');
        return;
      }

      renderDtrPreview();
      document.getElementById('dtrPreview').style.display = 'block';
      document.getElementById('payrollSummaryBar').style.display = 'none';
      toast(`DTR loaded — ${dtrRows.length} row${dtrRows.length !== 1 ? 's' : ''} found.`, 'success');
    } catch (err) {
      console.error(err);
      toast('Could not read the DTR file.', 'error');
    }
  };

  if (file.name.endsWith('.csv')) reader.readAsText(file);
  else reader.readAsBinaryString(file);
}

function renderDtrPreview() {
  const tbody = document.getElementById('dtrPreviewBody');
  tbody.innerHTML = dtrRows.map(r => {
    const emp = matchEmployee(r.name, 'regular');
    const tag = emp
      ? `<span style="color:var(--green);font-size:11px">✓ ${emp.name}</span>`
      : `<span style="color:var(--red);font-size:11px">✗ No match</span>`;
    return `
      <tr>
        <td><strong>${r.name}</strong><br>${tag}</td>
        <td class="mono">${r.daysPresent} / ${r.workingDays}</td>
        <td class="mono">${emp ? peso(emp.daily_rate) + '/day' : '—'}</td>
        <td colspan="6" style="color:var(--text-muted);font-size:12px">— compute to see —</td>
      </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════
//  DTR — EVENT-BASED EMPLOYEES
// ═══════════════════════════════════════════

/**
 * Expected Event DTR columns (case-insensitive):
 *   Name | Event Name | Pay (optional, uses employee event_rate if blank)
 */
function onEventDtrFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (evt) {
    try {
      let rows = [];

      if (file.name.endsWith('.csv')) {
        const lines   = evt.target.result.trim().split('\n');
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        rows = lines.slice(1).map(line => {
          const vals = line.split(',');
          const obj  = {};
          headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
          return obj;
        });
      } else {
        const wb = XLSX.read(evt.target.result, { type: 'binary' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: '' }).map(r => {
          const obj = {};
          Object.entries(r).forEach(([k, v]) => { obj[k.trim().toLowerCase()] = String(v).trim(); });
          return obj;
        });
      }

      if (!rows.length) { toast('Event DTR file appears empty.', 'error'); return; }

      dtrRows = rows.map((r, idx) => {
        const name      = r['name'] || r['employee'] || r['employee name'] || '';
        const eventName = r['event name'] || r['event'] || r['project'] || 'Event';
        const pay       = parseFloat(r['pay'] || r['amount'] || r['event pay'] || 0);
        return { _row: idx + 2, name: name.trim(), eventName: eventName.trim(), eventPay: pay };
      }).filter(r => r.name);

      if (!dtrRows.length) {
        toast('Could not find a "Name" column in your Event DTR.', 'error');
        return;
      }

      renderEventDtrPreview();
      document.getElementById('dtrPreview').style.display = 'block';
      document.getElementById('payrollSummaryBar').style.display = 'none';
      toast(`Event DTR loaded — ${dtrRows.length} row${dtrRows.length !== 1 ? 's' : ''} found.`, 'success');
    } catch (err) {
      console.error(err);
      toast('Could not read the Event DTR file.', 'error');
    }
  };

  if (file.name.endsWith('.csv')) reader.readAsText(file);
  else reader.readAsBinaryString(file);
}

function renderEventDtrPreview() {
  const tbody = document.getElementById('dtrPreviewBody');
  tbody.innerHTML = dtrRows.map(r => {
    const emp = matchEmployee(r.name, 'event');
    const resolvedPay = r.eventPay > 0 ? r.eventPay : (emp ? emp.event_rate : 0);
    const tag = emp
      ? `<span style="color:var(--green);font-size:11px">✓ ${emp.name}</span>`
      : `<span style="color:var(--red);font-size:11px">✗ No match</span>`;
    return `
      <tr>
        <td><strong>${r.name}</strong><br>${tag}</td>
        <td style="font-size:12px">${r.eventName}</td>
        <td class="mono">${resolvedPay > 0 ? peso(resolvedPay) : '—'}</td>
        <td colspan="6" style="color:var(--text-muted);font-size:12px">— compute to see —</td>
      </tr>`;
  }).join('');
}

// ── EMPLOYEE NAME MATCHING ─────────────────
function matchEmployee(name, empType = null) {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  const pool = empType
    ? employees.filter(e => (e.type || 'regular') === empType && e.status === 'active')
    : employees.filter(e => e.status === 'active');

  return (
    pool.find(e => e.name.toLowerCase() === n) ||
    pool.find(e => e.name.toLowerCase().includes(n) || n.includes(e.name.toLowerCase())) ||
    null
  );
}

// ═══════════════════════════════════════════
//  COMPUTE PAYROLL
// ═══════════════════════════════════════════

function computePayroll() {
  const month = document.getElementById('payMonth').value;
  if (!month)            { toast('Please select a pay period first.', 'error'); return; }
  if (!employees.length) { toast('No employees found. Add employees first.', 'error'); return; }
  if (!dtrRows.length)   { toast('No DTR data loaded.', 'error'); return; }

  computedRows = [];
  let totalGross = 0, totalDed = 0, totalNet = 0, unmatched = 0;
  const tbody = document.getElementById('dtrPreviewBody');
  tbody.innerHTML = '';

  const taxLabel = taxMode === 'bir' ? 'BIR 2025' : `Flat ${Math.round(flatTaxRate * 100)}%`;

  dtrRows.forEach(r => {
    const empType = currentPayType;
    const emp     = matchEmployee(r.name, empType);

    if (!emp) {
      unmatched++;
      tbody.innerHTML += `
        <tr style="opacity:.5">
          <td><strong>${r.name}</strong><br><span style="color:var(--red);font-size:11px">✗ No match — skipped</span></td>
          <td colspan="8" style="color:var(--text-muted)">—</td>
        </tr>`;
      return;
    }

    let c;
    if (empType === 'regular') {
      c = computeRegularPay(emp, r.daysPresent, r.workingDays || 26);
    } else {
      // Event pay: use row pay if specified, else fall back to employee's event_rate
      const pay = r.eventPay > 0 ? r.eventPay : (emp.event_rate || 0);
      if (!pay) {
        unmatched++;
        tbody.innerHTML += `
          <tr style="opacity:.5">
            <td><strong>${emp.name}</strong><br><span style="color:var(--red);font-size:11px">✗ No event pay specified</span></td>
            <td colspan="8">—</td>
          </tr>`;
        return;
      }
      c = computeEventPay(emp, pay, r.eventName || 'Event');
    }

    computedRows.push({ emp, ...c, month });
    totalGross += c.gross;
    totalDed   += c.totalDed;
    totalNet   += c.net;

    const col2 = empType === 'regular'
      ? `${c.daysPresent} / ${c.workingDays} days`
      : `<span style="font-size:11px">${c.eventName}</span>`;

    const col3 = empType === 'regular'
      ? peso(emp.daily_rate) + '/day'
      : peso(emp.event_rate || 0) + '/event';

    tbody.innerHTML += `
      <tr>
        <td>
          <strong>${emp.name}</strong><br>
          <span style="font-size:11px;color:var(--text-muted)">${emp.position || ''}</span>
        </td>
        <td class="mono" style="font-size:12px">${col2}</td>
        <td class="mono" style="font-size:12px">${col3}</td>
        <td class="mono">${peso(c.gross)}</td>
        <td class="mono" style="color:var(--text-muted)">${peso(c.sss)}</td>
        <td class="mono" style="color:var(--text-muted)">${peso(c.philhealth)}</td>
        <td class="mono" style="color:var(--text-muted)">${peso(c.pagibig)}</td>
        <td class="mono" style="color:var(--text-muted)">
          ${peso(c.tax)}
          <span style="font-size:9px;color:var(--accent-bright);margin-left:3px">${taxLabel}</span>
        </td>
        <td class="mono" style="color:var(--accent);font-weight:600">${peso(c.net)}</td>
        <td>
          <button class="btn btn-edit" style="font-size:11px;padding:4px 10px"
            onclick='generatePayslipPDF(${JSON.stringify({
              ...c,
              emp: { name: emp.name, position: emp.position, type: emp.type,
                     sss_no: emp.sss_no, philhealth_no: emp.philhealth_no, pagibig_no: emp.pagibig_no,
                     daily_rate: emp.daily_rate, event_rate: emp.event_rate }
            })}, "${month}", "${taxLabel}")'>
            Payslip
          </button>
        </td>
      </tr>`;
  });

  // Summary
  document.getElementById('sumGross').textContent    = peso(totalGross);
  document.getElementById('sumDed').textContent      = peso(totalDed);
  document.getElementById('sumNet').textContent      = peso(totalNet);
  document.getElementById('sumEmpCount').textContent = `${computedRows.length} employees`;
  document.getElementById('payrollSummaryBar').style.display = 'flex';

  if (unmatched > 0) toast(`${unmatched} row${unmatched > 1 ? 's' : ''} skipped — no match found.`, 'error');
  toast(`Payroll computed for ${computedRows.length} employee${computedRows.length !== 1 ? 's' : ''}.`, 'success');
}

// ═══════════════════════════════════════════
//  PAYSLIP PDF GENERATION
// ═══════════════════════════════════════════

function generatePayslipPDF(row, month, taxLabel = 'BIR 2025') {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const emp = row.emp;
  const W   = 210;
  const pad = 20;

  const blue  = [59, 130, 246];
  const dark  = [8, 12, 20];
  const navy  = [15, 23, 42];
  const gray  = [100, 116, 139];
  const light = [241, 245, 249];

  const isEvent = (emp.type || 'regular') === 'event';

  // ── Header band ──
  doc.setFillColor(...dark);
  doc.rect(0, 0, W, 34, 'F');

  // Left accent stripe
  doc.setFillColor(...blue);
  doc.rect(0, 0, 4, 34, 'F');

  doc.setTextColor(...blue);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Supreme InfoTech Solutions', pad, 14);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(148, 163, 184);
  doc.text('PAYSLIP  •  OFFICIAL DOCUMENT', pad, 21);

  // Pay type chip
  const chipLabel = isEvent ? 'EVENT-BASED' : 'REGULAR';
  doc.setFillColor(30, 41, 59);
  doc.roundedRect(pad, 24, 28, 7, 2, 2, 'F');
  doc.setTextColor(...blue);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.text(chipLabel, pad + 14, 29, { align: 'center' });

  // Period (right side)
  const [yr, mo] = month.split('-');
  const monthName = new Date(yr, +mo - 1).toLocaleString('en-PH', { month: 'long', year: 'numeric' });
  doc.setTextColor(226, 232, 240);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(monthName, W - pad, 14, { align: 'right' });
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(148, 163, 184);
  doc.text(`Generated: ${new Date().toLocaleDateString('en-PH')}`, W - pad, 21, { align: 'right' });
  doc.text(`Tax Mode: ${taxLabel}`, W - pad, 27, { align: 'right' });

  // ── Employee card ──
  let y = 44;
  doc.setFillColor(...light);
  doc.roundedRect(pad, y, W - pad * 2, 30, 3, 3, 'F');

  // Avatar circle
  doc.setFillColor(...blue);
  doc.circle(pad + 14, y + 15, 10, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  const initials = emp.name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  doc.text(initials, pad + 14, y + 19, { align: 'center' });

  // Name & position
  doc.setTextColor(...dark);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text(emp.name, pad + 28, y + 11);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...gray);
  doc.text(emp.position || 'Employee', pad + 28, y + 18);

  // Rate info
  const rateText = isEvent
    ? `Event Pay: ${peso(emp.event_rate || row.gross)}`
    : `Daily Rate: ${peso(emp.daily_rate)}  •  Days Present: ${row.daysPresent} / ${row.workingDays}`;
  doc.setFontSize(8);
  doc.text(rateText, pad + 28, y + 26);

  if (isEvent && row.eventName) {
    doc.setTextColor(...blue);
    doc.text(`Event: ${row.eventName}`, W - pad - 4, y + 11, { align: 'right' });
  }

  // ── Earnings ──
  y += 38;
  drawSectionHeader(doc, 'EARNINGS', pad, y, W, blue, gray);
  y += 12;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...dark);
  const earningLabel = isEvent ? `Event Pay — ${row.eventName || 'Event'}` : 'Basic Pay';
  doc.text(earningLabel, pad + 4, y);
  doc.setFont('helvetica', 'bold');
  doc.text(peso(row.gross), W - pad - 4, y, { align: 'right' });

  // ── Deductions ──
  y += 16;
  drawSectionHeader(doc, 'DEDUCTIONS', pad, y, W, [239, 68, 68], gray);
  y += 12;

  // Only show gov deduction lines that were actually applied
  const deductions = [
    ...(row.sss        > 0 ? [['SSS Contribution',                   peso(row.sss)]]        : []),
    ...(row.philhealth > 0 ? [['PhilHealth Contribution',            peso(row.philhealth)]] : []),
    ...(row.pagibig    > 0 ? [['Pag-IBIG Contribution',             peso(row.pagibig)]]    : []),
    [`Withholding Tax (${taxLabel})`, peso(row.tax)],
  ];

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...dark);
  deductions.forEach(([label, val], i) => {
    if (i % 2 === 0) {
      doc.setFillColor(248, 250, 252);
      doc.rect(pad, y - 5, W - pad * 2, 9, 'F');
    }
    doc.text(label, pad + 4, y);
    doc.setTextColor(...gray);
    doc.text(val, W - pad - 4, y, { align: 'right' });
    doc.setTextColor(...dark);
    y += 10;
  });

  // Total deductions row
  doc.setFillColor(254, 242, 242);
  doc.rect(pad, y - 4, W - pad * 2, 9, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(185, 28, 28);
  doc.text('Total Deductions', pad + 4, y + 1);
  doc.text(peso(row.totalDed), W - pad - 4, y + 1, { align: 'right' });

  // ── Net pay box ──
  y += 14;
  doc.setFillColor(...blue);
  doc.roundedRect(pad, y, W - pad * 2, 20, 3, 3, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('NET PAY', pad + 6, y + 8);

  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(186, 214, 255);
  doc.text('Amount to be received', pad + 6, y + 15);

  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(peso(row.net), W - pad - 6, y + 13, { align: 'right' });

  // ── Government contribution numbers ──
  y += 30;
  doc.setFillColor(...light);
  doc.roundedRect(pad, y, W - pad * 2, 14, 2, 2, 'F');
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...gray);
  doc.text('GOVERNMENT NUMBERS', pad + 4, y + 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...dark);
  doc.text(
    `SSS: ${emp.sss_no || '—'}     PhilHealth: ${emp.philhealth_no || '—'}     Pag-IBIG: ${emp.pagibig_no || '—'}`,
    pad + 4, y + 11
  );

  // ── Signature lines ──
  y += 26;
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.5);
  doc.line(pad, y, pad + 70, y);
  doc.line(W - pad - 70, y, W - pad, y);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...gray);
  doc.text('Employee Signature / Date', pad, y + 5);
  doc.text('Authorized Signatory / Date', W - pad, y + 5, { align: 'right' });

  // ── Footer ──
  doc.setFontSize(7);
  doc.setTextColor(180, 180, 180);
  doc.text(
    'This is a system-generated payslip. For concerns, contact HR immediately.',
    W / 2, 287, { align: 'center' }
  );

  const filename = `Payslip_${emp.name.replace(/\s+/g, '_')}_${month}.pdf`;
  doc.save(filename);
}

/** Draw a labeled section header with a colored accent bar. */
function drawSectionHeader(doc, label, pad, y, W, accentColor, grayColor) {
  doc.setFillColor(...accentColor);
  doc.rect(pad, y, 3, 8, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...grayColor);
  doc.text(label, pad + 6, y + 6);
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.3);
  doc.line(pad + 6 + doc.getTextWidth(label) + 4, y + 4, W - pad, y + 4);
}

// ═══════════════════════════════════════════
//  SAVE PAYROLL & GENERATE ALL PAYSLIPS
// ═══════════════════════════════════════════

async function saveAndGeneratePayslips() {
  if (!computedRows.length) { toast('No computed payroll to save.', 'error'); return; }
  const month     = document.getElementById('payMonth').value;
  const taxLabel  = taxMode === 'bir' ? 'BIR 2025' : `Flat ${Math.round(flatTaxRate * 100)}%`;
  const payLabel  = document.getElementById('payLabel').value.trim() || month;

  setLoading(true);
  try {
    const period = {
      month,
      label:          payLabel,
      pay_type:       currentPayType,
      tax_mode:       taxMode,
      employee_count: computedRows.length,
      total_gross:    computedRows.reduce((s, r) => s + r.gross, 0),
      total_net:      computedRows.reduce((s, r) => s + r.net, 0),
    };

    const [savedPeriod] = await sbPost(PERIOD_URL, period);
    const periodId = savedPeriod?.id || uid();

    const records = computedRows.map(r => ({
      period_id:     periodId,
      employee_id:   r.emp.id,
      employee_name: r.emp.name,
      emp_type:      r.empType,
      days_present:  r.daysPresent,
      working_days:  r.workingDays,
      event_name:    r.eventName || null,
      gross_pay:     r.gross,
      sss:           r.sss,
      philhealth:    r.philhealth,
      pagibig:       r.pagibig,
      tax:           r.tax,
      net_pay:       r.net,
    }));

    await sbPost(RECORD_URL, records);
    toast('Payroll saved. Generating payslips…', 'success');

    computedRows.forEach(r => generatePayslipPDF(r, month, taxLabel));

    // Reset
    dtrRows = []; computedRows = [];
    document.getElementById('dtrPreview').style.display = 'none';
    document.getElementById('payrollSummaryBar').style.display = 'none';
    document.getElementById('dtrFileInput').value = '';
    document.getElementById('eventDtrFileInput').value = '';

  } catch (err) {
    console.error(err);
    toast('Failed to save payroll. Check your connection.', 'error');
  } finally {
    setLoading(false);
  }
}

// ═══════════════════════════════════════════
//  HISTORY
// ═══════════════════════════════════════════

async function loadHistory() {
  setLoading(true);
  try {
    payrollHistory = await sbGet(`${PERIOD_URL}?select=*&order=created_at.desc`);
    renderHistory();
  } catch (err) {
    console.error(err);
    toast('Failed to load payroll history.', 'error');
  } finally {
    setLoading(false);
  }
}

function renderHistory() {
  const tbody = document.getElementById('historyTableBody');

  if (!payrollHistory.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state" style="padding:40px">
      <p style="color:var(--text-muted)">No payroll history yet.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = payrollHistory.map(p => {
    const created = new Date(p.created_at).toLocaleDateString('en-PH');
    const typeBadge = p.pay_type === 'event'
      ? `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(167,139,250,0.12);color:#a78bfa;border:1px solid rgba(167,139,250,0.2)">Event</span>`
      : `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(52,211,153,0.08);color:#34d399;border:1px solid rgba(52,211,153,0.15)">Regular</span>`;
    const taxBadge = p.tax_mode === 'flat'
      ? `<span style="font-size:10px;padding:2px 6px;border-radius:3px;background:rgba(251,191,36,0.1);color:#fbbf24">Flat</span>`
      : `<span style="font-size:10px;padding:2px 6px;border-radius:3px;background:rgba(59,130,246,0.1);color:var(--accent-bright)">BIR</span>`;
    return `
      <tr>
        <td class="history-period">${p.label || p.month}</td>
        <td>${typeBadge}</td>
        <td>${taxBadge}</td>
        <td class="mono">${p.employee_count}</td>
        <td class="mono">${peso(p.total_gross)}</td>
        <td class="mono" style="color:var(--accent);font-weight:600">${peso(p.total_net)}</td>
        <td style="font-size:12px;color:var(--text-muted)">${created}</td>
        <td>
          <button class="btn btn-edit" style="font-size:11px;padding:4px 10px"
            onclick="viewPeriodRecords('${p.id}', '${p.month}', '${p.tax_mode || 'bir'}')">
            Re-download
          </button>
        </td>
      </tr>`;
  }).join('');
}

async function viewPeriodRecords(periodId, month, savedTaxMode = 'bir') {
  setLoading(true);
  try {
    const records = await sbGet(`${RECORD_URL}?period_id=eq.${periodId}&select=*&order=employee_name.asc`);
    const [yr, mo] = month.split('-');
    const label = new Date(yr, +mo - 1).toLocaleString('en-PH', { month: 'long', year: 'numeric' });

    if (!confirm(`Re-download ${records.length} payslip${records.length !== 1 ? 's' : ''} for ${label}?`)) return;

    const taxLabel = savedTaxMode === 'flat' ? 'Flat Rate' : 'BIR 2025';
    records.forEach(r => {
      const row = {
        gross: r.gross_pay, sss: r.sss, philhealth: r.philhealth,
        pagibig: r.pagibig, tax: r.tax,
        totalDed: r.sss + r.philhealth + r.pagibig + r.tax,
        net: r.net_pay, daysPresent: r.days_present, workingDays: r.working_days,
        eventName: r.event_name,
        emp: {
          name: r.employee_name, position: '', type: r.emp_type || 'regular',
          sss_no: '', philhealth_no: '', pagibig_no: '',
          daily_rate: r.days_present > 0 ? r.gross_pay / r.days_present : 0,
          event_rate: r.event_name ? r.gross_pay : 0,
        },
      };
      generatePayslipPDF(row, month, taxLabel);
    });
  } catch (err) {
    console.error(err);
    toast('Failed to load period records.', 'error');
  } finally {
    setLoading(false);
  }
}

// ── DTR TEMPLATE DOWNLOADS ─────────────────
function downloadDtrTemplate() {
  const data = [
    { 'Name': 'Juan dela Cruz', 'Days Present': 22, 'Working Days': 26 },
    { 'Name': 'Maria Santos',   'Days Present': 20, 'Working Days': 26 },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 28 }, { wch: 14 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Regular DTR');
  XLSX.writeFile(wb, 'DTR_Regular_Template.xlsx');
  toast('Regular DTR template downloaded.', 'success');
}

function downloadEventDtrTemplate() {
  const data = [
    { 'Name': 'Pedro Reyes',  'Event Name': 'Annual Conference 2025', 'Pay': 3000 },
    { 'Name': 'Ana Gonzales', 'Event Name': 'Annual Conference 2025', 'Pay': 2500 },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 28 }, { wch: 32 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Event DTR');
  XLSX.writeFile(wb, 'DTR_Event_Template.xlsx');
  toast('Event DTR template downloaded.', 'success');
}

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async function () {
  const session = AUTH.requireAuth();
  if (!session) return;

  if (session.role !== 'admin') {
    document.body.innerHTML = `<div style="display:grid;place-items:center;height:100vh;font-family:'Barlow',sans-serif;color:#e8edf5;background:#080c14;">
      <div style="text-align:center">
        <div style="font-size:32px;margin-bottom:12px">🔒</div>
        <div style="font-size:18px;font-weight:700">Admin access required</div>
        <div style="color:#6b7fa3;margin:8px 0 20px">Payroll is restricted to admin users.</div>
        <a href="index.html" style="color:#60a5fa">← Back to Inventory</a>
      </div>
    </div>`;
    return;
  }

  const chipName = document.getElementById('userChipName');
  const chipRole = document.getElementById('userChipRole');
  if (chipName) chipName.textContent = session.display_name || session.username;
  if (chipRole) chipRole.textContent = session.role;

  // Default pay month to current
  const now = new Date();
  document.getElementById('payMonth').value =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Init tax mode UI
  setTaxMode('bir');

  await loadEmployees();
});