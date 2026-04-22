/* ─────────────────────────────────────────
   StockDesk — payroll.js
   Employee management, DTR upload,
   payroll computation, payslip PDF generation.

   Deductions (2025):
   • SSS     — per official contribution table
   • PhilHealth — 5% of basic, EE = 2.5% (max ₱5,000/mo total)
   • Pag-IBIG   — ₱100 fixed EE contribution
   • Withholding Tax — 2025 BIR graduated table (monthly)
   ───────────────────────────────────────── */

// ── SUPABASE TABLES ────────────────────────
const EMP_URL     = `${SUPABASE_URL}/rest/v1/employees`;
const PERIOD_URL  = `${SUPABASE_URL}/rest/v1/payroll_periods`;
const RECORD_URL  = `${SUPABASE_URL}/rest/v1/payroll_records`;

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
let dtrRows        = [];   // parsed DTR rows pending compute
let computedRows   = [];   // computed payroll rows
let payrollHistory = [];

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
  if (!res.ok) throw new Error(`POST ${url} failed: ${res.status}`);
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
  document.querySelectorAll('.ptab').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${name}`).style.display = 'block';
  btn.classList.add('active');
  if (name === 'history') loadHistory();
}

// ── FORMAT HELPERS ─────────────────────────
function peso(n) {
  return '₱' + (n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ═══════════════════════════════════════════
//  DEDUCTION COMPUTATIONS
// ═══════════════════════════════════════════

/**
 * SSS EE contribution (2025 schedule).
 * Based on monthly salary credit brackets.
 */
function computeSSS(monthlyGross) {
  const g = monthlyGross;
  // 2025 SSS table — EE contribution = 4.5% of MSC, max ₱900
  // MSC brackets (simplified: floor to nearest 500, min 5000, max 35000)
  const msc = Math.min(35000, Math.max(5000, Math.round(g / 500) * 500));
  const ee  = Math.round(msc * 0.045);
  return Math.min(ee, 1575); // 2025 max EE = ₱1,575
}

/**
 * PhilHealth EE contribution (2025).
 * 5% of basic monthly salary, EE pays 2.5%, max total ₱5,000/month.
 */
function computePhilHealth(monthlyGross) {
  const total = monthlyGross * 0.05;
  const capped = Math.min(total, 5000);
  return Math.round(capped / 2); // EE pays half
}

/**
 * Pag-IBIG EE contribution (2025).
 * Fixed ₱100 for monthly salary ≥ ₱1,500.
 */
function computePagIbig(monthlyGross) {
  if (monthlyGross < 1500) return Math.round(monthlyGross * 0.01);
  return 100;
}

/**
 * BIR withholding tax — 2025 graduated table (monthly).
 * Based on taxable income after non-taxable deductions.
 */
function computeWithholdingTax(monthlyGross, sss, philhealth, pagibig) {
  // Taxable income = Gross - mandatory deductions
  const taxable = Math.max(0, monthlyGross - sss - philhealth - pagibig);

  // 2025 BIR Monthly Graduated Tax Table
  if (taxable <= 20833)  return 0;
  if (taxable <= 33332)  return (taxable - 20833) * 0.15;
  if (taxable <= 66666)  return 1875 + (taxable - 33333) * 0.20;
  if (taxable <= 166666) return 8541.80 + (taxable - 66667) * 0.25;
  if (taxable <= 666666) return 33541.80 + (taxable - 166667) * 0.30;
  return 183541.80 + (taxable - 666667) * 0.35;
}

/**
 * Compute all deductions and net pay for one employee for a given period.
 * daysPresent / workingDays prorates the monthly salary.
 */
function computePayForEmployee(emp, daysPresent, workingDays) {
  const gross        = Math.round(emp.daily_rate * daysPresent * 100) / 100;
  // Monthly equivalent for deduction purposes (extrapolate to full month)
  const monthlyEquiv = workingDays > 0 ? (gross / daysPresent) * workingDays : gross;

  const sss          = computeSSS(monthlyEquiv);
  const philhealth   = computePhilHealth(monthlyEquiv);
  const pagibig      = computePagIbig(monthlyEquiv);
  const tax          = Math.round(computeWithholdingTax(monthlyEquiv, sss, philhealth, pagibig) * 100) / 100;
  const totalDed     = sss + philhealth + pagibig + tax;
  const net          = Math.round((gross - totalDed) * 100) / 100;

  return { gross, sss, philhealth, pagibig, tax, totalDed, net, daysPresent, workingDays };
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

  tbody.innerHTML = employees.map(e => `
    <tr>
      <td><strong>${e.name}</strong></td>
      <td style="color:var(--text-muted);font-size:12px">${e.position || '—'}</td>
      <td class="mono">${peso(e.daily_rate)}</td>
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
    </tr>
  `).join('');
}

// ── EMPLOYEE MODAL ─────────────────────────
let editEmpId = null;

function openEmpModal(id = null) {
  editEmpId = id;
  document.getElementById('empModalTitle').textContent = id ? 'Edit Employee' : 'Add Employee';
  const emp = id ? employees.find(e => e.id === id) || {} : {};
  document.getElementById('efName').value       = emp.name         || '';
  document.getElementById('efPosition').value   = emp.position     || '';
  document.getElementById('efRate').value       = emp.daily_rate   || '';
  document.getElementById('efSss').value        = emp.sss_no       || '';
  document.getElementById('efPhilhealth').value = emp.philhealth_no || '';
  document.getElementById('efPagibig').value    = emp.pagibig_no   || '';
  document.getElementById('efStatus').value     = emp.status       || 'active';
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
  const name = document.getElementById('efName').value.trim();
  const rate = parseFloat(document.getElementById('efRate').value);
  if (!name)       { toast('Name is required.', 'error'); return; }
  if (!rate || rate <= 0) { toast('Daily rate is required.', 'error'); return; }

  const data = {
    name,
    position:      document.getElementById('efPosition').value.trim(),
    daily_rate:    rate,
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
//  DTR UPLOAD & PAYROLL COMPUTE
// ═══════════════════════════════════════════

/**
 * Parse the actual SIS LIV Golf DTR format:
 *
 * Structure (consistent across all sheets):
 *   Row 0 (index): Title — "ATTENDANCE (Date) LIV GOLF …"
 *   Row 1 (index): Empty
 *   Row 2 (index): Headers — col[1]="Employee Name", col[6]="Status"
 *   Row 3+:        Data rows
 *
 * Rules:
 *   - col[1] must be a non-empty string (not a number, not "Total …")
 *   - col[6] (Status): P = Present, L = Late → count as worked day
 *   - Skip rows where col[1] is null, a number, or starts with "Total"
 *   - "LIV MEXICO" sheet has no data — skip sheets with 0 employee rows
 *   - Working days = number of valid sheets (sheets with ≥1 employee row)
 */
function onDtrFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (evt) {
    try {
      const wb = XLSX.read(evt.target.result, { type: 'binary' });

      // Per-employee map: normalizedKey → { name, daysPresent, sheets{} }
      const empMap     = {};
      let   validDays  = 0;

      wb.SheetNames.forEach(sheetName => {
        const ws = wb.Sheets[sheetName];
        if (!ws || !ws['!ref']) return;

        // Read as 2D array — no header inference, nulls preserved
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

        // Find header row: first row where any cell contains "Employee Name"
        let headerIdx = -1;
        for (let i = 0; i < Math.min(8, rows.length); i++) {
          const r = rows[i] || [];
          if (r.some(v => typeof v === 'string' && v.toLowerCase().includes('employee name'))) {
            headerIdx = i;
            break;
          }
        }
        if (headerIdx === -1) return; // No header found — skip sheet

        // Determine column positions from header row
        const hdr      = rows[headerIdx] || [];
        const nameCol  = hdr.findIndex(v => typeof v === 'string' && v.toLowerCase().includes('employee name'));
        const statCol  = hdr.findIndex(v => typeof v === 'string' && v.toLowerCase() === 'status');
        const NC       = nameCol !== -1 ? nameCol : 1;   // default col B
        const SC       = statCol !== -1 ? statCol : 6;   // default col G

        // Collect employee rows from this sheet
        let foundAny = false;
        for (let i = headerIdx + 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row) continue;

          const rawName = row[NC];

          // Skip: null, numbers, "Total Present/Absent:", legend rows
          if (rawName === null || rawName === undefined)      continue;
          if (typeof rawName === 'number')                    continue;
          if (typeof rawName !== 'string')                    continue;
          const trimmed = rawName.trim();
          if (!trimmed)                                       continue;
          if (/^total/i.test(trimmed))                       continue;
          if (/^P\s*=/i.test(trimmed) || /^A\s*=/i.test(trimmed) || /^L\s*=/i.test(trimmed)) continue;
          if (/^\/\//i.test(trimmed))                        continue; // comment rows

          // Clean name: remove trailing asterisks, normalize spaces
          const name   = trimmed.replace(/\s*\*+\s*$/, '').replace(/\s+/g, ' ').trim();
          if (!name) continue;

          const rawStat = row[SC];
          const status  = (rawStat !== null && rawStat !== undefined)
            ? String(rawStat).trim().toUpperCase()
            : '';
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
      }));

      if (!dtrRows.length) {
        toast('No employee rows found. Make sure the file uses the standard SIS DTR format.', 'error');
        return;
      }

      renderDtrPreview();
      document.getElementById('dtrPreview').style.display = 'block';
      toast(
        `DTR loaded — ${dtrRows.length} employees across ${validDays} day${validDays !== 1 ? 's' : ''}.`,
        'success'
      );

    } catch (err) {
      console.error('[DTR parse error]', err);
      toast('Could not read the DTR file. Make sure it is a valid .xlsx file.', 'error');
    }
  };
  reader.readAsBinaryString(file);
}

/**
 * Normalize a name for fuzzy matching.
 * Handles "Last, First Middle" and "First Last" by sorting tokens.
 * Strips asterisks, extra whitespace.
 */
function normalizeName(name) {
  if (!name) return '';
  let n = name.toLowerCase()
    .replace(/\*/g, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n.split(' ').filter(Boolean).sort().join(' ');
}

/**
 * Match a DTR name string to an employee record.
 * 1. Exact normalized match
 * 2. All DTR tokens present in employee's normalized name
 * 3. All employee tokens present in DTR normalized name
 */
function matchEmployee(name) {
  if (!name) return null;
  const key = normalizeName(name);

  // Pass 1: exact
  let emp = employees.find(e => e.status === 'active' && normalizeName(e.name) === key);
  if (emp) return emp;

  // Pass 2: every DTR token is in the employee key
  const dtrTokens = key.split(' ').filter(t => t.length > 1);
  emp = employees.find(e => {
    if (e.status !== 'active') return false;
    const ek = normalizeName(e.name);
    return dtrTokens.every(t => ek.includes(t));
  });
  if (emp) return emp;

  // Pass 3: every employee token is in the DTR key (at least 2 tokens)
  emp = employees.find(e => {
    if (e.status !== 'active') return false;
    const empTokens = normalizeName(e.name).split(' ').filter(t => t.length > 1);
    return empTokens.length >= 2 && empTokens.every(t => key.includes(t));
  });
  return emp || null;
}

function renderDtrPreview() {
  const tbody = document.getElementById('dtrPreviewBody');
  tbody.innerHTML = dtrRows.map(r => {
    const emp = matchEmployee(r.name);
    const tag = emp
      ? `<span style="color:var(--green);font-size:11px">✓ ${emp.name}</span>`
      : `<span style="color:var(--red);font-size:11px">✗ No match — add to Employees tab</span>`;

    const dots = Object.entries(r.sheets).map(([sheet, st]) => {
      const color = st === 'P' ? 'var(--green)' : st === 'L' ? 'var(--orange)' : 'var(--red)';
      return `<span title="${sheet}: ${st}" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin:1px;"></span>`;
    }).join('');

    return `
      <tr>
        <td>
          <strong>${r.name}</strong><br>
          <span style="font-size:11px;display:block;margin-top:2px">${tag}</span>
          <div style="margin-top:4px">${dots}</div>
        </td>
        <td class="mono">${r.daysPresent} / ${r.workingDays}</td>
        <td class="mono">${emp ? peso(emp.daily_rate) : '—'}</td>
        <td colspan="6" style="color:var(--text-dim);font-size:12px">— click Compute Payroll —</td>
      </tr>`;
  }).join('');
}

