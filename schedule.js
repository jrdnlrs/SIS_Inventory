/* ─────────────────────────────────────────
   SIS — schedule.js
   Game Schedule feature:
   • Admin / Super Admin can create, edit, delete sport events
   • Employees can only view events
   • Events stored in Supabase `sport_events` table
   • Assigned employees stored in `sport_event_assignees`
   • Flashcard grid with detail modal
   ───────────────────────────────────────── */

// ── SUPABASE HELPERS ────────────────────────
function dbHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Prefer':        'return=representation',
  };
}

async function dbGet(url) {
  const res = await fetch(url, { headers: dbHeaders() });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function dbPost(url, body) {
  const res = await fetch(url, { method: 'POST', headers: dbHeaders(), body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text(); throw new Error(`POST ${url} → ${res.status}: ${t}`); }
  return res.json();
}

async function dbPatch(url, body) {
  const res = await fetch(url, { method: 'PATCH', headers: dbHeaders(), body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text(); throw new Error(`PATCH ${url} → ${res.status}: ${t}`); }
  return res.json();
}

async function dbDelete(url) {
  const headers = { ...dbHeaders(), 'Prefer': 'return=minimal' };
  const res = await fetch(url, { method: 'DELETE', headers });
  if (!res.ok) { const t = await res.text(); throw new Error(`DELETE ${url} → ${res.status}: ${t}`); }
}

// ── STATE ──────────────────────────────────
let _session     = null;
let _isAdmin     = false;
let _events      = [];          // all loaded events
let _allUsers    = [];          // from users.json
let _assignees   = {};          // { event_id: [username, …] }
let _editingId   = null;        // null = creating new
let _selectedAssignees = new Map(); // username → hole_number (null for non-golf)

// ── SPORT CONFIG ───────────────────────────
const SPORT_EMOJI = {
  golf:        '⛳',
  baseball:    '⚾',
  tennis:      '🎾',
  volleyball:  '🏐',
  'car racing':'🏎️',
};

const SPORT_COLOR_KEY = {
  golf:        'golf',
  baseball:    'baseball',
  tennis:      'tennis',
  volleyball:  'volleyball',
  'car racing':'carracing',
};

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
  }, 3200);
}

// ── LOADING BAR ────────────────────────────
function setLoading(on) {
  const bar = document.getElementById('loadingBar');
  if (bar) bar.style.display = on ? 'block' : 'none';
}

// ── DATE / TIME HELPERS ────────────────────
function formatDisplayDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-PH', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDisplayTime(timeStr) {
  if (!timeStr) return '—';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour   = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

function computeStatus(event) {
  if (event.status && event.status !== 'upcoming') return event.status;
  if (!event.event_date) return 'upcoming';
  const today = new Date().toISOString().slice(0, 10);
  if (event.event_date < today) return 'completed';
  if (event.event_date === today) return 'ongoing';
  return 'upcoming';
}

