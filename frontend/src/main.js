// src/main.js  —  Application entry point
// Full feature set: TransformControls · Click-select · Properties panel · Delete · Layer toggles

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createScene } from './scene/SceneManager.js';
import { createRenderer } from './scene/RendererManager.js';
import { createCamera } from './scene/CameraManager.js';
import { setupLighting } from './scene/LightingManager.js';
import { createGround } from './scene/Ground.js';
import { setupResizeHandler } from './core/ResizeHandler.js';
import { rebuildWallWithOpenings } from './builders/WallBuilder.js';
import { createWindowOnWall } from './builders/WindowBuilder.js';
import { createDoor, createDoorFromGate } from './builders/DoorBuilder.js';
import {
  fetchWallData, fetchWindowData, fetchDoorData,
  fetchImageList, setCurrentImage, clearCache, fetch2DMasks
} from './services/floorPlanApi.js';
import { fetchMaterialAnalysis } from './services/materialApi.js';
import { setStatus, setError } from './ui/StatusUI.js';
import { initStructuralUI, renderOverview, openPanel } from './ui/StructuralPanel.js';
import { SCALE, WALL_HEIGHT, WALL_THICKNESS } from './config/constants.js';

// ═══════════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════════

let walls = [];    // { id, x1, y1, x2, y2, meshes: THREE.Mesh[] }
let windows = [];  // { id, wallId, posT, winWidth, winHeight, sillHeight, group }
let doors = [];    // { id, wallId, posT, doorWidth, doorHeight, door }
let wallIdCounter = 0, winIdCounter = 0, doorIdCounter = 0;
let selectedWin = null;
let _activeView = '3d'; // tracks '3d' | '2d' — used to auto-refresh masks on image change

// Selection state
let selectedObject = null; // currently selected THREE.Object3D

// ═══════════════════════════════════════════════════════════════════
//  SCENE BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════

const { scene } = createScene();
const container = document.getElementById('canvas-container');
const { renderer } = createRenderer(container);
// We create camera + orbit controls manually so we can also create TransformControls
const { camera, controls: orbitControls } = createCamera(renderer);

// ── Custom Fly Mode Setup ──
const clock = new THREE.Clock();
let isFlyMode = false;
let flyYaw = 0;
let flyPitch = 0;
const flyKeys = { w: false, a: false, s: false, d: false };

window.addEventListener('keydown', (e) => { if (e.key.length === 1) flyKeys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup',   (e) => { if (e.key.length === 1) flyKeys[e.key.toLowerCase()] = false; });

document.getElementById('fly-mode-btn')?.addEventListener('click', (e) => {
  isFlyMode = !isFlyMode;
  e.target.classList.toggle('active', isFlyMode);
  if (isFlyMode) {
    orbitControls.enabled = false;
    if (selectedObject) deselectObject();
    
    // Sync pitch/yaw to current camera orientation
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.setFromQuaternion(camera.quaternion);
    flyYaw = euler.y;
    flyPitch = euler.x;
    
    setStatus("✈ Fly Mode enabled: WASD to move, Click+Drag to look");
  } else {
    orbitControls.enabled = true;
    
    // Stop any leftover movement
    flyKeys.w = flyKeys.a = flyKeys.s = flyKeys.d = false;
    
    setStatus("🔄 Orbit Mode restored: Click/Drag to orbit, click objects to select");
  }
});

setupLighting(scene);
createGround(scene);
setupResizeHandler(camera, renderer, container);

// ── Scene groups for layer toggling ──
const wallsGroup    = new THREE.Group(); wallsGroup.name = 'walls';
const windowsGroup  = new THREE.Group(); windowsGroup.name = 'windows';
const gatesGroup    = new THREE.Group(); gatesGroup.name = 'gates';
scene.add(wallsGroup, windowsGroup, gatesGroup);

// ── TransformControls ──────────────────────────────────────────────
const transformControl = new TransformControls(camera, renderer.domElement);
transformControl.setMode('translate');
scene.add(transformControl);

// Prevent orbit during a gizmo drag
transformControl.addEventListener('dragging-changed', (e) => {
  if (!isFlyMode) orbitControls.enabled = !e.value;
  if (e.value) {
    document.body.classList.add('transform-active');
  } else {
    document.body.classList.remove('transform-active');
    // Sync properties panel after drag ends
    if (selectedObject) syncPropsToPanel(selectedObject);
  }
});

// Keep header transform buttons in sync when user switches mode via keyboard
transformControl.addEventListener('change', () => {
  updateTransformBtns(transformControl.getMode());
});

// ── Animation loop ──────────────────────────────────────────────────
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  
  if (isFlyMode) {
    // Custom WASD FPS movement
    const speed = 100 * delta;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    
    // Move forward/backward
    if (flyKeys.w) camera.position.addScaledVector(dir, speed);
    if (flyKeys.s) camera.position.addScaledVector(dir, -speed);
    
    // Move left/right (strafe)
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    if (flyKeys.d) camera.position.addScaledVector(right, speed);
    if (flyKeys.a) camera.position.addScaledVector(right, -speed);
    
  } else {
    orbitControls.update();
  }
  
  doors.forEach(d => {
    if (d.door && typeof d.door.update === 'function') {
      d.door.update();
    }
  });
  renderer.render(scene, camera);
});

