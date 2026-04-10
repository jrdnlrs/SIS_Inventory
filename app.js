/* ─────────────────────────────────────────
   StockDesk — app.js
   Core inventory logic: state, CRUD, render,
   sort, export, import, modal, toast, keyboard shortcuts
   ───────────────────────────────────────── */

// ── STATE ──────────────────────────────────
let items = [];          // populated from Supabase on load
let editId = null;
let sortField = 'name';
let sortAsc = true;
let selectedIds = new Set();
let currentRole = 'employee'; // set from session on init
let lastFiltered = []; // tracks the current filtered/sorted view for export

// ── SUPABASE CLIENT ────────────────────────
// Requires config.js to be loaded first (SUPABASE_URL + SUPABASE_ANON_KEY)
const _supa = (() => {
  const headers = {
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
  };
  const base = SUPABASE_URL + '/rest/v1/inventory';

  async function request(method, url, body) {
    const opts = { method, headers: { ...headers } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Supabase ${method} error ${res.status}: ${err}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }

  return {
    getAll:  ()           => request('GET',    base + '?order=created_at.asc&select=*'),
    insert:  (rows)       => request('POST',   base, rows),
    update:  (id, data)   => request('PATCH',  base + `?id=eq.${id}`, data),
    remove:  (ids)        => request('DELETE', base + `?id=in.(${ids.join(',')})`),
    upsert:  (rows)       => request('POST',   SUPABASE_URL + '/rest/v1/inventory',
                              // upsert via special header
                              (() => { headers['Prefer'] = 'resolution=merge-duplicates,return=representation'; return rows; })()),
  };
})();

// ── REALTIME SUBSCRIPTION ─────────────────
// Listens for INSERT / UPDATE / DELETE on the inventory table
// and keeps all connected clients in sync automatically.
function subscribeRealtime() {
  const wsUrl = SUPABASE_URL.replace('https://', 'wss://') + '/realtime/v1/websocket'
    + '?apikey=' + SUPABASE_ANON_KEY + '&vsn=1.0.0';

  let ws;
  let heartbeat;
  let reconnectDelay = 2000;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      reconnectDelay = 2000; // reset backoff on success

      // Join the realtime channel for the inventory table
      ws.send(JSON.stringify({
        topic:   'realtime:public:inventory',
        event:   'phx_join',
        payload: { config: { broadcast: { self: false }, presence: { key: '' } } },
        ref:     '1',
      }));

      // Heartbeat every 25s to keep connection alive
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
        }
      }, 25000);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const ev  = msg.payload?.type; // INSERT | UPDATE | DELETE
        if (!ev) return;

        const record = msg.payload.record;
        const old_record = msg.payload.old_record;

        if (ev === 'INSERT') {
          // Only add if not already present (e.g. from our own write)
          if (record && !items.find(i => i.id === record.id)) {
            items.push(record);
            renderTable();
            showRealtimePulse('insert');
          }
        } else if (ev === 'UPDATE') {
          if (record) {
            const idx = items.findIndex(i => i.id === record.id);
            if (idx !== -1) {
              items[idx] = record;
            } else {
              items.push(record);
            }
            renderTable();
            showRealtimePulse('update');
          }
        } else if (ev === 'DELETE') {
          if (old_record) {
            items = items.filter(i => i.id !== old_record.id);
            renderTable();
            showRealtimePulse('delete');
          }
        }
      } catch (err) {
        console.warn('[realtime] parse error:', err);
      }
    };

    ws.onerror = (e) => console.warn('[realtime] WebSocket error:', e);

    ws.onclose = () => {
      clearInterval(heartbeat);
      // Reconnect with exponential backoff (max 30s)
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
        connect();
      }, reconnectDelay);
    };
  }

  connect();
}

// Brief visual pulse on the stat card when a remote change arrives
function showRealtimePulse(type) {
  const card = document.getElementById('statCardTotal');
  if (!card) return;
  const color = type === 'delete' ? 'var(--red)' : type === 'update' ? 'var(--orange)' : 'var(--accent)';
  card.style.transition = 'box-shadow 0.2s ease';
  card.style.boxShadow  = `0 0 0 2px ${color}`;
  setTimeout(() => { card.style.boxShadow = ''; }, 800);
}