// ── INITIALS FROM NAME ─────────────────────
function initials(name) {
  if (!name) return '?';
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// ── LOAD USERS FROM users.json ──────────────
async function loadUsers() {
  try {
    const res  = await fetch('users.json?nocache=' + Date.now());
    const data = await res.json();
    _allUsers  = (data.users || []).filter(u => u.active);
  } catch (e) {
    console.error('[schedule] Could not load users.json:', e);
    _allUsers = [];
  }
}

// ── LOAD EVENTS FROM SUPABASE ───────────────
async function loadEvents() {
  setLoading(true);
  try {
    const rows = await dbGet(
      `${SUPABASE_URL}/rest/v1/sport_events?select=*&order=event_date.asc`
    );
    _events = rows;

    // Load all assignees in one shot
    if (rows.length > 0) {
      const assigneeRows = await dbGet(
        `${SUPABASE_URL}/rest/v1/sport_event_assignees?select=event_id,username,hole_number`
      );
      _assignees = {};
      assigneeRows.forEach(r => {
        if (!_assignees[r.event_id]) _assignees[r.event_id] = [];
        _assignees[r.event_id].push({ username: r.username, hole_number: r.hole_number || null });
      });
    }

  } catch (e) {
    console.error('[schedule] loadEvents error:', e);
    toast('Could not load events from database.', 'error');
  } finally {
    setLoading(false);
  }
}

// ── POPULATE SPORT FILTER ───────────────────
function populateSportFilter() {
  const sel    = document.getElementById('filterSport');
  const sports = [...new Set(_events.map(e => e.sport).filter(Boolean))];
  sports.forEach(s => {
    const opt = document.createElement('option');
    opt.value       = s;
    opt.textContent = (SPORT_EMOJI[s] || '🏆') + ' ' + s.charAt(0).toUpperCase() + s.slice(1);
    sel.appendChild(opt);
  });
}

// ── RENDER EVENT CARDS ──────────────────────
function renderEvents() {
  const grid     = document.getElementById('eventsGrid');
  const search   = document.getElementById('searchEvents').value.toLowerCase();
  const sport    = document.getElementById('filterSport').value;
  const status   = document.getElementById('filterStatus').value;

  let filtered = _events.filter(ev => {
    const matchSearch = !search
      || (ev.event_name || '').toLowerCase().includes(search)
      || (ev.venue || '').toLowerCase().includes(search);
    const matchSport  = !sport  || ev.sport === sport;
    const matchStatus = !status || computeStatus(ev) === status;
    return matchSearch && matchSport && matchStatus;
  });

  // Update subtitle
  document.getElementById('scheduleSubtitle').textContent =
    `${filtered.length} of ${_events.length} event${_events.length !== 1 ? 's' : ''}`;

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="schedule-empty">
        <div class="schedule-empty-icon">📅</div>
        <p>${_events.length === 0 ? 'No events yet. Admins can create the first one.' : 'No events match your filters.'}</p>
      </div>`;
    return;
  }

  grid.innerHTML = filtered.map(ev => buildCard(ev)).join('');
  startCardCountdowns();
}

// ── CARD COUNTDOWNS (one per visible card) ──
let _cardCountdownTimers = [];

function clearCardCountdowns() {
  _cardCountdownTimers.forEach(t => clearInterval(t));
  _cardCountdownTimers = [];
}

function startCardCountdowns() {
  clearCardCountdowns();
  document.querySelectorAll('.event-card-countdown').forEach(el => {
    const callDate = el.dataset.callDate;
    const callTime = el.dataset.callTime;

    function renderCardCountdown() {
      if (!callDate || !callTime) {
        el.innerHTML = `<div class="ct-card-notset">⏱ No call time set</div>`;
        return;
      }

      const now    = Date.now();
      const target = parseCallDateTime(callDate, callTime);
      const diff   = target - now;

      if (isNaN(diff)) {
        el.innerHTML = `<div class="ct-card-notset">⏱ No call time set</div>`;
        return;
      }

      if (diff <= 0) {
        el.innerHTML = `<div class="ct-card-past">✓ Call time passed</div>`;
        return;
      }

      const days  = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins  = Math.floor((diff % 3600000) / 60000);
      const secs  = Math.floor((diff % 60000) / 1000);

      const urgency = diff < 3600000 ? 'urgent'
                    : diff < 86400000 ? 'soon'
                    : 'normal';

      const parts = [];
      if (days > 0)  parts.push(`<span class="ct-card-num">${days}</span><span class="ct-card-lbl">d</span>`);
      parts.push(`<span class="ct-card-num">${String(hours).padStart(2,'0')}</span><span class="ct-card-lbl">h</span>`);
      parts.push(`<span class="ct-card-num">${String(mins).padStart(2,'0')}</span><span class="ct-card-lbl">m</span>`);
      parts.push(`<span class="ct-card-num ct-card-secs">${String(secs).padStart(2,'0')}</span><span class="ct-card-lbl">s</span>`);

      el.innerHTML = `
        <div class="ct-card-row ct-card-${urgency}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span class="ct-card-label-text">CALL IN</span>
          <div class="ct-card-parts">${parts.join('')}</div>
        </div>`;
    }

    renderCardCountdown();
    // Only tick upcoming cards
    const t = setInterval(() => {
      if (!document.getElementById(el.id)) { clearInterval(t); return; }
      renderCardCountdown();
    }, 1000);
    _cardCountdownTimers.push(t);
  });
}

function buildCard(ev) {
  const emoji      = SPORT_EMOJI[ev.sport] || '🏆';
  const colorKey   = SPORT_COLOR_KEY[ev.sport] || '';
  const statusStr  = computeStatus(ev);
  const assigned   = (_assignees[ev.id] || []).map(a => typeof a === 'object' ? a.username : a);
  const assignedUsers = _allUsers.filter(u => assigned.includes(u.username));

  // Avatar stack (up to 4 + overflow count)
  const maxAvatars = 4;
  const visible    = assignedUsers.slice(0, maxAvatars);
  const overflow   = assignedUsers.length - visible.length;
  const avatarHTML = visible.map(u =>
    `<div class="event-avatar" title="${u.display_name}">${initials(u.display_name)}</div>`
  ).join('') + (overflow > 0 ? `<div class="event-avatar" style="background:var(--surface3);color:var(--text-muted)">+${overflow}</div>` : '');

  const cardCountdownId = `cd-card-${ev.id}`;
  const callDateForCard  = ev.call_date || ev.event_date || '';
  const callTimeForCard  = ev.call_time || '';

  return `
    <div class="event-card" data-sport-color="${colorKey}" onclick="openDetail('${ev.id}')">
      <div class="event-banner">
        <div class="event-banner-bg">${emoji}</div>
        <div class="event-banner-icon">${emoji}</div>
        <div class="event-status-badge ${statusStr}">${statusStr}</div>
      </div>
      <div class="event-card-body">
        <div class="event-sport-label">${(ev.sport || 'other').toUpperCase()}</div>
        <div class="event-title">${escHtml(ev.event_name || 'Untitled Event')}</div>
        <div class="event-meta">
          <div class="event-meta-row">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            ${formatDisplayDate(ev.event_date)}
          </div>
          <div class="event-meta-row">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
            ${escHtml(ev.venue || 'TBD')}
          </div>
        </div>
        <div class="event-card-countdown" id="${cardCountdownId}" data-call-date="${callDateForCard}" data-call-time="${callTimeForCard}">
          <!-- countdown injected by startCardCountdowns() -->
        </div>
        <div class="event-assigned-count">
          <div class="event-assigned-avatars">${avatarHTML}</div>
          ${assignedUsers.length > 0
            ? `<span>${assignedUsers.length} employee${assignedUsers.length !== 1 ? 's' : ''} assigned</span>`
            : `<span style="color:var(--text-dim)">No assignees yet</span>`}
        </div>
      </div>
    </div>`;
}

// ── CALL TIME COUNTDOWN ─────────────────────
let _countdownInterval = null;

function clearCountdown() {
  if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null; }
}

/**
 * Builds and auto-ticks a countdown to the call time.
 * callDate: "YYYY-MM-DD", callTime: "HH:MM"
 * Injects live DOM into the element with id=`countdownTarget`
 */
function parseCallDateTime(callDate, callTime) {
  // Safely parse "YYYY-MM-DD" + "HH:MM" (or "HH:MM:SS") into a timestamp
  if (!callDate || !callTime) return NaN;
  const [year, month, day]   = callDate.split('-').map(Number);
  const timeParts             = callTime.split(':').map(Number);
  const [hour, minute]        = timeParts;
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  return d.getTime();
}

// Supports multiple targets: pass a CSS selector string or element id
function startCallTimeCountdown(callDate, callTime, targetId = 'countdownTarget') {
  clearCountdown();

  const el = document.getElementById(targetId);
  if (!el) return;

  if (!callDate || !callTime) {
    el.innerHTML = `
      <div class="ct-notset">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Call time not set
      </div>`;
    return;
  }

  function tick() {
    const now    = Date.now();
    const target = parseCallDateTime(callDate, callTime);
    const diff   = target - now;

    // Re-query in case DOM was replaced (card re-renders)
    const el2 = document.getElementById(targetId);
    if (!el2) { clearCountdown(); return; }

    if (diff <= 0) {
      const absDiff   = Math.abs(diff);
      const totalMins = Math.floor(absDiff / 60000);
      const hrs  = Math.floor(totalMins / 60);
      const mins = totalMins % 60;
      el2.innerHTML = `
        <div class="ct-past">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Call time passed ${hrs > 0 ? hrs + 'h ' : ''}${mins}m ago
        </div>`;
      clearCountdown();
      return;
    }

    const days  = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins  = Math.floor((diff % 3600000) / 60000);
    const secs  = Math.floor((diff % 60000) / 1000);

    const urgency = diff < 3600000 ? 'urgent'
                  : diff < 86400000 ? 'soon'
                  : 'normal';

    const daysBlock = days > 0 ? `
      <div class="ct-unit">
        <span class="ct-num">${String(days).padStart(2,'0')}</span>
        <span class="ct-label">Days</span>
      </div>
      <div class="ct-sep">:</div>` : '';

    el2.innerHTML = `
      <div class="ct-header">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        CALL TIME COUNTDOWN
      </div>
      <div class="ct-units ct-${urgency}">
        ${daysBlock}
        <div class="ct-unit">
          <span class="ct-num">${String(hours).padStart(2,'0')}</span>
          <span class="ct-label">Hours</span>
        </div>
        <div class="ct-sep">:</div>
        <div class="ct-unit">
          <span class="ct-num">${String(mins).padStart(2,'0')}</span>
          <span class="ct-label">Mins</span>
        </div>
        <div class="ct-sep">:</div>
        <div class="ct-unit">
          <span class="ct-num ct-secs">${String(secs).padStart(2,'0')}</span>
          <span class="ct-label">Secs</span>
        </div>
      </div>
      <div class="ct-target-label">
        Required arrival by <strong>${formatDisplayTime(callTime)}</strong>
        on <strong>${formatDisplayDate(callDate)}</strong>
      </div>`;
  }

  tick();
  _countdownInterval = setInterval(tick, 1000);
}

// ── EVENT TIME-IN TRACKING ───────────────────
const EVENT_TIMEIN_URL = `${SUPABASE_URL}/rest/v1/event_timein_logs`;

// Load existing time-in record for the current user + event
async function loadMyTimeInRecord(eventId) {
  if (!_session) return null;
  try {
    const rows = await dbGet(
      `${EVENT_TIMEIN_URL}?event_id=eq.${eventId}&username=eq.${_session.username}&select=*&limit=1`
    );
    return rows[0] || null;
  } catch { return null; }
}

// Load ALL time-in records for an event (admin view)
async function loadAllTimeInRecords(eventId) {
  try {
    const rows = await dbGet(`${EVENT_TIMEIN_URL}?event_id=eq.${eventId}&select=*&order=time_in.asc`);
    console.log(`[timein] ${rows.length} records for event ${eventId}:`, rows.map(r => ({ id: r.id, name: r.name, username: r.username, time_in: r.time_in })));
    return rows;
  } catch { return []; }
}

// Clock in
async function clockInToEvent(eventId) {
  const btn = document.getElementById('timeInBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Clocking in…'; }
  try {
    await dbPost(EVENT_TIMEIN_URL, {
      event_id:  eventId,
      username:  _session.username,
      name:      _session.display_name,
      time_in:   new Date().toISOString(),
      time_out:  null,
    });
    await refreshTimeInPanel(eventId);
    toast('Clocked in successfully!', 'success');
  } catch (e) {
    toast('Clock-in failed. ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Clock In'; }
  }
}

// Clock out
async function clockOutFromEvent(eventId, recordId) {
  const btn = document.getElementById('timeOutBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Clocking out…'; }
  try {
    await dbPatch(`${EVENT_TIMEIN_URL}?id=eq.${recordId}`, {
      time_out: new Date().toISOString(),
    });
    await refreshTimeInPanel(eventId);
    toast('Clocked out successfully!', 'success');
  } catch (e) {
    toast('Clock-out failed. ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Clock Out'; }
  }
}

// Refresh the time-in panel inside the open detail modal
async function refreshTimeInPanel(eventId) {
  const panel = document.getElementById('timeInPanel');
  if (!panel) return;
  panel.innerHTML = await buildTimeInPanelHTML(eventId);
}

function fmtTimeStamp(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDateStamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

// ── CLOCK-IN GATE HELPERS ────────────────────
// Returns { allowed: bool, minutesUntil: number } for 2-hour pre-gate
function getClockInGateStatus(ev) {
  if (!ev.call_date || !ev.call_time) return { allowed: true, minutesUntil: 0, noCallTime: true };
  const callTs  = parseCallDateTime(ev.call_date, ev.call_time);
  if (isNaN(callTs)) return { allowed: true, minutesUntil: 0, noCallTime: true };
  const now       = Date.now();
  const diff      = callTs - now; // ms until call time (negative = past)
  const twoHrsMs  = 2 * 60 * 60 * 1000;
  // Allow clock-in if we are within 2 hours before call time OR call time has already passed
  const allowed   = diff <= twoHrsMs;
  const minutesUntil = Math.max(0, Math.ceil((diff - twoHrsMs) / 60000));
  return { allowed, minutesUntil, diff };
}

function fmtMinutesUntilOpen(mins) {
  if (mins <= 0) return 'now';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

// ── ATTENDANCE STATUS HELPER ─────────────────
function computeAttendanceStatus(timeInIso, callDate, callTime) {
  if (!timeInIso) return { isPresent: false, isLate: false, label: '—' };
  const timeIn = new Date(timeInIso);
  if (isNaN(timeIn)) return { isPresent: true, isLate: false, label: 'Present' };
  if (!callDate || !callTime) return { isPresent: true, isLate: false, label: 'Present' };
  const callTs = parseCallDateTime(callDate, callTime);
  if (isNaN(callTs)) return { isPresent: true, isLate: false, label: 'Present' };
  const diffMs      = timeIn.getTime() - callTs;
  const minutesLate = Math.floor(diffMs / 60000);
  if (minutesLate <= 0) {
    const minsEarly = Math.abs(minutesLate);
    if (minsEarly === 0) return { isPresent: true, isLate: false, label: 'On Time' };
    return { isPresent: true, isLate: false, label: `${minsEarly}m Early` };
  }
  const h = Math.floor(minutesLate / 60);
  const m = minutesLate % 60;
  const lateStr = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  return { isPresent: true, isLate: true, minutesLate, label: `Late ${lateStr}` };
}

// Build the full Time In panel HTML (async — fetches records)
async function buildTimeInPanelHTML(eventId) {
  const ev           = _events.find(e => e.id == eventId);
  const assignedRaw  = _assignees[eventId] || [];
  const assigned     = assignedRaw.map(a => typeof a === 'object' ? a.username : a);
  const holeMap      = Object.fromEntries(
    assignedRaw.map(a => typeof a === 'object' ? [a.username, a.hole_number] : [a, null])
  );
  const isGolf       = ev && ev.sport === 'golf';
  const isAssigned   = assigned.includes(_session.username);

  // Admins always see the attendance table; employees only see if assigned
  if (!isAssigned && !_isAdmin) {
    return `<div class="ti-not-assigned">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      You are not assigned to this event.
    </div>`;
  }

  const allRecords = await loadAllTimeInRecords(eventId);
  // Robust match: username field first, display_name fallback
  const myRecord = allRecords.find(r =>
    (r.username && r.username === _session.username) ||
    (r.name && r.name === _session.display_name)
  ) || null;

  // ── 2-hour pre-gate check ──
  const gate = ev ? getClockInGateStatus(ev) : { allowed: true };

  // ── My clock-in section (assigned employees + admins if assigned) ──
  let mySection = '';
  if (isAssigned) {
    if (!myRecord) {
      if (!gate.allowed) {
        // Too early — show locked state with countdown
        mySection = `
          <div class="ti-my-section" style="border-color:rgba(251,191,36,0.25);background:rgba(251,191,36,0.04);">
            <div class="ti-my-label">Your Attendance</div>
            <div class="ti-my-status" style="color:#fbbf24;gap:8px;flex:1;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
              Clock-in opens in <strong style="font-family:'JetBrains Mono',monospace;margin:0 3px;">${fmtMinutesUntilOpen(gate.minutesUntil)}</strong>
              <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-muted);margin-left:4px;">(2 hrs before call time)</span>
            </div>
            <button class="btn ti-btn" disabled style="opacity:0.4;cursor:not-allowed;background:var(--surface3);border:1px solid var(--border);color:var(--text-muted);">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
              Locked
            </button>
          </div>`;
      } else {
        mySection = `
        <div class="ti-my-section">
          <div class="ti-my-label">Your Attendance</div>
          <div class="ti-my-status ti-status-pending">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Not yet clocked in
          </div>
          <button class="btn btn-primary ti-btn" id="timeInBtn" onclick="clockInToEvent('${eventId}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Clock In
          </button>
        </div>`;
      }
    } else if (!myRecord.time_out) {
      mySection = `
        <div class="ti-my-section ti-active">
          <div class="ti-my-label">Your Attendance</div>
          <div class="ti-my-status ti-status-in">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Clocked in at <strong>${fmtTimeStamp(myRecord.time_in)}</strong>
          </div>
          <button class="btn ti-btn ti-btn-out" id="timeOutBtn" onclick="clockOutFromEvent('${eventId}', '${myRecord.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Clock Out
          </button>
        </div>`;
    } else {
      mySection = `
        <div class="ti-my-section ti-done">
          <div class="ti-my-label">Your Attendance</div>
          <div class="ti-my-status ti-status-done">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Done — In: <strong>${fmtTimeStamp(myRecord.time_in)}</strong> · Out: <strong>${fmtTimeStamp(myRecord.time_out)}</strong>
          </div>
        </div>`;
    }
  }

  // ── Attendance table (all assigned employees) ──
  // Sort by hole number for golf, otherwise keep original order
  const assignedUsers = _allUsers
    .filter(u => assigned.includes(u.username))
    .sort((a, b) => {
      if (!isGolf) return 0;
      const ha = holeMap[a.username] || 999;
      const hb = holeMap[b.username] || 999;
      return ha - hb;
    });

  // Helper: find a record for a user — tries username match first, then display_name match
  function findRecordForUser(u) {
    // Prefer username match (most reliable)
    let r = allRecords.find(r => r.username && r.username === u.username);
    if (r) return r;
    // Fallback: match by stored name field (covers older records written before username column existed)
    r = allRecords.find(r => r.name && r.name === u.display_name);
    return r || null;
  }

  // Store records in a window-level cache keyed by username so onclick handlers
  // can look them up safely without passing ISO strings through HTML attributes
  window._tiRecordCache = window._tiRecordCache || {};
  window._tiRecordCache[eventId] = {};
  assignedUsers.forEach(u => {
    const r = findRecordForUser(u);
    if (r) window._tiRecordCache[eventId][u.username] = r;
  });

  // Admin rows have extra columns for actions — adjust grid accordingly
  // Compact (detail modal): avatar | name | [hole] | time-in | status
  const colsTemplate = isGolf
    ? '32px 1fr 56px 90px 110px'
    : '32px 1fr 90px 110px';

  const tableRows = assignedUsers.map(u => {
    const rec  = findRecordForUser(u);
    const isMe = u.username === _session.username;
    const hole = holeMap[u.username];

    const safeUser = u.username.replace(/'/g, "\\'");
    const safeEid  = String(eventId).replace(/'/g, "\\'");
    const safeName = u.display_name.replace(/'/g, "\\'");

    const holeCellAbsent = isGolf
      ? `<div class="ti-row-time" style="text-align:center;">
           ${hole ? `<span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:var(--accent-bright);">H${hole}</span>` : '<span style="color:var(--text-dim);">—</span>'}
         </div>` : '';

    const adminActions = _isAdmin
      ? `<div style="display:flex;gap:5px;justify-content:flex-end;align-items:center;">
          ${rec
            ? `<button
                title="Edit times"
                onclick="openEditAttendance('${safeEid}','${safeUser}')"
                style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;font-size:10px;font-family:'JetBrains Mono',monospace;font-weight:600;letter-spacing:0.3px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2);color:var(--accent-bright);border-radius:5px;cursor:pointer;white-space:nowrap;transition:background 0.15s;"
                onmouseover="this.style.background='rgba(59,130,246,0.22)'" onmouseout="this.style.background='rgba(59,130,246,0.1)'">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Edit
              </button>
              <button
                title="Reset attendance"
                onclick="resetAttendanceRecord('${safeEid}','${safeUser}','${safeName}')"
                style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;font-size:10px;font-family:'JetBrains Mono',monospace;font-weight:600;letter-spacing:0.3px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);color:var(--red);border-radius:5px;cursor:pointer;white-space:nowrap;transition:background 0.15s;"
                onmouseover="this.style.background='rgba(248,113,113,0.2)'" onmouseout="this.style.background='rgba(248,113,113,0.08)'">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                Reset
              </button>`
            : `<span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-dim);letter-spacing:0.5px;">—</span>`
          }
        </div>`
      : '';

    if (!rec) {
      return `<div class="ti-row ti-row-absent ${isMe ? 'ti-row-me' : ''}" style="grid-template-columns:${colsTemplate};">
        <div class="ti-row-avatar">${initials(u.display_name)}</div>
        <div class="ti-row-name">${escHtml(u.display_name)}${isMe ? ' <span class="ti-you-tag">you</span>' : ''}</div>
        ${holeCellAbsent}
        <div class="ti-row-time ti-absent" style="text-align:center;">—</div>
        <div class="ti-row-time"><span class="ti-status-badge ti-status-absent">Absent</span></div>
      </div>`;
    }
    const hasOut    = !!rec.time_out;
    const attStatus = computeAttendanceStatus(rec.time_in, ev ? ev.call_date : null, ev ? ev.call_time : null);
    const statusBadge = attStatus.isLate
      ? `<span class="ti-status-badge ti-status-late">${escHtml(attStatus.label)}</span>`
      : `<span class="ti-status-badge ti-status-ontime">${escHtml(attStatus.label)}</span>`;
    const holeCellPresent = isGolf
      ? `<div class="ti-row-time" style="text-align:center;">
           ${hole ? `<span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:var(--accent-bright);">H${hole}</span>` : '<span style="color:var(--text-dim);">—</span>'}
         </div>` : '';
    return `<div class="ti-row ti-row-present ${isMe ? 'ti-row-me' : ''}" style="grid-template-columns:${colsTemplate};">
      <div class="ti-row-avatar ti-avatar-in">${initials(u.display_name)}</div>
      <div class="ti-row-name">${escHtml(u.display_name)}${isMe ? ' <span class="ti-you-tag">you</span>' : ''}</div>
      ${holeCellPresent}
      <div class="ti-row-time ti-in" style="text-align:center;">${fmtTimeStamp(rec.time_in)}</div>
      <div class="ti-row-time">${statusBadge}</div>
    </div>`;
  }).join('');

  const holeHeader   = isGolf ? `<span style="text-align:center;">Hole</span>` : '';
  const colHeaders = `<span></span><span></span>${holeHeader}<span style="text-align:center;">Time In</span><span>Status</span>`;

  const presentCount = assignedUsers.filter(u => findRecordForUser(u)).length;
  const totalCount   = assignedUsers.length;

  return `
    ${mySection}
    <div class="ti-table-wrap">
      <div class="ti-table-header">
        <span>Attendance</span>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="ti-count">${presentCount}/${totalCount} clocked in</span>
          <button class="ti-expand-btn" onclick="openAttendanceExpand('${eventId}')">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            Expand
          </button>
        </div>
      </div>
      <div class="ti-table-cols" style="grid-template-columns:${colsTemplate};">
        ${colHeaders}
      </div>
      ${tableRows || `<div class="ti-empty">No assignees yet.</div>`}
    </div>`;
}

// ── ATTENDANCE EXPAND OVERLAY ────────────────
let _expandEventId = null;

async function openAttendanceExpand(eventId) {
  _expandEventId = eventId;
  const ev           = _events.find(e => e.id == eventId);
  const assignedRaw  = _assignees[eventId] || [];
  const assigned     = assignedRaw.map(a => typeof a === 'object' ? a.username : a);
  const holeMap      = Object.fromEntries(
    assignedRaw.map(a => typeof a === 'object' ? [a.username, a.hole_number] : [a, null])
  );
  const isGolf       = ev && ev.sport === 'golf';
  const allRecords   = await loadAllTimeInRecords(eventId);
  const assignedUsers = _allUsers
    .filter(u => assigned.includes(u.username))
    .sort((a, b) => {
      if (!isGolf) return 0;
      const ha = holeMap[a.username] || 999;
      const hb = holeMap[b.username] || 999;
      return ha - hb;
    });

  function findRec(u) {
    let r = allRecords.find(r => r.username && r.username === u.username);
    if (r) return r;
    r = allRecords.find(r => r.name && r.name === u.display_name);
    return r || null;
  }

  // Wide layout: avatar | name | [hole] | time-in | time-out | status | actions(admin)
  const colsExp = isGolf
    ? (_isAdmin ? '40px 1fr 60px 130px 130px 130px 160px' : '40px 1fr 60px 130px 130px 130px')
    : (_isAdmin ? '40px 1fr 130px 130px 130px 160px'      : '40px 1fr 130px 130px 130px');

  const holeHeaderExp = isGolf ? `<span style="text-align:center;">Hole</span>` : '';
  const headersExp = _isAdmin
    ? `<span></span><span style="text-align:left;">Employee</span>${holeHeaderExp}<span style="text-align:center;">Time In</span><span style="text-align:center;">Time Out</span><span style="text-align:center;">Status</span><span style="text-align:right;">Actions</span>`
    : `<span></span><span style="text-align:left;">Employee</span>${holeHeaderExp}<span style="text-align:center;">Time In</span><span style="text-align:center;">Time Out</span><span style="text-align:center;">Status</span>`;

  const rows = assignedUsers.map(u => {
    const rec    = findRec(u);
    const isMe   = u.username === _session.username;
    const hole   = holeMap[u.username];
    const safeUser = u.username.replace(/'/g, "\\'");
    const safeEid  = String(eventId).replace(/'/g, "\\'");
    const safeName = u.display_name.replace(/'/g, "\\'");

    const holeCell = isGolf
      ? `<div class="ti-row-time" style="text-align:center;">
           ${hole ? `<span style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:var(--accent-bright);">H${hole}</span>` : '<span style="color:var(--text-dim);">—</span>'}
         </div>` : '';

    const adminActions = _isAdmin
      ? `<div style="display:flex;gap:5px;justify-content:flex-end;align-items:center;">
          ${rec
            ? `<button title="Edit times" onclick="openEditAttendance('${safeEid}','${safeUser}')"
                style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;font-size:10px;font-family:'JetBrains Mono',monospace;font-weight:600;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2);color:var(--accent-bright);border-radius:5px;cursor:pointer;white-space:nowrap;"
                onmouseover="this.style.background='rgba(59,130,246,0.22)'" onmouseout="this.style.background='rgba(59,130,246,0.1)'">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Edit
              </button>
              <button title="Reset" onclick="resetAttendanceRecord('${safeEid}','${safeUser}','${safeName}')"
                style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;font-size:10px;font-family:'JetBrains Mono',monospace;font-weight:600;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);color:var(--red);border-radius:5px;cursor:pointer;white-space:nowrap;"
                onmouseover="this.style.background='rgba(248,113,113,0.2)'" onmouseout="this.style.background='rgba(248,113,113,0.08)'">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                Reset
              </button>`
            : `<span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-dim);">—</span>`
          }
        </div>`
      : '';

    if (!rec) {
      return `<div class="ti-row ti-row-absent ${isMe ? 'ti-row-me' : ''}" style="grid-template-columns:${colsExp};padding:12px 18px;">
        <div class="ti-row-avatar">${initials(u.display_name)}</div>
        <div class="ti-row-name">${escHtml(u.display_name)}${isMe ? ' <span class="ti-you-tag">you</span>' : ''}</div>
        ${holeCell}
        <div class="ti-row-time ti-absent" style="text-align:center;">—</div>
        <div class="ti-row-time ti-absent" style="text-align:center;">—</div>
        <div class="ti-row-time" style="text-align:center;"><span class="ti-status-badge ti-status-absent">Absent</span></div>
        ${adminActions}
      </div>`;
    }

    const hasOut    = !!rec.time_out;
    const attStatus = computeAttendanceStatus(rec.time_in, ev ? ev.call_date : null, ev ? ev.call_time : null);
    const statusBadge = attStatus.isLate
      ? `<span class="ti-status-badge ti-status-late">${escHtml(attStatus.label)}</span>`
      : `<span class="ti-status-badge ti-status-ontime">${escHtml(attStatus.label)}</span>`;

    return `<div class="ti-row ti-row-present ${isMe ? 'ti-row-me' : ''}" style="grid-template-columns:${colsExp};padding:12px 18px;">
      <div class="ti-row-avatar ti-avatar-in">${initials(u.display_name)}</div>
      <div class="ti-row-name">${escHtml(u.display_name)}${isMe ? ' <span class="ti-you-tag">you</span>' : ''}</div>
      ${holeCell}
      <div class="ti-row-time ti-in" style="text-align:center;">${fmtTimeStamp(rec.time_in)}</div>
      <div class="ti-row-time ${hasOut ? 'ti-out' : 'ti-pending'}" style="text-align:center;">${hasOut ? fmtTimeStamp(rec.time_out) : '…'}</div>
      <div class="ti-row-time" style="text-align:center;">${statusBadge}</div>
      ${adminActions}
    </div>`;
  }).join('');

  const presentCount = assignedUsers.filter(u => findRec(u)).length;

  document.getElementById('attendanceExpandCount').textContent = `${presentCount}/${assignedUsers.length} clocked in`;
  document.getElementById('attendanceExpandBody').innerHTML = `
    <div style="display:grid;grid-template-columns:${colsExp};padding:6px 18px;background:var(--surface2);border-bottom:1px solid var(--border);font-family:'JetBrains Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-muted);align-items:center;">
      ${headersExp}
    </div>
    ${rows || `<div class="ti-empty">No assignees yet.</div>`}`;

  document.getElementById('attendanceExpandOverlay').classList.add('open');
}

function closeAttendanceExpand() {
  document.getElementById('attendanceExpandOverlay').classList.remove('open');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('attendanceExpandOverlay').addEventListener('click', function(e) {
    if (e.target === this) closeAttendanceExpand();
  });
});

// ── ADMIN: RESET ATTENDANCE RECORD ───────────
async function resetAttendanceRecord(eventId, username, displayName) {
  if (!_isAdmin) return;
  const rec = (window._tiRecordCache[eventId] || {})[username];
  if (!rec) { toast('No record found to reset.', 'error'); return; }

  if (!confirm(`Reset attendance for ${displayName}? This will permanently delete their clock-in record for this event.`)) return;

  let deleted = false;
  const headers = { ...dbHeaders(), 'Prefer': 'return=minimal' };

  // Always delete by event_id + name to catch ALL duplicate rows for this person
  // (deleting by id alone leaves duplicates behind)
  if (rec.name) {
    try {
      const url = `${EVENT_TIMEIN_URL}?event_id=eq.${eventId}&name=eq.${encodeURIComponent(rec.name)}`;
      const res = await fetch(url, { method: 'DELETE', headers });
      if (res.ok || res.status === 204) {
        deleted = true;
      } else {
        const errText = await res.text();
        console.warn('[reset by name failed]', res.status, errText);
      }
    } catch(e) { console.warn('[reset by name error]', e); }
  }

  // Also delete by id as belt-and-suspenders
  if (rec.id) {
    try {
      const url = `${EVENT_TIMEIN_URL}?id=eq.${rec.id}`;
      const res = await fetch(url, { method: 'DELETE', headers });
      if (res.ok || res.status === 204) deleted = true;
    } catch(e) { console.warn('[reset by id error]', e); }
  }

  // Also delete by event_id + username if that column exists
  if (rec.username || username) {
    try {
      const u = rec.username || username;
      const url = `${EVENT_TIMEIN_URL}?event_id=eq.${eventId}&username=eq.${encodeURIComponent(u)}`;
      const res = await fetch(url, { method: 'DELETE', headers });
      if (res.ok || res.status === 204) deleted = true;
    } catch(e) { /* column may not exist — ignore */ }
  }

  if (deleted) {
    delete window._tiRecordCache[eventId][username];
    toast(`Attendance reset for ${displayName}.`, 'success');
    // Small delay to let Supabase propagate before re-fetching
    await new Promise(r => setTimeout(r, 400));
    await refreshTimeInPanel(eventId);
  } else {
    toast('Could not delete record — check Supabase RLS policies on event_timein_logs.', 'error');
  }
}

// ── ADMIN: EDIT ATTENDANCE MODAL ─────────────
function openEditAttendance(eventId, username) {
  if (!_isAdmin) return;
  const rec = (window._tiRecordCache[eventId] || {})[username];
  if (!rec) { toast('Record not found.', 'error'); return; }

  const recordId = rec.id;
  const rawTimeIn  = rec.time_in  || '';
  const rawTimeOut = rec.time_out || '';

  // Convert ISO timestamps to local datetime-local format (YYYY-MM-DDTHH:MM)
  function isoToLocal(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Inject the edit modal if not present
  let overlay = document.getElementById('editAttendanceOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'editAttendanceOverlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);
      z-index:2000;display:flex;align-items:center;justify-content:center;padding:24px;
    `;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeEditAttendance(); });
    document.body.appendChild(overlay);
  }

  const user = _allUsers.find(u => u.username === username);
  const name = user ? user.display_name : username;

  overlay.innerHTML = `
    <div style="
      background:var(--surface);border:1px solid var(--border-bright);border-radius:var(--radius-lg);
      width:100%;max-width:420px;box-shadow:0 24px 80px rgba(0,0,0,0.5);
    ">
      <!-- Header -->
      <div style="padding:20px 24px 0;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;display:flex;align-items:center;gap:10px;">
            <span style="width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);display:inline-block;flex-shrink:0;"></span>
            Edit Attendance
          </div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted);margin-top:4px;">${escHtml(name)}</div>
        </div>
        <button onclick="closeEditAttendance()" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-muted);width:32px;height:32px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">✕</button>
      </div>

      <!-- Body -->
      <div style="padding:20px 24px;">
        <div style="display:flex;flex-direction:column;gap:14px;">
          <div>
            <label style="display:block;font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:7px;">Time In</label>
            <input id="editTiIn" type="datetime-local" value="${isoToLocal(rawTimeIn)}" style="width:100%;padding:9px 13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;transition:border-color 0.15s;" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'"/>
          </div>
          <div>
            <label style="display:block;font-family:'JetBrains Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:7px;">Time Out <span style="font-weight:400;color:var(--text-dim);text-transform:none;letter-spacing:0;">(optional)</span></label>
            <input id="editTiOut" type="datetime-local" value="${isoToLocal(rawTimeOut)}" style="width:100%;padding:9px 13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:13px;outline:none;transition:border-color 0.15s;" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'"/>
          </div>
        </div>

        <div style="margin-top:6px;padding:10px 12px;border-radius:var(--radius);background:rgba(59,130,246,0.05);border:1px solid rgba(59,130,246,0.12);font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-muted);display:flex;align-items:center;gap:7px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-bright)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Admin override — times will be saved as entered.
        </div>
      </div>

      <!-- Footer -->
      <div style="padding:14px 24px 20px;display:flex;align-items:center;justify-content:flex-end;gap:10px;border-top:1px solid var(--border);">
        <button onclick="closeEditAttendance()" class="btn btn-ghost">Cancel</button>
        <button onclick="saveEditAttendance('${eventId}','${recordId}')" class="btn btn-primary">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Save Changes
        </button>
      </div>
    </div>`;

  overlay.style.display = 'flex';
}

