'use strict';

// ── State ──────────────────────────────────────────────
let fileHandle = null;
let data = [];      // array of entry objects
let editIdx = null;    // null = add, number = edit
let deleteIdx = null;
let unsaved = false;

// ── Persistence (IndexedDB) ──────────────────────────
const DB_NAME = 'PromptDashboardDB';
const STORE_NAME = 'handles';
const KEY_NAME = 'lastHandle';
const CACHE_DATA_KEY = 'promptDashboardData';
const CACHED_NAME_KEY = 'promptDashboardFileName';

async function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveHandle(handle) {
    try {
        const db = await getDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, KEY_NAME);
    } catch (e) {
        console.warn('Failed to cache file handle:', e);
    }
}

async function getCachedHandle() {
    try {
        const db = await getDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(KEY_NAME);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch (e) {
        return null;
    }
}

async function verifyPermission(handle) {
    const options = { mode: 'readwrite' };
    if ((await handle.queryPermission(options)) === 'granted') return true;
    if ((await handle.requestPermission(options)) === 'granted') return true;
    return false;
}

// ── File System Access API ────────────────────────────
async function loadFileFromHandle(handle) {
    try {
        const file = await handle.getFile();
        const text = await file.text();
        fileHandle = handle;
        data = parseFile(text);

        // Persist to local cache
        localStorage.setItem(CACHE_DATA_KEY, JSON.stringify(data));
        localStorage.setItem(CACHED_NAME_KEY, handle.name);

        onFileLoaded(handle.name);
        await saveHandle(handle);
    } catch (e) {
        toast('Failed to load file: ' + e.message, true);
        console.error(e);
    }
}

async function openFile() {
    if (!window.showOpenFilePicker) {
        toast('Your browser does not support the File System Access API.\nUse Chrome or Edge.', true);
        return;
    }
    try {
        // 1. Try restoring from cache
        const cached = await getCachedHandle();
        if (cached) {
            if (await verifyPermission(cached)) {
                await loadFileFromHandle(cached);
                return;
            }
        }

        // 2. Otherwise/Fallback: Picker
        const [handle] = await window.showOpenFilePicker({
            types: [{ description: 'JavaScript File', accept: { 'text/javascript': ['.js'] } }],
        });
        await loadFileFromHandle(handle);
    } catch (e) {
        if (e.name !== 'AbortError') toast('Failed to open file: ' + e.message, true);
    }
}

async function saveFile() {
    if (!fileHandle) { toast('No file loaded', true); return; }
    try {
        const content = serialize(data);
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        setUnsaved(false);
        toast('File saved successfully!');
    } catch (e) {
        // Fallback: download
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
            downloadFallback();
        } else {
            toast('Save failed: ' + e.message, true);
        }
    }
}

