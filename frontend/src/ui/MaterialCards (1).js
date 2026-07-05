// src/ui/MaterialCards.js
// Material card rendering, pros/cons database, and radar chart popup.
// Extracted from 3DFloorGenerator/frontend/index.html

// ── Material Pros / Cons Database ────────────────────────────────────────────
export const MATERIAL_PROS_CONS = {
  'Reinforced Concrete (M25)': {
    pros: [
      'Extremely high compressive strength — ideal for load-bearing walls and slabs',
      'Excellent fire resistance, maintaining structural integrity up to 300°C',
      'Long service life (50–100 years) with minimal maintenance',
      'Versatile — can be cast into any shape or section',
      'Good sound insulation and thermal mass for energy efficiency',
    ],
    cons: [
      'High construction cost — both material and skilled labour',
      'Heavy self-weight increases foundation load and seismic forces',
      'Cracks if not properly cured or if rebar corrodes over time',
    ],
  },
  'Reinforced Concrete (M30)': {
    pros: [
      'Higher grade concrete offers superior compressive strength (30 MPa)',
      'Better durability in aggressive environments (coastal, chemical exposure)',
      'Reduced section sizes possible — saves floor area',
      'Lower permeability reduces rebar corrosion risk',
      'Preferred for high-rise and bridge-class structures',
    ],
    cons: [
      'More expensive mix design and stricter quality control required',
      'Requires proper curing regime — premature drying causes micro-cracks',
      'Heavier than alternative materials like steel or timber',
    ],
  },
  'AAC Block Wall': {
    pros: [
      'Lightweight — reduces dead load on structure by up to 50% vs brick',
      'Excellent thermal insulation — lowers HVAC energy consumption',
      'Fire resistant up to 4 hours (non-combustible material)',
      'Easy to cut and shape on-site — reduces construction waste',
      'Fast construction — large block size covers more area quickly',
    ],
    cons: [
      'Low compressive strength — not suitable for load-bearing use without frame',
      'Water absorption can weaken blocks if not properly plastered',
      'Requires specialised mortar (thin-bed) for proper bonding',
    ],
  },
  'Fly Ash Brick': {
    pros: [
      'Uses industrial waste (fly ash) — environmentally sustainable choice',
      'Uniform size and smooth surface reduces plaster thickness',
      'Good compressive strength (7–10 MPa) for partition walls',
      'Low water absorption compared to traditional clay bricks',
      'Cost-effective — typically 20–30% cheaper than red clay bricks',
    ],
    cons: [
      'Brittle — prone to chipping at corners during handling',
      'Requires skilled masonry for tight jointing',
      'Not suitable as a standalone load-bearing material for tall structures',
    ],
  },
  'Hollow Block (Concrete)': {
    pros: [
      'Hollow core provides natural insulation and reduces overall weight',
      'Fast to lay — large modules reduce construction time',
      'Good sound attenuation between rooms',
      'Cores can be filled with concrete/rebar for added strength',
      'Dimensionally accurate — reduces finishing time and plaster',
    ],
    cons: [
      'Lower solid section area reduces strength vs solid block',
      'Fragile face shells — care needed during transport and fixing',
      'Limited aesthetic appeal without surface treatment',
    ],
  },
  'Steel Frame (MS)': {
    pros: [
      'Highest strength-to-weight ratio among structural materials',
      'Factory prefabricated — rapid on-site erection',
      'Ductile behaviour under seismic loads — absorbs energy without collapse',
      'Recyclable — 90%+ of structural steel is recovered at end of life',
      'Precisely engineered — predictable and reliable structural performance',
    ],
    cons: [
      'Requires fireproofing coat — bare steel loses strength above 550°C',
      'Prone to corrosion without protective paint or galvanising',
      'High initial cost compared to concrete or masonry',
    ],
  },
  'Brick Masonry': {
    pros: [
      'Proven, time-tested material with centuries of structural performance',
      'Good compressive strength under vertical loads',
      'Excellent thermal mass — stabilises indoor temperature swings',
      'Naturally fire-resistant and non-combustible',
      'Widely available and well understood by local labour',
    ],
    cons: [
      'Heavy — significantly increases foundation and structural loads',
      'Poor tensile and shear strength — needs reinforcing in seismic zones',
      'Labour-intensive — slow construction speed',
    ],
  },
  'Precast Concrete Panel': {
    pros: [
      'Factory-controlled quality — superior surface finish and consistency',
      'Rapid installation — panels are crane-lifted into position',
      'High compressive strength and durability',
      'Reduces on-site formwork and wet work significantly',
      'Suitable for repetitive large-scale construction (apartments, warehouses)',
    ],
    cons: [
      'High initial transport and crane cost',
      'Requires precise structural connections — engineering-intensive',
      'Limited flexibility for design changes after manufacturing',
    ],
  },
};