function closeEditAttendance() {
  const overlay = document.getElementById('editAttendanceOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function saveEditAttendance(eventId, recordId) {
  if (!_isAdmin) return;
  const inVal  = document.getElementById('editTiIn').value;
  const outVal = document.getElementById('editTiOut').value;

  if (!inVal) {
    toast('Time In is required.', 'error');
    return;
  }

  // Convert local datetime-local value to ISO string
  function localToIso(val) {
    if (!val) return null;
    return new Date(val).toISOString();
  }

  const timeInIso  = localToIso(inVal);
  const timeOutIso = outVal ? localToIso(outVal) : null;

  if (timeOutIso && new Date(timeInIso) >= new Date(timeOutIso)) {
    toast('Time Out must be after Time In.', 'error');
    return;
  }

  try {
    await dbPatch(`${EVENT_TIMEIN_URL}?id=eq.${recordId}`, {
      time_in:  timeInIso,
      time_out: timeOutIso,
    });
    toast('Attendance updated successfully.', 'success');
    closeEditAttendance();
    await refreshTimeInPanel(eventId);
  } catch (e) {
    toast('Failed to save: ' + e.message, 'error');
  }
}

// ── DETAIL MODAL ────────────────────────────
function openDetail(eventId) {
  const ev       = _events.find(e => e.id == eventId);
  if (!ev) return;

  const emoji     = SPORT_EMOJI[ev.sport] || '🏆';
  const colorKey  = SPORT_COLOR_KEY[ev.sport] || '';
  const statusStr = computeStatus(ev);
  const assigned  = _assignees[ev.id] || [];
  const assignedUsers = _allUsers.filter(u => assigned.includes(u.username));

  const assigneesHTML = assignedUsers.length > 0
    ? assignedUsers.map(u => `
        <div class="detail-assignee-row">
          <div class="detail-assignee-avatar">${initials(u.display_name)}</div>
          <div class="detail-assignee-name">${escHtml(u.display_name)}</div>
          <span class="assign-role-badge ${u.role}">${u.role}</span>
        </div>`).join('')
    : `<div style="padding:16px;text-align:center;color:var(--text-muted);font-family:'JetBrains Mono',monospace;font-size:12px;">No employees assigned yet.</div>`;

  const notesHTML = ev.notes
    ? `<div style="margin-bottom:20px;">
         <div class="detail-section-title">Notes</div>
         <div class="detail-notes">${escHtml(ev.notes)}</div>
       </div>`
    : '';

  const editBtn = _isAdmin
    ? `<button class="btn btn-ghost" onclick="openEditModal('${ev.id}')">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
         Edit Event
       </button>`
    : '';

  const inner = document.getElementById('detailModalInner');
  inner.setAttribute('data-sport-color', colorKey);
  inner.innerHTML = `
    <div class="detail-banner" style="--sport-color:${getCssVar(colorKey)}">
      <div class="detail-banner-bg">${emoji}</div>
      <div class="detail-banner-icon" style="border-color:${getCssVar(colorKey)};box-shadow:0 0 32px ${getCssVarAlpha(colorKey, 0.35)}">${emoji}</div>
      <div style="position:absolute;top:12px;right:12px;">
        <span class="event-status-badge ${statusStr}">${statusStr}</span>
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-sport-tag">
        ${emoji} ${(ev.sport || 'Other').toUpperCase()}
      </div>
      <div class="detail-title">${escHtml(ev.event_name || 'Untitled Event')}</div>

      <div class="detail-info-grid">
        <div class="detail-info-item">
          <div class="detail-info-label">Call Date</div>
          <div class="detail-info-val accent">${formatDisplayDate(ev.call_date || ev.event_date)}</div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">Match Date</div>
          <div class="detail-info-val accent">${formatDisplayDate(ev.event_date)}${ev.call_date && ev.call_date !== ev.event_date ? ' <span style="font-size:10px;font-family:\'JetBrains Mono\',monospace;background:rgba(251,191,36,0.12);color:#fbbf24;padding:1px 7px;border-radius:4px;vertical-align:middle;margin-left:4px;">OVERNIGHT</span>' : ''}</div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">Venue</div>
          <div class="detail-info-val">${escHtml(ev.venue || 'TBD')}</div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">Match Start</div>
          <div class="detail-info-val">${formatDisplayTime(ev.event_time)}</div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">Status</div>
          <div class="detail-info-val">${statusStr.charAt(0).toUpperCase() + statusStr.slice(1)}</div>
        </div>
      </div>

      <div class="detail-calltime-box" style="padding:0;background:none;border:none;">
        <div id="timeInPanel" class="ti-panel">
          <div class="ti-loading">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:sa-spin 1s linear infinite"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
            Loading attendance…
          </div>
        </div>
      </div>

      ${notesHTML}

      <div class="detail-section-title">
        Assigned Employees
        <span>${assignedUsers.length}</span>
      </div>
      <div class="detail-assignees">
        ${assigneesHTML}
      </div>
    </div>
    <div class="detail-footer">
      ${editBtn}
      <button class="btn btn-primary" onclick="closeDetailModal()" style="margin-left:auto;">Close</button>
    </div>`;

  document.getElementById('detailModalOverlay').classList.add('open');

  // Load time-in panel after DOM is injected
  refreshTimeInPanel(ev.id);
}

function closeDetailModal() {
  clearCountdown();
  document.getElementById('detailModalOverlay').classList.remove('open');
}

// Click-outside to close detail
document.getElementById('detailModalOverlay').addEventListener('click', function(e) {
  if (e.target === this) { clearCountdown(); closeDetailModal(); }
});

// ── CSS VARIABLE HELPERS ────────────────────
function getCssVar(colorKey) {
  if (!colorKey) return 'var(--accent-bright)';
  return `var(--sport-${colorKey})`;
}

function getCssVarAlpha(colorKey, alpha) {
  // Returns approximate hex for box-shadow glow
  const map = {
    golf:        `rgba(74,222,128,${alpha})`,
    baseball:    `rgba(251,191,36,${alpha})`,
    tennis:      `rgba(248,113,113,${alpha})`,
    volleyball:  `rgba(167,139,250,${alpha})`,
    carracing:   `rgba(251,146,60,${alpha})`,
  };
  return map[colorKey] || `rgba(96,165,250,${alpha})`;
}

// ── CREATE / EDIT MODAL ─────────────────────
function openCreateModal() {
  _editingId = null;
  _selectedAssignees = new Map();

  document.getElementById('createModalTitle').textContent = 'New Sport Event';
  document.getElementById('deleteEventBtn').style.display  = 'none';
  document.getElementById('fEventName').value   = '';
  document.getElementById('fSport').value       = '';
  document.getElementById('fCallDate').value    = '';
  document.getElementById('fEventDate').value   = '';
  document.getElementById('fEventTime').value   = '';
  document.getElementById('fCallTime').value    = '';
  document.getElementById('fVenue').value       = '';
  document.getElementById('fStatus').value      = 'upcoming';
  document.getElementById('fNotes').value       = '';

  buildAssignList();
  document.getElementById('createModalOverlay').classList.add('open');
}

function openEditModal(eventId) {
  closeDetailModal();

  const ev = _events.find(e => e.id == eventId);
  if (!ev) return;

  _editingId = ev.id;
  // Build Map: username → hole_number (from _assignees which stores objects)
  _selectedAssignees = new Map();
  (_assignees[ev.id] || []).forEach(a => {
    if (typeof a === 'object') {
      _selectedAssignees.set(a.username, a.hole_number || null);
    } else {
      _selectedAssignees.set(a, null);
    }
  });

  document.getElementById('createModalTitle').textContent  = 'Edit Event';
  document.getElementById('deleteEventBtn').style.display  = '';
  document.getElementById('fEventName').value  = ev.event_name  || '';
  document.getElementById('fSport').value      = ev.sport       || '';
  document.getElementById('fCallDate').value   = ev.call_date   || ev.event_date || '';
  document.getElementById('fEventDate').value  = ev.event_date  || '';
  document.getElementById('fEventTime').value  = ev.event_time  || '';
  document.getElementById('fCallTime').value   = ev.call_time   || '';
  document.getElementById('fVenue').value      = ev.venue       || '';
  document.getElementById('fStatus').value     = ev.status      || 'upcoming';
  document.getElementById('fNotes').value      = ev.notes       || '';

  buildAssignList();
  document.getElementById('createModalOverlay').classList.add('open');
}

function closeCreateModal() {
  document.getElementById('createModalOverlay').classList.remove('open');
}

// Click-outside to close
document.getElementById('createModalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeCreateModal();
});