// ═══════════════════════════════════════════════════════════════════
//  PROPERTIES PANEL
// ═══════════════════════════════════════════════════════════════════

function openPropsPanel(obj) {
  const panel = document.getElementById('props-panel');
  if (!panel) return;
  panel.classList.add('open');
  syncPropsToPanel(obj);
}

function closePropsPanel() {
  const panel = document.getElementById('props-panel');
  if (panel) panel.classList.remove('open');
}

function syncPropsToPanel(obj) {
  if (!obj) return;
  // Determine the "primary" mesh — if obj is a Group grab its first child
  const mesh = (obj.isMesh) ? obj : obj.children.find(c => c.isMesh);

  const typeEl = document.getElementById('props-type');
  if (typeEl) {
    const lyr = obj.userData?.layer || 'object';
    typeEl.textContent = lyr.charAt(0).toUpperCase() + lyr.slice(1);
  }

  if (mesh && mesh.material) {
    const colorInput = document.getElementById('prop-color');
    if (colorInput) colorInput.value = '#' + mesh.material.color.getHexString();

    const opacityInput = document.getElementById('prop-opacity');
    const opacityVal = document.getElementById('opacity-val');
    const op = mesh.material.opacity ?? 1;
    if (opacityInput) opacityInput.value = op;
    if (opacityVal) opacityVal.textContent = op.toFixed(2);
  }

  const yInput = document.getElementById('prop-y');
  if (yInput) yInput.value = obj.position.y.toFixed(2);
}

// Wire props panel inputs (these update the currently selected object live)
document.getElementById('prop-color')?.addEventListener('input', (e) => {
  if (!selectedObject) return;
  applyToMeshes(selectedObject, m => m.material.color.set(e.target.value));
});

document.getElementById('prop-opacity')?.addEventListener('input', (e) => {
  if (!selectedObject) return;
  const val = parseFloat(e.target.value);
  const opacityVal = document.getElementById('opacity-val');
  if (opacityVal) opacityVal.textContent = val.toFixed(2);
  applyToMeshes(selectedObject, m => {
    m.material.opacity = val;
    m.material.transparent = val < 1;
    m.material.needsUpdate = true;
  });
});

document.getElementById('prop-y')?.addEventListener('input', (e) => {
  if (!selectedObject) return;
  selectedObject.position.y = parseFloat(e.target.value) || 0;
});

document.getElementById('props-close')?.addEventListener('click', () => {
  deselectObject();
});

document.getElementById('props-delete-btn')?.addEventListener('click', () => {
  deleteSelected();
});

/** Apply a function to each MeshStandardMaterial in a mesh or group */
function applyToMeshes(obj, fn) {
  if (obj.isMesh && obj.material) {
    // Clone material per-mesh so other meshes sharing it aren't affected
    if (!obj.userData.matOwned) {
      obj.material = obj.material.clone();
      obj.userData.matOwned = true;
    }
    fn(obj);
  }
  if (obj.isGroup) {
    obj.children.forEach(c => applyToMeshes(c, fn));
  }
}

// ── Transform mode buttons (header + props panel) ──
function setTransformMode(mode) {
  transformControl.setMode(mode);
  updateTransformBtns(mode);
}

function updateTransformBtns(mode) {
  // Header buttons
  ['translate','rotate','scale'].forEach(m => {
    document.getElementById(`tf-${m}`)?.classList.toggle('active', m === mode);
    document.getElementById(`pp-${m}`)?.classList.toggle('active', m === mode);
  });
}

document.getElementById('tf-translate')?.addEventListener('click', () => setTransformMode('translate'));
document.getElementById('tf-rotate')?.addEventListener('click',    () => setTransformMode('rotate'));
document.getElementById('tf-scale')?.addEventListener('click',     () => setTransformMode('scale'));
document.getElementById('pp-translate')?.addEventListener('click', () => setTransformMode('translate'));
document.getElementById('pp-rotate')?.addEventListener('click',    () => setTransformMode('rotate'));
document.getElementById('pp-scale')?.addEventListener('click',     () => setTransformMode('scale'));

// ── Keyboard shortcuts ──
window.addEventListener('keydown', (e) => {
  // Don't hijack if user is typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key) {
    case 'w': case 'W': if (!isFlyMode) setTransformMode('translate'); break;
    case 'e': case 'E': if (!isFlyMode) setTransformMode('rotate');    break;
    case 'r': case 'R': if (!isFlyMode) setTransformMode('scale');     break;
    case 'Delete':
    case 'Backspace': deleteSelected(); break;
    case 'Escape': deselectObject(); break;
  }
});