const DEFAULT_PROS_CONS = {
  pros: [
    'Proven structural performance in standard construction conditions',
    'Cost-effective within its intended application range',
    'Compatible with conventional construction methods and local labour',
    'Acceptable thermal and acoustic performance for interior walls',
    'Readily available through standard supply chains',
  ],
  cons: [
    'Performance may vary based on mix quality or workmanship',
    'Check compatibility with local seismic and climate zone requirements',
    'Confirm fire rating requirements with structural engineer',
  ],
};

export function getProsCons(materialName) {
  if (!materialName) return DEFAULT_PROS_CONS;
  if (MATERIAL_PROS_CONS[materialName]) return MATERIAL_PROS_CONS[materialName];
  const key = Object.keys(MATERIAL_PROS_CONS).find(
    (k) =>
      materialName.toLowerCase().includes(k.toLowerCase()) ||
      k.toLowerCase().includes(materialName.toLowerCase())
  );
  return key ? MATERIAL_PROS_CONS[key] : DEFAULT_PROS_CONS;
}

// ── Label maps ────────────────────────────────────────────────────────────────
const STR_MAP = { Low: 1, Medium: 2, 'Medium–High': 2.5, High: 3, 'Very High': 4 };
const DUR_MAP = { Low: 1, Medium: 2, High: 3, 'Very High': 4 };
const CST_MAP = { Low: 1, 'Low–Medium': 1.5, Medium: 2, 'Medium–High': 2.5, High: 3 };

export const BADGE_CLASS = {
  load_bearing_wall: 'badge-lb',
  partition_wall: 'badge-pt',
  slab: 'badge-sl',
  column: 'badge-co',
};

const PPM = 41.0; // pixels per metre

// ── Chart popup state ─────────────────────────────────────────────────────────
let _chartInstance = null;
let _popupPinned = false;
const RANK_LABELS = ['Best Option', 'Option 2', 'Option 3'];

// ── renderDetails ─────────────────────────────────────────────────────────────
/**
 * Build the full inner HTML for the "Details" tab and inject it.
 * Also wires up the card hover/click interactions.
 * @param {Object} el  Full element dict from materialApi
 */
