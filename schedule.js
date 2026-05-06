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
        <div class="event-assigned-count">
          <div class="event-assigned-avatars">${avatarHTML}</div>
          ${assignedUsers.length > 0
            ? `<span>${assignedUsers.length} employee${assignedUsers.length !== 1 ? 's' : ''} assigned</span>`
            : `<span style="color:var(--text-dim)">No assignees yet</span>`}
        </div>
      </div>
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
          <div class="detail-info-label">Date</div>
          <div class="detail-info-val accent">${formatDisplayDate(ev.event_date)}</div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">Venue</div>
          <div class="detail-info-val">${escHtml(ev.venue || 'TBD')}</div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">Start Time</div>
          <div class="detail-info-val">${formatDisplayTime(ev.event_time)}</div>
        </div>
        <div class="detail-info-item">
          <div class="detail-info-label">Status</div>
          <div class="detail-info-val">${statusStr.charAt(0).toUpperCase() + statusStr.slice(1)}</div>
        </div>
      </div>

      <div class="detail-calltime-box">
        <div class="detail-calltime-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="detail-calltime-text">
          <strong>${ev.call_time ? formatDisplayTime(ev.call_time) : 'Not set'}</strong>
          <span>Call Time — Required Arrival</span>
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
}

function closeDetailModal() {
  document.getElementById('detailModalOverlay').classList.remove('open');
}

// Click-outside to close detail
document.getElementById('detailModalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeDetailModal();
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
  const date     = document.getElementById('fEventDate').value;
  const time     = document.getElementById('fEventTime').value;
  const callTime = document.getElementById('fCallTime').value;
  const venue    = document.getElementById('fVenue').value.trim();
  const status   = document.getElementById('fStatus').value;
  const notes    = document.getElementById('fNotes').value.trim();

  if (!name)     { toast('Event name is required.', 'error'); return; }
  if (!sport)    { toast('Please select a sport.', 'error'); return; }
  if (!date)     { toast('Event date is required.', 'error'); return; }
  if (!callTime) { toast('Call time is required.', 'error'); return; }
  if (!venue)    { toast('Venue is required.', 'error'); return; }

  const payload = {
    event_name:  name,
    sport,
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