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
  const records = await dbGet(
    `${SUPABASE_URL}/rest/v1/payroll_records?employee_id=eq.${empId}&select=days_present,working_days,emp_type,event_name,gross_pay,payroll_periods(month,label)&order=period_id.desc&limit=12`
  );

  const el = document.getElementById('empDtrList');

  if (!records.length) {
    el.innerHTML = emptyState('No attendance records yet.');
    return;
  }

  el.innerHTML = records.map(r => {
    const period   = r.payroll_periods || {};
    const label    = period.label || period.month || '—';
    const isEvent  = r.emp_type === 'event';

    const attendance = isEvent
      ? `<span style="color:var(--accent-bright)">${r.event_name || 'Event'}</span>`
      : `<span style="color:var(--text)">${r.days_present}</span><span style="color:var(--text-muted)"> / ${r.working_days} days</span>`;

    const pct = !isEvent && r.working_days > 0
      ? Math.round((r.days_present / r.working_days) * 100)
      : null;

    const barColor = pct === null ? 'var(--accent)'
      : pct >= 90 ? 'var(--green)'
      : pct >= 70 ? 'var(--yellow)'
      : 'var(--red)';

    return `
      <div class="emp-record-row">
        <div class="emp-record-left">
          <div class="emp-record-period">${label}</div>
          <div class="emp-record-meta">${attendance}</div>
          ${pct !== null ? `
            <div class="emp-dtr-bar-wrap">
              <div class="emp-dtr-bar" style="width:${pct}%;background:${barColor}"></div>
            </div>` : ''}
        </div>
        <div class="emp-record-right">
          ${pct !== null ? `<div class="emp-record-net" style="color:${barColor}">${pct}%</div>` : ''}
          <div class="emp-record-gross" style="font-size:11px">${isEvent ? 'Event-based' : 'Attendance rate'}</div>
        </div>
      </div>`;
  }).join('');
}

function emptyState(msg) {
  return `<div style="padding:28px 16px;text-align:center;color:var(--text-muted);font-size:13px;font-family:'JetBrains Mono',monospace">${msg}</div>`;
}

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async function () {
  const session = AUTH.requireAuth();
  if (!session) return;

  // Superadmins have their own dedicated page — redirect if they land here
  if (session.role === 'superadmin') {
    window.location.href = 'superadmin.html';
    return;
  }

  const isAdmin    = session.role === 'admin';
  const name       = session.display_name || session.username;
  const initials   = name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();

  // Populate header chip
  document.getElementById('userChipName').textContent = name;
  document.getElementById('userChipRole').textContent = session.role;

  if (isAdmin) {
    // ── Admin view ──
    document.getElementById('adminView').style.display = 'block';
    document.getElementById('adminGreeting').textContent = `${greeting()}, ${name.split(' ')[0]} 👋`;
    document.getElementById('hubDate').textContent = formatDate();
    await loadAdminStats();

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