export function renderDetails(el) {
  const wp = el.weight_profile || {};
  const typeLabel = el.element_type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const badgeClass = BADGE_CLASS[el.element_type] || 'badge-pt';

  // Coordinates section
  let coordsHtml = '';
  if (el.start && el.end) {
    const { x: sx, y: sy } = el.start;
    const { x: ex, y: ey } = el.end;
    coordsHtml = `
      <div class="coords-section">
        <div class="coords-title">Wall Coordinates</div>
        <div class="coords-grid">
          <div class="coord-item"><div class="clbl">Start (px)</div><div class="cval">(${sx.toFixed(0)}, ${sy.toFixed(0)})</div></div>
          <div class="coord-item"><div class="clbl">End (px)</div><div class="cval">(${ex.toFixed(0)}, ${ey.toFixed(0)})</div></div>
          <div class="coord-item"><div class="clbl">Start (m)</div><div class="cval">(${(sx / PPM).toFixed(2)}, ${(sy / PPM).toFixed(2)})</div></div>
          <div class="coord-item"><div class="clbl">End (m)</div><div class="cval">(${(ex / PPM).toFixed(2)}, ${(ey / PPM).toFixed(2)})</div></div>
        </div>
      </div>`;
  }

  // Material option cards
  const optLabels = ['Best Option', 'Option 2', 'Option 3'];
  const recs = (el.recommendations || [])
    .slice(0, 3)
    .map(
      (r, i) => `
      <div class="mat-card rank-${i + 1}" data-mat-idx="${i}">
        <div class="mat-rank-stripe stripe-${i + 1}"></div>
        <div style="margin-left:8px;margin-bottom:4px">
          <span style="font-size:8px;text-transform:uppercase;letter-spacing:0.5px;color:${i === 0 ? 'var(--accent)' : 'var(--muted)'};font-family:'IBM Plex Mono',monospace">${optLabels[i]}</span>
          <span style="float:right;font-size:8px;color:var(--muted);font-family:'IBM Plex Mono',monospace">Click to expand ▾</span>
        </div>
        <div class="mat-top">
          <span class="mat-name">${r.material}</span>
          <span class="mat-score">${r.score.toFixed(3)}</span>
        </div>
        <div style="margin:6px 0 6px 8px;font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:var(--accent)">
          &#8377;${r.unit_cost_inr.toLocaleString()}<span style="font-size:9px;color:var(--muted);font-weight:400"> / m<sup>3</sup></span>
        </div>
        <div class="mat-tags">
          <span class="mat-tag">Cost: ${r.cost_label}</span>
          <span class="mat-tag">Str: ${r.strength_label}</span>
          <span class="mat-tag">Dur: ${r.durability_label}</span>
        </div>
        <div class="mat-note">${r.notes}</div>
        <div class="pros-cons-panel">
          <div class="pros-cons-divider"></div>
          <div class="pros-cons-title pros">✦ 5 Advantages</div>
          <ul class="pros-cons-list pros"></ul>
          <div class="pros-cons-title cons">✖ Disadvantages</div>
          <ul class="pros-cons-list cons"></ul>
        </div>
      </div>`
    )
    .join('');

  const concerns = (el.concerns || [])
    .map((c) => `<div class="concern-box"><strong>⚠ Structural Concern</strong>${c}</div>`)
    .join('');

  document.getElementById('tab-details').innerHTML = `
    <span class="type-badge ${badgeClass}">${typeLabel}</span>
    ${coordsHtml}
    <div class="mat-section-title" style="margin-bottom:6px">Scoring Weights</div>
    <div class="weights-row">
      <div class="w-chip w-str"><div class="wval">${wp.strength ?? '?'}</div><div class="wlbl">Strength</div></div>
      <div class="w-chip w-dur"><div class="wval">${wp.durability ?? '?'}</div><div class="wlbl">Durability</div></div>
      <div class="w-chip w-cst"><div class="wval">${wp.cost ?? '?'}</div><div class="wlbl">Cost</div></div>
    </div>
    <div class="mat-section-title">Material Options — Hover or Click to Compare</div>
    ${recs}
    ${concerns}
  `;

  bindMatCards(el.recommendations || []);
}

// ── Chart popup ───────────────────────────────────────────────────────────────

/** Inject the chart popup DOM once (idempotent). */
export function initChartPopup() {
  if (document.getElementById('chart-popup')) return;
  const popup = document.createElement('div');
  popup.id = 'chart-popup';
  popup.innerHTML = `
    <div id="chart-popup-inner">
      <div id="chart-popup-header">
        <div>
          <div id="chart-popup-title">—</div>
          <div id="chart-popup-sub">—</div>
        </div>
        <div id="chart-popup-rank-badge">—</div>
      </div>
      <canvas id="chart-popup-canvas" width="276" height="220"></canvas>
      <div class="chart-divider"></div>
      <div class="chart-stats-row">
        <div class="chart-stat cs-strength"><div class="cs-val" id="cp-str">—</div><div class="cs-lbl">Strength</div></div>
        <div class="chart-stat cs-durability"><div class="cs-val" id="cp-dur">—</div><div class="cs-lbl">Durability</div></div>
        <div class="chart-stat cs-cost"><div class="cs-val" id="cp-cst">—</div><div class="cs-lbl">Cost Effect.</div></div>
        <div class="chart-stat cs-score"><div class="cs-val" id="cp-score">—</div><div class="cs-lbl">Overall Score</div></div>
      </div>
    </div>`;
  document.body.appendChild(popup);
}