function computePayroll() {
  const month = document.getElementById('payMonth').value;
  if (!month)            { toast('Please select a pay month first.', 'error'); return; }
  if (!employees.length) { toast('No active employees. Add employees first.', 'error'); return; }
  if (!dtrRows.length)   { toast('Upload a DTR file first.', 'error'); return; }

  computedRows = [];
  let totalGross = 0, totalDed = 0, totalNet = 0, unmatched = 0;

  const tbody = document.getElementById('dtrPreviewBody');
  tbody.innerHTML = '';

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
    computedRows.push({ emp, ...c, month });
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
        <td class="mono">${peso(emp.daily_rate)}</td>
        <td class="mono" style="color:var(--text)">${peso(c.gross)}</td>
        <td class="mono" style="color:var(--text-muted)">${peso(c.sss)}</td>
        <td class="mono" style="color:var(--text-muted)">${peso(c.philhealth)}</td>
        <td class="mono" style="color:var(--text-muted)">${peso(c.pagibig)}</td>
        <td class="mono" style="color:var(--text-muted)">${peso(c.tax)}</td>
        <td class="mono" style="color:var(--accent);font-weight:600">${peso(c.net)}</td>
        <td>
          <button class="btn btn-edit" style="font-size:11px;padding:4px 10px"
            onclick="generatePayslipPDF({...${rowJson}, emp: ${empJson}}, '${month}')">
            Payslip
          </button>
        </td>
      </tr>`;
  });

  document.getElementById('sumGross').textContent = peso(totalGross);
  document.getElementById('sumDed').textContent   = peso(totalDed);
  document.getElementById('sumNet').textContent   = peso(totalNet);
  document.getElementById('payrollSummaryBar').style.display = 'flex';

  if (unmatched) toast(`${unmatched} row${unmatched > 1 ? 's' : ''} not matched to any employee — skipped.`, 'error');
  toast(`Payroll computed — ${computedRows.length} employee${computedRows.length !== 1 ? 's' : ''}.`, 'success');
}

// ═══════════════════════════════════════════
//  PAYSLIP PDF GENERATION
// ═══════════════════════════════════════════

function generatePayslipPDF(row, month) {
  const { jsPDF } = window.jspdf;
  const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const emp  = row.emp;
  const W    = 210; // A4 width mm
  const pad  = 20;

  // Accent color
  const accent = [59, 130, 246];  // SIS brand blue
  const dark   = [8, 12, 20];    // SIS dark navy

  // ── Header bar ──
  doc.setFillColor(...dark);
  doc.rect(0, 0, W, 30, 'F');

  doc.setTextColor(96, 165, 250);  // accent-bright
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Supreme InfoTech Solutions', pad, 13);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(180, 180, 180);
  doc.text('PAYSLIP', pad, 20);

  // Period
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
  doc.text(emp.position || 'Employee', pad + 6, y + 16);

  doc.setFontSize(8);
  doc.text(`Daily Rate: ${peso(emp.daily_rate)}`, pad + 6, y + 23);
  doc.text(`Days Present: ${row.daysPresent} / ${row.workingDays}`, pad + 80, y + 23);

  // ── Earnings section ──
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
  doc.text('Basic Pay', pad, y);
  doc.text(peso(row.gross), W - pad, y, { align: 'right' });

  // ── Deductions section ──
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

  const deductions = [
    ['SSS Contribution',       peso(row.sss)],
    ['PhilHealth Contribution', peso(row.philhealth)],
    ['Pag-IBIG Contribution',   peso(row.pagibig)],
    ['Withholding Tax',         peso(row.tax)],
  ];

  deductions.forEach(([label, val]) => {
    doc.text(label, pad, y);
    doc.text(val, W - pad, y, { align: 'right' });
    y += 8;
  });

  // Total deductions
  y += 2;
  doc.setDrawColor(200, 200, 200);
  doc.line(pad, y, W - pad, y);
  y += 6;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
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

  // ── Government numbers ──
  y += 28;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.text(`SSS: ${emp.sss_no || '—'}    PhilHealth: ${emp.philhealth_no || '—'}    Pag-IBIG: ${emp.pagibig_no || '—'}`, pad, y);

  // ── Signature lines ──
  y += 20;
  doc.setDrawColor(80, 80, 80);
  doc.line(pad, y, pad + 60, y);
  doc.line(W - pad - 60, y, W - pad, y);

  y += 5;
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text('Employee Signature', pad, y);
  doc.text("Authorized Signatory", W - pad, y, { align: 'right' });

  // ── Footer ──
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text('This is a system-generated payslip. No signature required for digital copies.', W / 2, 285, { align: 'center' });

  // Save
  const filename = `Payslip_${emp.name.replace(/\s+/g, '_')}_${month}.pdf`;
  doc.save(filename);
}

// ── SAVE PAYROLL & GENERATE ALL PAYSLIPS ──
async function saveAndGeneratePayslips() {
  if (!computedRows.length) { toast('No computed payroll to save.', 'error'); return; }
  const month = document.getElementById('payMonth').value;

  setLoading(true);
  try {
    const periodId = uid();
    const period = {
      id:             periodId,
      month,
      employee_count: computedRows.length,
      total_gross:    computedRows.reduce((s, r) => s + r.gross, 0),
      total_net:      computedRows.reduce((s, r) => s + r.net, 0),
    };

    await sbPost(PERIOD_URL, period);

    // Save individual records
    const records = computedRows.map(r => ({
      period_id:    periodId,
      employee_id:  r.emp.id,
      employee_name: r.emp.name,
      days_present: r.daysPresent,
      working_days: r.workingDays,
      gross_pay:    r.gross,
      sss:          r.sss,
      philhealth:   r.philhealth,
      pagibig:      r.pagibig,
      tax:          r.tax,
      net_pay:      r.net,
    }));

    await sbPost(RECORD_URL, records);
    toast('Payroll saved. Generating payslips…', 'success');

    // Generate one PDF per employee
    computedRows.forEach(r => {
      generatePayslipPDF(r, month);
    });

    // Clear DTR
    dtrRows     = [];
    computedRows = [];
    document.getElementById('dtrPreview').style.display = 'none';
    document.getElementById('payrollSummaryBar').style.display = 'none';

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
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state" style="padding:40px">
      <p style="color:var(--text-muted)">No payroll history yet.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = payrollHistory.map(p => {
    const [yr, mo] = p.month.split('-');
    const label = new Date(yr, mo - 1).toLocaleString('en-PH', { month: 'long', year: 'numeric' });
    const created = new Date(p.created_at).toLocaleDateString('en-PH');
    return `
      <tr>
        <td class="history-period">${label}</td>
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

    // Re-generate payslips from saved records
    if (!confirm(`Re-download ${records.length} payslip${records.length !== 1 ? 's' : ''} for ${label}?`)) return;

    records.forEach(r => {
      const row = {
        gross: r.gross_pay, sss: r.sss, philhealth: r.philhealth,
        pagibig: r.pagibig, tax: r.tax, totalDed: r.sss + r.philhealth + r.pagibig + r.tax,
        net: r.net_pay, daysPresent: r.days_present, workingDays: r.working_days,
        emp: {
          name: r.employee_name, position: '', daily_rate: r.gross_pay / r.days_present,
          sss_no: '', philhealth_no: '', pagibig_no: '',
        },
      };
      generatePayslipPDF(row, month);
    });
  } catch (err) {
    console.error(err);
    toast('Failed to load period records.', 'error');
  } finally {
    setLoading(false);
  }
}

// ── DTR TEMPLATE DOWNLOAD ──────────────────
function downloadDtrTemplate() {
  const data = [
    { 'Name': 'Juan dela Cruz', 'Days Present': 22, 'Working Days': 26 },
    { 'Name': 'Maria Santos',   'Days Present': 20, 'Working Days': 26 },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 28 }, { wch: 14 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'DTR');
  XLSX.writeFile(wb, 'DTR_Template.xlsx');
  toast('DTR template downloaded.', 'success');
}

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async function () {
  const session = AUTH.requireAuth();
  if (!session) return;

  // Admin only
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

  // User chip
  const chipName = document.getElementById('userChipName');
  const chipRole = document.getElementById('userChipRole');
  if (chipName) chipName.textContent = session.display_name || session.username;
  if (chipRole) chipRole.textContent = session.role;

  // Default pay month to current month
  const now = new Date();
  document.getElementById('payMonth').value =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  await loadEmployees();
}); 