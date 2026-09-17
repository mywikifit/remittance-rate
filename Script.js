/* ============================================================
   CONFIGURATION — replace these three values with your own.
   See README.md for exact step-by-step setup instructions.
   ============================================================ */

// 1. The Google Sheet that holds your CURRENT, LIVE rates.
//    Get the Sheet ID from its URL:
//    https://docs.google.com/spreadsheets/d/  >>>THIS PART<<<  /edit
const RATES_SHEET_ID   = '1oZNYx85udmr6_3nimU3LO9y7a0A5ss0yHK0N0e-mqqw';
const RATES_SHEET_TAB  = 'Rates'; // the exact tab name at the bottom of that sheet

// 2. The Apps Script Web App URL that receives user rate submissions
//    and logs them into your second ("Submissions") Google Sheet.
const SUBMIT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbx8m2XpWT5YRaN7gCtN9gcXyv29K8_OxGEX8tYeon234rClQmABFRPMxkvaBmyA4YA/exec';

// 3. How often to re-check the Rates sheet for updates (milliseconds).
const REFRESH_INTERVAL_MS = 45000; // 45 seconds

/* ============================================================
   You shouldn't need to edit anything below this line.
   ============================================================ */

const RATES_CSV_URL =
  `https://docs.google.com/spreadsheets/d/${RATES_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(RATES_SHEET_TAB)}`;

let currentRates = []; // cached parsed rows

document.addEventListener('DOMContentLoaded', function () {
  // Safety net: make sure the submission popup is never visible on page load.
  const overlayEl = document.getElementById('modalOverlay');
  if (overlayEl) overlayEl.hidden = true;

  loadRates();
  setInterval(loadRates, REFRESH_INTERVAL_MS);
  setupModal();
});

/* ---------------- Fetch + parse the live Rates sheet ---------------- */

function loadRates() {
  const bustCache = '&_=' + Date.now();

  fetch(RATES_CSV_URL + bustCache)
    .then(function (res) {
      if (!res.ok) throw new Error('Sheet fetch failed (' + res.status + ')');
      return res.text();
    })
    .then(function (csvText) {
      const rows = parseCSV(csvText);
      currentRates = buildRateObjects(rows);
      renderRates(currentRates);
      updateLiveRate(currentRates);
      setSyncNote('Live — synced just now', false);
    })
    .catch(function (err) {
      console.error(err);

      // If we've never managed to load anything, clear the spinner row so the
      // page doesn't sit on "Loading current rates…" forever.
      if (!currentRates.length) {
        const loadingRow = document.getElementById('loadingRow');
        if (loadingRow) loadingRow.remove();
        const emptyState = document.getElementById('emptyState');
        if (emptyState) emptyState.hidden = false;
      }

      const isFileProtocol = location.protocol === 'file:';
      setSyncNote(
        isFileProtocol
          ? 'Could not reach the rate sheet. Opening the page directly from your hard drive blocks this request — run it from a local web server instead (see notes).'
          : 'Could not reach the live rate sheet. Showing the last known rates.',
        true
      );
    });
}

function setSyncNote(text, isError) {
  const el = document.getElementById('syncNote');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? '#C0453A' : '';
}

/* Minimal CSV parser — handles quoted fields and commas inside quotes */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') { inQuotes = false; }
      else { field += char; }
    } else {
      if (char === '"') inQuotes = true;
      else if (char === ',') { row.push(field); field = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && next === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else { field += char; }
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows;
}

/* Turn raw CSV rows into { name, rate, updatedAt } objects, using the header row */
function buildRateObjects(rows) {
  if (!rows.length) return [];

  const header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
  const nameIdx    = header.findIndex(function (h) { return h.includes('center') || h.includes('centre') || h.includes('name'); });
  const rateIdx    = header.findIndex(function (h) { return h.includes('rate'); });
  const updatedIdx = header.findIndex(function (h) { return h.includes('updated'); });

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || nameIdx === -1) continue;

    const name = (r[nameIdx] || '').trim();
    if (!name) continue;

    const rawRate = (r[rateIdx] || '').trim();
    const rate = parseFloat(rawRate);
    const updatedRaw = updatedIdx > -1 ? (r[updatedIdx] || '').trim() : '';

    out.push({ name: name, rate: isNaN(rate) ? 0 : rate, updatedRaw: updatedRaw });
  }
  return out;
}

/* ---------------- Render the table ---------------- */

function renderRates(rates) {
  const list = document.getElementById('ratesList');
  const emptyState = document.getElementById('emptyState');

  // Hide any center with no rate / zero rate, then sort highest first
  const visible = rates
    .filter(function (r) { return r.rate && r.rate > 0; })
    .sort(function (a, b) { return b.rate - a.rate; });

  list.innerHTML = '';

  if (!visible.length) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  visible.forEach(function (r, index) {
    const row = document.createElement('div');
    row.className = 'rate-row';
    row.style.animationDelay = (index * 0.05) + 's';

    const rankClass = index === 0 ? 'top1' : index === 1 ? 'top2' : index === 2 ? 'top3' : '';

    row.innerHTML =
      '<span class="rank-badge ' + rankClass + '">' + (index + 1) + '</span>' +
      '<span class="center-name">' + escapeHTML(r.name) + '</span>' +
      '<span class="updated-at">' + relativeTime(r.updatedRaw) + '</span>' +
      '<span class="rate-value">' + r.rate.toFixed(2) + '</span>' +
      '<button class="update-btn" type="button">Update new rate</button>';

    // Store the exact centre name on the button itself — safer than building
    // it into the HTML string (handles names with quotes or apostrophes).
    const btn = row.querySelector('.update-btn');
    btn.dataset.center = r.name;
    btn.addEventListener('click', function () {
      openModal(r.name);
    });

    list.appendChild(row);
  });
}

