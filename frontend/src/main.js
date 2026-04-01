// src/main.js  —  Application entry point (Modular Version)
import * as THREE from 'three';
import { initThreeJS } from './core/SceneInit.js';
import { EntityManager } from './managers/EntityManager.js';
import { InputManager } from './core/InputManager.js';
import { UIManager } from './ui/UIManager.js';
import { state } from './state.js';
import {
  fetchWallData, fetchWindowData, fetchDoorData,
  fetchImageList, setCurrentImage, clearCache, fetch2DMasks
} from './services/floorPlanApi.js';
import { fetchMaterialAnalysis } from './services/materialApi.js';
import { setStatus, setError } from './ui/StatusUI.js';
import { initStructuralUI, renderOverview, openPanel } from './ui/StructuralPanel.js';
import { createDoor } from './builders/DoorBuilder.js';

// ═══════════════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

const container = document.getElementById('canvas-container');
const {
  scene, renderer, camera, orbitControls,
  wallsGroup, windowsGroup, gatesGroup, transformControl
} = initThreeJS(container);

const ui = {
  ...UIManager,
  setStatus,
  setError
};

const entityManager = new EntityManager(scene, wallsGroup, windowsGroup, gatesGroup, state, ui);
const inputManager = new InputManager(scene, camera, renderer, orbitControls, transformControl, { wallsGroup, windowsGroup, gatesGroup }, state, entityManager, ui);

const clock = new THREE.Clock();

// ═══════════════════════════════════════════════════════════════════
//  ANIMATION LOOP
// ═══════════════════════════════════════════════════════════════════

renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  inputManager.update(delta);
  
  state.doors.forEach(d => {
    if (d.door && typeof d.door.update === 'function') {
      d.door.update();
    }
  });
  renderer.render(scene, camera);
});

// ═══════════════════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════════════════

function clearScene() {
  state.walls.forEach(w => w.meshes.forEach(m => wallsGroup.remove(m)));
  state.windows.forEach(wi => windowsGroup.remove(wi.group));
  state.doors.forEach(d => {
    if (d.door && d.door.dispose) d.door.dispose();
    if (d.gateMesh) gatesGroup.remove(d.gateMesh);
  });
  while (wallsGroup.children.length) wallsGroup.remove(wallsGroup.children[0]);
  while (windowsGroup.children.length) windowsGroup.remove(windowsGroup.children[0]);
  while (gatesGroup.children.length) gatesGroup.remove(gatesGroup.children[0]);

  state.walls = []; state.windows = []; state.doors = [];
  state.wallIdCounter = 0; state.winIdCounter = 0; state.doorIdCounter = 0;
  state.selectedWin = null;
  inputManager.deselectObject(true);
  ui.refreshWallList(state.walls, (id) => entityManager.removeWall(id));
  ui.refreshWindowList(state, (id) => entityManager.removeWindow(id), (id) => selectWindow(id));
  ui.refreshDoorList(state, (id) => entityManager.removeDoor(id));
  ui.refreshAllSelects(state.walls);
  ui.updateStats(state);
}

function selectWindow(id) {
  state.selectedWin = id === null ? null : state.windows.find(w => w.id === id) || null;
  const sec = document.getElementById('sel-section');
  if (!state.selectedWin) { if (sec) sec.style.display = 'none'; ui.refreshWindowList(state, (id) => entityManager.removeWindow(id), (id) => selectWindow(id)); return; }
  if (sec) sec.style.display = '';
  document.getElementById('sel-pos').value   = state.selectedWin.posT;
  document.getElementById('sel-width').value = state.selectedWin.winWidth;
  document.getElementById('sel-height').value= state.selectedWin.winHeight;
  document.getElementById('sel-sill').value  = state.selectedWin.sillHeight;
  ui.refreshWindowList(state, (id) => entityManager.removeWindow(id), (id) => selectWindow(id));
}