// ── ASSIGN LIST ─────────────────────────────
function buildAssignList() {
  filterAssignList();
}

function filterAssignList() {
  const q      = (document.getElementById('assignSearch').value || '').toLowerCase();
  const list   = document.getElementById('assignList');
  const sport  = document.getElementById('fSport').value;
  const isGolf = sport === 'golf';

  const visible = _allUsers.filter(u =>
    !q || u.display_name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)
  );

  if (!visible.length) {
    list.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;font-family:'JetBrains Mono',monospace;">No users found.</div>`;
    return;
  }

  list.innerHTML = visible.map(u => {
    const checked    = _selectedAssignees.has(u.username);
    const holeVal    = checked ? (_selectedAssignees.get(u.username) || '') : '';
    const holeInput  = isGolf ? `
      <input
        type="number" min="1" max="18"
        class="assign-hole-input"
        placeholder="Hole #"
        value="${holeVal}"
        ${!checked ? 'disabled' : ''}
        onclick="event.stopPropagation()"
        oninput="setAssigneeHole('${u.username}', this.value)"
        title="Hole number (1–18)"
      />` : '';

    return `
      <div class="assign-item ${checked ? 'checked' : ''}" onclick="toggleAssignee('${u.username}')">
        <div class="assign-checkbox"></div>
        <div class="assign-avatar-sm">${initials(u.display_name)}</div>
        <div class="assign-name">${escHtml(u.display_name)}</div>
        <span class="assign-role-badge ${u.role}">${u.role}</span>
        ${holeInput}
      </div>`;
  }).join('');

  updateAssignCount();
}

