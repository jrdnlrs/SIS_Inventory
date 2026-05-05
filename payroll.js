/* ─────────────────────────────────────────
   SIS — payroll.js  (v2)
   Employee management, DTR upload,
   payroll computation, payslip PDF generation.

   Regular Employees:
   • Daily rate × days present (prorated from working days)
   • SSS, PhilHealth, Pag-IBIG, Withholding Tax (toggleable)

   Event-Based Employees:
   • ₱2,000 flat per day
   • Late deduction = minutes late × (2000 ÷ 480)
   • No government contributions or tax (gross = net)
   • DTR columns: Name · Role · Time In · Time Out · Working Hours · Status

   Both types can appear in the same pay run.
   ───────────────────────────────────────── */

// ── SUPABASE TABLES ────────────────────────
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
let dtrRows        = [];        // regular DTR rows
let eventDtrRows   = [];        // event DTR rows
let computedRows   = [];        // all computed rows (regular + event merged)
let payrollHistory = [];
let currentPayType = 'regular'; // 'regular' | 'event'
let taxMode        = 'bir';     // 'bir' | 'flat'
let flatRatePct    = 10;        // flat rate %

const EVENT_DAY_RATE    = 2000;           // ₱2,000 per event day
const EVENT_RATE_PER_MIN = EVENT_DAY_RATE / 480; // ₱4.1667/minute

// ── SUPABASE HELPERS ───────────────────────
async function sbGet(url) {
  const res = await fetch(url, { headers: makeDbHeaders() });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

async function sbPost(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: makeDbHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let errMsg = `POST failed: ${res.status}`;
    try { errMsg = JSON.stringify(await res.json()); } catch (_) {}
    throw new Error(errMsg);
  }
  return res.json();
}