async function loadFloorPlan(imageName) {
  ui.showLoading(`Analysing ${imageName}…`);
  clearScene();
  clearCache();
  setCurrentImage(imageName);

  try {
    const [wallData, windowData, doorData] = await Promise.all([
      fetchWallData(imageName),
      fetchWindowData(imageName),
      fetchDoorData(imageName),
    ]);

    wallData.forEach(seg => entityManager.addWall(seg.start.x, seg.start.y, seg.end.x, seg.end.y));

    windowData.forEach(w => {
      const wall = state.walls[w.wallIndex - 1];
      if (wall) entityManager.addWindow(wall.id, w.posT, w.winWidth, w.winHeight, w.sillHeight);
    });

    doorData.forEach(d => {
      const id = ++state.doorIdCounter;
      if (d.hingeX !== undefined) {
        const mesh = entityManager.buildSimpleGate({ ...d }, id);
        const wallId = state.walls[d.wallIndex - 1]?.id;
        state.doors.push({ id, wallId: wallId ?? 0, posT: d.posT, doorWidth: d.doorWidth, doorHeight: d.doorHeight, gateMesh: mesh, door: null });
        if (wallId) entityManager.refreshWallGeometry(wallId);
      } else {
        const wall = state.walls[d.wallIndex - 1];
        if (!wall) return;
        const door = createDoor(scene, wall, { posT: d.posT, doorWidth: d.doorWidth, doorHeight: d.doorHeight, swingDir: d.swingDir ?? 1, label: `Gate ${id}` });
        if (door.frameGroup) { scene.remove(door.frameGroup); door.frameGroup.userData.layer = 'gate'; door.frameGroup.userData.gateId = id; gatesGroup.add(door.frameGroup); }
        if (door.doorRoot)   { scene.remove(door.doorRoot);   door.doorRoot.userData.layer   = 'gate'; door.doorRoot.userData.gateId   = id; gatesGroup.add(door.doorRoot);   }
        if (door.panelMesh)  { door.panelMesh.userData.layer = 'gate'; door.panelMesh.userData.gateId = id; }
        state.doors.push({ id, wallId: wall.id, posT: d.posT, doorWidth: d.doorWidth, doorHeight: d.doorHeight, door, gateMesh: null });
        entityManager.refreshWallGeometry(wall.id);
      }
    });

    ui.refreshDoorList(state, (id) => entityManager.removeDoor(id));
    autoFitCamera();
    ui.setStatus(`✓ ${imageName} · ${wallData.length} walls · ${windowData.length} windows · ${doorData.length} gates`);
    ui.updateStats(state);

    try {
      ui.showLoading('Running structural analysis…');
      const matResult = await fetchMaterialAnalysis();
      window._materialAnalysis = matResult;
      renderOverview(matResult, (elementId) => {
        const el = matResult.analysis.find(e => e.element_id === elementId);
        if (el) openPanel(el);
      });
      const ovStatus = document.getElementById('ov-status');
      if (ovStatus) ovStatus.textContent = `Ready · ${matResult.analysis.length} elements analysed`;
    } catch (matErr) {
      const ovStatus = document.getElementById('ov-status');
      if (ovStatus) ovStatus.textContent = 'Material analysis offline';
    }
  } catch (err) {
    ui.setError(`Backend error: ${err.message}`);
  } finally {
    ui.hideLoading();
    if (state.activeView === '2d') refresh2DMasks(imageName);
  }
}