function toggleAssignee(username) {
  if (_selectedAssignees.has(username)) {
    _selectedAssignees.delete(username);
  } else {
    _selectedAssignees.set(username, null);
  }
  filterAssignList();
}

function setAssigneeHole(username, value) {
  if (!_selectedAssignees.has(username)) return;
  const num = parseInt(value, 10);
  _selectedAssignees.set(username, (!isNaN(num) && num >= 1 && num <= 18) ? num : null);
}

function updateAssignCount() {
  const n = _selectedAssignees.size;
  document.getElementById('assignCount').textContent = `${n} selected`;
}

// ── SAVE EVENT ──────────────────────────────
async function saveEvent() {
  const name     = document.getElementById('fEventName').value.trim();
  const sport    = document.getElementById('fSport').value;
  const callDate = document.getElementById('fCallDate').value;
  const date     = document.getElementById('fEventDate').value;
  const time     = document.getElementById('fEventTime').value;
  const callTime = document.getElementById('fCallTime').value;
  const venue    = document.getElementById('fVenue').value.trim();
  const status   = document.getElementById('fStatus').value;
  const notes    = document.getElementById('fNotes').value.trim();

  if (!name)     { toast('Event name is required.', 'error'); return; }
  if (!sport)    { toast('Please select a sport.', 'error'); return; }
  if (!callDate) { toast('Call date is required.', 'error'); return; }
  if (!callTime) { toast('Call time is required.', 'error'); return; }
  if (!date)     { toast('Match date is required.', 'error'); return; }
  if (!venue)    { toast('Venue is required.', 'error'); return; }

  // ── GOLF HOLE VALIDATION ─────────────────────────────────────────
  if (sport === 'golf' && _selectedAssignees.size > 0) {
    const missing = [..._selectedAssignees.entries()].filter(([, hole]) => !hole);
    if (missing.length > 0) {
      toast('Please assign a hole number (1–18) to all selected employees.', 'error');
      return;
    }
    const holeValues = [..._selectedAssignees.values()];
    const dupes = holeValues.filter((h, i, arr) => arr.indexOf(h) !== i);
    if (dupes.length > 0) {
      toast(`Duplicate hole numbers found: ${[...new Set(dupes)].join(', ')}. Each hole can only be assigned once.`, 'error');
      return;
    }
  }

  // ── PAST CALL TIME CHECK ─────────────────────────────────────────
  const callDateTime = parseCallDateTime(callDate, callTime);
  if (!isNaN(callDateTime) && callDateTime <= Date.now()) {
    toast('Call time cannot be in the past. Please set a future date and time.', 'error');
    return;
  }

  const payload = {
    event_name:  name,
    sport,
    call_date:   callDate,
    event_date:  date,
    event_time:  time || null,
    call_time:   callTime,
    venue,
    status,
    notes:       notes || null,
    created_by:  _session.username,
  };

  const btn = document.getElementById('saveEventBtn');
  btn.disabled     = true;
  btn.textContent  = 'Saving…';
  setLoading(true);

  try {
    let eventId = _editingId;

    if (_editingId) {
      // UPDATE
      await dbPatch(
        `${SUPABASE_URL}/rest/v1/sport_events?id=eq.${_editingId}`,
        payload
      );
    } else {
      // INSERT
      const result = await dbPost(
        `${SUPABASE_URL}/rest/v1/sport_events`,
        payload
      );
      eventId = Array.isArray(result) ? result[0].id : result.id;
    }

    // Sync assignees: delete existing → insert new
    await dbDelete(
      `${SUPABASE_URL}/rest/v1/sport_event_assignees?event_id=eq.${eventId}`
    );

    if (_selectedAssignees.size > 0) {
      const rows = [..._selectedAssignees.entries()].map(([username, hole_number]) => ({
        event_id: eventId,
        username,
        hole_number: hole_number || null,
      }));

      try {
        await dbPost(`${SUPABASE_URL}/rest/v1/sport_event_assignees`, rows);
      } catch (assignErr) {
        // If hole_number column doesn't exist yet, retry without it
        const errText = assignErr.message || '';
        if (errText.includes('hole_number') || errText.includes('column')) {
          console.warn('[schedule] hole_number column missing — retrying without it. Run: ALTER TABLE sport_event_assignees ADD COLUMN hole_number integer;');
          const rowsFallback = [..._selectedAssignees.keys()].map(username => ({
            event_id: eventId,
            username,
          }));
          await dbPost(`${SUPABASE_URL}/rest/v1/sport_event_assignees`, rowsFallback);
          toast('Assignees saved (hole numbers skipped — column missing in DB). See console.', 'info');
        } else {
          throw assignErr;
        }
      }
    }

    toast(_editingId ? 'Event updated successfully.' : 'Event created successfully.', 'success');
    closeCreateModal();
    await loadEvents();
    populateSportFilter();
    renderEvents();

  } catch (err) {
    console.error('[schedule] saveEvent error:', err);
    const msg = err.message || '';
    const short = msg.length > 120 ? msg.slice(0, 120) + '…' : msg;
    toast(`Save failed: ${short}`, 'error');
  } finally {
    btn.disabled    = false;
    btn.innerHTML   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Save Event`;
    setLoading(false);
  }
}

// ── DELETE EVENT ────────────────────────────
async function deleteCurrentEvent() {
  if (!_editingId) return;
  const ev = _events.find(e => e.id == _editingId);
  if (!ev) return;

  if (!confirm(`Delete "${ev.event_name}"? This cannot be undone.`)) return;

  setLoading(true);
  try {
    await dbDelete(`${SUPABASE_URL}/rest/v1/sport_event_assignees?event_id=eq.${_editingId}`);
    await dbDelete(`${SUPABASE_URL}/rest/v1/sport_events?id=eq.${_editingId}`);
    toast('Event deleted.', 'success');
    closeCreateModal();
    await loadEvents();
    renderEvents();
  } catch (err) {
    console.error('[schedule] deleteEvent error:', err);
    toast('Failed to delete event.', 'error');
  } finally {
    setLoading(false);
  }
}

// ── ESCAPE HTML ─────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── INIT ────────────────────────────────────
document.addEventListener('DOMContentLoaded', async function () {
  _session = AUTH.requireAuth();
  if (!_session) return;

  const isSuperAdmin = _session.role === 'superadmin';
  _isAdmin           = _session.role === 'admin' || isSuperAdmin;

  // Header chip
  document.getElementById('userChipName').textContent = _session.display_name || _session.username;
  document.getElementById('userChipRole').textContent = _session.role;

  // Nav visibility
  if (_isAdmin) {
    const navInventory = document.getElementById('navInventory');
    const navPayroll   = document.getElementById('navPayroll');
    if (navInventory) navInventory.style.display = '';
    if (navPayroll)   navPayroll.style.display   = '';
  }
  if (isSuperAdmin) {
    const navSA = document.getElementById('navSuperAdmin');
    if (navSA) navSA.style.display = '';
  }

  // Show "New Event" button only for admins
  if (_isAdmin) {
    document.getElementById('createEventBtnWrap').style.display = '';
  }

  // Load data
  await loadUsers();
  await loadEvents();
  populateSportFilter();
  renderEvents();
});

// ── EVENT PAYROLL PDF ─────────────────────────
async function runEventPayroll() {
  const eventId = _expandEventId;
  if (!eventId) { toast('No event selected.', 'error'); return; }

  const ev = _events.find(e => e.id == eventId);
  if (!ev) { toast('Event not found.', 'error'); return; }

  const btn = document.getElementById('runPayrollBtn');
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:sa-spin 0.8s linear infinite"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Generating…`;

  try {
    // ── All events pay a flat ₱2,000 ──
    const EVENT_FLAT_RATE = 2000;

    // ── Get assignees and attendance records ──
    const assignedRaw  = _assignees[eventId] || [];
    const assigned     = assignedRaw.map(a => typeof a === 'object' ? a.username : a);
    const allRecords   = await loadAllTimeInRecords(eventId);

    const assignedUsers = _allUsers
      .filter(u => assigned.includes(u.username))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));

    // ── Build rows ──
    const WORK_MINS = 8 * 60; // 480 mins = 1 full day
    const eventDateLabel = ev.event_date
      ? new Date(ev.event_date + 'T00:00:00').toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'N/A';

    const tableRows = assignedUsers.map(u => {
      const rec = allRecords.find(r =>
        (r.username && r.username === u.username) ||
        (r.name && r.name === u.display_name)
      ) || null;

      const dailyRate = EVENT_FLAT_RATE;

      // Late deduction: (minutesLate / 480) * dailyRate
      let lateDeduction = 0;
      if (rec && ev.call_date && ev.call_time) {
        const att = computeAttendanceStatus(rec.time_in, ev.call_date, ev.call_time);
        if (att.isLate && att.minutesLate > 0) {
          lateDeduction = Math.round((att.minutesLate / WORK_MINS) * dailyRate * 100) / 100;
        }
      }

      const netSalary = dailyRate > 0 ? Math.round((dailyRate - lateDeduction) * 100) / 100 : 0;

      function fmt(n) {
        const parts = n.toFixed(2).split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return 'PHP ' + parts.join('.');
      }

      return [
        u.display_name,
        eventDateLabel,
        dailyRate > 0 ? fmt(dailyRate) : '—',
        lateDeduction > 0 ? fmt(lateDeduction) : '—',
        netSalary > 0 ? fmt(netSalary) : '—',
        '' // signature — left blank for physical signing
      ];
    });

    // ── Build PDF ──
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    const pageW = doc.internal.pageSize.getWidth();
    const pad   = 14;
    const ink   = [30, 30, 30];
    const muted = [120, 120, 120];
    const rule  = [210, 210, 210];

    // White background
    doc.setFillColor(255, 255, 255);
    doc.rect(0, 0, pageW, doc.internal.pageSize.getHeight(), 'F');

    // Company name
    let y = 16;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...ink);
    doc.text('Supreme InfoTech Solutions', pad, y);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...muted);
    doc.text('Event Payroll Report', pad, y + 6);

    // Generated timestamp (right-aligned)
    doc.setFontSize(7.5);
    doc.setTextColor(...muted);
    doc.text(`Generated: ${new Date().toLocaleString('en-PH')}`, pageW - pad, y + 6, { align: 'right' });

    // Divider
    y += 12;
    doc.setDrawColor(...rule);
    doc.setLineWidth(0.4);
    doc.line(pad, y, pageW - pad, y);
    y += 6;

    // Event name + meta
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...ink);
    doc.text(ev.event_name || 'Untitled Event', pad, y);

    const metaParts = [
      ev.sport ? ev.sport.charAt(0).toUpperCase() + ev.sport.slice(1) : '',
      ev.venue ? `Venue: ${ev.venue}` : '',
      `Date: ${eventDateLabel}`,
      ev.call_time ? `Call Time: ${formatDisplayTime(ev.call_time)}` : '',
    ].filter(Boolean).join('   ·   ');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...muted);
    doc.text(metaParts, pad, y + 6);

    // Table
    doc.autoTable({
      startY: y + 14,
      head: [['Employee Name', 'Event Date', 'Daily Rate', 'Late Deduction', 'Net Salary', 'Signature']],
      body: tableRows,
      margin: { left: pad, right: pad },
      styles: {
        font: 'helvetica',
        fontSize: 9,
        cellPadding: 7,
        lineColor: rule,
        lineWidth: 0.3,
        textColor: ink,
        fillColor: [255, 255, 255],
        valign: 'middle',
        halign: 'center',
        minCellHeight: 16,
      },
      headStyles: {
        fillColor: [245, 245, 245],
        textColor: ink,
        fontStyle: 'bold',
        fontSize: 8,
        halign: 'center',
        valign: 'middle',
        lineColor: rule,
        minCellHeight: 14,
      },
      alternateRowStyles: {
        fillColor: [250, 250, 250],
      },
      columnStyles: {
        0: { cellWidth: 52, fontStyle: 'bold', halign: 'left' },
        1: { cellWidth: 36 },
        2: { cellWidth: 38 },
        3: { cellWidth: 38 },
        4: { cellWidth: 38, fontStyle: 'bold' },
        5: { cellWidth: 'auto' },
      },
      didParseCell(data) {
        // Force center + middle on every body cell except col 0
        if (data.section === 'body' && data.column.index !== 0) {
          data.cell.styles.halign = 'center';
          data.cell.styles.valign = 'middle';
        }
        if (data.section === 'body' && data.column.index === 0) {
          data.cell.styles.halign = 'left';
          data.cell.styles.valign = 'middle';
        }
      },
    });

    // Footer on every page
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      const y = doc.internal.pageSize.getHeight() - 7;
      doc.setDrawColor(...rule);
      doc.setLineWidth(0.3);
      doc.line(pad, y - 2, pageW - pad, y - 2);
      doc.setFontSize(7);
      doc.setTextColor(...muted);
      doc.text('Supreme InfoTech Solutions — Confidential', pad, y);
      doc.text(`Page ${i} of ${pageCount}`, pageW - pad, y, { align: 'right' });
    }

    // Save
    const safeName = (ev.event_name || 'event').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    doc.save(`payroll_${safeName}_${ev.event_date || 'undated'}.pdf`);
    toast('Payroll PDF generated!', 'success');

  } catch (err) {
    console.error('[runEventPayroll]', err);
    toast('Failed to generate payroll PDF.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}