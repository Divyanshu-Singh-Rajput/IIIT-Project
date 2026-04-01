// src/ui/UIManager.js

export const UIManager = {
  refreshWallList(walls, removeWallFn) {
    const list = document.getElementById('wall-list');
    if (!list) return;
    list.innerHTML = '';
    walls.forEach(w => {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `<span>W${w.id} (${w.x1},${w.y1})→(${w.x2},${w.y2})</span>`;
      const del = document.createElement('button');
      del.className = 'del-btn'; del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); removeWallFn(w.id); };
      item.appendChild(del);
      list.appendChild(item);
    });
  },

  refreshAllSelects(walls) {
    ['win-wall-select', 'door-wall-select'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '';
      walls.forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.id;
        opt.textContent = `Wall W${w.id}`;
        sel.appendChild(opt);
      });
    });
  },

  refreshWindowList(state, removeWindowFn, selectWindowFn) {
    const list = document.getElementById('win-list');
    if (!list) return;
    list.innerHTML = '';
    state.windows.forEach(wd => {
      const item = document.createElement('div');
      item.className = 'list-item' + (state.selectedWin && state.selectedWin.id === wd.id ? ' active' : '');
      item.innerHTML = `<span>Win${wd.id} · W${wd.wallId} · ${wd.winWidth}×${wd.winHeight}</span>`;
      const del = document.createElement('button');
      del.className = 'del-btn'; del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); removeWindowFn(wd.id); };
      item.onclick = () => selectWindowFn(wd.id);
      item.appendChild(del);
      list.appendChild(item);
    });
  },

  refreshDoorList(state, removeDoorFn) {
    const list = document.getElementById('door-list');
    if (!list) return;
    list.innerHTML = '';
    state.doors.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'list-item';
      const icon = (entry.door && entry.door.isOpen) ? '🔓' : '🔒';
      const lbl = entry.door ? entry.door.label : `Gate ${entry.id}`;
      item.innerHTML = `<span>${icon} ${lbl}</span>`;
      const del = document.createElement('button');
      del.className = 'del-btn'; del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); removeDoorFn(entry.id); };
      if (entry.door && entry.door.toggle) {
        item.onclick = () => { entry.door.toggle(); this.refreshDoorList(state, removeDoorFn); };
      }
      item.appendChild(del);
      list.appendChild(item);
    });
  },

  updateStats(state) {
    const el = document.getElementById('stat-counts');
    if (el) el.textContent = `Walls: ${state.walls.length}  ·  Windows: ${state.windows.length}  ·  Doors/Gates: ${state.doors.length}`;
  },

  showLoading(msg = 'Analysing floor plan…') {
    const overlay = document.getElementById('loading-overlay');
    const text = document.getElementById('loading-text');
    if (overlay) overlay.style.display = 'flex';
    if (text) text.textContent = msg;
  },

  hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }
};