// ── CATEGORY → ID PREFIX MAP ───────────────
// ✏️  EDIT ONLY THIS to add/remove/rename categories.
// Format: 'Category Name': 'SIS-XXX'  (keep prefix unique, 3 letters recommended)
const CATEGORY_PREFIX = {
  'Laptop':         'SIS-LAP',
  'Laptop Charger': 'SIS-ACC',
  'Monitor':        'SIS-MON',
  'Headphones':     'SIS-HPH',
  'Mouse':          'SIS-MOU',
  'Keyboard':       'SIS-KYB',
  'Camera':         'SIS-CAM',
  'Chair':          'SIS-CHR',
  'Table':          'SIS-TBL',
  'Appliances':     'SIS-APP',
};

// Auto-derived from CATEGORY_PREFIX — do not edit manually
const PRESET_CATEGORIES = Object.keys(CATEGORY_PREFIX).sort();

// ── STATUS OPTIONS ─────────────────────────
const STATUS_OPTIONS = ['In Use', 'Defective', 'Spare', 'For Repair'];

// ── LOCATION OPTIONS ───────────────────────
// ✏️  EDIT HERE to add/remove/rename locations.
const LOCATION_OPTIONS = ['Second Floor Office', 'Third Floor Office', 'Stock Room'];

/**
 * Returns the next auto-incremented unique ID for a given category.
 */
function generateUniqueId(category, excludeId = null) {
  const cat    = (category || '').trim();
  const prefix = CATEGORY_PREFIX[cat] || 'SIS-' + cat.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X');
  const existing = items
    .filter(i => (i.unique_id || i.uniqueId) && (i.unique_id || i.uniqueId).startsWith(prefix) && i.id !== excludeId)
    .map(i => parseInt((i.unique_id || i.uniqueId || '').replace(prefix, ''), 10))
    .filter(n => !isNaN(n));
  const next = existing.length > 0 ? existing.reduce((a, b) => Math.max(a, b), 0) + 1 : 1;
  return prefix + String(next).padStart(4, '0');
}

// ── HELPERS ────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// save() is replaced by direct Supabase calls per operation.
// This stub remains so any stray call doesn't crash.
function save() { /* no-op: data lives in Supabase */ }

function showLoading(on) {
  const bar = document.getElementById('loadingBar');
  if (bar) bar.style.display = on ? 'block' : 'none';
}

async function loadItems() {
  showLoading(true);
  try {
    items = await _supa.getAll();
  } catch (e) {
    console.error('[db] loadItems failed:', e);
    toast('Could not load inventory. Check your connection.', 'error');
    items = [];
  } finally {
    showLoading(false);
  }
  renderTable();
}

