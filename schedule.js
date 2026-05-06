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
  const res = await fetch(url, { method: 'DELETE', headers: dbHeaders() });
  if (!res.ok) { const t = await res.text(); throw new Error(`DELETE ${url} → ${res.status}: ${t}`); }
}

// ── STATE ──────────────────────────────────
let _session     = null;
let _isAdmin     = false;
let _events      = [];          // all loaded events
let _allUsers    = [];          // from users.json
let _assignees   = {};          // { event_id: [username, …] }
let _editingId   = null;        // null = creating new
let _selectedAssignees = new Set();

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
        `${SUPABASE_URL}/rest/v1/sport_event_assignees?select=event_id,username`
      );
      _assignees = {};
      assigneeRows.forEach(r => {
        if (!_assignees[r.event_id]) _assignees[r.event_id] = [];
        _assignees[r.event_id].push(r.username);
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
  const assigned   = _assignees[ev.id] || [];
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
    return await dbGet(`${EVENT_TIMEIN_URL}?event_id=eq.${eventId}&select=*&order=time_in.asc`);
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

// Build the full Time In panel HTML (async — fetches records)
async function buildTimeInPanelHTML(eventId) {
  const assigned = _assignees[eventId] || [];
  const isAssigned = assigned.includes(_session.username);

  // Admins always see the attendance table; employees only see if assigned
  if (!isAssigned && !_isAdmin) {
    return `<div class="ti-not-assigned">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      You are not assigned to this event.
    </div>`;
  }

  const allRecords = await loadAllTimeInRecords(eventId);
  const myRecord   = allRecords.find(r => r.username === _session.username) || null;

  // ── My clock-in section (assigned employees + admins if assigned) ──
  let mySection = '';
  if (isAssigned) {
    if (!myRecord) {
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
  const assignedUsers = _allUsers.filter(u => assigned.includes(u.username));
  const tableRows = assignedUsers.map(u => {
    const rec = allRecords.find(r => r.username === u.username);
    const isMe = u.username === _session.username;
    if (!rec) {
      return `<div class="ti-row ti-row-absent ${isMe ? 'ti-row-me' : ''}">
        <div class="ti-row-avatar">${initials(u.display_name)}</div>
        <div class="ti-row-name">${escHtml(u.display_name)}${isMe ? ' <span class="ti-you-tag">you</span>' : ''}</div>
        <div class="ti-row-time ti-absent">—</div>
        <div class="ti-row-time ti-absent">—</div>
      </div>`;
    }
    const hasOut = !!rec.time_out;
    return `<div class="ti-row ti-row-present ${isMe ? 'ti-row-me' : ''}">
      <div class="ti-row-avatar ti-avatar-in">${initials(u.display_name)}</div>
      <div class="ti-row-name">${escHtml(u.display_name)}${isMe ? ' <span class="ti-you-tag">you</span>' : ''}</div>
      <div class="ti-row-time ti-in">${fmtTimeStamp(rec.time_in)}</div>
      <div class="ti-row-time ${hasOut ? 'ti-out' : 'ti-pending'}">${hasOut ? fmtTimeStamp(rec.time_out) : '…'}</div>
    </div>`;
  }).join('');

  const presentCount = allRecords.length;
  const totalCount   = assignedUsers.length;

  return `
    ${mySection}
    <div class="ti-table-wrap">
      <div class="ti-table-header">
        <span>Attendance</span>
        <span class="ti-count">${presentCount}/${totalCount} clocked in</span>
      </div>
      <div class="ti-table-cols">
        <span>Employee</span><span></span><span>Time In</span><span>Time Out</span>
      </div>
      ${tableRows || `<div class="ti-empty">No assignees yet.</div>`}
    </div>`;
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
  _selectedAssignees = new Set();

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
  _selectedAssignees = new Set(_assignees[ev.id] || []);

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
  const q   = (document.getElementById('assignSearch').value || '').toLowerCase();
  const list = document.getElementById('assignList');

  const visible = _allUsers.filter(u =>
    !q || u.display_name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)
  );

  if (!visible.length) {
    list.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;font-family:'JetBrains Mono',monospace;">No users found.</div>`;
    return;
  }

  list.innerHTML = visible.map(u => {
    const checked = _selectedAssignees.has(u.username);
    return `
      <div class="assign-item ${checked ? 'checked' : ''}" onclick="toggleAssignee('${u.username}')">
        <div class="assign-checkbox"></div>
        <div class="assign-avatar-sm">${initials(u.display_name)}</div>
        <div class="assign-name">${escHtml(u.display_name)}</div>
        <span class="assign-role-badge ${u.role}">${u.role}</span>
      </div>`;
  }).join('');

  updateAssignCount();
}

function toggleAssignee(username) {
  if (_selectedAssignees.has(username)) {
    _selectedAssignees.delete(username);
  } else {
    _selectedAssignees.add(username);
  }
  filterAssignList();
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
      const rows = [..._selectedAssignees].map(username => ({
        event_id: eventId,
        username,
      }));
      await dbPost(
        `${SUPABASE_URL}/rest/v1/sport_event_assignees`,
        rows
      );
    }

    toast(_editingId ? 'Event updated successfully.' : 'Event created successfully.', 'success');
    closeCreateModal();
    await loadEvents();
    populateSportFilter();
    renderEvents();

  } catch (err) {
    console.error('[schedule] saveEvent error:', err);
    toast('Failed to save event. Check console for details.', 'error');
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