function showChartPopup(rec, cardEl, rankIndex) {
  const popup = document.getElementById('chart-popup');
  const str    = STR_MAP[rec.strength_label]   || 2;
  const dur    = DUR_MAP[rec.durability_label] || 2;
  const cstRaw = CST_MAP[rec.cost_label]       || 2;
  const cstEff = parseFloat(((4 - cstRaw) / 3 * 4).toFixed(2));
  const scoreN = parseFloat((rec.score * 4).toFixed(2));

  document.getElementById('chart-popup-title').textContent    = rec.material;
  document.getElementById('chart-popup-sub').textContent      = `₹${rec.unit_cost_inr.toLocaleString()}/m³  ·  Score ${rec.score.toFixed(3)}`;
  document.getElementById('chart-popup-rank-badge').textContent = RANK_LABELS[rankIndex] || `Option ${rankIndex + 1}`;
  document.getElementById('cp-str').textContent   = rec.strength_label;
  document.getElementById('cp-dur').textContent   = rec.durability_label;
  document.getElementById('cp-cst').textContent   = rec.cost_label;
  document.getElementById('cp-score').textContent = rec.score.toFixed(3);

  // Smart positioning: prefer left of panel, else right
  const panelRect = document.getElementById('str-panel').getBoundingClientRect();
  const pw = 320, ph = 420;
  let left = panelRect.left - pw - 16;
  if (left < 8) left = panelRect.right + 16;
  const cardRect = cardEl.getBoundingClientRect();
  let top = cardRect.top - 20;
  const vpH = window.innerHeight;
  if (top + ph > vpH) top = vpH - ph - 8;
  if (top < 8) top = 8;
  popup.style.left = left + 'px';
  popup.style.top  = top  + 'px';

  // Draw radar chart using Chart.js (loaded as global from CDN)
  const canvas = document.getElementById('chart-popup-canvas');
  if (_chartInstance) { _chartInstance.destroy(); _chartInstance = null; }
  const ctx = canvas.getContext('2d');

  const axisColors = ['#ff6b35', '#00d4aa', '#bf5af2', '#e8ff47'];

  const spokeColorPlugin = {
    id: 'spokeColors',
    afterDraw(chart) {
      const { ctx: c, scales: { r } } = chart;
      const cx = r.xCenter, cy = r.yCenter;
      axisColors.forEach((col, i) => {
        const angle = r.getIndexAngle(i) - Math.PI / 2;
        const x = cx + Math.cos(angle) * r.drawingArea;
        const y = cy + Math.sin(angle) * r.drawingArea;
        c.save();
        c.strokeStyle = col + '66';
        c.lineWidth = 1.5;
        c.setLineDash([3, 4]);
        c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y); c.stroke();
        c.restore();
      });
    },
  };

  _chartInstance = new Chart(ctx, {  // eslint-disable-line no-undef
    type: 'radar',
    plugins: [spokeColorPlugin],
    data: {
      labels: ['Strength', 'Durability', 'Value', 'Score'],
      datasets: [{
        data: [str, dur, cstEff, scoreN],
        backgroundColor: (ctx2) => {
          const { chart } = ctx2;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return 'rgba(232,255,71,0.08)';
          const grad = c.createRadialGradient(
            chart.scales.r.xCenter, chart.scales.r.yCenter, 0,
            chart.scales.r.xCenter, chart.scales.r.yCenter,
            chart.scales.r.drawingArea
          );
          grad.addColorStop(0,   'rgba(232,255,71,0.22)');
          grad.addColorStop(0.6, 'rgba(232,255,71,0.08)');
          grad.addColorStop(1,   'rgba(232,255,71,0.02)');
          return grad;
        },
        borderColor: 'rgba(232,255,71,0.9)',
        borderWidth: 2,
        pointBackgroundColor: axisColors,
        pointBorderColor: axisColors,
        pointBorderWidth: 2,
        pointRadius: 5,
        pointHoverRadius: 7,
        fill: true,
      }],
    },
    options: {
      animation: { duration: 450, easing: 'easeOutExpo' },
      responsive: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0d0f20',
          borderColor: 'rgba(232,255,71,0.35)',
          borderWidth: 1,
          titleColor: '#e8ff47',
          bodyColor: '#c8ccd8',
          padding: 10,
          callbacks: { label: (c3) => ` ${c3.parsed.r.toFixed(2)} / 4.00` },
        },
      },
      scales: {
        r: {
          min: 0, max: 4,
          ticks: { display: false, stepSize: 1 },
          grid: {
            color: (ctx4) => {
              const lvl = ctx4.tick?.value;
              return lvl === 4 ? 'rgba(232,255,71,0.18)' : 'rgba(255,255,255,0.05)';
            },
            lineWidth: (ctx5) => ctx5.tick?.value === 4 ? 1.5 : 1,
          },
          angleLines: { display: false },
          pointLabels: {
            color: (ctx6) => axisColors[ctx6.index] || '#7a8098',
            font: { family: "'IBM Plex Mono', monospace", size: 10, weight: '600' },
            padding: 6,
          },
        },
      },
    },
  });

  popup.classList.add('visible');
}