// ── ITEM STATUS BADGE ──────────────────────
function itemStatusBadge(status) {
  const map = {
    'In Use':    'badge-ok',
    'Spare':     'badge-spare',
    'Defective': 'badge-out',
    'For Repair':'badge-low',
  };
  if (!status) return '<span style="color:var(--text-muted);font-size:11px">—</span>';
  return `<span class="badge ${map[status] || 'badge-ok'}">${status}</span>`;
}
function renderTable() {
  const q       = document.getElementById('searchInput').value.toLowerCase();
  const cat     = document.getElementById('categoryFilter').value;

  let filtered = items.filter(item => {
    const matchQ   = !q || (item.brand || '').toLowerCase().includes(q)
                         || (item.model || '').toLowerCase().includes(q)
                         || (item.barcode || '').includes(q)
                         || (item.category || '').toLowerCase().includes(q)
                         || (item.serial   || '').toLowerCase().includes(q)
                         || (item.location || '').toLowerCase().includes(q)
                         || (item.unique_id || item.uniqueId || '').toLowerCase().includes(q);
    const matchCat = !cat || (item.category || '') === cat;
    return matchQ && matchCat;
  });

  filtered.sort((a, b) => {
    let va = a[sortField] ?? '', vb = b[sortField] ?? '';
    if (typeof va === 'number') return sortAsc ? va - vb : vb - va;
    return sortAsc
      ? String(va).localeCompare(String(vb))
      : String(vb).localeCompare(String(va));
  });

  lastFiltered = filtered; // keep in sync for export

  const tbody = document.getElementById('tableBody');

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M9 9h6M9 12h6M9 15h4"/>
          </svg>
          <p>No items found.</p>
        </div>
      </td></tr>`;
  } else {
    tbody.innerHTML = filtered.map(item => `
      <tr id="row-${item.id}" class="${selectedIds.has(item.id) ? 'row-selected' : ''}">
        ${currentRole === 'admin' ? `
        <td class="col-check" onclick="event.stopPropagation()">
          <input type="checkbox" class="row-check" data-id="${item.id}"
            ${selectedIds.has(item.id) ? 'checked' : ''}
            onchange="onRowCheckChange(this, '${item.id}')" />
        </td>` : '<td class="col-check"></td>'}
        <td class="mono" style="color:var(--accent);font-weight:500">${item.unique_id || item.uniqueId || '—'}</td>
        <td class="mono" style="color:var(--text-muted)">${item.serial || '—'}</td>
        <td><strong>${item.brand || '—'}</strong></td>
        <td style="color:var(--text-muted);font-size:13px">${item.model || '—'}</td>
        <td><span style="color:var(--text-muted);font-size:12px">${item.category || '—'}</span></td>
        <td style="font-size:12px;color:var(--text-muted)">${item.location || '—'}</td>
        <td>${itemStatusBadge(item.status)}</td>
        ${currentRole === 'admin' ? `
        <td onclick="event.stopPropagation()">
          <div class="td-actions">
            <button class="btn btn-edit"   onclick="openModal('${item.id}')">Edit</button>
            <button class="btn btn-danger" onclick="deleteItem('${item.id}')">Delete</button>
          </div>
        </td>` : '<td></td>'}
      </tr>
    `).join('');
  }

  // ── Stats ─────────────────────────────────
  const usedCats   = [...new Set(items.map(i => i.category).filter(Boolean))];
  const isFiltered = cat || q;

  const totalLabel = document.getElementById('statLabelTotal');
  document.getElementById('stat-total').textContent   = filtered.length;
  document.getElementById('stat-instock').textContent = usedCats.length;
  if (totalLabel) totalLabel.textContent = isFiltered ? 'Filtered Items' : 'Total Items';


  // ── Rebuild category filter dropdown ──────
  const cats = [...new Set([...PRESET_CATEGORIES, ...usedCats])].sort();
  const cf   = document.getElementById('categoryFilter');
  const prev = cf.value;
  cf.innerHTML = '<option value="">All Categories</option>'
    + cats.map(c => `<option value="${c}"${c === prev ? ' selected' : ''}>${c}</option>`).join('');

  // ── Rebuild datalist for modal ─────────────
  document.getElementById('catList').innerHTML =
    cats.map(c => `<option value="${c}">`).join('');
}



// ── SORT ───────────────────────────────────
function sortBy(field, thEl) {
  if (sortField === field) {
    sortAsc = !sortAsc;
  } else {
    sortField = field;
    sortAsc   = true;
  }
  document.querySelectorAll('th').forEach(th => th.classList.remove('sorted'));
  if (thEl) thEl.classList.add('sorted');
  renderTable();
}

// ── MULTI-SELECT ───────────────────────────
function toggleRowSelect(event, id) {
  // Don't trigger if clicking a button or checkbox directly
  if (event.target.tagName === 'BUTTON' || event.target.tagName === 'INPUT') return;
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  updateSelectionUI();
}

function onRowCheckChange(checkbox, id) {
  if (checkbox.checked) {
    selectedIds.add(id);
  } else {
    selectedIds.delete(id);
  }
  updateSelectionUI();
}

function toggleSelectAll(checkbox) {
  const allCheckboxes = document.querySelectorAll('.row-check');
  // Only operate on visible rows — avoids ghost-selecting items hidden by search/filter
  allCheckboxes.forEach(cb => {
    const id = cb.dataset.id;
    if (checkbox.checked) {
      selectedIds.add(id);
    } else {
      selectedIds.delete(id);
    }
    cb.checked = checkbox.checked;
  });
  document.querySelectorAll('#tableBody tr').forEach(row => {
    row.classList.toggle('row-selected', checkbox.checked);
  });
  updateSelectionUI();
}

function updateSelectionUI() {
  const count   = selectedIds.size;
  const bulkBar = document.getElementById('bulkBar');
  document.getElementById('bulkCount').textContent   = count;
  document.getElementById('bulkPlural').textContent  = count === 1 ? '' : 's';
  bulkBar.classList.toggle('bulk-bar-visible', count > 0);

  // Sync row highlight classes
  document.querySelectorAll('#tableBody tr').forEach(row => {
    const id = row.id.replace('row-', '');
    row.classList.toggle('row-selected', selectedIds.has(id));
    const cb = row.querySelector('.row-check');
    if (cb) cb.checked = selectedIds.has(id);
  });

  // Sync select-all checkbox state
  const allCbs  = document.querySelectorAll('.row-check');
  const selectAll = document.getElementById('selectAll');
  if (selectAll && allCbs.length > 0) {
    selectAll.indeterminate = count > 0 && count < allCbs.length;
    selectAll.checked       = count === allCbs.length && allCbs.length > 0;
  }
}

function clearSelection() {
  selectedIds.clear();
  const selectAll = document.getElementById('selectAll');
  if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
  updateSelectionUI();
}

// ── BULK DELETE ────────────────────────────
async function bulkDelete() {
  if (currentRole !== 'admin') { toast('Admin access required.', 'error'); return; }
  const count = selectedIds.size;
  if (!count) return;
  if (!confirm(`Delete ${count} selected item${count > 1 ? 's' : ''}? This cannot be undone.`)) return;
  showLoading(true);
  try {
    await _supa.remove([...selectedIds]);
    selectedIds.clear();
    toast(`${count} item${count > 1 ? 's' : ''} deleted.`, 'info');
    await loadItems();
  } catch (e) {
    console.error('[db] bulkDelete failed:', e);
    toast('Failed to delete. Please try again.', 'error');
  } finally {
    showLoading(false);
  }
}

// ── BULK STATUS CHANGE ─────────────────────
async function bulkChangeStatus() {
  if (currentRole !== 'admin') { toast('Admin access required.', 'error'); return; }
  const status = document.getElementById('bulkStatusSelect').value;
  if (!status) { toast('Please select a status to apply.', 'error'); return; }
  const count = selectedIds.size;
  if (!count) return;
  showLoading(true);
  try {
    // Update each selected item — run in parallel
    await Promise.all([...selectedIds].map(id => _supa.update(id, { status })));
    selectedIds.clear();
    toast(`Status updated to "${status}" for ${count} item${count > 1 ? 's' : ''}.`, 'success');
    await loadItems();
  } catch (e) {
    console.error('[db] bulkChangeStatus failed:', e);
    toast('Failed to update status. Please try again.', 'error');
  } finally {
    showLoading(false);
  }
}

// ── FLASH ROW ──────────────────────────────
function flashRow(id) {
  const row = document.getElementById(`row-${id}`);
  if (!row) return;
  row.classList.remove('highlight');
  void row.offsetWidth;
  row.classList.add('highlight');
}

// ── MODAL ──────────────────────────────────
function openModal(id = null) {
  if (currentRole !== 'admin') { toast('Admin access required.', 'error'); return; }
  editId = id;
  const isEdit = !!id;
  document.getElementById('modalTitle').textContent = isEdit ? 'Edit Item' : 'Add Item';
  const item = isEdit ? (items.find(i => i.id === id) || {}) : {};

  document.getElementById('fBrand').value     = item.brand    || '';
  document.getElementById('fModel').value     = item.model    || '';
  document.getElementById('fCategory').value  = item.category || '';
  document.getElementById('fSerial').value    = item.serial   || '';
  document.getElementById('fLocation').value  = item.location || '';
  document.getElementById('fStatus').value    = item.status   || '';
  document.getElementById('fNotes').value     = item.notes    || '';

  // Quantity — only visible when adding
  document.getElementById('fQuantityGroup').style.display = isEdit ? 'none' : '';
  document.getElementById('fSerialGroup').style.display   = isEdit ? '' : '';
  document.getElementById('fQuantity').value              = 1;
  document.getElementById('fQuantityHint').style.display  = 'none';
  document.getElementById('saveBtn').textContent          = isEdit ? 'Save Item' : 'Add Item';

  // Serial hidden when adding multiple (quantity > 1 hides it dynamically via onQuantityChange)
  if (!isEdit) document.getElementById('fSerial').value = '';

  const uniqueIdField = document.getElementById('fUniqueId');
  if (isEdit && (item.unique_id || item.uniqueId)) {
    uniqueIdField.value = item.unique_id || item.uniqueId;
  } else if (!isEdit && item.category) {
    // editing existing — category pre-filled
    uniqueIdField.value = generateUniqueId(item.category, id);
  } else {
    uniqueIdField.value = '';
    uniqueIdField.placeholder = 'Select a category first';
  }

  document.getElementById('overlay').classList.add('open');
  setTimeout(() => document.getElementById('fBrand').focus(), 100);
}

function onQuantityChange() {
  if (editId) return;
  const qty     = parseInt(document.getElementById('fQuantity').value, 10) || 1;
  const brand   = document.getElementById('fBrand').value.trim();
  const model   = document.getElementById('fModel').value.trim();
  const cat     = document.getElementById('fCategory').value.trim();
  const hint    = document.getElementById('fQuantityHint');
  const serial  = document.getElementById('fSerialGroup');
  const saveBtn = document.getElementById('saveBtn');

  if (qty > 1) {
    serial.style.display = 'none';
    const prefix = [brand, model].filter(Boolean).join(' ') || cat || 'Item';
    hint.style.display  = 'block';
    hint.textContent    = `Will create ${qty} items: "${prefix} #1" → "${prefix} #${qty}" — serial numbers can be added later via Scan Session`;
    saveBtn.textContent = `Add ${qty} Items`;
  } else {
    serial.style.display = '';
    hint.style.display   = 'none';
    saveBtn.textContent  = 'Add Item';
  }
}

function onCategoryChange() {
  if (editId) return;
  const cat   = document.getElementById('fCategory').value.trim();
  const field = document.getElementById('fUniqueId');
  if (cat) {
    field.value       = generateUniqueId(cat);
    field.placeholder = 'Auto-generated';
  } else {
    field.value       = '';
    field.placeholder = 'Select a category first';
  }
}

function closeModal() {
  document.getElementById('overlay').classList.remove('open');
  editId = null;
}

function closeModalOutside(e) {
  if (e.target === document.getElementById('overlay')) closeModal();
}

async function saveItem() {
  if (currentRole !== 'admin') { toast('Admin access required.', 'error'); return; }
  const brand = document.getElementById('fBrand').value.trim();
  const model = document.getElementById('fModel').value.trim();
  if (!brand && !model) { toast('Brand or Model is required.', 'error'); return; }

  const category = document.getElementById('fCategory').value.trim() || 'Uncategorized';
  const qty = editId ? 1 : Math.min(500, Math.max(1, parseInt(document.getElementById('fQuantity').value, 10) || 1));

  const base = {
    category,
    location: document.getElementById('fLocation').value,
    status:   document.getElementById('fStatus').value,
    notes:    document.getElementById('fNotes').value.trim(),
  };

  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  showLoading(true);

  try {
    if (editId) {
      // ── Single edit ──
      const existing = items.find(i => i.id === editId);
      if (!existing) { toast('Item not found. It may have been deleted.', 'error'); closeModal(); return; }
      const data = {
        ...base,
        brand,
        model,
        serial:    document.getElementById('fSerial').value.trim(),
        unique_id: (existing.unique_id && existing.category === category)
          ? existing.unique_id
          : generateUniqueId(category, editId),
      };
      await _supa.update(editId, data);
      toast('Item updated.', 'success');

    } else if (qty === 1) {
      // ── Single add ──
      const newItem = {
        ...base,
        brand,
        model,
        serial:    document.getElementById('fSerial').value.trim(),
        unique_id: generateUniqueId(category),
      };
      await _supa.insert(newItem);
      toast('Item added.', 'success');

    } else {
      // ── Batch add ──
      const newItems = [];
      for (let i = 1; i <= qty; i++) {
        newItems.push({
          ...base,
          brand,
          model:     model ? `${model} #${i}` : `#${i}`,
          serial:    '',
          unique_id: generateUniqueId(category),
        });
      }
      await _supa.insert(newItems);
      toast(`${qty} items added successfully.`, 'success');
    }

    closeModal();
    await loadItems();
  } catch (e) {
    console.error('[db] saveItem failed:', e);
    toast('Failed to save. Please try again.', 'error');
  } finally {
    saveBtn.disabled = false;
    showLoading(false);
  }
}