function downloadFallback() {
    const content = serialize(data);
    const blob = new Blob([content], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileHandle ? fileHandle.name : 'data.js';
    a.click();
    URL.revokeObjectURL(url);
    toast('Direct write blocked — file downloaded instead.');
}

// ── Parse data.js ────────────────────────────────────
function parseFile(text) {
    try {
        // Execute the file content and return the galleryData variable
        const fn = new Function(text + '\n; return galleryData;');
        const result = fn();
        if (!Array.isArray(result)) throw new Error('galleryData is not an array');
        return result;
    } catch (e) {
        toast('Parse error: ' + e.message, true);
        console.error(e);
        return [];
    }
}

// ── Serialize back to JS ─────────────────────────────
function escTpl(s) {
    // Escape for use inside template literal
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
}

function escStr(s) {
    // Escape for use inside double-quoted string
    if (s === null || s === undefined) return '';
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function serializeEntry(item) {
    const p = [];
    p.push(`    id: ${item.id}`);
    p.push(`    prompt: \`${escTpl(item.prompt)}\``);
    p.push(`    imageUrl: "${escStr(item.imageUrl || '')}"`);

    if ('date' in item) {
        p.push(`    date: ${!item.date ? 'null' : `"${item.date}"`}`);
    }

    p.push(`    gender: "${item.gender || 'female'}"`);

    if (!item.source) {
        p.push(`    source: null`);
    } else {
        p.push(`    source: {\n      url: "${escStr(item.source.url || '')}"\n    }`);
    }

    if (item.position) {
        p.push(`    position: "${escStr(item.position)}"`);
    }

    return `  {\n${p.join(',\n')}\n  }`;
}

function serialize(arr) {
    const header = '// AI Prompt Gallery Data\n// Each object represents an AI-generated image with its prompt and metadata\n\nconst galleryData = [\n';
    return header + arr.map(serializeEntry).join(',\n') + '\n];\n';
}

// ── UI Setup ─────────────────────────────────────────
function onFileLoaded(name) {
    document.getElementById('fileStatus').innerHTML =
        `<strong class="status-name">${escHtml(name)}</strong>&ensp;<span class="status-meta">${data.length} entries loaded</span>`;
    document.getElementById('saveBtn').disabled = false;
    document.getElementById('addBtn').disabled = false;
    document.getElementById('landingScreen').classList.add('hidden');
    document.getElementById('gridWrapper').classList.remove('hidden');
    document.getElementById('toolbar').classList.remove('hidden');
    setUnsaved(false);
    renderTable();
    toast(`Loaded ${data.length} entries from ${name}`);
}

function setUnsaved(val) {
    unsaved = val;
    const btn = document.getElementById('saveBtn');
    if (val) {
        btn.textContent = 'Save \u25CF';
        btn.classList.add('unsaved');
    } else {
        btn.textContent = 'Save';
        btn.classList.remove('unsaved');
    }
}

// ── Table Render (Grid.js) ──────────────────────────
let grid = null;

function renderTable() {
    const q = (document.getElementById('searchInput').value || '').toLowerCase();
    const gender = document.getElementById('genderFilter').value;

    const filtered = data.slice().sort((a, b) => b.id - a.id).filter(item => {
        const matchG = !gender || item.gender === gender;
        const matchQ = !q
            || String(item.id).includes(q)
            || (item.prompt || '').toLowerCase().includes(q)
            || (item.gender || '').toLowerCase().includes(q)
            || (item.date || '').toLowerCase().includes(q)
            || (item.source && item.source.url && item.source.url.toLowerCase().includes(q));
        return matchG && matchQ;
    });

    document.getElementById('countBadge').textContent =
        filtered.length === data.length
            ? `${data.length} entries`
            : `${filtered.length} of ${data.length} entries`;

    const gridData = filtered.map(item => {
        const realIdx = data.indexOf(item);
        const promptPreview = (item.prompt || '').slice(0, 500) + ((item.prompt || '').length > 500 ? '\u2026' : '');
        const sourceText = item.source ? (item.source.url || '') : '';
        const posText = item.position || '';
        const posAttr = item.position ? `data-pos="${escHtml(item.position)}"` : '';

        return [
            item.id,
            gridjs.html(`
                ${item.imageUrl
                    ? `<img class="thumb" src="${escHtml(item.imageUrl)}" alt="" ${posAttr}
                       onerror="this.classList.add('thumb-error');this.nextElementSibling.classList.add('thumb-error-visible')">
                     <div class="thumb-placeholder thumb-fallback">No img</div>`
                    : `<div class="thumb-placeholder">No URL</div>`
                }
            `),
            gridjs.html(`<div class="cell-prompt" title="${escHtml(item.prompt || '')}">${escHtml(promptPreview)}</div>`),
            gridjs.html(`<span class="badge badge-${item.gender || 'female'}">${item.gender || ''}</span>`),
            gridjs.html(`<span class="cell-muted">${escHtml(item.date || '')}</span>`),
            gridjs.html(`<span class="cell-muted" title="${escHtml(sourceText)}">${escHtml(sourceText)}</span>`),
            gridjs.html(`<span class="cell-pos">${escHtml(posText)}</span>`),
            gridjs.html(`
                <div class="actions">
                  <button class="btn btn-edit" onclick="showEditModal(${realIdx})" title="Edit">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                  </button>
                  <button class="btn btn-del" onclick="showDeleteModal(${realIdx})" title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                  </button>
                </div>
            `)
        ];
    });

    if (!grid) {
        grid = new gridjs.Grid({
            columns: [
                { name: "ID", width: "70px" },
                { name: "Image", width: "170px", sort: false },
                { name: "Prompt", width: "400px", sort: false },
                { name: "Gender", width: "100px", sort: false },
                { name: "Date", width: "120px", sort: false },
                { name: "Source", width: "150px", sort: false },
                { name: "Position", width: "110px", sort: false },
                { name: "Actions", width: "100px", sort: false }
            ],
            data: gridData,
            sort: true,
            pagination: {
                limit: 25
            },
            className: {
                table: 'gridjs-table-custom'
            },
            style: {
                table: {
                    'width': '100%'
                }
            }
        }).render(document.getElementById("gridWrapper"));

        // Attach row click via DOM delegation after render
        attachRowClickListener();
    } else {
        grid.updateConfig({
            data: gridData
        }).forceRender();
        setTimeout(applyDataPos, 100);
    }
}

function attachRowClickListener() {
    // Use a short timeout to ensure Grid.js has finished rendering the DOM
    setTimeout(() => {
        const wrapper = document.getElementById('gridWrapper');
        if (!wrapper) return;

        wrapper.addEventListener('click', (e) => {
            // Ignore clicks on action buttons
            if (e.target.closest('.actions')) return;

            const tr = e.target.closest('tr.gridjs-tr');
            if (!tr) return;

            // Get the first cell's text (the ID) and look up the entry
            const idCell = tr.querySelector('td.gridjs-td');
            if (!idCell) return;

            const rowId = parseInt(idCell.textContent.trim(), 10);
            if (isNaN(rowId)) return;

            const idx = data.findIndex(item => item.id === rowId);
            if (idx !== -1) showEditModal(idx);
        });

        applyDataPos();
    }, 100);
}

function applyDataPos() {
    document.querySelectorAll('[data-pos]').forEach(el => {
        el.style.objectPosition = el.getAttribute('data-pos');
    });
}

// ── Add Modal ────────────────────────────────────────
function showAddModal() {
    editIdx = null;
    document.getElementById('modalTitle').textContent = 'Add New Entry';

    const maxId = data.reduce((m, x) => Math.max(m, x.id || 0), 0);
    document.getElementById('fId').value = maxId + 1;
    document.getElementById('fGender').value = 'female';
    document.getElementById('fDate').value = todayStr();
    document.getElementById('fSource').value = '';
    document.getElementById('fPosition').value = 'center';
    document.getElementById('fPosHelper').value = '';
    document.getElementById('fImageUrl').value = '';
    document.getElementById('fPrompt').value = '';
    updatePreview();
    document.getElementById('editOverlay').classList.remove('hidden');
    document.getElementById('fPrompt').focus();
}

// ── Edit Modal ───────────────────────────────────────
function showEditModal(idx) {
    editIdx = idx;
    const item = data[idx];
    document.getElementById('modalTitle').textContent = `Edit Entry #${item.id}`;

    document.getElementById('fId').value = item.id;
    document.getElementById('fGender').value = item.gender || 'female';
    document.getElementById('fDate').value = item.date || '';
    document.getElementById('fSource').value = item.source ? (item.source.url || '') : '';
    document.getElementById('fPosition').value = item.position || '';
    document.getElementById('fPosHelper').value = '';
    document.getElementById('fImageUrl').value = item.imageUrl || '';
    document.getElementById('fPrompt').value = item.prompt || '';
    updatePreview();
    document.getElementById('editOverlay').classList.remove('hidden');
}

function closeEdit() {
    document.getElementById('editOverlay').classList.add('hidden');
    editIdx = null;
}

function applyPosHelper() {
    const helper = document.getElementById('fPosHelper');
    if (helper.value) {
        document.getElementById('fPosition').value = helper.value;
        updatePreview();
    }
}

function updatePreview() {
    const url = document.getElementById('fImageUrl').value.trim();
    const pos = document.getElementById('fPosition').value.trim();
    const box = document.getElementById('imgPreviewBox');
    if (url) {
        box.innerHTML = '';
        const img = document.createElement('img');
        img.className = 'preview-img';
        img.alt = 'preview';
        img.src = url;
        if (pos) img.style.objectPosition = pos;
        img.onerror = () => {
            box.innerHTML = '<span class="placeholder preview-error">Failed to load image</span>';
        };
        box.appendChild(img);
    } else {
        box.innerHTML = '<span class="placeholder">Enter image URL above to preview</span>';
    }
}

function saveEntry() {
    const id = parseInt(document.getElementById('fId').value, 10);
    const prompt = document.getElementById('fPrompt').value.trim();
    const imageUrl = document.getElementById('fImageUrl').value.trim();
    const date = document.getElementById('fDate').value.trim();
    const gender = document.getElementById('fGender').value;
    const srcVal = document.getElementById('fSource').value.trim();
    const position = document.getElementById('fPosition').value.trim();

    if (!id || isNaN(id)) { toast('ID is required', true); return; }
    if (!prompt) { toast('Prompt text is required', true); return; }

    // Check duplicate ID
    const dupeIdx = data.findIndex(x => x.id === id);
    if (dupeIdx !== -1 && dupeIdx !== editIdx) {
        toast(`ID ${id} already exists (entry at row ${dupeIdx + 1})`, true);
        return;
    }

    const source = srcVal ? { url: srcVal } : null;

    const entry = { id, prompt, imageUrl, gender, source };

    if (editIdx !== null) {
        // Preserve 'date' field presence from original
        const orig = data[editIdx];
        if ('date' in orig || date) {
            entry.date = date || null;
        }
        if (position) entry.position = position;
        data[editIdx] = entry;
        toast(`Entry #${id} updated`);
    } else {
        // New entry: always include date field
        entry.date = date || null;
        if (position) entry.position = position;
        data.push(entry);
        data.sort((a, b) => a.id - b.id);
        toast(`Entry #${id} added`);
    }

    setUnsaved(true);
    localStorage.setItem(CACHE_DATA_KEY, JSON.stringify(data));
    closeEdit();
    renderTable();
    // Auto-save to the file
    saveFile();
}

// ── Delete ────────────────────────────────────────────
function showDeleteModal(idx) {
    deleteIdx = idx;
    const item = data[idx];
    document.getElementById('delEntryLabel').textContent = `#${item.id}`;
    // Show a snippet of the prompt
    const snippet = (item.prompt || '').slice(0, 60);
    document.getElementById('delEntryLabel').innerHTML =
        `<strong>#${item.id}</strong> &mdash; ${escHtml(snippet)}${snippet.length >= 60 ? '&hellip;' : ''}`;
    document.getElementById('deleteOverlay').classList.remove('hidden');
}

function closeDelete() {
    document.getElementById('deleteOverlay').classList.add('hidden');
    deleteIdx = null;
}

function confirmDelete() {
    if (deleteIdx === null) return;
    const id = data[deleteIdx].id;
    data.splice(deleteIdx, 1);
    setUnsaved(true);
    localStorage.setItem(CACHE_DATA_KEY, JSON.stringify(data));
    closeDelete();
    renderTable();
    toast(`Entry #${id} deleted`);
}

// ── Helpers ───────────────────────────────────────────
function overlayClick(e, id) {
    if (e.target.id === id) {
        if (id === 'editOverlay') closeEdit();
        if (id === 'deleteOverlay') closeDelete();
    }
}

function escHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

let toastTimer = null;
function toast(msg, isErr = false) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    clearTimeout(toastTimer);

    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    toastTimer = setTimeout(() => el.remove(), 3500);
}

// ── Keyboard shortcuts ────────────────────────────────
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeEdit(); closeDelete(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (!document.getElementById('saveBtn').disabled) saveFile();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n' && !document.getElementById('addBtn').disabled) {
        e.preventDefault();
        showAddModal();
    }
});

