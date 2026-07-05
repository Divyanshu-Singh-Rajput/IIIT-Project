// src/ui/StructuralPanel.js
// Overview panel + Element Detail panel management.
// Extracted from 3DFloorGenerator/frontend/index.html

import { renderDetails, initChartPopup } from './MaterialCards.js';
import { setChatElement, initChatInputHandlers } from './ChatUI.js';

// ── DOM colour maps ───────────────────────────────────────────────────────────
const DOT_COLORS = {
  load_bearing_wall: 'var(--lb-col)',
  partition_wall:    'var(--pt-col)',
  slab:              'var(--sl-col)',
  column:            'var(--co-col)',
};

// ── Inject panel HTML into the page ──────────────────────────────────────────
/**
 * Call once at startup. Injects the overview panel and the detail panel
 * into document.body. Safe to call multiple times (idempotent).
 */
export function initStructuralUI() {
  if (document.getElementById('str-overview')) return; // already initialised

  // ── Overview panel ──────────────────────────────────────────────────────
  const overview = document.createElement('div');
  overview.id = 'str-overview';
  overview.innerHTML = `
    <div id="ov-header">
      <h2>Structural Intelligence</h2>
      <p>Material Analysis · Cost–Strength Tradeoff</p>
    </div>
    <div id="ov-tabs">
      <div class="ovtab active" data-tab="summary">Summary</div>
      <div class="ovtab" data-tab="elements">Elements</div>
      <div class="ovtab" data-tab="concerns">⚠ Issues</div>
    </div>
    <div id="ov-body">
      <div id="ov-tab-summary">
        <div id="ov-summary-grid">
          <div class="stat-card"><div class="num" id="s-total">—</div><div class="lbl">Total Elements</div></div>
          <div class="stat-card"><div class="num" id="s-lb">—</div><div class="lbl">Load-Bearing</div></div>
          <div class="stat-card"><div class="num" id="s-pt">—</div><div class="lbl">Partition Walls</div></div>
          <div class="stat-card"><div class="num" id="s-col">—</div><div class="lbl">Cols + Slabs</div></div>
        </div>
        <p id="ov-hint">Click any <strong>wall in the 3D view</strong> to open its material analysis and ask questions about it.</p>
      </div>
      <div id="ov-tab-elements" style="display:none"></div>
      <div id="ov-tab-concerns" style="display:none"></div>
    </div>
    <div id="ov-status">Loading…</div>`;
  document.body.appendChild(overview);

  // Tab clicks for overview
  overview.querySelectorAll('.ovtab').forEach((tab) => {
    tab.addEventListener('click', () => ovSwitch(tab.dataset.tab, tab));
  });

  // ── Detail panel ────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'str-panel';
  panel.innerHTML = `
    <div id="panel-header">
      <div>
        <div id="panel-el-id">—</div>
        <div id="panel-el-label">—</div>
        <div id="panel-el-meta">—</div>
      </div>
      <button id="panel-close">✕</button>
    </div>
    <div id="panel-tabs">
      <div class="ptab active" data-tab="details">Details</div>
      <div class="ptab" data-tab="chat">Ask AI</div>
    </div>
    <div id="panel-body">
      <div id="tab-details"></div>
      <div id="tab-chat" style="display:none">
        <div id="chat-messages"></div>
        <div id="chat-input-row">
          <textarea id="chat-input" placeholder="Ask about this element…"></textarea>
          <button id="chat-send">↑</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  // Panel tab clicks
  panel.querySelectorAll('.ptab').forEach((tab) => {
    tab.addEventListener('click', () => pSwitch(tab.dataset.tab));
  });

  // Close button
  document.getElementById('panel-close').addEventListener('click', closePanel);

  // Wire chat input handlers
  initChatInputHandlers();

  // Inject chart popup placeholder
  initChartPopup();
}

// ── openPanel ─────────────────────────────────────────────────────────────────
/**
 * Open the detail panel for a structural element.
 * @param {Object} el  Full element dict from fetchMaterialAnalysis().analysis
 */
export function openPanel(el) {
  window._currentEl = el; // kept for compat

  document.getElementById('panel-el-id').textContent   = el.element_id;
  document.getElementById('panel-el-label').textContent = el.room_label || el.element_type.replace(/_/g, ' ');
  document.getElementById('panel-el-meta').textContent  =
    `Span: ${el.span_m} m  ·  Area: ${el.area_m2} m²  ·  ${el.is_outer ? 'Outer Wall' : 'Interior'}`;

  renderDetails(el);
  setChatElement(el);

  pSwitch('details');

  document.getElementById('str-panel').classList.add('open');
  document.getElementById('str-overview').style.display = 'none';
}

// ── closePanel ────────────────────────────────────────────────────────────────
export function closePanel() {
  document.getElementById('str-panel').classList.remove('open');
  document.getElementById('str-overview').style.display = 'flex';
}

// ── renderOverview ────────────────────────────────────────────────────────────
/**
 * Populate the overview panel from the material analysis result.
 * @param {Object} result  Full JSON from fetchMaterialAnalysis()
 * @param {Function} onSelectEl  Callback: (elementId) => void  (used by main.js to highlight wall)
 */
export function renderOverview(result, onSelectEl) {
  const { summary, analysis } = result;

  document.getElementById('s-total').textContent = summary.total_elements;
  document.getElementById('s-lb').textContent    = summary.load_bearing_walls;
  document.getElementById('s-pt').textContent    = summary.partition_walls;
  document.getElementById('s-col').textContent   = summary.slabs + summary.columns;

  document.getElementById('ov-tab-elements').innerHTML = analysis
    .map(
      (el) => `
      <div class="ov-el-row" data-el-id="${el.element_id}">
        <div class="ov-el-dot" style="background:${DOT_COLORS[el.element_type] || '#fff'}"></div>
        <div class="ov-el-name">${el.element_id} — ${el.room_label || el.element_type.replace(/_/g, ' ')}</div>
        <div class="ov-el-meta">${el.span_m}m</div>
      </div>`
    )
    .join('');

  // Wire element row clicks
  document.querySelectorAll('.ov-el-row').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.elId;
      if (onSelectEl) onSelectEl(id);
    });
  });

  const concerns = analysis.flatMap((el) =>
    (el.concerns || []).map((c) => ({ id: el.element_id, label: el.room_label, concern: c }))
  );

  document.getElementById('ov-tab-concerns').innerHTML =
    concerns.length === 0
      ? '<p style="font-size:10px;color:var(--muted);margin-top:12px">No structural concerns detected.</p>'
      : concerns
          .map(
            (c) => `
          <div class="ov-concern">
            <strong>${c.id} — ${c.label}</strong>${c.concern}
          </div>`
          )
          .join('');

  document.getElementById('ov-status').textContent =
    `Ready · ${analysis.length} elements · ${concerns.length} concern(s)`;
}

// ── Tab switchers ─────────────────────────────────────────────────────────────
function pSwitch(name) {
  document.querySelectorAll('.ptab').forEach((t) => t.classList.remove('active'));
  const target = document.querySelector(`.ptab[data-tab="${name}"]`);
  if (target) target.classList.add('active');
  document.getElementById('tab-details').style.display = name === 'details' ? '' : 'none';
  document.getElementById('tab-chat').style.display    = name === 'chat'    ? 'flex' : 'none';
  if (name === 'chat') {
    setTimeout(() => document.getElementById('chat-messages').lastElementChild?.scrollIntoView(), 50);
    document.getElementById('chat-input')?.focus();
  }
}

function ovSwitch(name, tabEl) {
  document.querySelectorAll('.ovtab').forEach((t) => t.classList.remove('active'));
  if (tabEl) tabEl.classList.add('active');
  document.getElementById('ov-tab-summary').style.display  = name === 'summary'  ? '' : 'none';
  document.getElementById('ov-tab-elements').style.display = name === 'elements' ? '' : 'none';
  document.getElementById('ov-tab-concerns').style.display = name === 'concerns' ? '' : 'none';
}