// ── DELETE ─────────────────────────────────
async function deleteItem(id) {
  if (currentRole !== 'admin') { toast('Admin access required.', 'error'); return; }
  if (!confirm('Delete this item?')) return;
  showLoading(true);
  try {
    await _supa.remove([id]);
    toast('Item deleted.', 'info');
    await loadItems();
  } catch (e) {
    console.error('[db] deleteItem failed:', e);
    toast('Failed to delete. Please try again.', 'error');
  } finally {
    showLoading(false);
  }
}

// ── EXPORT EXCEL ───────────────────────────
function exportExcel() {
  const source = lastFiltered.length > 0 ? lastFiltered : items;

  const q   = document.getElementById('searchInput').value.trim();
  const cat = document.getElementById('categoryFilter').value;
  const isFiltered = q || cat;

  const rows = source.map(item => ({
    'Unique ID':     item.unique_id || item.uniqueId || '',
    'Brand':         item.brand     || '',
    'Model':         item.model     || '',
    'Category':      item.category  || '',
    'Serial Number': item.serial    || '',
    'Location':      item.location  || '',
    'Status':        item.status    || '',
    'Notes':         item.notes     || '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 22 }, { wch: 20 }, { wch: 14 }, { wch: 28 },
  ];

  const wb   = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inventory');

  // Build filename — append filter context if active
  const date       = new Date().toISOString().slice(0, 10);
  const filterSlug = [
    cat ? cat.replace(/\s+/g, '_') : '',
    q   ? 'search-' + q.replace(/\s+/g, '_').slice(0, 20) : '',
  ].filter(Boolean).join('_');
  const filename = filterSlug
    ? `StockDesk_${filterSlug}_${date}.xlsx`
    : `StockDesk_Inventory_${date}.xlsx`;

  XLSX.writeFile(wb, filename);

  const note = isFiltered
    ? `Exported ${source.length} filtered item${source.length !== 1 ? 's' : ''} (${items.length} total).`
    : `Exported all ${source.length} item${source.length !== 1 ? 's' : ''}.`;
  toast(note, 'success');
}

// ── IMPORT EXCEL ───────────────────────────

// Column name → item field mapping (case-insensitive, trimmed)
const IMPORT_COL_MAP = {
  'unique id':     'uniqueId',
  'brand':         'brand',
  'model':         'model',
  'category':      'category',
  'serial number': 'serial',
  'serial':        'serial',
  'location':      'location',
  'status':        'status',
  'notes':         'notes',
};

/** Open hidden file input to pick an Excel file */
function triggerImport() {
  const input = document.getElementById('importFileInput');
  input.value = '';
  input.click();
}

/** Called when user picks a file */
function onImportFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (evt) {
    try {
      const wb      = XLSX.read(evt.target.result, { type: 'binary' });
      const ws      = wb.Sheets[wb.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(ws, { defval: '' });

      if (!rawRows.length) {
        toast('The Excel file appears to be empty.', 'error');
        return;
      }

      // Normalise column headers
      const parsed = rawRows.map((row, idx) => {
        const out = { _rowNum: idx + 2 }; // +2: 1-based + header row
        for (const [col, val] of Object.entries(row)) {
          const key = IMPORT_COL_MAP[col.trim().toLowerCase()];
          if (key) out[key] = String(val).trim();
        }
        return out;
      });

      // Validate + classify each row
      const preview = parsed.map(row => {
        const errors = [];
        if (!row.brand && !row.model) errors.push('Missing Brand and Model');

        // Duplicate detection by uniqueId or serial
        let dupType = null;
        if (row.uniqueId && items.find(i => (i.unique_id || i.uniqueId) === row.uniqueId)) dupType = 'uniqueId';
        else if (row.serial && items.find(i => i.serial === row.serial)) dupType = 'serial';

        return { ...row, _errors: errors, _dupType: dupType, _action: errors.length ? 'skip' : (dupType ? 'overwrite' : 'add') };
      });

      openImportPreview(preview);
    } catch (err) {
      console.error(err);
      toast('Could not read the Excel file. Make sure it is a valid .xlsx file.', 'error');
    }
  };
  reader.readAsBinaryString(file);
}

// ── IMPORT PREVIEW MODAL ───────────────────
let _importPreviewRows = [];

function openImportPreview(rows) {
  _importPreviewRows = rows;

  const addCount   = rows.filter(r => r._action === 'add').length;
  const dupCount   = rows.filter(r => r._action === 'overwrite').length;
  const skipCount  = rows.filter(r => r._action === 'skip').length;

  // Detect which columns are present
  const hasCols = {
    uniqueId: rows.some(r => r.uniqueId),
    brand:    rows.some(r => r.brand),
    model:    rows.some(r => r.model),
    category: rows.some(r => r.category),
    serial:   rows.some(r => r.serial),
    location: rows.some(r => r.location),
    notes:    rows.some(r => r.notes),
  };

  // Build column headers dynamically
  const colHeaders = ['#'];
  if (hasCols.brand)    colHeaders.push('Brand');
  if (hasCols.model)    colHeaders.push('Model');
  if (hasCols.uniqueId) colHeaders.push('Unique ID');
  if (hasCols.category) colHeaders.push('Category');
  if (hasCols.serial)   colHeaders.push('Serial');
  if (hasCols.location) colHeaders.push('Location');
  colHeaders.push('Status');

  const tableRows = rows.map((row, i) => {
    const statusHtml = row._errors.length
      ? `<span class="import-badge error" title="${row._errors.join(', ')}">⚠ Skip</span>`
      : row._dupType
        ? `<span class="import-badge warn">↺ Overwrite</span>`
        : `<span class="import-badge ok">+ Add</span>`;

    const cells = [`<td class="mono" style="color:var(--text-muted)">${row._rowNum}</td>`];
    if (hasCols.brand)    cells.push(`<td><strong>${row.brand    || '—'}</strong></td>`);
    if (hasCols.model)    cells.push(`<td>${row.model    || '—'}</td>`);
    if (hasCols.uniqueId) cells.push(`<td class="mono" style="color:var(--accent);font-size:11px">${row.uniqueId || '—'}</td>`);
    if (hasCols.category) cells.push(`<td>${row.category || '—'}</td>`);
    if (hasCols.serial)   cells.push(`<td class="mono">${row.serial   || '—'}</td>`);
    if (hasCols.location) cells.push(`<td>${row.location || '—'}</td>`);
    cells.push(`<td>${statusHtml}</td>`);

    const rowClass = row._errors.length ? 'import-row-error' : row._dupType ? 'import-row-warn' : '';
    return `<tr class="${rowClass}">${cells.join('')}</tr>`;
  }).join('');

  const modal = document.getElementById('importPreviewOverlay');
  document.getElementById('importPreviewSummary').innerHTML = `
    <span class="import-badge ok">+${addCount} new</span>
    ${dupCount  ? `<span class="import-badge warn">↺ ${dupCount} overwrite</span>` : ''}
    ${skipCount ? `<span class="import-badge error">⚠ ${skipCount} skip</span>`   : ''}
    <span style="color:var(--text-muted);font-size:12px;margin-left:4px;">from ${rows.length} row${rows.length !== 1 ? 's' : ''}</span>
  `;

  document.getElementById('importPreviewThead').innerHTML =
    '<tr>' + colHeaders.map(h => `<th>${h}</th>`).join('') + '</tr>';
  document.getElementById('importPreviewTbody').innerHTML = tableRows;

  // Overwrite toggle visibility
  document.getElementById('importOverwriteRow').style.display = dupCount ? '' : 'none';

  modal.classList.add('open');
}

function closeImportPreview() {
  document.getElementById('importPreviewOverlay').classList.remove('open');
}

function closeImportPreviewOutside(e) {
  if (e.target === document.getElementById('importPreviewOverlay')) closeImportPreview();
}

async function confirmImport() {
  const overwrite = document.getElementById('importOverwriteToggle').checked;
  const toInsert  = [];
  const toUpdate  = []; // { id, data }
  let skipped = 0;

  for (const row of _importPreviewRows) {
    if (row._errors.length) { skipped++; continue; }

    const category = row.category || 'Uncategorized';
    const incoming = { category };
    if (row.brand    !== undefined) incoming.brand     = row.brand;
    if (row.model    !== undefined) incoming.model     = row.model;
    if (row.uniqueId !== undefined) incoming.unique_id = row.uniqueId;
    if (row.serial   !== undefined) incoming.serial    = row.serial;
    if (row.location !== undefined) incoming.location  = row.location;
    if (row.status   !== undefined) incoming.status    = row.status;
    if (row.notes    !== undefined) incoming.notes     = row.notes;

    if (row._dupType) {
      if (!overwrite) { skipped++; continue; }
      let existing = null;
      if (row.uniqueId) existing = items.find(i => (i.unique_id || i.uniqueId) === row.uniqueId);
      if (!existing && row.serial) existing = items.find(i => i.serial === row.serial);
      if (existing) {
        if (!incoming.unique_id) incoming.unique_id = generateUniqueId(category, existing.id);
        toUpdate.push({ id: existing.id, data: incoming });
        continue;
      }
    }

    if (!incoming.unique_id) incoming.unique_id = generateUniqueId(category);
    toInsert.push({ brand: '', model: '', serial: '', location: '', notes: '', ...incoming });
  }

  // ── Chunk helper — avoids overwhelming Supabase with huge batches ──
  async function chunkInsert(rows, size = 50) {
    for (let i = 0; i < rows.length; i += size) {
      await _supa.insert(rows.slice(i, i + size));
    }
  }

  // ── Sequential updates — avoids 200+ parallel PATCH requests ──
  async function sequentialUpdate(updates, concurrency = 10) {
    for (let i = 0; i < updates.length; i += concurrency) {
      const batch = updates.slice(i, i + concurrency);
      await Promise.all(batch.map(({ id, data }) => _supa.update(id, data)));
    }
  }

  showLoading(true);

  // Show a progress toast for large imports
  if (toInsert.length + toUpdate.length > 50) {
    toast(`Importing ${toInsert.length + toUpdate.length} items — please wait…`, 'info');
  }

  try {
    if (toInsert.length) await chunkInsert(toInsert, 50);
    if (toUpdate.length) await sequentialUpdate(toUpdate, 10);
    closeImportPreview();
    await loadItems();
    toast(`Import done — ${toInsert.length} added, ${toUpdate.length} updated, ${skipped} skipped.`, 'success');
  } catch (e) {
    console.error('[db] confirmImport failed:', e);
    toast('Import failed. Please try again.', 'error');
  } finally {
    showLoading(false);
  }
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

// ── KEYBOARD SHORTCUTS ─────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
    closeImportPreview();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    openModal();
  }
});