// Warn on close if unsaved
window.addEventListener('beforeunload', e => {
    if (unsaved) { e.preventDefault(); e.returnValue = ''; }
});

// ── Theme Management ──────────────────────────────────
function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    updateThemeUI(isDark);
}

function initTheme() {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = saved === 'dark' || (!saved && prefersDark);

    if (isDark) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
    updateThemeUI(isDark);
}

function updateThemeUI(isDark) {
    const sun = document.querySelector('.sun-icon');
    const moon = document.querySelector('.moon-icon');
    if (sun && moon) {
        sun.classList.toggle('hidden', !isDark);
        moon.classList.toggle('hidden', isDark);
    }
}

// Update UI and Auto-restore if cached file exists
window.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    // 1. Try loading raw data from LocalStorage first for instant UI
    const localData = localStorage.getItem(CACHE_DATA_KEY);
    const localName = localStorage.getItem(CACHED_NAME_KEY);

    if (localData) {
        try {
            data = JSON.parse(localData);
            if (Array.isArray(data)) {
                // Show UI immediately
                document.getElementById('landingScreen').classList.add('hidden');
                document.getElementById('gridWrapper').classList.remove('hidden');
                document.getElementById('toolbar').classList.remove('hidden');
                document.getElementById('addBtn').disabled = false;
                renderTable();

                const status = document.getElementById('fileStatus');
                const displayName = localName || 'cached repository';
                status.innerHTML = `Viewing: <strong class="status-name">${escHtml(displayName)}</strong> <span class="status-meta">(Disconnected)</span>`;
            }
        } catch (e) {
            console.warn('Failed to parse local cache:', e);
        }
    }

    // 2. Try restoring the actual file handle for saving
    const cached = await getCachedHandle();
    if (cached) {
        // Update the "Open" button to act as a "Restore Connection" button
        const headerBtn = document.querySelector('.btn-open');
        if (headerBtn) headerBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg> <span>Restore ${escHtml(cached.name)}</span>`;

        const bigBtn = document.querySelector('.open-big');
        if (bigBtn) {
            bigBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg> <span>Restore ${escHtml(cached.name)}</span>`;
        }

        // Auto-restore if permission already granted
        if ((await cached.queryPermission({ mode: 'readwrite' })) === 'granted') {
            await loadFileFromHandle(cached);
        } else if (localData) {
            // If we have local data but no file permission yet, update status to reflect we can "Restore Connection"
            const status = document.getElementById('fileStatus');
            status.innerHTML = `Viewing: <strong class="status-name">${escHtml(cached.name)}</strong> <span class="status-meta">(Click Restore to sync)</span>`;
        }
    }
});