function autoFitCamera() {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().expandByObject(wallsGroup);
  if (!box.isEmpty()) {
    const center = new THREE.Vector3(), size = new THREE.Vector3();
    box.getCenter(center); box.getSize(size);
    const dist = Math.max(size.x, size.z) * 1.4;
    camera.position.set(center.x + dist * 0.6, center.y + dist * 0.9, center.z + dist * 0.8);
    orbitControls.target.copy(center); orbitControls.update();
    
    let floor = scene.getObjectByName('customFloor');
    if (floor) { floor.geometry.dispose(); floor.material.dispose(); scene.remove(floor); }
    const padding = 2;
    floor = new THREE.Mesh(new THREE.BoxGeometry(size.x + padding * 2, 0.5, size.z + padding * 2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    floor.name = 'customFloor'; floor.position.set(center.x, -0.25, center.z); floor.receiveShadow = true;
    scene.add(floor);
  }
}

async function refresh2DMasks(imageName) {
  try {
    ui.showLoading('Fetching 2D Analysis Masks…');
    const masks = await fetch2DMasks(imageName);
    ['original', 'walls', 'gates', 'windows'].forEach(k => {
      const el = document.getElementById(`mask-${k}`);
      if (el) el.src = masks[k] || '';
    });
  } catch (err) {
    ui.setStatus(`Failed to load 2D masks: ${err.message}`);
  } finally { ui.hideLoading(); }
}

function switchView(mode) {
  state.activeView = mode;
  const is3D = mode === '3d';
  document.getElementById('view-3d-btn')?.classList.toggle('active', is3D);
  document.getElementById('view-2d-btn')?.classList.toggle('active', !is3D);
  document.getElementById('canvas-container').style.display = is3D ? 'block' : 'none';
  document.getElementById('2d-panel').style.display = is3D ? 'none' : 'block';
  if (!is3D) refresh2DMasks(document.getElementById('image-select')?.value || 'F3.png');
}

// ═══════════════════════════════════════════════════════════════════
//  WIRE BUTTONS
// ═══════════════════════════════════════════════════════════════════

function wireButtons() {
  document.getElementById('add-wall-btn')?.addEventListener('click', () => {
    const x1 = parseFloat(document.getElementById('wall-x1').value);
    const y1 = parseFloat(document.getElementById('wall-y1').value);
    const x2 = parseFloat(document.getElementById('wall-x2').value);
    const y2 = parseFloat(document.getElementById('wall-y2').value);
    entityManager.addWall(x1, y1, x2, y2);
  });
  document.getElementById('add-win-btn')?.addEventListener('click', () => {
    const wallId = parseInt(document.getElementById('win-wall-select').value);
    const posT = parseFloat(document.getElementById('win-pos').value);
    const winWidth = parseFloat(document.getElementById('win-width').value);
    const winHeight = parseFloat(document.getElementById('win-height').value);
    const sillH = parseFloat(document.getElementById('win-sill').value);
    entityManager.addWindow(wallId, posT, winWidth, winHeight, sillH);
  });
  document.getElementById('apply-size-btn')?.addEventListener('click', () => entityManager.applyWindowChanges());
  document.getElementById('delete-win-btn')?.addEventListener('click', () => { if (state.selectedWin) entityManager.removeWindow(state.selectedWin.id); });
  document.getElementById('add-door-btn')?.addEventListener('click', () => {
    const wallId = parseInt(document.getElementById('door-wall-select').value);
    const posT = parseFloat(document.getElementById('door-pos').value);
    const doorWidth = parseFloat(document.getElementById('door-width').value);
    const doorHeight = parseFloat(document.getElementById('door-height').value);
    entityManager.addDoor(wallId, posT, doorWidth, doorHeight);
  });

  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    const btn = document.getElementById('sidebar-toggle');
    if (btn) { btn.textContent = isCollapsed ? '▶' : '◀'; btn.style.left = isCollapsed ? '0px' : '272px'; }
  });

  document.getElementById('view-3d-btn')?.addEventListener('click', () => switchView('3d'));
  document.getElementById('view-2d-btn')?.addEventListener('click', () => switchView('2d'));
  document.getElementById('fly-mode-btn')?.addEventListener('click', (e) => inputManager.toggleFlyMode(e));

  document.getElementById('prop-color')?.addEventListener('input', (e) => {
    if (state.selectedObject) inputManager.applyToMeshes(state.selectedObject, m => m.material.color.set(e.target.value));
  });
  document.getElementById('prop-opacity')?.addEventListener('input', (e) => {
    if (!state.selectedObject) return;
    const val = parseFloat(e.target.value);
    const opacityVal = document.getElementById('opacity-val');
    if (opacityVal) opacityVal.textContent = val.toFixed(2);
    inputManager.applyToMeshes(state.selectedObject, m => { m.material.opacity = val; m.material.transparent = val < 1; m.material.needsUpdate = true; });
  });
  document.getElementById('prop-y')?.addEventListener('input', (e) => {
    if (state.selectedObject) state.selectedObject.position.y = parseFloat(e.target.value) || 0;
  });
  document.getElementById('props-close')?.addEventListener('click', () => inputManager.deselectObject());
  document.getElementById('props-delete-btn')?.addEventListener('click', () => inputManager.deleteSelected());

  const imageSelect = document.getElementById('image-select');
  imageSelect?.addEventListener('change', (e) => { if (e.target.value) loadFloorPlan(e.target.value); });
  document.getElementById('load-plan-btn')?.addEventListener('click', () => { if (imageSelect.value) loadFloorPlan(imageSelect.value); });
  
  document.getElementById('upload-btn')?.addEventListener('click', () => document.getElementById('upload-input')?.click());
  document.getElementById('upload-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const formData = new FormData(); formData.append('image', file);
    ui.showLoading('Uploading image...');
    try {
      const res = await fetch('http://localhost:5000/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.status === 'success') {
        const option = document.createElement('option'); option.value = data.image; option.textContent = data.image;
        imageSelect.appendChild(option); imageSelect.value = data.image;
        loadFloorPlan(data.image);
      } else alert('Upload failed: ' + data.message);
    } catch (err) { alert('Upload error: ' + err.message); }
    finally { e.target.value = ''; ui.hideLoading(); }
  });

  document.getElementById('wall-toggle')?.addEventListener('change', (e) => wallsGroup.visible = e.target.checked);
  document.getElementById('window-toggle')?.addEventListener('change', (e) => windowsGroup.visible = e.target.checked);
  document.getElementById('gate-toggle')?.addEventListener('change', (e) => gatesGroup.visible = e.target.checked);
  
  ['translate','rotate','scale'].forEach(m => {
    document.getElementById(`tf-${m}`)?.addEventListener('click', () => inputManager.setTransformMode(m));
    document.getElementById(`pp-${m}`)?.addEventListener('click', () => inputManager.setTransformMode(m));
  });
}

// ═══════════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════════

async function init() {
  initStructuralUI();
  ui.setStatus('Connecting to backend…');
  wireButtons();
  inputManager.setTransformMode('translate');

  const imageSelect = document.getElementById('image-select');
  if (imageSelect) {
    try {
      const images = await fetchImageList();
      images.forEach(name => {
        const opt = document.createElement('option'); opt.value = name;
        opt.textContent = name.replace('.png', '');
        imageSelect.appendChild(opt);
      });
    } catch (_) {}
  }
  const firstImage = (imageSelect && imageSelect.options.length > 0) ? imageSelect.options[0].value : (imageSelect?.value || 'F3.png');
  await loadFloorPlan(firstImage);
}

init();