// ── INIT ───────────────────────────────────
// Wrapped in DOMContentLoaded to guarantee the select elements exist before
// we append options — previously ran as a bare IIFE which could silently bail.
document.addEventListener('DOMContentLoaded', function () {

  // ── Auth guard — redirect to login if no valid session ──
  const session = AUTH.requireAuth();
  if (!session) return; // requireAuth() already redirected

  // Set global role for permission checks throughout the app
  currentRole = session.role || 'employee';

  // Show/hide admin-only header controls
  const isAdmin = currentRole === 'admin';
  ['btn-add-item','btn-import','btn-export'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isAdmin ? '' : 'none';
  });

  // Populate user chip in header
  const chipName = document.getElementById('userChipName');
  const chipRole = document.getElementById('userChipRole');
  if (chipName) chipName.textContent = session.display_name || session.username;
  if (chipRole) chipRole.textContent = session.role;

  // Populate Location dropdown
  const locSel = document.getElementById('fLocation');
  if (locSel) {
    LOCATION_OPTIONS.forEach(loc => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = loc;
      locSel.appendChild(opt);
    });
  }

  // Populate Status dropdown from STATUS_OPTIONS (single source of truth)
  const statSel = document.getElementById('fStatus');
  if (statSel) {
    while (statSel.options.length > 1) statSel.remove(1);
    STATUS_OPTIONS.forEach(s => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = s;
      statSel.appendChild(opt);
    });
  }

  // Hide employee-irrelevant UI elements
  if (currentRole !== 'admin') {
    // Hide select-all checkbox column header
    const selectAllTh = document.querySelector('th.col-check');
    if (selectAllTh) selectAllTh.style.visibility = 'hidden';
    // Hide bulk action bar entirely
    const bulkBar = document.getElementById('bulkBar');
    if (bulkBar) bulkBar.style.display = 'none';
    // Hide scan session button (employees can't add items)
    document.addEventListener('scannerReady', () => {
      const ssBtn = document.getElementById('startSessionBtn');
      if (ssBtn) ssBtn.style.display = 'none';
    });
  }

  loadItems();
  subscribeRealtime();
});