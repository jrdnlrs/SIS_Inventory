/* ─────────────────────────────────────────
   SIS — home.js
   Central Hub logic:
   • Role-based view (admin vs employee)
   • Admin: live stats from Supabase
   • Employee: payslip history + DTR records
     from payroll_records/payroll_periods
   • Slideshow auto-advance
   ───────────────────────────────────────── */

// ── SUPABASE ───────────────────────────────
function dbHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

async function dbGet(url) {
  const res = await fetch(url, { headers: dbHeaders() });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

// ── HELPERS ────────────────────────────────
function setLoading(on) {
  const bar = document.getElementById('loadingBar');
  if (bar) bar.style.display = on ? 'block' : 'none';
}

function peso(n) {
  return '₱' + (n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatDate() {
  return new Date().toLocaleDateString('en-PH', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
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
  }, 3000);
}

// ═══════════════════════════════════════════
//  SLIDESHOW
// ═══════════════════════════════════════════
let currentSlide = 0;
let slideshowTimer = null;

function goToSlide(n) {
  const slides = document.querySelectorAll('.slide');
  const dots   = document.querySelectorAll('.slide-dot');
  slides.forEach((s, i) => s.classList.toggle('active', i === n));
  dots.forEach((d, i)   => d.classList.toggle('active', i === n));
  currentSlide = n;
}

function startSlideshow() {
  slideshowTimer = setInterval(() => {
    const slides = document.querySelectorAll('.slide');
    goToSlide((currentSlide + 1) % slides.length);
  }, 4500);
}

// ═══════════════════════════════════════════
//  ADMIN VIEW
// ═══════════════════════════════════════════

async function loadAdminStats() {
  setLoading(true);
  try {
    const [inventory, employees, periods] = await Promise.all([
      dbGet(`${SUPABASE_URL}/rest/v1/inventory?select=id,category`),
      dbGet(`${SUPABASE_URL}/rest/v1/employees?select=id`),
      dbGet(`${SUPABASE_URL}/rest/v1/payroll_periods?select=id`),
    ]);

    const itemCount  = inventory.length;
    const catCount   = new Set(inventory.map(i => i.category).filter(Boolean)).size;
    const empCount   = employees.length;
    const runCount   = periods.length;

    // Stat strip
    document.getElementById('statInventoryItems').textContent = itemCount.toLocaleString();
    document.getElementById('statCategories').textContent     = catCount.toLocaleString();
    document.getElementById('statEmployees').textContent      = empCount.toLocaleString();
    document.getElementById('statPayrollRuns').textContent    = runCount.toLocaleString();

    // Module cards
    document.getElementById('mcInventoryItems').textContent = `${itemCount.toLocaleString()} items`;
    document.getElementById('mcCategories').textContent     = `${catCount} categories`;
    document.getElementById('mcEmployees').textContent      = `${empCount} employees`;
    document.getElementById('mcPayrollRuns').textContent    = `${runCount} payroll runs`;

  } catch (err) {
    console.error(err);
    // Fail silently — stats just show —
  } finally {
    setLoading(false);
  }
}

// ═══════════════════════════════════════════
//  EMPLOYEE VIEW
// ═══════════════════════════════════════════

async function loadEmployeeData(displayName) {
  setLoading(true);
  try {
    // Try to find the employee record by matching display name
    const employees = await dbGet(
      `${SUPABASE_URL}/rest/v1/employees?select=id,name&name=ilike.${encodeURIComponent('%' + displayName + '%')}`
    );

    const emp = employees[0] || null;

    if (emp) {
      await Promise.all([
        loadEmpPayslips(emp.id, emp.name),
        loadEmpDtr(emp.id, emp.name),
      ]);
    } else {
      // Employee not yet in payroll roster
      document.getElementById('empPayslipList').innerHTML = emptyState('No payslip records found yet.');
      document.getElementById('empDtrList').innerHTML     = emptyState('No attendance records found yet.');
    }
  } catch (err) {
    console.error(err);
    document.getElementById('empPayslipList').innerHTML = emptyState('Could not load payslips.');
    document.getElementById('empDtrList').innerHTML     = emptyState('Could not load records.');
  } finally {
    setLoading(false);
  }
}

async function loadEmpPayslips(empId, empName) {
  const records = await dbGet(
    `${SUPABASE_URL}/rest/v1/payroll_records?employee_id=eq.${empId}&select=*,payroll_periods(month,label)&order=period_id.desc&limit=12`
  );

  const el = document.getElementById('empPayslipList');

  if (!records.length) {
    el.innerHTML = emptyState('No payslips yet.');
    return;
  }

  el.innerHTML = records.map(r => {
    const period = r.payroll_periods || {};
    const label  = period.label || period.month || '—';
    const isEvent = r.emp_type === 'event';
    const typeTag = isEvent
      ? `<span class="emp-record-tag event">Event</span>`
      : `<span class="emp-record-tag regular">Regular</span>`;

    return `
      <div class="emp-record-row">
        <div class="emp-record-left">
          <div class="emp-record-period">${label}</div>
          <div class="emp-record-meta">
            ${typeTag}
            ${isEvent && r.event_name ? `<span style="font-size:11px;color:var(--text-muted)">${r.event_name}</span>` : ''}
            ${!isEvent ? `<span style="font-size:11px;color:var(--text-muted)">${r.days_present} / ${r.working_days} days</span>` : ''}
          </div>
        </div>
        <div class="emp-record-right">
          <div class="emp-record-net">${peso(r.net_pay)}</div>
          <div class="emp-record-gross">Gross ${peso(r.gross_pay)}</div>
        </div>
      </div>`;
  }).join('');
}

async function loadEmpDtr(empId, empName) {
  // ── Fetch recent DTR logs directly from dtr_logs table ──────────────────
  const DTR_URL = `${SUPABASE_URL}/rest/v1/dtr_logs`;
  let dtrRows = [];

  try {
    dtrRows = await dbGet(
      `${DTR_URL}?employee_id=eq.${empId}&order=date.desc&limit=30&select=*`
    );
  } catch (_) {
    // Table may not exist yet — fall through to empty state
  }

  // ── Punch CTA ────────────────────────────────────────────────────────────
  const today     = new Date().toISOString().slice(0, 10);
  const todayLog  = dtrRows.find(r => r.date === today) || null;
  const isTimedIn = todayLog && !todayLog.time_out;
  const ctaEl     = document.getElementById('empPunchCta');
  const ctaInner  = document.getElementById('empPunchCtaInner');
  const ctaLabel  = document.getElementById('empPunchCtaLabel');
  const ctaSub    = document.getElementById('empPunchCtaSub');
  const ctaBtn    = document.getElementById('empPunchCtaBtn');

  if (ctaEl) {
    ctaEl.style.display = 'block';
    // Always route the button to the Attendance tab directly
    if (ctaBtn) ctaBtn.href = 'profile.html?tab=dtr';

    if (!todayLog) {
      // Not timed in yet
      ctaInner.className = '';
      ctaLabel.textContent = 'Not yet timed in';
      ctaLabel.style.color = 'var(--green)';
      ctaSub.textContent   = 'Go to Attendance to clock in today';
      ctaBtn.innerHTML     = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg> Time In`;
      ctaBtn.style.background = 'linear-gradient(135deg,#065f46,#34d399)';
      ctaBtn.style.boxShadow  = '0 2px 10px rgba(52,211,153,0.25)';
    } else if (isTimedIn) {
      // Timed in, not out
      const tIn = formatTime(todayLog.time_in);
      ctaInner.className    = 'punched-in';
      ctaLabel.textContent  = `Clocked in at ${tIn}`;
      ctaLabel.style.color  = 'var(--orange)';
      ctaSub.textContent    = 'Go to Attendance to clock out';
      ctaBtn.innerHTML      = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg> Time Out`;
      ctaBtn.style.background = 'linear-gradient(135deg,#d97706,#f59e0b)';
      ctaBtn.style.boxShadow  = '0 2px 10px rgba(245,158,11,0.25)';
    } else {
      // Fully punched out today
      const tIn  = formatTime(todayLog.time_in);
      const tOut = formatTime(todayLog.time_out);
      ctaInner.className    = '';
      ctaLabel.textContent  = `Shift complete · ${tIn} – ${tOut}`;
      ctaLabel.style.color  = 'var(--accent-bright)';
      ctaSub.textContent    = 'View your full log in Attendance';
      ctaBtn.innerHTML      = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M16 2v4M8 2v4M2 10h20"/></svg> View Log`;
      ctaBtn.style.background = 'linear-gradient(135deg,var(--accent-dim),var(--accent))';
      ctaBtn.style.boxShadow  = '0 2px 10px rgba(59,130,246,0.25)';
    }
  }

  // ── DTR log list ─────────────────────────────────────────────────────────
  // Expose all rows to the modal — the card itself opens the modal on click
  window._dtrAllRows = dtrRows;
}

// ── DTR helpers ─────────────────────────────────────────────────────────────
function formatTime(t) {
  if (!t) return '—';
  const d = new Date('1970-01-01T' + (t.length <= 8 ? t : t.slice(11, 19)));
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function emptyState(msg) {
  return `<div style="padding:28px 16px;text-align:center;color:var(--text-muted);font-size:13px;font-family:'JetBrains Mono',monospace">${msg}</div>`;
}

// ═══════════════════════════════════════════
//  ADMIN ATTENDANCE CARD
// ═══════════════════════════════════════════

async function loadAdminAttendance(displayName) {
  const DTR_URL = `${SUPABASE_URL}/rest/v1/dtr_logs`;
  const EMP_URL = `${SUPABASE_URL}/rest/v1/employees`;

  try {
    // Find matching employee record
    const employees = await dbGet(
      `${EMP_URL}?select=id,name&name=ilike.${encodeURIComponent('%' + displayName + '%')}`
    );
    const emp = employees[0] || null;
    if (!emp) return; // No employee record — hide card gracefully

    // Fetch recent DTR logs
    const dtrRows = await dbGet(
      `${DTR_URL}?employee_id=eq.${emp.id}&order=date.desc&limit=30&select=*`
    );

    // Expose to modal (shared with employee modal)
    window._dtrAllRows = dtrRows;

    // Drive the punch CTA
    const today    = new Date().toISOString().slice(0, 10);
    const todayLog = dtrRows.find(r => r.date === today) || null;
    const isTimedIn = todayLog && !todayLog.time_out;

    const ctaEl    = document.getElementById('adminPunchCta');
    const ctaInner = document.getElementById('adminPunchCtaInner');
    const ctaLabel = document.getElementById('adminPunchCtaLabel');
    const ctaSub   = document.getElementById('adminPunchCtaSub');
    const ctaBtn   = document.getElementById('adminPunchCtaBtn');

    if (!ctaEl) return;
    ctaEl.style.display = 'block';
    ctaBtn.href = 'profile.html?tab=dtr';

    if (!todayLog) {
      ctaInner.className    = '';
      ctaLabel.textContent  = 'Not yet timed in';
      ctaLabel.style.color  = 'var(--green)';
      ctaSub.textContent    = 'Go to Attendance to clock in today';
      ctaBtn.innerHTML      = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg> Time In`;
      ctaBtn.style.background = 'linear-gradient(135deg,#065f46,#34d399)';
      ctaBtn.style.boxShadow  = '0 2px 10px rgba(52,211,153,0.25)';
    } else if (isTimedIn) {
      const tIn = _fmtTimeSimple(todayLog.time_in);
      ctaInner.style.background = 'rgba(251,146,60,0.06)';
      ctaLabel.textContent  = `Clocked in at ${tIn}`;
      ctaLabel.style.color  = 'var(--orange)';
      ctaSub.textContent    = 'Go to Attendance to clock out';
      ctaBtn.innerHTML      = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg> Time Out`;
      ctaBtn.style.background = 'linear-gradient(135deg,#d97706,#f59e0b)';
      ctaBtn.style.boxShadow  = '0 2px 10px rgba(245,158,11,0.25)';
    } else {
      const tIn  = _fmtTimeSimple(todayLog.time_in);
      const tOut = _fmtTimeSimple(todayLog.time_out);
      ctaInner.style.background = 'rgba(59,130,246,0.06)';
      ctaLabel.textContent  = `Shift complete · ${tIn} – ${tOut}`;
      ctaLabel.style.color  = 'var(--accent-bright)';
      ctaSub.textContent    = 'View your full log in Attendance';
      ctaBtn.innerHTML      = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M16 2v4M8 2v4M2 10h20"/></svg> View Log`;
      ctaBtn.style.background = 'linear-gradient(135deg,var(--accent-dim),var(--accent))';
      ctaBtn.style.boxShadow  = '0 2px 10px rgba(59,130,246,0.25)';
    }

  } catch (err) {
    console.warn('[admin attendance]', err);
  }
}

function _fmtTimeSimple(t) {
  if (!t) return '—';
  const d = new Date('1970-01-01T' + (t.length <= 8 ? t : t.slice(11, 19)));
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async function () {
  const session = AUTH.requireAuth();
  if (!session) return;

  const isSuperAdmin = session.role === 'superadmin';
  const isAdmin      = session.role === 'admin' || isSuperAdmin;
  const name         = session.display_name || session.username;
  const initials     = name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();

  // Populate header chip
  document.getElementById('userChipName').textContent = name;
  document.getElementById('userChipRole').textContent = session.role;

  // ── Show nav tabs based on role ──
  // Admins and superadmins see Inventory + Payroll tabs
  if (isAdmin) {
    const navInventory = document.getElementById('navInventory');
    const navPayroll   = document.getElementById('navPayroll');
    if (navInventory) navInventory.style.display = '';
    if (navPayroll)   navPayroll.style.display   = '';
  }
  // Only superadmins see the Super Admin tab
  if (isSuperAdmin) {
    const navSA = document.getElementById('navSuperAdmin');
    if (navSA) navSA.style.display = '';
  }

  if (isAdmin) {
    // ── Admin / Super Admin view ──
    document.getElementById('adminView').style.display = 'block';
    document.getElementById('adminGreeting').textContent = `${greeting()}, ${name.split(' ')[0]} 👋`;
    document.getElementById('hubDate').textContent = formatDate();
    await loadAdminStats();
    await loadAdminAttendance(name);

  } else {
    // ── Employee view ──
    document.getElementById('employeeView').style.display = 'block';

    // Slideshow hero
    const heroName = document.getElementById('empHeroName');
    const heroRole = document.getElementById('empHeroRole');
    const heroInit = document.getElementById('slideshowInitials');
    if (heroName) heroName.textContent = name;
    if (heroRole) heroRole.textContent = session.role.charAt(0).toUpperCase() + session.role.slice(1);
    if (heroInit) heroInit.textContent = initials;

    startSlideshow();
    await loadEmployeeData(name);
  }
});