async function sbPatch(url, body) {
  const res = await fetch(url, {
    method: 'PATCH', headers: makeDbHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${url} failed: ${res.status}`);
  return res.json();
}

async function sbDelete(url) {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: makeDbHeaders({ Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`DELETE ${url} failed: ${res.status}`);
}

// ── LOADING ────────────────────────────────
function setLoading(on) {
  const bar = document.getElementById('loadingBar');
  if (bar) bar.style.display = on ? 'block' : 'none';
}

// ── TOAST ──────────────────────────────────
function toast(msg, type = 'info') {
  const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';
  const el   = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icon}</span> ${msg}`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut 0.3s ease-in forwards';
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

// ── TAB SWITCHING ──────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.ptab-content').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.payroll-tabs .ptab').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${name}`).style.display = 'block';
  btn.classList.add('active');
  if (name === 'history') loadHistory();
}

// ── PAY TYPE TOGGLE ────────────────────────
function switchPayType(type, btn) {
  currentPayType = type;
  document.querySelectorAll('.pay-type-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const regularSection = document.getElementById('dtrRegularSection');
  const eventSection   = document.getElementById('dtrEventSection');

  if (type === 'regular') {
    regularSection.style.display = 'block';
    eventSection.style.display   = 'none';
  } else {
    regularSection.style.display = 'none';
    eventSection.style.display   = 'block';
  }

  // Clear preview when switching types
  document.getElementById('dtrPreview').style.display        = 'none';
  document.getElementById('payrollSummaryBar').style.display = 'none';
}

// ── TAX MODE ───────────────────────────────
function setTaxMode(mode) {
  taxMode = mode;
  document.getElementById('btnTaxBir').classList.toggle('active', mode === 'bir');
  document.getElementById('btnTaxFlat').classList.toggle('active', mode === 'flat');
  document.getElementById('flatRateRow').style.display = mode === 'flat' ? 'flex' : 'none';
}

function updateFlatRate(val) {
  flatRatePct = parseInt(val, 10);
  document.getElementById('flatRateDisplay').textContent = `${flatRatePct}%`;
}

// ── GOV CONTRIBUTION TOGGLES ───────────────
function toggleGovContrib(type, checkbox) {
  // Visual feedback only — actual toggle state is read at compute time
}

// ── DTR SOURCE TOGGLE ──────────────────────
function switchDtrSource(src) {
  const livePanel = document.getElementById('liveDtrPanel');
  const filePanel = document.getElementById('fileDtrPanel');
  const btnLive   = document.getElementById('dtrSrcLive');
  const btnFile   = document.getElementById('dtrSrcFile');

  if (src === 'live') {
    livePanel.style.display = 'flex';
    filePanel.style.display = 'none';
    btnLive.classList.add('active');
    btnFile.classList.remove('active');
  } else {
    livePanel.style.display = 'none';
    filePanel.style.display = 'flex';
    btnFile.classList.add('active');
    btnLive.classList.remove('active');
  }

  dtrRows = [];
  document.getElementById('dtrPreview').style.display        = 'none';
  document.getElementById('payrollSummaryBar').style.display = 'none';
}

// ── FORMAT HELPERS ─────────────────────────
function peso(n) {
  return '₱' + (n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── TIME PARSING ───────────────────────────
/**
 * Parse a time string like "8:00 AM", "08:00", "8:00:00 AM" → total minutes from midnight.
 * Returns null if unparseable.
 */
function parseTimeToMinutes(raw) {
  if (raw === null || raw === undefined) return null;

  // Excel serial time (fraction of a day)
  if (typeof raw === 'number') {
    return Math.round(raw * 24 * 60);
  }

  const s = String(raw).trim();
  if (!s) return null;

  // HH:MM AM/PM or H:MM AM/PM
  const ampm = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    const period = ampm[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  }

  // HH:MM or HH:MM:SS (24-hr)
  const hhmm = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hhmm) {
    return parseInt(hhmm[1], 10) * 60 + parseInt(hhmm[2], 10);
  }

  return null;
}

/**
 * Format total minutes → "H:MM AM/PM"
 */
function formatMinutes(totalMin) {
  if (totalMin === null || totalMin === undefined) return '—';
  const h   = Math.floor(totalMin / 60) % 24;
  const m   = totalMin % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh   = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ═══════════════════════════════════════════
//  DEDUCTION COMPUTATIONS (Regular)
// ═══════════════════════════════════════════

function computeSSS(monthlyGross) {
  const msc = Math.min(35000, Math.max(5000, Math.round(monthlyGross / 500) * 500));
  return Math.min(Math.round(msc * 0.045), 1575);
}

function computePhilHealth(monthlyGross) {
  return Math.round(Math.min(monthlyGross * 0.05, 5000) / 2);
}

function computePagIbig(monthlyGross) {
  return monthlyGross < 1500 ? Math.round(monthlyGross * 0.01) : 100;
}

function computeWithholdingTax(monthlyGross, sss, philhealth, pagibig) {
  const taxable = Math.max(0, monthlyGross - sss - philhealth - pagibig);
  if (taxMode === 'flat') return taxable * (flatRatePct / 100);
  // BIR 2025 graduated
  if (taxable <= 20833)  return 0;
  if (taxable <= 33332)  return (taxable - 20833) * 0.15;
  if (taxable <= 66666)  return 1875 + (taxable - 33333) * 0.20;
  if (taxable <= 166666) return 8541.80 + (taxable - 66667) * 0.25;
  if (taxable <= 666666) return 33541.80 + (taxable - 166667) * 0.30;
  return 183541.80 + (taxable - 666667) * 0.35;
}

function computePayForEmployee(emp, daysPresent, workingDays) {
  const gross        = Math.round(emp.daily_rate * daysPresent * 100) / 100;
  const ratio        = workingDays > 0 ? daysPresent / workingDays : 1;
  const monthlyEquiv = workingDays > 0 ? emp.daily_rate * workingDays : gross;

  const sssOn  = document.getElementById('chkSss')?.checked       ?? false;
  const philOn = document.getElementById('chkPhilhealth')?.checked ?? false;
  const pagOn  = document.getElementById('chkPagibig')?.checked    ?? false;

  const sss        = sssOn  ? Math.round(computeSSS(monthlyEquiv)        * ratio * 100) / 100 : 0;
  const philhealth = philOn ? Math.round(computePhilHealth(monthlyEquiv) * ratio * 100) / 100 : 0;
  const pagibig    = pagOn  ? Math.round(computePagIbig(monthlyEquiv)    * ratio * 100) / 100 : 0;

  const monthlyTax = computeWithholdingTax(
    monthlyEquiv,
    computeSSS(monthlyEquiv),
    computePhilHealth(monthlyEquiv),
    computePagIbig(monthlyEquiv)
  );
  const tax = Math.round(monthlyTax * ratio * 100) / 100;

  const totalDed = sss + philhealth + pagibig + tax;
  const net      = Math.round((gross - totalDed) * 100) / 100;

  return { gross, sss, philhealth, pagibig, tax, totalDed, net, daysPresent, workingDays };
}

// ═══════════════════════════════════════════
//  EVENT PAY COMPUTATION
//  ₱2,000/day, deduct per-minute if late.
//  No government deductions — gross = net.
// ═══════════════════════════════════════════

/**
 * Compute pay for one event DTR row.
 * @param {object} row — { name, role, days: [{timeIn, timeOut, workingHours, status, minutesLate}] }
 * @returns {{ gross, lateDeduction, net, totalDays, lateDays }}
 */
function computeEventPay(row) {
  let gross         = 0;
  let lateDeduction = 0;
  let lateDays      = 0;

  row.days.forEach(d => {
    const status = (d.status || '').trim().toUpperCase();
    if (status === 'PRESENT') {
      gross += EVENT_DAY_RATE;
    } else if (status === 'LATE') {
      // Deduct: minutes late × rate per minute
      const minLate = d.minutesLate || 0;
      const ded     = Math.round(minLate * EVENT_RATE_PER_MIN * 100) / 100;
      gross        += EVENT_DAY_RATE;
      lateDeduction += ded;
      lateDays++;
    }
    // Absent / empty → no pay for that day
  });

  const net = Math.max(0, Math.round((gross - lateDeduction) * 100) / 100);
  return {
    gross:         Math.round(gross * 100) / 100,
    lateDeduction: Math.round(lateDeduction * 100) / 100,
    net,
    totalDays:     row.days.filter(d => ['PRESENT','LATE'].includes((d.status||'').toUpperCase())).length,
    lateDays,
    sss: 0, philhealth: 0, pagibig: 0, tax: 0,
    totalDed: lateDeduction,
  };
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
  count.textContent = `${employees.length} employee${employees.length !== 1 ? 's' : ''}`;

  if (!employees.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40" style="opacity:.2;margin-bottom:12px"><circle cx="12" cy="8" r="5"/><path d="M3 21c0-4 4-7 9-7s9 3 9 7"/></svg>
      <p>No employees yet. Add one to get started.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = employees.map(e => {
    const typeTag = e.emp_type === 'event'
      ? `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(167,139,250,0.1);color:#a78bfa;border:1px solid rgba(167,139,250,0.2);font-family:'JetBrains Mono',monospace;margin-left:6px">EVENT</span>`
      : `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(52,211,153,0.08);color:var(--green);border:1px solid rgba(52,211,153,0.15);font-family:'JetBrains Mono',monospace;margin-left:6px">REGULAR</span>`;

    const rateLabel = e.emp_type === 'event'
      ? `<span style="color:var(--text-muted);font-size:11px">₱2,000/day (fixed)</span>`
      : `<span class="mono">${peso(e.daily_rate)}/day</span>`;

    return `
    <tr class="${e.emp_type === 'event' ? 'emp-type-event' : ''}">
      <td><strong>${e.name}</strong>${typeTag}</td>
      <td style="color:var(--text-muted);font-size:12px">${e.position || '—'}</td>
      <td>${rateLabel}</td>
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

function toggleEmpTypeFields() {
  const type = document.getElementById('efType').value;
  document.getElementById('rateRegularGroup').style.display = type === 'regular' ? '' : 'none';
  document.getElementById('rateEventGroup').style.display   = type === 'event'   ? '' : 'none';
}

function openEmpModal(id = null) {
  editEmpId = id;
  document.getElementById('empModalTitle').textContent = id ? 'Edit Employee' : 'Add Employee';
  const emp = id ? employees.find(e => e.id === id) || {} : {};
  document.getElementById('efName').value       = emp.name          || '';
  document.getElementById('efPosition').value   = emp.position      || '';
  document.getElementById('efType').value       = emp.emp_type      || 'regular';
  document.getElementById('efRate').value       = emp.daily_rate    || '';
  document.getElementById('efEventRate').value  = emp.event_rate    || '';
  document.getElementById('efSss').value        = emp.sss_no        || '';
  document.getElementById('efPhilhealth').value = emp.philhealth_no || '';
  document.getElementById('efPagibig').value    = emp.pagibig_no    || '';
  document.getElementById('efStatus').value     = emp.status        || 'active';
  toggleEmpTypeFields();
  document.getElementById('empOverlay').classList.add('open');
  setTimeout(() => document.getElementById('efName').focus(), 100);
}

function closeEmpModal() {
  document.getElementById('empOverlay').classList.remove('open');
  editEmpId = null;
}

function closeEmpModalOutside(e) {
  if (e.target === document.getElementById('empOverlay')) closeEmpModal();
}

async function saveEmployee() {
  const name    = document.getElementById('efName').value.trim();
  const empType = document.getElementById('efType').value;

  if (!name) { toast('Name is required.', 'error'); return; }

  let daily_rate  = null;
  let event_rate  = null;

  if (empType === 'regular') {
    daily_rate = parseFloat(document.getElementById('efRate').value);
    if (!daily_rate || daily_rate <= 0) { toast('Daily rate is required for regular employees.', 'error'); return; }
  } else {
    // Event-based: rate is fixed ₱2,000 but store their profile event_rate field too
    event_rate = parseFloat(document.getElementById('efEventRate').value) || EVENT_DAY_RATE;
    daily_rate = event_rate; // store for reference; actual compute uses EVENT_DAY_RATE constant
  }

  const data = {
    name,
    position:      document.getElementById('efPosition').value.trim(),
    emp_type:      empType,
    daily_rate,
    event_rate,
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
//  REGULAR DTR — EXCEL UPLOAD
// ═══════════════════════════════════════════

function onDtrFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (evt) {
    try {
      const wb = XLSX.read(evt.target.result, { type: 'binary' });
      const empMap   = {};
      let   validDays = 0;

      wb.SheetNames.forEach(sheetName => {
        const ws = wb.Sheets[sheetName];
        if (!ws || !ws['!ref']) return;

        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

        let headerIdx = -1;
        for (let i = 0; i < Math.min(8, rows.length); i++) {
          const r = rows[i] || [];
          if (r.some(v => typeof v === 'string' && v.toLowerCase().includes('employee name'))) {
            headerIdx = i; break;
          }
        }
        if (headerIdx === -1) return;

        const hdr     = rows[headerIdx] || [];
        const nameCol = hdr.findIndex(v => typeof v === 'string' && v.toLowerCase().includes('employee name'));
        const statCol = hdr.findIndex(v => typeof v === 'string' && v.toLowerCase() === 'status');
        const NC      = nameCol !== -1 ? nameCol : 1;
        const SC      = statCol !== -1 ? statCol : 6;

        let foundAny = false;
        for (let i = headerIdx + 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row) continue;
          const rawName = row[NC];
          if (rawName === null || rawName === undefined) continue;
          if (typeof rawName === 'number') continue;
          if (typeof rawName !== 'string') continue;
          const trimmed = rawName.trim();
          if (!trimmed) continue;
          if (/^total/i.test(trimmed)) continue;
          if (/^P\s*=/i.test(trimmed) || /^A\s*=/i.test(trimmed) || /^L\s*=/i.test(trimmed)) continue;
          if (/^\/\//i.test(trimmed)) continue;

          const name   = trimmed.replace(/\s*\*+\s*$/, '').replace(/\s+/g, ' ').trim();
          if (!name) continue;

          const rawStat = row[SC];
          const status  = (rawStat !== null && rawStat !== undefined) ? String(rawStat).trim().toUpperCase() : '';
          const worked  = status === 'P' || status === 'L';

          const key = normalizeName(name);
          if (!empMap[key]) empMap[key] = { name, daysPresent: 0, sheets: {} };
          if (worked) empMap[key].daysPresent++;
          empMap[key].sheets[sheetName] = status || '—';
          foundAny = true;
        }

        if (foundAny) validDays++;
      });

      dtrRows = Object.values(empMap).map(r => ({
        name:        r.name,
        daysPresent: r.daysPresent,
        workingDays: validDays,
        sheets:      r.sheets,
        type:        'regular',
      }));

      if (!dtrRows.length) {
        toast('No employee rows found. Make sure the file uses the standard SIS DTR format.', 'error');
        return;
      }

      renderDtrPreview('regular');
      document.getElementById('dtrPreview').style.display = 'block';
      toast(`DTR loaded — ${dtrRows.length} employees across ${validDays} day${validDays !== 1 ? 's' : ''}.`, 'success');

    } catch (err) {
      console.error('[DTR parse error]', err);
      toast('Could not read the DTR file. Make sure it is a valid .xlsx file.', 'error');
    }
  };
  reader.readAsBinaryString(file);
}

// ═══════════════════════════════════════════
//  EVENT DTR — EXCEL UPLOAD
//
//  Expected columns (flexible header detection):
//  Name | Role | Time In | Time Out | Working Hours | Status
//
//  One row per employee per day (multiple rows per employee OK).
//  Status: Present | Late
//  If Late: minutesLate = timeIn - expectedStart (8:00 AM)
// ═══════════════════════════════════════════

const EVENT_EXPECTED_START = 8 * 60; // 8:00 AM in minutes

function onEventDtrFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (evt) {
    try {
      const wb   = XLSX.read(evt.target.result, { type: 'binary', cellDates: false });
      const empMap = {}; // normalizedKey → { name, role, days[] }

      wb.SheetNames.forEach(sheetName => {
        const ws = wb.Sheets[sheetName];
        if (!ws || !ws['!ref']) return;

        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

        // Find header row
        let headerIdx = -1;
        for (let i = 0; i < Math.min(10, rows.length); i++) {
          const r = rows[i] || [];
          const hasName   = r.some(v => typeof v === 'string' && /name/i.test(v));
          const hasStatus = r.some(v => typeof v === 'string' && /status/i.test(v));
          if (hasName && hasStatus) { headerIdx = i; break; }
        }
        if (headerIdx === -1) return;

        const hdr = rows[headerIdx] || [];

        // Detect column indices
        const col = (keywords) => hdr.findIndex(v =>
          typeof v === 'string' && keywords.some(kw => v.toLowerCase().includes(kw))
        );

        const NC  = col(['employee name', 'name']);
        const RC  = col(['role', 'position']);
        const TIC = col(['time in', 'timein', 'in']);
        const TOC = col(['time out', 'timeout', 'out']);
        const WHC = col(['working hours', 'hours', 'wh']);
        const SC  = col(['status']);

        if (NC === -1 || SC === -1) return; // skip sheet without required cols

        for (let i = headerIdx + 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row) continue;

          const rawName = row[NC];
          if (!rawName || typeof rawName === 'number') continue;
          const trimmed = String(rawName).trim();
          if (!trimmed || /^total/i.test(trimmed)) continue;

          const name   = trimmed.replace(/\s*\*+\s*$/, '').replace(/\s+/g, ' ').trim();
          if (!name) continue;

          const role   = RC !== -1 && row[RC] ? String(row[RC]).trim() : '';
          const rawSt  = row[SC];
          const status = rawSt ? String(rawSt).trim() : '';
          if (!status) continue;

          // Parse time in to compute minutes late
          const timeInMin  = TIC !== -1 ? parseTimeToMinutes(row[TIC]) : null;
          const timeOutMin = TOC !== -1 ? parseTimeToMinutes(row[TOC]) : null;

          let minutesLate = 0;
          if (/late/i.test(status) && timeInMin !== null) {
            minutesLate = Math.max(0, timeInMin - EVENT_EXPECTED_START);
          }

          // Working hours: prefer parsed, fallback to Time Out - Time In
          let workingHours = null;
          if (WHC !== -1 && row[WHC] !== null && row[WHC] !== undefined) {
            const rawWH = row[WHC];
            if (typeof rawWH === 'number') {
              workingHours = rawWH < 2 ? Math.round(rawWH * 24 * 100) / 100 : rawWH; // Excel fraction or plain hours
            } else {
              workingHours = parseFloat(String(rawWH)) || null;
            }
          } else if (timeInMin !== null && timeOutMin !== null && timeOutMin > timeInMin) {
            workingHours = Math.round((timeOutMin - timeInMin) / 60 * 100) / 100;
          }

          const key = normalizeName(name);
          if (!empMap[key]) empMap[key] = { name, role, days: [] };

          empMap[key].days.push({
            sheet:        sheetName,
            timeIn:       timeInMin,
            timeOut:      timeOutMin,
            workingHours,
            status,
            minutesLate,
          });
        }
      });

      eventDtrRows = Object.values(empMap).filter(r => r.days.length > 0);

      if (!eventDtrRows.length) {
        toast('No event employee rows found. Check that your file has Name, Status columns.', 'error');
        return;
      }

      renderDtrPreview('event');
      document.getElementById('dtrPreview').style.display = 'block';
      toast(`Event DTR loaded — ${eventDtrRows.length} employees.`, 'success');

    } catch (err) {
      console.error('[Event DTR parse error]', err);
      toast('Could not read the event DTR file.', 'error');
    }
  };
  reader.readAsBinaryString(file);
}

// ── EVENT DTR TEMPLATE ────────────────────
function downloadEventDtrTemplate() {
  const data = [
    { 'Employee Name': 'Juan dela Cruz', 'Role': 'Operator',   'Time In': '8:00 AM',  'Time Out': '5:00 PM', 'Working Hours': 9, 'Status': 'Present' },
    { 'Employee Name': 'Maria Santos',   'Role': 'Marshaller', 'Time In': '8:15 AM',  'Time Out': '5:00 PM', 'Working Hours': 8.75, 'Status': 'Late' },
    { 'Employee Name': 'Pedro Reyes',    'Role': 'Operator',   'Time In': '8:00 AM',  'Time Out': '5:00 PM', 'Working Hours': 9, 'Status': 'Present' },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Event DTR');
  XLSX.writeFile(wb, 'Event_DTR_Template.xlsx');
  toast('Event DTR template downloaded.', 'success');
}

// ── REGULAR DTR TEMPLATE ──────────────────
function downloadDtrTemplate() {
  const data = [
    { 'Employee Name': 'Juan dela Cruz', 'Status': 'P' },
    { 'Employee Name': 'Maria Santos',   'Status': 'L' },
    { 'Employee Name': 'Pedro Reyes',    'Status': 'A' },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 24 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'DTR');
  XLSX.writeFile(wb, 'Regular_DTR_Template.xlsx');
  toast('Regular DTR template downloaded.', 'success');
}

// ── NAME MATCHING ─────────────────────────
function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\*/g, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(Boolean).sort().join(' ');
}

function matchEmployee(name) {
  if (!name) return null;
  const key = normalizeName(name);

  let emp = employees.find(e => e.status === 'active' && normalizeName(e.name) === key);
  if (emp) return emp;

  const dtrTokens = key.split(' ').filter(t => t.length > 1);
  emp = employees.find(e => {
    if (e.status !== 'active') return false;
    const ek = normalizeName(e.name);
    return dtrTokens.every(t => ek.includes(t));
  });
  if (emp) return emp;

  emp = employees.find(e => {
    if (e.status !== 'active') return false;
    const empTokens = normalizeName(e.name).split(' ').filter(t => t.length > 1);
    return empTokens.length >= 2 && empTokens.every(t => key.includes(t));
  });
  return emp || null;
}

// ═══════════════════════════════════════════
//  DTR PREVIEW RENDER
// ═══════════════════════════════════════════

function renderDtrPreview(type) {
  const tbody = document.getElementById('dtrPreviewBody');

  if (type === 'event') {
    tbody.innerHTML = eventDtrRows.map(r => {
      const emp = matchEmployee(r.name);
      const tag = emp
        ? `<span style="color:var(--green);font-size:11px">✓ ${emp.name}</span>`
        : `<span style="color:var(--red);font-size:11px">✗ No match — add to Employees tab</span>`;

      const totalPresent = r.days.filter(d => /present|late/i.test(d.status)).length;
      const totalLate    = r.days.filter(d => /late/i.test(d.status)).length;
      const totalMinLate = r.days.reduce((s, d) => s + (d.minutesLate || 0), 0);

      // Preview pay estimate
      const previewPay = totalPresent > 0
        ? peso(Math.max(0, totalPresent * EVENT_DAY_RATE - totalMinLate * EVENT_RATE_PER_MIN))
        : '—';

      return `
        <tr style="background:rgba(167,139,250,0.03)">
          <td>
            <strong>${r.name}</strong>
            ${r.role ? `<span style="font-size:11px;color:#a78bfa;margin-left:6px">${r.role}</span>` : ''}
            <br><span style="font-size:11px;display:block;margin-top:2px">${tag}</span>
          </td>
          <td class="mono">
            ${totalPresent} day${totalPresent !== 1 ? 's' : ''}
            ${totalLate ? `<br><span style="color:var(--orange);font-size:11px">${totalLate} late (${totalMinLate} min)</span>` : ''}
          </td>
          <td class="mono" style="color:#a78bfa">₱2,000/day</td>
          <td class="mono">${previewPay}</td>
          <td colspan="5" style="color:var(--text-dim);font-size:12px">— click Compute Payroll —</td>
        </tr>`;
    }).join('');
    return;
  }

  // Regular preview
  tbody.innerHTML = dtrRows.map(r => {
    const emp = matchEmployee(r.name);
    const tag = emp
      ? `<span style="color:var(--green);font-size:11px">✓ ${emp.name}</span>`
      : `<span style="color:var(--red);font-size:11px">✗ No match — add to Employees tab</span>`;

    const sourceInfo = r.source === 'live'
      ? `<span style="display:inline-flex;align-items:center;gap:4px;margin-top:4px;font-size:10px;font-family:'JetBrains Mono',monospace;">
           <span style="background:rgba(52,211,153,0.12);color:var(--green);border:1px solid rgba(52,211,153,0.2);padding:1px 6px;border-radius:4px;">LIVE</span>
           ${r.lates > 0 ? `<span style="color:var(--orange)">${r.lates} late day${r.lates > 1 ? 's' : ''}</span>` : ''}
         </span>`
      : (() => {
          const dots = Object.entries(r.sheets || {}).map(([sheet, st]) => {
            const color = st === 'P' ? 'var(--green)' : st === 'L' ? 'var(--orange)' : 'var(--red)';
            return `<span title="${sheet}: ${st}" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin:1px;"></span>`;
          }).join('');
          return `<div style="margin-top:4px">${dots}</div>`;
        })();

    return `
      <tr>
        <td>
          <strong>${r.name}</strong><br>
          <span style="font-size:11px;display:block;margin-top:2px">${tag}</span>
          ${sourceInfo}
        </td>
        <td class="mono">${r.daysPresent} / ${r.workingDays}</td>
        <td class="mono">${emp ? peso(emp.daily_rate) : '—'}</td>
        <td colspan="6" style="color:var(--text-dim);font-size:12px">— click Compute Payroll —</td>
      </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════
//  COMPUTE PAYROLL
//  Merges regular + event rows if both loaded
// ═══════════════════════════════════════════

function computePayroll() {
  const month = document.getElementById('payMonth').value;
  if (!month)            { toast('Please select a pay month first.', 'error'); return; }
  if (!employees.length) { toast('No active employees. Add employees first.', 'error'); return; }

  const hasRegular = dtrRows.length > 0;
  const hasEvent   = eventDtrRows.length > 0;

  if (!hasRegular && !hasEvent) {
    toast('Upload at least one DTR file first.', 'error');
    return;
  }

  computedRows = [];
  let totalGross = 0, totalDed = 0, totalNet = 0, unmatched = 0;
  const tbody = document.getElementById('dtrPreviewBody');
  tbody.innerHTML = '';

  // ── Regular rows ──
  if (hasRegular) {
    dtrRows.forEach(r => {
      const emp = matchEmployee(r.name);
      if (!emp) {
        unmatched++;
        tbody.innerHTML += `
          <tr style="opacity:.5">
            <td><strong>${r.name}</strong><br>
              <span style="color:var(--red);font-size:11px">✗ No match — skipped</span></td>
            <td>${r.daysPresent} / ${r.workingDays}</td>
            <td colspan="8" style="color:var(--text-dim)">—</td>
          </tr>`;
        return;
      }

      const c = computePayForEmployee(emp, r.daysPresent, r.workingDays || 1);
      computedRows.push({ emp, ...c, month, emp_type: 'regular' });
      totalGross += c.gross;
      totalDed   += c.totalDed;
      totalNet   += c.net;

      const empJson = JSON.stringify({
        name: emp.name, position: emp.position, sss_no: emp.sss_no,
        philhealth_no: emp.philhealth_no, pagibig_no: emp.pagibig_no,
        daily_rate: emp.daily_rate,
      }).replace(/'/g, '&#39;');
      const rowJson = JSON.stringify({ ...c }).replace(/'/g, '&#39;');

      tbody.innerHTML += `
        <tr>
          <td>
            <strong>${emp.name}</strong><br>
            <span style="font-size:11px;color:var(--text-muted)">${emp.position || ''}</span><br>
            <span style="font-size:10px;color:var(--text-dim)">DTR: ${r.name}</span>
          </td>
          <td class="mono">${c.daysPresent} / ${c.workingDays}</td>
          <td class="mono">${peso(emp.daily_rate)}/day</td>
          <td class="mono">${peso(c.gross)}</td>
          <td class="mono" style="color:var(--text-muted)">${peso(c.sss)}</td>
          <td class="mono" style="color:var(--text-muted)">${peso(c.philhealth)}</td>
          <td class="mono" style="color:var(--text-muted)">${peso(c.pagibig)}</td>
          <td class="mono" style="color:var(--text-muted)">${peso(c.tax)}</td>
          <td class="mono" style="color:var(--accent);font-weight:600">${peso(c.net)}</td>
          <td>
            <button class="btn btn-edit" style="font-size:11px;padding:4px 10px"
              onclick='generatePayslipPDF({...${rowJson}, emp: ${empJson}}, "${month}", "regular")'>
              Payslip
            </button>
          </td>
        </tr>`;
    });
  }

  // ── Event rows ──
  if (hasEvent) {
    // Separator row
    if (hasRegular) {
      tbody.innerHTML += `
        <tr>
          <td colspan="10" style="padding:8px 14px;background:rgba(167,139,250,0.06);border-top:1px solid rgba(167,139,250,0.15);border-bottom:1px solid rgba(167,139,250,0.15);">
            <span style="font-size:10px;font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:1.2px;color:#a78bfa;">
              ◆ Event-Based Employees — ₱2,000/day · No gov deductions
            </span>
          </td>
        </tr>`;
    }

    eventDtrRows.forEach(r => {
      const emp = matchEmployee(r.name);
      if (!emp) {
        unmatched++;
        tbody.innerHTML += `
          <tr style="opacity:.5;background:rgba(167,139,250,0.03)">
            <td><strong>${r.name}</strong> <span style="font-size:10px;color:#a78bfa">${r.role || ''}</span><br>
              <span style="color:var(--red);font-size:11px">✗ No match — skipped</span></td>
            <td colspan="9" style="color:var(--text-dim)">—</td>
          </tr>`;
        return;
      }

      const c = computeEventPay(r);
      computedRows.push({ emp, ...c, month, emp_type: 'event', event_role: r.role, event_days: r.days });
      totalGross += c.gross;
      totalDed   += c.lateDeduction;
      totalNet   += c.net;

      const lateInfo = c.lateDays > 0
        ? `<span style="color:var(--orange);font-size:11px">Late ded: ${peso(c.lateDeduction)}</span>`
        : '';

      const empJson = JSON.stringify({
        name: emp.name, position: r.role || emp.position,
        sss_no: '', philhealth_no: '', pagibig_no: '',
        daily_rate: EVENT_DAY_RATE,
      }).replace(/'/g, '&#39;');
      const rowJson = JSON.stringify({
        gross: c.gross, sss: 0, philhealth: 0, pagibig: 0,
        tax: 0, totalDed: c.lateDeduction, net: c.net,
        daysPresent: c.totalDays, workingDays: c.totalDays,
        lateDeduction: c.lateDeduction, lateDays: c.lateDays,
      }).replace(/'/g, '&#39;');

      tbody.innerHTML += `
        <tr style="background:rgba(167,139,250,0.03)">
          <td>
            <strong>${emp.name}</strong>
            ${r.role ? `<span style="font-size:11px;color:#a78bfa;margin-left:6px">${r.role}</span>` : ''}
            <br>
            <span style="font-size:10px;color:var(--text-dim)">DTR: ${r.name}</span>
          </td>
          <td class="mono">${c.totalDays} day${c.totalDays !== 1 ? 's' : ''}
            ${c.lateDays ? `<br><span style="color:var(--orange);font-size:10px">${c.lateDays} late</span>` : ''}
          </td>
          <td class="mono" style="color:#a78bfa">₱2,000/day</td>
          <td class="mono">${peso(c.gross)}</td>
          <td class="mono" style="color:var(--text-dim)">—</td>
          <td class="mono" style="color:var(--text-dim)">—</td>
          <td class="mono" style="color:var(--text-dim)">—</td>
          <td class="mono" style="color:var(--orange)">${c.lateDeduction > 0 ? `- ${peso(c.lateDeduction)}` : '—'}</td>
          <td class="mono" style="color:var(--accent);font-weight:600">${peso(c.net)}</td>
          <td>
            <button class="btn btn-edit" style="font-size:11px;padding:4px 10px"
              onclick='generatePayslipPDF({...${rowJson}, emp: ${empJson}}, "${month}", "event")'>
              Payslip
            </button>
          </td>
        </tr>`;
    });
  }

  // ── Summary bar ──
  const empCount = document.getElementById('sumEmpCount');
  if (empCount) empCount.textContent = computedRows.length;
  document.getElementById('sumGross').textContent = peso(totalGross);
  document.getElementById('sumDed').textContent   = peso(totalDed);
  document.getElementById('sumNet').textContent   = peso(totalNet);
  document.getElementById('payrollSummaryBar').style.display = 'flex';

  if (unmatched) toast(`${unmatched} row${unmatched > 1 ? 's' : ''} not matched — skipped.`, 'error');
  toast(`Payroll computed — ${computedRows.length} employee${computedRows.length !== 1 ? 's' : ''}.`, 'success');
}

// ═══════════════════════════════════════════
//  PAYSLIP PDF — Regular + Event variants
// ═══════════════════════════════════════════

function generatePayslipPDF(row, month, type = 'regular') {
  const { jsPDF } = window.jspdf;
  const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const emp  = row.emp;
  const W    = 210;
  const pad  = 20;

  const accent = type === 'event' ? [167, 139, 250] : [59, 130, 246];
  const dark   = [8, 12, 20];

  // ── Header bar ──
  doc.setFillColor(...dark);
  doc.rect(0, 0, W, 30, 'F');

  doc.setTextColor(...accent);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Supreme InfoTech Solutions', pad, 13);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(180, 180, 180);
  doc.text(type === 'event' ? 'EVENT PAYSLIP' : 'PAYSLIP', pad, 20);

  const [yr, mo] = month.split('-');
  const monthName = new Date(yr, mo - 1).toLocaleString('en-PH', { month: 'long', year: 'numeric' });
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.text(`Pay Period: ${monthName}`, W - pad, 13, { align: 'right' });
  doc.setFontSize(8);
  doc.setTextColor(180, 180, 180);
  doc.text(`Generated: ${new Date().toLocaleDateString('en-PH')}`, W - pad, 20, { align: 'right' });

  // ── Employee info box ──
  let y = 40;
  doc.setFillColor(240, 240, 240);
  doc.roundedRect(pad, y, W - pad * 2, 28, 3, 3, 'F');

  doc.setTextColor(...dark);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text(emp.name, pad + 6, y + 9);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);
  doc.text(emp.position || (type === 'event' ? 'Event Staff' : 'Employee'), pad + 6, y + 16);

  doc.setFontSize(8);
  if (type === 'event') {
    doc.text(`Rate: ₱2,000/day (fixed)`, pad + 6, y + 23);
    doc.text(`Days: ${row.daysPresent}${row.lateDays ? ` (${row.lateDays} late)` : ''}`, pad + 80, y + 23);
  } else {
    doc.text(`Daily Rate: ${peso(emp.daily_rate)}`, pad + 6, y + 23);
    doc.text(`Days Present: ${row.daysPresent} / ${row.workingDays}`, pad + 80, y + 23);
  }

  // ── Earnings ──
  y += 36;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.text('EARNINGS', pad, y);
  y += 5;
  doc.setDrawColor(220, 220, 220);
  doc.line(pad, y, W - pad, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...dark);
  doc.text(type === 'event' ? `Basic Pay (${row.daysPresent} × ₱2,000)` : 'Basic Pay', pad, y);
  doc.text(peso(row.gross), W - pad, y, { align: 'right' });

  // ── Deductions ──
  y += 12;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.text('DEDUCTIONS', pad, y);
  y += 5;
  doc.line(pad, y, W - pad, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...dark);

  if (type === 'event') {
    if (row.lateDeduction > 0) {
      const totalMinLate = Math.round(row.lateDeduction / EVENT_RATE_PER_MIN);
      doc.text(`Late Deduction (${totalMinLate} min × ₱${EVENT_RATE_PER_MIN.toFixed(4)})`, pad, y);
      doc.text(peso(row.lateDeduction), W - pad, y, { align: 'right' });
      y += 8;
    } else {
      doc.setTextColor(160, 160, 160);
      doc.text('No deductions', pad, y);
      y += 8;
    }
  } else {
    const deductions = [
      ['SSS Contribution',        peso(row.sss)],
      ['PhilHealth Contribution',  peso(row.philhealth)],
      ['Pag-IBIG Contribution',    peso(row.pagibig)],
      ['Withholding Tax',          peso(row.tax)],
    ];
    deductions.forEach(([label, val]) => {
      doc.setTextColor(...dark);
      doc.text(label, pad, y);
      doc.text(val, W - pad, y, { align: 'right' });
      y += 8;
    });
  }

  // Total deductions
  y += 2;
  doc.setDrawColor(200, 200, 200);
  doc.line(pad, y, W - pad, y);
  y += 6;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...dark);
  doc.text('Total Deductions', pad, y);
  doc.text(peso(row.totalDed), W - pad, y, { align: 'right' });

  // ── Net pay box ──
  y += 12;
  doc.setFillColor(...accent);
  doc.roundedRect(pad, y, W - pad * 2, 18, 3, 3, 'F');
  doc.setTextColor(...dark);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('NET PAY', pad + 6, y + 7);
  doc.setFontSize(14);
  doc.text(peso(row.net), W - pad - 6, y + 11, { align: 'right' });

  // ── Gov numbers (regular only) ──
  if (type === 'regular') {
    y += 28;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(`SSS: ${emp.sss_no || '—'}    PhilHealth: ${emp.philhealth_no || '—'}    Pag-IBIG: ${emp.pagibig_no || '—'}`, pad, y);
  }

  // ── Signature lines ──
  y += type === 'regular' ? 20 : 36;
  doc.setDrawColor(80, 80, 80);
  doc.line(pad, y, pad + 60, y);
  doc.line(W - pad - 60, y, W - pad, y);
  y += 5;
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text('Employee Signature', pad, y);
  doc.text('Authorized Signatory', W - pad, y, { align: 'right' });

  // ── Footer ──
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text('This is a system-generated payslip. No signature required for digital copies.', W / 2, 285, { align: 'center' });

  const filename = `Payslip_${type === 'event' ? 'Event_' : ''}${emp.name.replace(/\s+/g, '_')}_${month}.pdf`;
  doc.save(filename);
}

// ── SAVE & GENERATE ALL PAYSLIPS ──────────
async function saveAndGeneratePayslips() {
  if (!computedRows.length) { toast('No computed payroll to save.', 'error'); return; }
  const month    = document.getElementById('payMonth').value;
  const runLabel = document.getElementById('payLabel')?.value?.trim() || '';

  const [yr, mo]   = month.split('-').map(Number);
  const monthLabel = new Date(yr, mo - 1).toLocaleString('en-PH', { month: 'long', year: 'numeric' });
  const label      = runLabel || monthLabel;

  setLoading(true);
  try {
    const periodId   = uid();
    const totalGross = computedRows.reduce((s, r) => s + r.gross, 0);
    const totalDed   = computedRows.reduce((s, r) => s + r.totalDed, 0);
    const totalNet   = computedRows.reduce((s, r) => s + r.net, 0);

    const hasRegular = computedRows.some(r => r.emp_type !== 'event');
    const hasEvent   = computedRows.some(r => r.emp_type === 'event');
    const typeLabel  = hasRegular && hasEvent ? 'mixed' : hasEvent ? 'event' : 'regular';

    const period = {
      id:               periodId,
      month,
      label,
      pay_type:         typeLabel,
      tax_mode:         taxMode,
      employee_count:   computedRows.length,
      total_gross:      totalGross,
      total_deductions: totalDed,
      total_net:        totalNet,
    };

    await sbPost(PERIOD_URL, period);

    const records = computedRows.map(r => ({
      id:            uid(),
      period_id:     periodId,
      employee_id:   r.emp.id,
      employee_name: r.emp.name,
      emp_type:      r.emp_type || 'regular',
      event_name:    r.event_role || null,
      days_present:  r.daysPresent ?? r.totalDays ?? 0,
      working_days:  r.workingDays ?? r.totalDays ?? 0,
      gross_pay:     r.gross,
      sss:           r.sss,
      philhealth:    r.philhealth,
      pagibig:       r.pagibig,
      tax:           r.tax,
      net_pay:       r.net,
    }));

    await sbPost(RECORD_URL, records);
    toast('Payroll saved. Generating payslips…', 'success');

    computedRows.forEach(r => {
      const type = r.emp_type === 'event' ? 'event' : 'regular';
      generatePayslipPDF(r, month, type);
    });

    // Reset
    dtrRows      = [];
    eventDtrRows = [];
    computedRows = [];
    document.getElementById('dtrPreview').style.display        = 'none';
    document.getElementById('payrollSummaryBar').style.display = 'none';

  } catch (err) {
    console.error('[saveAndGeneratePayslips]', err);
    let detail = err.message || 'Unknown error';
    try {
      const parsed = JSON.parse(err.message);
      detail = parsed.message || parsed.details || parsed.hint || detail;
    } catch (_) {}
    toast(`Failed to save payroll: ${detail}`, 'error');
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
    payrollHistory = await sbGet(`${PERIOD_URL}?select=*&order=month.desc`);
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
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state" style="padding:40px">
      <p style="color:var(--text-muted)">No payroll history yet.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = payrollHistory.map(p => {
    const [yr, mo] = p.month.split('-');
    const label    = p.label || new Date(yr, mo - 1).toLocaleString('en-PH', { month: 'long', year: 'numeric' });
    const created  = new Date(p.created_at).toLocaleDateString('en-PH');

    const typeTag = p.pay_type === 'event'
      ? `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(167,139,250,0.1);color:#a78bfa;border:1px solid rgba(167,139,250,0.2);font-family:'JetBrains Mono',monospace;">EVENT</span>`
      : p.pay_type === 'mixed'
      ? `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(251,191,36,0.08);color:var(--yellow);border:1px solid rgba(251,191,36,0.18);font-family:'JetBrains Mono',monospace;">MIXED</span>`
      : `<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(52,211,153,0.08);color:var(--green);border:1px solid rgba(52,211,153,0.15);font-family:'JetBrains Mono',monospace;">REGULAR</span>`;

    const taxTag = p.tax_mode === 'flat'
      ? `<span style="font-size:10px;color:var(--yellow);font-family:'JetBrains Mono',monospace;">Flat</span>`
      : `<span style="font-size:10px;color:var(--accent-bright);font-family:'JetBrains Mono',monospace;">BIR 2025</span>`;

    return `
      <tr>
        <td class="history-period">${label}</td>
        <td>${typeTag}</td>
        <td>${taxTag}</td>
        <td class="mono">${p.employee_count}</td>
        <td class="mono">${peso(p.total_gross)}</td>
        <td class="mono" style="color:var(--accent);font-weight:600">${peso(p.total_net)}</td>
        <td style="font-size:12px;color:var(--text-muted)">${created}</td>
        <td>
          <button class="btn btn-edit" style="font-size:11px;padding:4px 10px"
            onclick="viewPeriodRecords('${p.id}', '${p.month}')">View</button>
        </td>
      </tr>`;
  }).join('');
}

async function viewPeriodRecords(periodId, month) {
  setLoading(true);
  try {
    const records = await sbGet(`${RECORD_URL}?period_id=eq.${periodId}&select=*&order=employee_name.asc`);
    const [yr, mo] = month.split('-');
    const label = new Date(yr, mo - 1).toLocaleString('en-PH', { month: 'long', year: 'numeric' });
    if (!confirm(`Re-download ${records.length} payslip${records.length !== 1 ? 's' : ''} for ${label}?`)) return;

    // Find the period to get tax_mode
    const period = payrollHistory.find(p => p.id === periodId);
    const savedTaxMode = period?.tax_mode || 'bir';

    records.forEach(r => {
      const totalDed = (r.sss || 0) + (r.philhealth || 0) + (r.pagibig || 0) + (r.tax || 0);
      const empType  = r.emp_type || 'regular';

      const row = {
        gross:         r.gross_pay,
        sss:           r.sss,
        philhealth:    r.philhealth,
        pagibig:       r.pagibig,
        tax:           r.tax,
        totalDed,
        lateDeduction: totalDed, // for event type, totalDed IS the late deduction
        net:           r.net_pay,
        daysPresent:   r.days_present,
        workingDays:   r.working_days,
        lateDays:      0,
        emp: {
          name:          r.employee_name,
          position:      r.event_name || '',
          daily_rate:    empType === 'event' ? EVENT_DAY_RATE : (r.gross_pay / (r.days_present || 1)),
          sss_no:        '',
          philhealth_no: '',
          pagibig_no:    '',
        },
      };
      generatePayslipPDF(row, month, empType);
    });
  } catch (err) {
    console.error(err);
    toast('Failed to load period records.', 'error');
  } finally {
    setLoading(false);
  }
}

// ── LIVE DTR ──────────────────────────────
async function loadLiveDtr() {
  const month = document.getElementById('payMonth').value;
  if (!month) { toast('Select a pay period first.', 'error'); return; }

  const workingDays = parseInt(document.getElementById('liveWorkingDays').value, 10) || 26;
  const [yr, mo]   = month.split('-').map(Number);
  const dateFrom   = `${month}-01`;
  const dateTo     = new Date(yr, mo, 0).toISOString().slice(0, 10);

  setLoading(true);
  try {
    const DTR_URL = `${SUPABASE_URL}/rest/v1/dtr_logs`;
    const logs    = await sbGet(
      `${DTR_URL}?date=gte.${dateFrom}&date=lte.${dateTo}&time_in=not.is.null&select=employee_id,date,time_in,time_out,is_late`
    );

    if (!logs.length) {
      toast(`No punch records found for ${month}.`, 'error');
      setLoading(false);
      return;
    }

    const empDays = {};
    logs.forEach(log => {
      if (!empDays[log.employee_id]) empDays[log.employee_id] = { dates: new Set(), lates: 0 };
      empDays[log.employee_id].dates.add(log.date);
      if (log.is_late) empDays[log.employee_id].lates++;
    });

    const idToEmp = {};
    employees.forEach(e => { idToEmp[e.id] = e; });

    dtrRows = [];
    const unmatchedIds = [];

    Object.entries(empDays).forEach(([empId, data]) => {
      const emp = idToEmp[empId];
      if (!emp) { unmatchedIds.push(empId); return; }
      dtrRows.push({
        name:        emp.name,
        daysPresent: data.dates.size,
        workingDays,
        lates:       data.lates,
        source:      'live',
        type:        'regular',
      });
    });

    if (!dtrRows.length) {
      toast('Punch records found but no employees matched.', 'error');
      setLoading(false);
      return;
    }

    renderDtrPreview('regular');
    document.getElementById('dtrPreview').style.display = 'block';

    const msg = unmatchedIds.length
      ? `Live DTR loaded — ${dtrRows.length} employees. ${unmatchedIds.length} unmatched punch record(s).`
      : `Live DTR loaded — ${dtrRows.length} employees, ${workingDays} working days.`;
    toast(msg, unmatchedIds.length ? 'info' : 'success');

  } catch (err) {
    console.error('[loadLiveDtr]', err);
    toast('Failed to load live DTR records.', 'error');
  } finally {
    setLoading(false);
  }
}

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async function () {
  const session = AUTH.requireAuth();
  if (!session) return;

  if (session.role !== 'admin' && session.role !== 'superadmin') {
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

  const navSA = document.getElementById('navSuperAdmin');
  if (navSA) navSA.style.display = (session.role === 'superadmin') ? '' : 'none';

  const now = new Date();
  document.getElementById('payMonth').value =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Initialize tax mode display
  setTaxMode('bir');

  await loadEmployees();
});