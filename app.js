/* ─────────────────────────────────────────
   StockDesk — app.js
   Core inventory logic: state, CRUD, render,
   sort, export, import, modal, toast, keyboard shortcuts
   ───────────────────────────────────────── */

// ── STATE ──────────────────────────────────
let items = JSON.parse(localStorage.getItem('stockdesk_items') || '[]');
let editId = null;
let sortField = 'name';
let sortAsc = true;
let selectedIds = new Set();
let currentRole = 'employee'; // set from session on init
let lastFiltered = []; // tracks the current filtered/sorted view for export


// Seed sample data on first load
if (items.length === 0) {
  items = [];
  save();
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
    .filter(i => i.uniqueId && i.uniqueId.startsWith(prefix) && i.id !== excludeId)
    .map(i => parseInt(i.uniqueId.replace(prefix, ''), 10))
    .filter(n => !isNaN(n));
  const next = existing.length > 0 ? existing.reduce((a, b) => Math.max(a, b), 0) + 1 : 1;
  return prefix + String(next).padStart(4, '0');
}

// ── HELPERS ────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function save() {
  localStorage.setItem('stockdesk_items', JSON.stringify(items));
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
                         || (item.uniqueId || '').toLowerCase().includes(q);
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
        <td class="mono" style="color:var(--accent);font-weight:500">${item.uniqueId || '—'}</td>
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
function bulkDelete() {
  if (currentRole !== 'admin') { toast('Admin access required.', 'error'); return; }
  const count = selectedIds.size;
  if (!count) return;
  if (!confirm(`Delete ${count} selected item${count > 1 ? 's' : ''}? This cannot be undone.`)) return;
  items = items.filter(i => !selectedIds.has(i.id));
  selectedIds.clear();
  save();
  renderTable();
  toast(`${count} item${count > 1 ? 's' : ''} deleted.`, 'info');
}

// ── BULK STATUS CHANGE ─────────────────────
function bulkChangeStatus() {
  if (currentRole !== 'admin') { toast('Admin access required.', 'error'); return; }
  const status = document.getElementById('bulkStatusSelect').value;
  if (!status) { toast('Please select a status to apply.', 'error'); return; }
  const count = selectedIds.size;
  if (!count) return;
  items.forEach(i => { if (selectedIds.has(i.id)) i.status = status; });
  save();
  renderTable();
  toast(`Status updated to "${status}" for ${count} item${count > 1 ? 's' : ''}.`, 'success');
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
  if (isEdit && item.uniqueId) {
    uniqueIdField.value = item.uniqueId;
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

function saveItem() {
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

  if (editId) {
    // ── Single edit ──
    const idx      = items.findIndex(i => i.id === editId);
    if (idx === -1) { toast('Item not found. It may have been deleted.', 'error'); closeModal(); return; }
    const existing = items[idx];
    const data     = {
      ...base,
      brand,
      model,
      serial:   document.getElementById('fSerial').value.trim(),
      uniqueId: (existing.uniqueId && existing.category === category)
        ? existing.uniqueId
        : generateUniqueId(category, editId),
    };
    items[idx] = { ...existing, ...data };
    toast('Item updated.', 'success');

  } else if (qty === 1) {
    // ── Single add ──
    items.push({
      id: uid(),
      ...base,
      brand,
      model,
      serial:   document.getElementById('fSerial').value.trim(),
      uniqueId: generateUniqueId(category),
    });
    toast('Item added.', 'success');

  } else {
    // ── Batch add ──
    const prefix = [brand, model].filter(Boolean).join(' ');
    for (let i = 1; i <= qty; i++) {
      items.push({
        id:       uid(),
        ...base,
        brand,
        model:    model ? `${model} #${i}` : `#${i}`,
        serial:   '',
        uniqueId: generateUniqueId(category),
      });
    }
    toast(`${qty} items added successfully.`, 'success');
  }

  save();
  closeModal();
  renderTable();
}

// ── DELETE ─────────────────────────────────
function deleteItem(id) {
  if (currentRole !== 'admin') { toast('Admin access required.', 'error'); return; }
  if (!confirm('Delete this item?')) return;
  items = items.filter(i => i.id !== id);
  save();
  renderTable();
  toast('Item deleted.', 'info');
}

// ── EXPORT EXCEL ───────────────────────────
function exportExcel() {
  const source = lastFiltered.length > 0 ? lastFiltered : items;

  const q   = document.getElementById('searchInput').value.trim();
  const cat = document.getElementById('categoryFilter').value;
  const isFiltered = q || cat;

  const rows = source.map(item => ({
    'Unique ID':     item.uniqueId || '',
    'Brand':         item.brand    || '',
    'Model':         item.model    || '',
    'Category':      item.category || '',
    'Serial Number': item.serial   || '',
    'Location':      item.location || '',
    'Status':        item.status   || '',
    'Notes':         item.notes    || '',
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
        if (row.uniqueId && items.find(i => i.uniqueId === row.uniqueId)) dupType = 'uniqueId';
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

function confirmImport() {
  const overwrite = document.getElementById('importOverwriteToggle').checked;
  let added = 0, updated = 0, skipped = 0;

  for (const row of _importPreviewRows) {
    if (row._errors.length) { skipped++; continue; }

    const category = row.category || 'Uncategorized';

    // Build item — only include fields that were present in the sheet
    const incoming = { category };
    if (row.brand    !== undefined) incoming.brand    = row.brand;
    if (row.model    !== undefined) incoming.model    = row.model;
    if (row.uniqueId !== undefined) incoming.uniqueId = row.uniqueId;
    if (row.serial   !== undefined) incoming.serial   = row.serial;
    if (row.location !== undefined) incoming.location = row.location;
    if (row.status   !== undefined) incoming.status   = row.status;
    if (row.notes    !== undefined) incoming.notes    = row.notes;

    if (row._dupType) {
      if (!overwrite) { skipped++; continue; }

      // Find the existing item to update
      let existing = null;
      if (row.uniqueId) existing = items.find(i => i.uniqueId === row.uniqueId);
      if (!existing && row.serial) existing = items.find(i => i.serial === row.serial);

      if (existing) {
        Object.assign(existing, incoming);
        if (!row.uniqueId) existing.uniqueId = generateUniqueId(category, existing.id);
        updated++;
        continue;
      }
    }

    // New item
    const newItem = {
      id:       uid(),
      brand:    '',
      model:    '',
      serial:   '',
      location: '',
      notes:    '',
      ...incoming,
    };
    if (!newItem.uniqueId) newItem.uniqueId = generateUniqueId(category);
    items.push(newItem);
    added++;
  }

  save();
  renderTable();
  closeImportPreview();
  toast(`Import done — ${added} added, ${updated} updated, ${skipped} skipped.`, 'success');
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

  renderTable();
});