function hideChartPopup() {
  if (_popupPinned) return;
  document.getElementById('chart-popup').classList.remove('visible');
}

// ── bindMatCards ──────────────────────────────────────────────────────────────
/**
 * After renderDetails() injects cards into the DOM, call this to wire up
 * hover (radar chart) and click (pros/cons + pin chart) behaviours.
 * @param {Array} recs  el.recommendations array
 */
export function bindMatCards(recs) {
  setTimeout(() => {
    let lastPinnedIndex = -1;

    document.querySelectorAll('.mat-card').forEach((card, i) => {
      const rec = recs[i];
      if (!rec) return;

      // Populate pros/cons lists
      const pc = getProsCons(rec.material);
      const prosList = card.querySelector('.pros-cons-list.pros');
      const consList = card.querySelector('.pros-cons-list.cons');
      if (prosList) prosList.innerHTML = pc.pros.map((p) => `<li>${p}</li>`).join('');
      if (consList) consList.innerHTML = pc.cons.map((c) => `<li>${c}</li>`).join('');

      // Hover → show radar chart
      card.addEventListener('mouseenter', () => {
        if (!_popupPinned) showChartPopup(rec, card, i);
      });
      card.addEventListener('mouseleave', () => {
        if (!_popupPinned) hideChartPopup();
      });

      // Click → toggle inline pros/cons AND pin/unpin radar
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = card.querySelector('.pros-cons-panel');
        const isOpen = panel && panel.classList.contains('open');

        // Close all other cards
        document.querySelectorAll('.pros-cons-panel.open').forEach((p) => p.classList.remove('open'));
        document.querySelectorAll('.mat-card').forEach((c) => {
          const lbl = c.querySelector('[style*="float:right"]');
          if (lbl) lbl.textContent = 'Click to expand ▾';
        });

        if (isOpen) {
          _popupPinned = false;
          lastPinnedIndex = -1;
          hideChartPopup();
        } else {
          if (panel) panel.classList.add('open');
          const lbl = card.querySelector('[style*="float:right"]');
          if (lbl) lbl.textContent = 'Click to collapse ▴';
          _popupPinned = true;
          lastPinnedIndex = i;
          showChartPopup(rec, card, i);
        }
      });
    });

    // Click outside popup → unpin
    document.addEventListener('click', (e) => {
      const popup = document.getElementById('chart-popup');
      if (!popup) return;
      if (!popup.contains(e.target) && !e.target.closest('.mat-card')) {
        _popupPinned = false;
        lastPinnedIndex = -1;
        hideChartPopup();
        document.querySelectorAll('.pros-cons-panel.open').forEach((p) => p.classList.remove('open'));
        document.querySelectorAll('.mat-card').forEach((c) => {
          const lbl = c.querySelector('[style*="float:right"]');
          if (lbl) lbl.textContent = 'Click to expand ▾';
        });
      }
    }, { capture: true });
  }, 0);
}
