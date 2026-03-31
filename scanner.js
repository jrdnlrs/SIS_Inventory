/* ─────────────────────────────────────────
   StockDesk — scanner.js
   Handles keyboard-wedge barcode scanner input.

   Two modes:
   1. LOOKUP MODE (default): scan a barcode →
      highlight existing item OR open Add modal.
   2. SCAN SESSION MODE: set category/fields once,
      then scan items in bulk.

      Session supports two scan flows (chosen at setup):
      A) BARCODE ONLY — one scan adds the item.
         Duplicate = same barcode already in inventory.
      B) BARCODE + SERIAL — scan barcode, then scan
         serial number. Duplicate = same serial already
         in inventory. Solves the "same model, same
         barcode, different unit" problem.
   ───────────────────────────────────────── */

(function () {

  // ── SESSION STATE ─────────────────────────
  let session = {
    active:        false,
    requireSerial: false,
    category:      '',
    location:      '',
    brand:         '',
    model:         '',
    notes:         '',
    log:           [],
    pendingBarcode: null,
  };

  document.addEventListener('DOMContentLoaded', initScanner);

  function initScanner() {
    const input  = document.getElementById('scannerInput');
    const status = document.getElementById('scannerStatus');
    if (!input || !status) return;

    injectSessionModal();
    injectSessionLog();
    injectStartButton();

    // ── Scan handler ────────────────────────
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      const code = input.value.trim();
      input.value = '';
      if (!code) return;

      if (session.active) {
        handleSessionScan(code, status);
      } else {
        handleLookupScan(code, status);
      }

      setTimeout(() => {
        if (!session.active) setStatus(status, 'ready', 'READY');
      }, 3000);
    });

    // Focus scanner on '/' key
    document.addEventListener('keydown', function (e) {
      const tag = document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.getElementById('overlay').classList.contains('open')) return;
      if (document.getElementById('scanSessionOverlay').classList.contains('open')) return;
      if (e.key === '/') {
        e.preventDefault();
        input.focus();
      }
    });
  }

  // ── LOOKUP MODE (original behaviour) ──────
  function handleLookupScan(code, status) {
    const found = (typeof items !== 'undefined')
      ? items.find(i => i.serial === code || i.uniqueId === code || (i.barcode && i.barcode === code))
      : null;

    if (found) {
      const label = [found.brand, found.model].filter(Boolean).join(' ') || found.uniqueId;
      setStatus(status, 'found', `✓ ${label}`);
      scrollAndFlash(found.id);
      showToast(`Found: ${label}`, 'success');
    } else {
      setStatus(status, 'notfound', 'New — adding…');
      showToast('New serial scanned. Fill in item details.', 'info');
      autoAddNew(code);
    }
  }

  // ── SESSION MODE ──────────────────────────
  function handleSessionScan(code, status) {
    // Serial-only flow: each scan IS the serial number
    const dupSerial = (typeof items !== 'undefined')
      ? items.find(i => i.serial && i.serial === code)
      : null;

    if (dupSerial) {
      setStatus(status, 'notfound', '⚠ Serial exists');
      showToast(`Serial already in inventory: ${dupSerial.brand || ''} ${dupSerial.model || ''}`.trim(), 'error');
      addToSessionLog({ serial: code, brand: dupSerial.brand, model: dupSerial.model, uniqueId: dupSerial.uniqueId, status: 'duplicate' });
      pulseScanner('warn');
      return;
    }

    commitItem(code, status);
  }

  // ── COMMIT ITEM TO INVENTORY ──────────────
  function commitItem(serial, status) {
    const category = session.category || 'Uncategorized';
    const uniqueId = (typeof generateUniqueId === 'function') ? generateUniqueId(category) : '';
    const brand    = session.brand || '';
    const itemCount = session.log.filter(l => l.status === 'added').length + 1;
    const model    = session.model
      ? `${session.model} #${itemCount}`
      : `${category} #${itemCount}`;

    const newItem = {
      id:       uid(),
      serial,
      brand,
      model,
      category,
      uniqueId,
      location: session.location,
      status:   session.status,
      notes:    session.notes,
    };

    if (typeof items !== 'undefined') {
      items.push(newItem);
      if (typeof save === 'function') save();
      if (typeof renderTable === 'function') renderTable();
    }

    setStatus(status, 'found', '✓ Added');
    addToSessionLog({ serial, brand, model, uniqueId, status: 'added' });
    pulseScanner('ok');

    setTimeout(() => {
      if (typeof flashRow === 'function') flashRow(newItem.id);
    }, 80);
  }

  // ── SESSION MODAL ─────────────────────────
  function injectSessionModal() {
    const html = `
    <div class="overlay" id="scanSessionOverlay" onclick="closeScanSessionOutside(event)">
      <div class="modal scan-session-modal">
        <h2><span class="dot dot-scan"></span> <span>Scan Session Setup</span></h2>
        <p style="margin:-8px 0 18px;font-size:13px;color:var(--text-muted);">
          Set shared fields once — then scan serial numbers continuously.
        </p>

        <div class="form-grid">
          <div class="form-group">
            <label>Category <span style="color:var(--red)">*</span></label>
            <input id="ssCategory" placeholder="e.g. Mouse, Monitor…" list="catList" oninput="refreshSessionUniqueIdPreview()" />
          </div>
          <div class="form-group">
            <label>Location / Cabinet</label>
            <select id="ssLocation">
              <option value="">— Select location —</option>
            </select>
          </div>
          <div class="form-group">
            <label>Status</label>
            <select id="ssStatus">
              <option value="">— Select status —</option>
            </select>
          </div>
          <div class="form-group">
            <label>Brand</label>
            <input id="ssBrand" placeholder="e.g. Sony, Logitech…" />
          </div>
          <div class="form-group">
            <label>Model</label>
            <input id="ssModel" placeholder="e.g. ZV-E10, MX Master 3…" />
          </div>
          <div class="form-group form-full">
            <label>Notes</label>
            <textarea id="ssNotes" placeholder="Optional notes applied to all scanned items…"></textarea>
          </div>
        </div>

        <div id="ssUniqueIdPreview" style="
          margin:4px 0 18px;padding:10px 14px;border-radius:8px;
          background:var(--surface-2,#1e1e24);font-size:12px;
          color:var(--text-muted);display:none;">
          Next ID will be: <strong id="ssNextId" style="color:var(--accent)">—</strong>
        </div>

        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeScanSession()">Cancel</button>
          <button class="btn btn-primary" onclick="startScanSession()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Start Scanning
          </button>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  // ── SESSION LOG PANEL ─────────────────────
  function injectSessionLog() {
    const html = `
    <div id="scanSessionLog" style="display:none;">
      <div class="session-log-header">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="scanner-indicator" style="animation:pulse 1s infinite;"></div>
          <span style="font-weight:600;font-size:13px;letter-spacing:.04em;">SCAN SESSION ACTIVE</span>
          <span id="sessionLogCount" style="
            background:var(--accent);color:#000;font-size:11px;font-weight:700;
            padding:2px 8px;border-radius:99px;">0 scanned</span>
          <span id="sessionFlowBadge" style="
            font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
            padding:2px 8px;border-radius:99px;border:1px solid var(--border,#2a2a35);
            color:var(--text-muted);">Barcode only</span>
        </div>
        <button class="btn btn-danger" onclick="endScanSession()" style="padding:6px 14px;font-size:12px;">
          End Session
        </button>
      </div>
      <div id="sessionScanHint" class="session-scan-hint">Scan a barcode…</div>
      <div id="sessionLogItems" class="session-log-items"></div>
    </div>`;

    const scannerBar = document.querySelector('.scanner-bar');
    if (scannerBar) scannerBar.insertAdjacentHTML('afterend', html);
  }

  // ── START SESSION BUTTON ──────────────────
  function injectStartButton() {
    const bar = document.querySelector('.scanner-bar');
    if (!bar) return;
    const btn = document.createElement('button');
    btn.id        = 'startSessionBtn';
    btn.className = 'btn btn-ghost';
    btn.style.cssText = 'padding:6px 14px;font-size:12px;white-space:nowrap;';
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Scan Session`;
    btn.onclick = openScanSession;
    bar.appendChild(btn);

    // Hide scan session for non-admin users
    if (typeof currentRole !== 'undefined' && currentRole !== 'admin') {
      btn.style.display = 'none';
    }
  }



  // ── OPEN / CLOSE SESSION MODAL ────────────
  window.openScanSession = function () {
    // Populate location dropdown from LOCATION_OPTIONS
    const locSel = document.getElementById('ssLocation');
    locSel.innerHTML = '<option value="">— Select location —</option>'
      + (typeof LOCATION_OPTIONS !== 'undefined' ? LOCATION_OPTIONS : [])
          .map(l => `<option value="${l}">${l}</option>`).join('');

    // Populate status dropdown from STATUS_OPTIONS
    const statSel = document.getElementById('ssStatus');
    statSel.innerHTML = '<option value="">— Select status —</option>'
      + (typeof STATUS_OPTIONS !== 'undefined' ? STATUS_OPTIONS : [])
          .map(s => `<option value="${s}">${s}</option>`).join('');

    document.getElementById('scanSessionOverlay').classList.add('open');
    setTimeout(() => document.getElementById('ssCategory').focus(), 100);
  };

  window.closeScanSession = function () {
    document.getElementById('scanSessionOverlay').classList.remove('open');
  };

  window.closeScanSessionOutside = function (e) {
    if (e.target === document.getElementById('scanSessionOverlay')) closeScanSession();
  };

  window.refreshSessionUniqueIdPreview = function () {
    const cat     = document.getElementById('ssCategory').value.trim();
    const preview = document.getElementById('ssUniqueIdPreview');
    const nextId  = document.getElementById('ssNextId');
    if (cat && typeof generateUniqueId === 'function') {
      nextId.textContent    = generateUniqueId(cat);
      preview.style.display = 'block';
    } else {
      preview.style.display = 'none';
    }
  };

  // ── START SESSION ─────────────────────────
  window.startScanSession = function () {
    const cat = document.getElementById('ssCategory').value.trim();
    if (!cat) {
      showToast('Please enter a category before starting.', 'error');
      document.getElementById('ssCategory').focus();
      return;
    }

    session = {
      active:        true,
      requireSerial: true,
      category:      cat,
      location:      document.getElementById('ssLocation').value,
      status:        document.getElementById('ssStatus').value,
      brand:         document.getElementById('ssBrand').value.trim(),
      model:         document.getElementById('ssModel').value.trim(),
      notes:         document.getElementById('ssNotes').value.trim(),
      log:           [],
      pendingBarcode: null,
    };

    closeScanSession();

    document.getElementById('scanSessionLog').style.display  = 'block';
    document.getElementById('startSessionBtn').style.display = 'none';
    document.getElementById('sessionLogItems').innerHTML     = '';
    document.getElementById('sessionLogCount').textContent   = '0 scanned';
    document.getElementById('sessionFlowBadge').textContent  = 'Serial Number';

    updateScannerHint('Scan a serial number…');

    const status = document.getElementById('scannerStatus');
    setStatus(status, 'found', '● SESSION');
    document.querySelector('.scanner-bar').classList.add('session-active');

    document.getElementById('scannerInput').placeholder = 'Session active — scan serial number here…';
    document.getElementById('scannerInput').focus();

    showToast('Session started · Serial Number mode', 'success');
  };

  // ── END SESSION ───────────────────────────
  window.endScanSession = function () {
    const count = session.log.filter(l => l.status === 'added').length;

    // If mid-serial scan, warn user
    if (session.pendingBarcode) {
      if (!confirm(`You have a pending barcode (${session.pendingBarcode}) waiting for a serial scan. End session anyway?`)) return;
    }

    session.active        = false;
    session.pendingBarcode = null;

    document.getElementById('scanSessionLog').style.display  = 'none';
    document.getElementById('startSessionBtn').style.display = '';

    const status = document.getElementById('scannerStatus');
    setStatus(status, 'ready', 'READY');
    document.querySelector('.scanner-bar').classList.remove('session-active');
    document.getElementById('scannerInput').placeholder = 'Scan or type serial number, then press Enter…';

    if (typeof renderTable === 'function') renderTable();
    showToast(`Session ended · ${count} item${count !== 1 ? 's' : ''} added.`, 'info');
  };

  // ── SESSION LOG ───────────────────────────
  function addToSessionLog(entry) {
    session.log.unshift(entry);

    const container  = document.getElementById('sessionLogItems');
    const countEl    = document.getElementById('sessionLogCount');
    const addedCount = session.log.filter(l => l.status === 'added').length;
    countEl.textContent = `${addedCount} scanned`;

    const displayName = [entry.brand, entry.model].filter(Boolean).join(' ') || '—';

    const row = document.createElement('div');
    row.className = `session-log-row ${entry.status}`;
    row.innerHTML = `
      <span class="log-status-icon">${entry.status === 'added' ? '✓' : '⚠'}</span>
      <span class="log-serial mono">${entry.serial || '—'}</span>
      <span class="log-name">${displayName}</span>
      <span class="log-uid mono">${entry.uniqueId || '—'}</span>
      <span class="log-badge ${entry.status}">${entry.status === 'added' ? 'Added' : 'Duplicate'}</span>
    `;
    container.prepend(row);
    requestAnimationFrame(() => row.classList.add('visible'));
  }

  function updateScannerHint(msg) {
    const el = document.getElementById('sessionScanHint');
    if (el) el.textContent = msg;
  }

  function pulseScanner(type) {
    const bar = document.querySelector('.scanner-bar');
    bar.classList.remove('pulse-ok', 'pulse-warn');
    void bar.offsetWidth;
    if (type === 'ok')   bar.classList.add('pulse-ok');
    if (type === 'warn') bar.classList.add('pulse-warn');
    setTimeout(() => bar.classList.remove('pulse-ok', 'pulse-warn'), 500);
  }

  // ── SHARED HELPERS ────────────────────────
  function setStatus(el, state, label) {
    el.className   = `scanner-status ${state}`;
    el.textContent = label;
  }

  function scrollAndFlash(id) {
    const row = document.getElementById(`row-${id}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (typeof flashRow === 'function') flashRow(id);
  }

  function autoAddNew(code) {
    if (typeof openModal !== 'function') return;
    openModal();
    // 150ms ensures we write AFTER openModal's own synchronous fSerial clear
    // and after the focus() it sets on fBrand, so serial is visible to the user
    setTimeout(() => {
      const serialField = document.getElementById('fSerial');
      if (serialField) serialField.value = code;
      const brandField = document.getElementById('fBrand');
      if (brandField) brandField.focus();
    }, 150);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function showToast(msg, type) {
    if (typeof toast === 'function') {
      toast(msg, type);
    } else {
      console.log(`[scanner] ${type}: ${msg}`);
    }
  }

})();