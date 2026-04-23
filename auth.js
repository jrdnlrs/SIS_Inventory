/* ─────────────────────────────────────────
   StockDesk — auth.js
   Authentication engine:
   • SHA-256 password hashing (Web Crypto API)
   • Session management via sessionStorage
   • Lockout after 5 failed attempts (15 min)
   • Auto-logout after 30 min inactivity
   • Loads credentials from users.json
   ───────────────────────────────────────── */

const AUTH = (() => {

  // ── CONFIG ─────────────────────────────
  const CFG = {
    SESSION_KEY:       'stockdesk_session',
    LOCKOUT_KEY:       'stockdesk_lockout',
    MAX_ATTEMPTS:      5,
    LOCKOUT_DURATION:  15 * 60 * 1000,   // 15 minutes in ms
    INACTIVITY_LIMIT:  30 * 60 * 1000,   // 30 minutes in ms
    USERS_FILE:        'users.json',
  };

  // ── SHA-256 HASH ───────────────────────
  async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data    = encoder.encode(password);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ── LOAD USERS ─────────────────────────
  async function loadUsers() {
    try {
      const res  = await fetch(CFG.USERS_FILE + '?nocache=' + Date.now());
      const data = await res.json();
      return data.users || [];
    } catch (e) {
      console.error('[auth] Could not load users.json:', e);
      return [];
    }
  }

  // ── LOCKOUT HELPERS ────────────────────
  function getLockout(username) {
    try {
      const raw = localStorage.getItem(CFG.LOCKOUT_KEY + '_' + username);
      return raw ? JSON.parse(raw) : { attempts: 0, lockedUntil: null };
    } catch { return { attempts: 0, lockedUntil: null }; }
  }

  function saveLockout(username, data) {
    localStorage.setItem(CFG.LOCKOUT_KEY + '_' + username, JSON.stringify(data));
  }

  function isLocked(username) {
    const l = getLockout(username);
    if (!l.lockedUntil) return false;
    if (Date.now() < l.lockedUntil) return true;
    // Lock expired — reset
    saveLockout(username, { attempts: 0, lockedUntil: null });
    return false;
  }

  function recordFailedAttempt(username) {
    const l = getLockout(username);
    l.attempts = (l.attempts || 0) + 1;
    if (l.attempts >= CFG.MAX_ATTEMPTS) {
      l.lockedUntil = Date.now() + CFG.LOCKOUT_DURATION;
    }
    saveLockout(username, l);
    return {
      attemptsLeft: Math.max(0, CFG.MAX_ATTEMPTS - l.attempts),
      locked:       l.attempts >= CFG.MAX_ATTEMPTS,
    };
  }

  function resetAttempts(username) {
    saveLockout(username, { attempts: 0, lockedUntil: null });
  }

  function getLockoutRemaining(username) {
    const l = getLockout(username);
    if (!l.lockedUntil) return 0;
    return Math.max(0, Math.ceil((l.lockedUntil - Date.now()) / 1000 / 60));
  }

  // ── SESSION ────────────────────────────
  function createSession(user) {
    const session = {
      username:     user.username,
      display_name: user.display_name,
      role:         user.role,
      loginTime:    Date.now(),
      lastActivity: Date.now(),
    };
    sessionStorage.setItem(CFG.SESSION_KEY, JSON.stringify(session));
    startInactivityTimer();
  }

  function getSession() {
    try {
      const raw = sessionStorage.getItem(CFG.SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function touchSession() {
    const s = getSession();
    if (!s) return;
    s.lastActivity = Date.now();
    sessionStorage.setItem(CFG.SESSION_KEY, JSON.stringify(s));
  }

  function destroySession() {
    sessionStorage.removeItem(CFG.SESSION_KEY);
    clearInactivityTimer();
  }

  // ── INACTIVITY TIMER ───────────────────
  let _inactivityTimer = null;

  function startInactivityTimer() {
    clearInactivityTimer();
    _inactivityTimer = setInterval(() => {
      const s = getSession();
      if (!s) { clearInactivityTimer(); return; }
      if (Date.now() - s.lastActivity > CFG.INACTIVITY_LIMIT) {
        destroySession();
        window.location.href = 'login.html?reason=timeout';
      }
    }, 60 * 1000); // check every minute
  }

  function clearInactivityTimer() {
    if (_inactivityTimer) { clearInterval(_inactivityTimer); _inactivityTimer = null; }
  }

  // Reset inactivity on user interaction
  function bindActivityListeners() {
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt => {
      document.addEventListener(evt, touchSession, { passive: true });
    });
  }

  // ── LOGIN ──────────────────────────────
  async function login(username, password) {
    const u = username.trim().toLowerCase();

    if (isLocked(u)) {
      return {
        ok:      false,
        reason:  'locked',
        minutes: getLockoutRemaining(u),
      };
    }

    const users = await loadUsers();
    const user  = users.find(x => x.username.toLowerCase() === u && x.active);

    if (!user) {
      // Generic message — don't reveal whether username exists
      recordFailedAttempt(u);
      return { ok: false, reason: 'invalid' };
    }

    const hash = await hashPassword(password);
    if (hash !== user.password_hash) {
      const result = recordFailedAttempt(u);
      if (result.locked) {
        return { ok: false, reason: 'locked', minutes: CFG.LOCKOUT_DURATION / 60000 };
      }
      return { ok: false, reason: 'invalid', attemptsLeft: result.attemptsLeft };
    }

    resetAttempts(u);
    createSession(user);
    return { ok: true, user };
  }

  // ── GUARDS ───────────────────────────────
  function requireAuth() {
    const s = getSession();
    if (!s) {
      window.location.href = 'login.html';
      return null;
    }
    // Check inactivity inline on page load too
    if (Date.now() - s.lastActivity > CFG.INACTIVITY_LIMIT) {
      destroySession();
      window.location.href = 'login.html?reason=timeout';
      return null;
    }
    touchSession();
    bindActivityListeners();
    startInactivityTimer();
    return s;
  }

  function requireSuperAdmin() {
    const s = requireAuth();
    if (s && s.role !== 'superadmin') {
      window.location.href = 'index.html'; // Kick standard admins out
      return null;
    }
    return s;
  }

  // ── LOGOUT ─────────────────────────────
  function logout() {
    destroySession();
    window.location.href = 'login.html?reason=logout';
  }

  // ── PUBLIC API ─────────────────────────
  return { login, logout, requireAuth, requireSuperAdmin, getSession, hashPassword };

})();