// ═══════════════════════════════════════════════════════════════════
//  SELECTION / DESELECTION
// ═══════════════════════════════════════════════════════════════════

function selectObject(obj) {
  // Walk up to the top-level "selectable" parent — a direct child of our groups
  const root = getSelectableRoot(obj);
  if (!root) return;

  if (selectedObject === root) return; // already selected

  deselectObject(/* silent */ true);
  selectedObject = root;

  // Highlight
  applyToMeshes(root, m => {
    if (m.material.emissive) m.material.emissive.setHex(0x222244);
  });

  transformControl.attach(root);
  openPropsPanel(root);
}

function deselectObject(silent = false) {
  if (selectedObject) {
    applyToMeshes(selectedObject, m => {
      if (m.material.emissive) m.material.emissive.setHex(0x000000);
    });
    transformControl.detach();
    selectedObject = null;
  }
  if (!silent) closePropsPanel();
}

/**
 * Walk up from a clicked object to find the direct child of one of our layer groups.
 * Returns null if the object isn't inside one of our groups.
 */
function getSelectableRoot(obj) {
  let cur = obj;
  while (cur && cur.parent) {
    if (cur.parent === wallsGroup || cur.parent === windowsGroup || cur.parent === gatesGroup) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Deletes the currently selected object from the scene AND from the data arrays.
 */
function deleteSelected() {
  if (!selectedObject) return;
  const obj = selectedObject;
  const layer = obj.userData.layer;

  deselectObject(true);
  closePropsPanel();

  if (layer === 'wall') {
    const wallId = obj.userData.wallId;
    const w = walls.find(w => w.id === wallId);
    if (w) removeWall(w.id);
  } else if (layer === 'window') {
    const winId = obj.userData.winId;
    if (winId !== undefined) removeWindow(winId);
    else {
      // Fallback: just remove from scene
      windowsGroup.remove(obj);
    }
  } else if (layer === 'gate') {
    const gateId = obj.userData.gateId;
    if (gateId !== undefined) removeDoor(gateId);
    else {
      gatesGroup.remove(obj);
    }
  } else {
    // Generic remove from whatever group it belongs to
    if (obj.parent) obj.parent.remove(obj);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  LAYER TOGGLES  (walls / windows / gates checkboxes in header)
// ═══════════════════════════════════════════════════════════════════

document.getElementById('wall-toggle')?.addEventListener('change', (e) => {
  wallsGroup.visible = e.target.checked;
});
document.getElementById('window-toggle')?.addEventListener('change', (e) => {
  windowsGroup.visible = e.target.checked;
});
document.getElementById('gate-toggle')?.addEventListener('change', (e) => {
  gatesGroup.visible = e.target.checked;
});

// ═══════════════════════════════════════════════════════════════════
//  RAYCASTER — click to select OR toggle doors
// ═══════════════════════════════════════════════════════════════════

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

renderer.domElement.addEventListener('pointerdown', () => { _mouseDown = true; _mouseHasMoved = false; });
renderer.domElement.addEventListener('pointermove', (e) => { 
  if (_mouseDown) {
    _mouseHasMoved = true;
    
    // ── Custom FPS view dragging in Fly Mode ──
    if (isFlyMode) {
      flyYaw -= e.movementX * 0.003;
      flyPitch -= e.movementY * 0.003;
      flyPitch = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, flyPitch));
      camera.quaternion.setFromEuler(new THREE.Euler(flyPitch, flyYaw, 0, 'YXZ'));
    }
  } 
});
let _mouseDown = false, _mouseHasMoved = false;

renderer.domElement.addEventListener('pointerup', (e) => {
  _mouseDown = false;
  
  if (isFlyMode) return; // Prevent object selection/clicking in Fly Mode
  if (_mouseHasMoved) return; // it was a drag, not a click

  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // ── 1. TransformControl gizmo takes priority ──────────────────────
  // If the transform gizmo is active, don't re-select
  if (transformControl.dragging) return;

  // ── 2. All objects in scene groups ───────────────────────────────
  const allObjects = [
    ...wallsGroup.children,
    ...windowsGroup.children,
    ...gatesGroup.children,
  ];

  const hits = raycaster.intersectObjects(allObjects, true);

  if (hits.length > 0) {
    const hitObj = hits[0].object;

    // ── 2a. Is it a door panel? Toggle open/close ──────────────────
    const panelMeshes = doors.filter(d => d.door).map(d => d.door.panelMesh);
    const isPanelHit  = panelMeshes.includes(hitObj);

    if (isPanelHit && selectedObject === null) {
      // Only toggle if nothing is selected (avoids accidental toggles while moving)
      const entry = doors.find(d => d.door && d.door.panelMesh === hitObj);
      if (entry) {
        entry.door.toggle();
        refreshDoorList();
        setStatus(entry.door.isOpen ? `🚪 ${entry.door.label} opened` : `🚪 ${entry.door.label} closed`);
        return;
      }
    }

    // ── 2b. Wall click → structural panel (no selection) ──────────
    const wallHit = wallsGroup.children.includes(hitObj) ||
      wallsGroup.children.some(g => g.children?.includes(hitObj));

    if (wallHit && window._materialAnalysis && selectedObject === null) {
      const wallId = hitObj.userData.wallId;
      const wall = walls.find(w => w.id === wallId);
      if (wall) {
        const { analysis } = window._materialAnalysis;
        const wallIdx = walls.indexOf(wall);
        const el = analysis[wallIdx] || analysis[0];
        if (el) openPanel(el);
      }
    }

    // ── 2c. Select the object ──────────────────────────────────────
    selectObject(hitObj);

  } else {
    // Clicked empty space → deselect
    deselectObject();
  }
});

// ═══════════════════════════════════════════════════════════════════
//  GATE / DOOR builder — simple aligned-box approach (like reference HTML)
// ═══════════════════════════════════════════════════════════════════

/**
 * Builds a simple closed-gate mesh (box aligned between hinge and strike)
 * and adds it to gatesGroup. Returns the mesh.
 *
 * This uses the same simple approach as the reference HTML:
 *   gateMesh.rotation.y = -Math.atan2(dz, dx)
 * instead of an animated pivot — purely for the backend-detected gates
 * that sit perfectly in the wall gap.
 */
function buildSimpleGate(gateData, gateId) {
  const hx = gateData.hingeX * SCALE;
  const hz = gateData.hingeY * SCALE;
  const sx = gateData.strikeX * SCALE;
  const sz = gateData.strikeY * SCALE;
  const dx = sx - hx, dz = sz - hz;
  const doorWidth = Math.sqrt(dx * dx + dz * dz);

  if (doorWidth < 0.1) return null;

  const geo = new THREE.BoxGeometry(doorWidth, WALL_HEIGHT * 0.95, WALL_THICKNESS * 0.8);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8B4513,
    roughness: 0.6,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(hx + dx / 2, (WALL_HEIGHT * 0.95) / 2, hz + dz / 2);
  mesh.rotation.y = -Math.atan2(dz, dx);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Tag for selection / deletion
  mesh.userData.layer  = 'gate';
  mesh.userData.gateId = gateId;

  gatesGroup.add(mesh);
  return mesh;
}

// ═══════════════════════════════════════════════════════════════════
//  OPENING HELPERS  (windows + doors both punch holes in walls)
// ═══════════════════════════════════════════════════════════════════

function openingsForWall(wallId) {
  const winOps = windows
    .filter(w => w.wallId === wallId)
    .map(w => ({ posT: w.posT, winWidth: w.winWidth, winHeight: w.winHeight, sillHeight: w.sillHeight }));

  const doorOps = doors
    .filter(d => d.wallId === wallId)
    .map(d => ({ posT: d.posT, winWidth: d.doorWidth, winHeight: d.doorHeight, sillHeight: 0 }));

  return [...winOps, ...doorOps];
}

function refreshWallGeometry(wallId) {
  const w = walls.find(w => w.id === wallId);
  if (!w) return;

  // Remove old meshes from wallsGroup
  w.meshes.forEach(m => wallsGroup.remove(m));

  // Rebuild
  const x1 = w.x1, y1 = w.y1, x2 = w.x2, y2 = w.y2;
  const newMeshes = rebuildWallWithOpenings(scene, { x1, y1, x2, y2 }, [], openingsForWall(wallId));
  // rebuildWallWithOpenings adds to scene — move to our group instead
  newMeshes.forEach(m => {
    scene.remove(m);
    m.userData.wallId = wallId;
    m.userData.layer  = 'wall';
    wallsGroup.add(m);
  });
  w.meshes = newMeshes;
}

// ═══════════════════════════════════════════════════════════════════
//  WALL CRUD
// ═══════════════════════════════════════════════════════════════════

function addWall(x1, y1, x2, y2) {
  if ([x1, y1, x2, y2].some(isNaN)) return null;
  const id = ++wallIdCounter;
  const wall = { id, x1, y1, x2, y2, meshes: [] };
  walls.push(wall);

  // Build initial solid wall meshes (no openings)
  const rawMeshes = rebuildWallWithOpenings(scene, wall, [], []);
  rawMeshes.forEach(m => {
    scene.remove(m);
    m.userData.wallId = id;
    m.userData.layer  = 'wall';
    wallsGroup.add(m);
  });
  wall.meshes = rawMeshes;

  refreshWallList();
  refreshAllSelects();
  updateStats();
  return wall;
}

function addWallFromInputs() {
  const x1 = parseFloat(document.getElementById('wall-x1').value);
  const y1 = parseFloat(document.getElementById('wall-y1').value);
  const x2 = parseFloat(document.getElementById('wall-x2').value);
  const y2 = parseFloat(document.getElementById('wall-y2').value);
  addWall(x1, y1, x2, y2);
}

function removeWall(id) {
  const w = walls.find(w => w.id === id);
  if (!w) return;
  w.meshes.forEach(m => wallsGroup.remove(m));
  walls = walls.filter(w => w.id !== id);
  windows.filter(wi => wi.wallId === id).forEach(wi => windowsGroup.remove(wi.group));
  windows = windows.filter(w => w.wallId !== id);
  doors.filter(d => d.wallId === id).forEach(d => {
    if (d.door.dispose) d.door.dispose();
    else if (d.gateMesh) gatesGroup.remove(d.gateMesh);
  });
  doors = doors.filter(d => d.wallId !== id);
  refreshWallList(); refreshAllSelects(); refreshWindowList(); refreshDoorList(); updateStats();
}

function refreshWallList() {
  const list = document.getElementById('wall-list');
  if (!list) return;
  list.innerHTML = '';
  walls.forEach(w => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<span>W${w.id} (${w.x1},${w.y1})→(${w.x2},${w.y2})</span>`;
    const del = document.createElement('button');
    del.className = 'del-btn'; del.textContent = '✕';
    del.onclick = (e) => { e.stopPropagation(); removeWall(w.id); };
    item.appendChild(del);
    list.appendChild(item);
  });
}

function refreshAllSelects() {
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
}

// ═══════════════════════════════════════════════════════════════════
//  WINDOW CRUD
// ═══════════════════════════════════════════════════════════════════

function addWindow(wallId, posT, winWidth, winHeight, sillHeight) {
  const wall = walls.find(w => w.id === wallId);
  if (!wall) return;
  const id = ++winIdCounter;
  const group = createWindowOnWall(scene, wall, { posT, winWidth, winHeight, sillHeight });
  // Move from scene to windowsGroup
  scene.remove(group);
  group.userData.layer = 'window';
  group.userData.winId = id;
  group.children.forEach(c => { c.userData.layer = 'window'; c.userData.winId = id; });
  windowsGroup.add(group);

  windows.push({ id, wallId, posT, winWidth, winHeight, sillHeight, group });
  refreshWallGeometry(wallId);
  refreshWindowList();
  updateStats();
  return id;
}

function addWindowFromInputs() {
  const wallId   = parseInt(document.getElementById('win-wall-select').value);
  const posT     = parseFloat(document.getElementById('win-pos').value);
  const winWidth = parseFloat(document.getElementById('win-width').value);
  const winHeight= parseFloat(document.getElementById('win-height').value);
  const sillH   = parseFloat(document.getElementById('win-sill').value);
  addWindow(wallId, posT, winWidth, winHeight, sillH);
}

function removeWindow(id) {
  const wd = windows.find(w => w.id === id);
  if (!wd) return;
  windowsGroup.remove(wd.group);
  windows = windows.filter(w => w.id !== id);
  refreshWallGeometry(wd.wallId);
  if (selectedWin && selectedWin.id === id) selectWindow(null);
  refreshWindowList();
  updateStats();
}

function refreshWindowList() {
  const list = document.getElementById('win-list');
  if (!list) return;
  list.innerHTML = '';
  windows.forEach(wd => {
    const item = document.createElement('div');
    item.className = 'list-item' + (selectedWin && selectedWin.id === wd.id ? ' active' : '');
    item.innerHTML = `<span>Win${wd.id} · W${wd.wallId} · ${wd.winWidth}×${wd.winHeight}</span>`;
    const del = document.createElement('button');
    del.className = 'del-btn'; del.textContent = '✕';
    del.onclick = (e) => { e.stopPropagation(); removeWindow(wd.id); };
    item.onclick = () => selectWindow(wd.id);
    item.appendChild(del);
    list.appendChild(item);
  });
}

function selectWindow(id) {
  selectedWin = id === null ? null : windows.find(w => w.id === id) || null;
  const sec = document.getElementById('sel-section');
  if (!selectedWin) { if (sec) sec.style.display = 'none'; refreshWindowList(); return; }
  if (sec) sec.style.display = '';
  document.getElementById('sel-pos').value   = selectedWin.posT;
  document.getElementById('sel-width').value = selectedWin.winWidth;
  document.getElementById('sel-height').value= selectedWin.winHeight;
  document.getElementById('sel-sill').value  = selectedWin.sillHeight;
  refreshWindowList();
}

function applyWindowChanges() {
  if (!selectedWin) return;
  const wd = selectedWin;
  windowsGroup.remove(wd.group);
  wd.posT      = parseFloat(document.getElementById('sel-pos').value);
  wd.winWidth  = parseFloat(document.getElementById('sel-width').value);
  wd.winHeight = parseFloat(document.getElementById('sel-height').value);
  wd.sillHeight= parseFloat(document.getElementById('sel-sill').value);
  const wall = walls.find(w => w.id === wd.wallId);
  const group = createWindowOnWall(scene, wall, {
    posT: wd.posT, winWidth: wd.winWidth, winHeight: wd.winHeight, sillHeight: wd.sillHeight,
  });
  scene.remove(group);
  group.userData.layer = 'window';
  group.userData.winId = wd.id;
  group.children.forEach(c => { c.userData.layer = 'window'; c.userData.winId = wd.id; });
  windowsGroup.add(group);
  wd.group = group;
  refreshWallGeometry(wd.wallId);
  refreshWindowList();
}

// ═══════════════════════════════════════════════════════════════════
//  DOOR / GATE CRUD
// ═══════════════════════════════════════════════════════════════════

function addDoor(wallId, posT, doorWidth, doorHeight) {
  const wall = walls.find(w => w.id === wallId);
  if (!wall) return;
  const id = ++doorIdCounter;
  const label = `Door ${id} (W${wallId})`;
  const door = createDoor(scene, wall, { posT, doorWidth, doorHeight, label });
  // Move door objects to gatesGroup
  if (door.frameGroup)  { scene.remove(door.frameGroup);  door.frameGroup.userData.layer = 'gate'; door.frameGroup.userData.gateId = id; gatesGroup.add(door.frameGroup); }
  if (door.doorRoot)    { scene.remove(door.doorRoot);    door.doorRoot.userData.layer   = 'gate'; door.doorRoot.userData.gateId   = id; gatesGroup.add(door.doorRoot); }
  // Tag panel mesh
  if (door.panelMesh) { door.panelMesh.userData.layer = 'gate'; door.panelMesh.userData.gateId = id; }

  doors.push({ id, wallId, posT, doorWidth, doorHeight, door });
  refreshWallGeometry(wallId);
  refreshDoorList();
  updateStats();
  return id;
}

function addDoorFromInputs() {
  const wallId    = parseInt(document.getElementById('door-wall-select').value);
  const posT      = parseFloat(document.getElementById('door-pos').value);
  const doorWidth = parseFloat(document.getElementById('door-width').value);
  const doorHeight= parseFloat(document.getElementById('door-height').value);
  addDoor(wallId, posT, doorWidth, doorHeight);
}

function removeDoor(id) {
  const entry = doors.find(d => d.id === id);
  if (!entry) return;

  if (entry.door && entry.door.dispose) {
    // Animated door — dispose removes from scene
    entry.door.dispose();
  }
  // If we stored a simple gateMesh (from buildSimpleGate):
  if (entry.gateMesh) gatesGroup.remove(entry.gateMesh);

  doors = doors.filter(d => d.id !== id);
  if (entry.wallId) refreshWallGeometry(entry.wallId);
  refreshDoorList();
  updateStats();
}

function refreshDoorList() {
  const list = document.getElementById('door-list');
  if (!list) return;
  list.innerHTML = '';
  doors.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'list-item';
    const icon = (entry.door && entry.door.isOpen) ? '🔓' : '🔒';
    const lbl  = entry.door  ? entry.door.label : `Gate ${entry.id}`;
    item.innerHTML = `<span>${icon} ${lbl}</span>`;
    const del = document.createElement('button');
    del.className = 'del-btn'; del.textContent = '✕';
    del.onclick = (e) => { e.stopPropagation(); removeDoor(entry.id); };
    if (entry.door && entry.door.toggle) {
      item.onclick = () => { entry.door.toggle(); refreshDoorList(); };
    }
    item.appendChild(del);
    list.appendChild(item);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════════════

function updateStats() {
  const el = document.getElementById('stat-counts');
  if (el) el.textContent = `Walls: ${walls.length}  ·  Windows: ${windows.length}  ·  Doors/Gates: ${doors.length}`;
}

// ═══════════════════════════════════════════════════════════════════
//  CLEAR SCENE
// ═══════════════════════════════════════════════════════════════════

function clearScene() {
  walls.forEach(w => w.meshes.forEach(m => wallsGroup.remove(m)));
  windows.forEach(wi => windowsGroup.remove(wi.group));
  doors.forEach(d => {
    if (d.door && d.door.dispose) d.door.dispose();
    if (d.gateMesh) gatesGroup.remove(d.gateMesh);
  });
  // Clear all remaining children from groups
  while (wallsGroup.children.length) wallsGroup.remove(wallsGroup.children[0]);
  while (windowsGroup.children.length) windowsGroup.remove(windowsGroup.children[0]);
  while (gatesGroup.children.length) gatesGroup.remove(gatesGroup.children[0]);

  walls = []; windows = []; doors = [];
  wallIdCounter = 0; winIdCounter = 0; doorIdCounter = 0;
  selectedWin = null;
  deselectObject(true);
  closePropsPanel();
  refreshWallList(); refreshWindowList(); refreshDoorList(); refreshAllSelects();
  updateStats();
}

// ═══════════════════════════════════════════════════════════════════
//  LOADING OVERLAY
// ═══════════════════════════════════════════════════════════════════

function showLoading(msg = 'Analysing floor plan…') {
  const overlay = document.getElementById('loading-overlay');
  const text    = document.getElementById('loading-text');
  if (overlay) overlay.style.display = 'flex';
  if (text) text.textContent = msg;
}

function hideLoading() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════
//  WIRE UI BUTTONS
// ═══════════════════════════════════════════════════════════════════

function wireButtons() {
  document.getElementById('add-wall-btn')?.addEventListener('click', addWallFromInputs);
  document.getElementById('add-win-btn')?.addEventListener('click', addWindowFromInputs);
  document.getElementById('apply-size-btn')?.addEventListener('click', applyWindowChanges);
  document.getElementById('delete-win-btn')?.addEventListener('click', () => { if (selectedWin) removeWindow(selectedWin.id); });
  document.getElementById('add-door-btn')?.addEventListener('click', addDoorFromInputs);

  // Sidebar toggle
  const sidebarToggleBtn = document.getElementById('sidebar-toggle');
  sidebarToggleBtn?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    if (sidebarToggleBtn) {
      sidebarToggleBtn.textContent = isCollapsed ? '▶' : '◀';
      sidebarToggleBtn.style.left = isCollapsed ? '0px' : '272px';
    }
  });

  // View toggles (3D / 2D)
  document.getElementById('view-3d-btn')?.addEventListener('click', () => switchView('3d'));
  document.getElementById('view-2d-btn')?.addEventListener('click', () => switchView('2d'));

  // Image picker
  const imageSelect = document.getElementById('image-select');
  imageSelect?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val) loadFloorPlan(val);
  });
  
  document.getElementById('load-plan-btn')?.addEventListener('click', () => {
    const val = imageSelect.value;
    if (val) loadFloorPlan(val);
  });
}

// ─── 2D mask refresh helper ───────────────────────────────────────────────────
/**
 * Fetches and displays 2D analysis masks for the given image name.
 * Called both by switchView('2d') and by loadFloorPlan when already in 2D mode.
 */
async function refresh2DMasks(imageName) {
  try {
    showLoading('Fetching 2D Analysis Masks…');
    const masks = await fetch2DMasks(imageName);

    const setMask = (id, src) => {
      const el = document.getElementById(id);
      if (el) el.src = src || '';
    };

    setMask('mask-original', masks.original);
    setMask('mask-walls',    masks.walls);
    setMask('mask-gates',    masks.gates);
    setMask('mask-windows',  masks.windows);
  } catch (err) {
    console.error('[2DView] Failed to load masks:', err);
    setStatus(`Failed to load 2D masks: ${err.message}`);
  } finally {
    hideLoading();
  }
}

/**
 * Switch between 3D viewport and 2D masks panel.
 */
async function switchView(mode) {
  const btn3d = document.getElementById('view-3d-btn');
  const btn2d = document.getElementById('view-2d-btn');
  const canvas = document.getElementById('canvas-container');
  const panel2d = document.getElementById('2d-panel');

  _activeView = mode;

  if (mode === '3d') {
    btn3d?.classList.add('active');
    btn2d?.classList.remove('active');
    canvas.style.display = 'block';
    panel2d.style.display = 'none';
  } else {
    btn3d?.classList.remove('active');
    btn2d?.classList.add('active');
    canvas.style.display = 'none';
    panel2d.style.display = 'block';

    // Always use the current dropdown value so we fetch the right image
    const sel = document.getElementById('image-select');
    const currentImg = sel?.value || 'F3.png';
    await refresh2DMasks(currentImg);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  LOAD FLOOR PLAN  (fetch + build scene)
// ═══════════════════════════════════════════════════════════════════

async function loadFloorPlan(imageName) {
  showLoading(`Analysing ${imageName}…`);
  clearScene();
  clearCache();
  setCurrentImage(imageName);

  try {
    const [wallData, windowData, doorData] = await Promise.all([
      fetchWallData(imageName),
      fetchWindowData(imageName),
      fetchDoorData(imageName),
    ]);

    // ── Build walls ──
    wallData.forEach(seg => {
      addWall(seg.start.x, seg.start.y, seg.end.x, seg.end.y);
    });

    // ── Build windows ──
    windowData.forEach(w => {
      const wall = walls[w.wallIndex - 1];
      if (!wall) return;
      addWindow(wall.id, w.posT, w.winWidth, w.winHeight, w.sillHeight);
    });

    // ── Build doors / gates ──
    doorData.forEach(d => {
      const id = ++doorIdCounter;
      const label = `Gate ${id}`;

      if (d.hingeX !== undefined) {
        // ── Simple closed-gate box (reference HTML approach) ──
        const mesh = buildSimpleGate({ ...d }, id);
        // Store a minimal door-like entry (no animation, but deletable)
        const wallId = walls[d.wallIndex - 1]?.id;
        doors.push({
          id,
          wallId: wallId ?? 0,
          posT: d.posT,
          doorWidth: d.doorWidth,
          doorHeight: d.doorHeight,
          gateMesh: mesh,
          door: null,  // no animated door for backend-detected gates
        });
        if (wallId) refreshWallGeometry(wallId);
      } else {
        // Legacy wall-relative placement
        const wall = walls[d.wallIndex - 1];
        if (!wall) return;
        const door = createDoor(scene, wall, {
          posT: d.posT, doorWidth: d.doorWidth, doorHeight: d.doorHeight,
          swingDir: d.swingDir ?? 1, label,
        });
        // Move to gatesGroup
        if (door.frameGroup) { scene.remove(door.frameGroup); door.frameGroup.userData.layer = 'gate'; door.frameGroup.userData.gateId = id; gatesGroup.add(door.frameGroup); }
        if (door.doorRoot)   { scene.remove(door.doorRoot);   door.doorRoot.userData.layer   = 'gate'; door.doorRoot.userData.gateId   = id; gatesGroup.add(door.doorRoot);   }
        if (door.panelMesh)  { door.panelMesh.userData.layer = 'gate'; door.panelMesh.userData.gateId = id; }
        const wallId = wall.id;
        doors.push({ id, wallId, posT: d.posT, doorWidth: d.doorWidth, doorHeight: d.doorHeight, door, gateMesh: null });
        refreshWallGeometry(wallId);
      }
    });


    refreshDoorList();

    // ── Auto-fit camera to loaded floor plan ──────────────────────────
    scene.updateMatrixWorld(true);   // ensure transforms are up to date
    const box = new THREE.Box3();
    box.expandByObject(wallsGroup);
    if (!box.isEmpty()) {
      const center = new THREE.Vector3();
      const size   = new THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);

      const maxDim = Math.max(size.x, size.z);
      const dist   = maxDim * 1.4;

      camera.position.set(
        center.x + dist * 0.6,
        center.y + dist * 0.9,
        center.z + dist * 0.8
      );
      orbitControls.target.copy(center);
      orbitControls.update();

      // ── Build a fitted floor slab below the floorplan ──────────────────
      const oldFloor = scene.getObjectByName('customFloor');
      if (oldFloor) {
        oldFloor.geometry.dispose();
        oldFloor.material.dispose();
        scene.remove(oldFloor);
      }

      const padding = 2; // small overhang around the walls
      const floorGeo = new THREE.BoxGeometry(size.x + padding * 2, 0.5, size.z + padding * 2);
      const floorMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, // White floor
        roughness: 0.9,
        metalness: 0.1,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      const floorMesh = new THREE.Mesh(floorGeo, floorMat);
      floorMesh.name = 'customFloor';
      
      // Position center X/Z, and place top surface exactly at Y=0
      floorMesh.position.set(center.x, -0.25, center.z);
      floorMesh.receiveShadow = true;
      scene.add(floorMesh);

    }

    setStatus(`✓ ${imageName} · ${wallData.length} walls · ${windowData.length} windows · ${doorData.length} gates  |  Click = select · W/E/R = transform · Del = delete`);

    // ── Structural / material analysis ──
    try {
      showLoading('Running structural analysis…');
      const matResult = await fetchMaterialAnalysis();
      window._materialAnalysis = matResult;
      renderOverview(matResult, (elementId) => {
        const el = matResult.analysis.find(e => e.element_id === elementId);
        if (el) openPanel(el);
      });
      const ovStatus = document.getElementById('ov-status');
      if (ovStatus) ovStatus.textContent = `Ready · ${matResult.analysis.length} elements analysed`;
    } catch (matErr) {
      console.warn('[Structural] Material analysis unavailable:', matErr.message);
      const ovStatus = document.getElementById('ov-status');
      if (ovStatus) ovStatus.textContent = 'Material analysis offline';
    }

  } catch (err) {
    console.error('[FloorPlan] Failed to load data:', err);
    setError(`Backend error: ${err.message}. Is the Flask server running on port 5000?`);
  } finally {
    hideLoading();
  }

  // ── If the 2D panel is currently visible, refresh its masks for the new image ──
  // This fixes the bug where changing images while in 2D mode showed stale masks.
  if (_activeView === '2d') {
    await refresh2DMasks(imageName);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════════

async function init() {
  initStructuralUI();
  setStatus('Connecting to backend…');
  wireButtons();

  // Set initial transform mode
  setTransformMode('translate');

  // Populate image dropdown
  const imageSelect = document.getElementById('image-select');
  if (imageSelect) {
    try {
      const images = await fetchImageList();
      images.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name.replace('.png', '');
        imageSelect.appendChild(opt);
      });
    } catch (_) { /* fetchImageList falls back gracefully */ }
  }

  // Auto-load first image
  const firstImage = (imageSelect && imageSelect.options.length > 0)
    ? imageSelect.options[0].value
    : (imageSelect?.value || 'F3.png');
  await loadFloorPlan(firstImage);
}

init();