function updateLiveRate(rates) {
  const visible = rates.filter(function (r) { return r.rate && r.rate > 0; });
  const liveEl = document.getElementById('liveRateValue');
  if (!visible.length) { liveEl.textContent = '—'; return; }
  const best = Math.max.apply(null, visible.map(function (r) { return r.rate; }));
  liveEl.textContent = '₹ ' + best.toFixed(2);
}

/* ---------------- Helpers ---------------- */

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function relativeTime(rawValue) {
  if (!rawValue) return '—';

  let date = new Date(rawValue.replace(' ', 'T'));
  if (isNaN(date.getTime())) date = new Date(rawValue);
  if (isNaN(date.getTime())) return rawValue; // fall back to showing raw text

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' hr ago';
  if (seconds < 604800) return Math.floor(seconds / 86400) + ' day' + (Math.floor(seconds / 86400) > 1 ? 's' : '') + ' ago';
  return date.toLocaleDateString();
}

/* ---------------- Submission modal ---------------- */

function setupModal() {
  const overlay      = document.getElementById('modalOverlay');
  const closeBtn      = document.getElementById('modalClose');
  const cancelBtn      = document.getElementById('modalCancel');
  const submitBtn      = document.getElementById('modalSubmit');
  const input          = document.getElementById('modalRateInput');
  const errorEl        = document.getElementById('modalError');
  const statusEl       = document.getElementById('modalStatus');
  const centerNameEl   = document.getElementById('modalCenterName');

  let activeCenter = '';

  overlay.hidden = true; // closed until a row's "Update new rate" is clicked

  window.openModal = function (centerName) {
    activeCenter = centerName || '';
    centerNameEl.textContent = activeCenter || 'this centre';
    input.value = '';
    errorEl.hidden = true;
    statusEl.textContent = '';
    statusEl.className = 'modal-status';
    submitBtn.disabled = false;
    overlay.hidden = false;
    setTimeout(function () { input.focus(); }, 50);
  };

  function closeModal() { overlay.hidden = true; }

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !overlay.hidden) closeModal(); });

  // Restrict typing to numbers and a single decimal point
  input.addEventListener('input', function () {
    let v = input.value.replace(/[^0-9.]/g, '');
    const parts = v.split('.');
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
    input.value = v;
  });

  // Wraps a promise with a hard timeout so the UI can NEVER hang forever,
  // regardless of what the network/browser does under the hood.
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        reject(new Error('timeout'));
      }, ms);
      promise.then(
        function (val) { clearTimeout(timer); resolve(val); },
        function (err) { clearTimeout(timer); reject(err); }
      );
    });
  }

  submitBtn.addEventListener('click', function () {
    const value = input.value.trim();
    const isValid = /^\d+(\.\d+)?$/.test(value) && parseFloat(value) > 0;

    if (!isValid) {
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    if (!SUBMIT_WEBAPP_URL || SUBMIT_WEBAPP_URL.indexOf('YOUR_') === 0) {
      statusEl.textContent = 'Submission endpoint is not configured yet.';
      statusEl.className = 'modal-status error';
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = 'Submitting\u2026';
    statusEl.className = 'modal-status';

    const payload = new URLSearchParams();
    payload.append('center', activeCenter);
    payload.append('rate', value);
    payload.append('submittedAt', new Date().toISOString());

    // IMPORTANT: mode 'no-cors' — Apps Script Web Apps frequently don't
    // return browser-readable cross-origin headers on their final response
    // (they redirect internally to script.googleusercontent.com). Trying to
    // read that response can hang the request indefinitely in some
    // browsers. With 'no-cors' the browser fires the request and doesn't
    // wait to inspect the response body/headers, so it resolves promptly —
    // and a hard timeout below guarantees the UI never gets stuck either way.
    const submitPromise = fetch(SUBMIT_WEBAPP_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload.toString()
    });

    withTimeout(submitPromise, 10000)
      .then(function () {
        statusEl.textContent = 'Thank you! Your rate suggestion has been recorded.';
        statusEl.className = 'modal-status success';
        setTimeout(closeModal, 1600);
      })
      .catch(function (err) {
        if (err && err.message === 'timeout') {
          statusEl.textContent = 'This is taking longer than expected — your submission was likely still sent. Please check your Submissions sheet.';
        } else {
          statusEl.textContent = 'Could not submit right now. Please try again shortly.';
        }
        statusEl.className = 'modal-status error';
        submitBtn.disabled = false;
      });
  });
}
