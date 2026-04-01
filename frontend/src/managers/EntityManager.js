// src/managers/EntityManager.js
import * as THREE from 'three';
import { rebuildWallWithOpenings } from '../builders/WallBuilder.js';
import { createWindowOnWall } from '../builders/WindowBuilder.js';
import { createDoor } from '../builders/DoorBuilder.js';
import { SCALE, WALL_HEIGHT, WALL_THICKNESS } from '../config/constants.js';

export class EntityManager {
  constructor(scene, wallsGroup, windowsGroup, gatesGroup, state, ui) {
    this.scene = scene;
    this.wallsGroup = wallsGroup;
    this.windowsGroup = windowsGroup;
    this.gatesGroup = gatesGroup;
    this.state = state;
    this.ui = ui; // Error/Status UI
  }

  openingsForWall(wallId) {
    const winOps = this.state.windows
      .filter(w => w.wallId === wallId)
      .map(w => ({ posT: w.posT, winWidth: w.winWidth, winHeight: w.winHeight, sillHeight: w.sillHeight }));

    const doorOps = this.state.doors
      .filter(d => d.wallId === wallId)
      .map(d => ({ posT: d.posT, winWidth: d.doorWidth, winHeight: d.doorHeight, sillHeight: 0 }));

    return [...winOps, ...doorOps];
  }

  refreshWallGeometry(wallId) {
    const w = this.state.walls.find(w => w.id === wallId);
    if (!w) return;

    w.meshes.forEach(m => this.wallsGroup.remove(m));

    const newMeshes = rebuildWallWithOpenings(this.scene, { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 }, [], this.openingsForWall(wallId));
    newMeshes.forEach(m => {
      this.scene.remove(m);
      m.userData.wallId = wallId;
      m.userData.layer = 'wall';
      this.wallsGroup.add(m);
    });
    w.meshes = newMeshes;
  }

  addWall(x1, y1, x2, y2) {
    if ([x1, y1, x2, y2].some(isNaN)) return null;
    const id = ++this.state.wallIdCounter;
    const wall = { id, x1, y1, x2, y2, meshes: [] };
    this.state.walls.push(wall);

    const rawMeshes = rebuildWallWithOpenings(this.scene, wall, [], []);
    rawMeshes.forEach(m => {
      this.scene.remove(m);
      m.userData.wallId = id;
      m.userData.layer = 'wall';
      this.wallsGroup.add(m);
    });
    wall.meshes = rawMeshes;

    this.ui.refreshWallList(this.state.walls, (id) => this.removeWall(id));
    this.ui.refreshAllSelects(this.state.walls);
    this.ui.updateStats(this.state);
    return wall;
  }

  removeWall(id) {
    const w = this.state.walls.find(w => w.id === id);
    if (!w) return;
    w.meshes.forEach(m => this.wallsGroup.remove(m));
    this.state.walls = this.state.walls.filter(w => w.id !== id);
    
    this.state.windows.filter(wi => wi.wallId === id).forEach(wi => this.windowsGroup.remove(wi.group));
    this.state.windows = this.state.windows.filter(w => w.wallId !== id);
    
    this.state.doors.filter(d => d.wallId === id).forEach(d => {
      if (d.door && d.door.dispose) d.door.dispose();
      else if (d.gateMesh) this.gatesGroup.remove(d.gateMesh);
    });
    this.state.doors = this.state.doors.filter(d => d.wallId !== id);

    this.ui.refreshWallList(this.state.walls, (id) => this.removeWall(id));
    this.ui.refreshAllSelects(this.state.walls);
    this.ui.refreshWindowList(this.state, (id) => this.removeWindow(id), (id) => this.selectWindow(id));
    this.ui.refreshDoorList(this.state, (id) => this.removeDoor(id));
    this.ui.updateStats(this.state);
  }

  addWindow(wallId, posT, winWidth, winHeight, sillHeight) {
    const wall = this.state.walls.find(w => w.id === wallId);
    if (!wall) return;
    const id = ++this.state.winIdCounter;
    const group = createWindowOnWall(this.scene, wall, { posT, winWidth, winHeight, sillHeight });
    this.scene.remove(group);
    group.userData.layer = 'window';
    group.userData.winId = id;
    group.children.forEach(c => { c.userData.layer = 'window'; c.userData.winId = id; });
    this.windowsGroup.add(group);

    this.state.windows.push({ id, wallId, posT, winWidth, winHeight, sillHeight, group });
    this.refreshWallGeometry(wallId);
    this.ui.refreshWindowList(this.state, (id) => this.removeWindow(id), (id) => this.selectWindow(id));
    this.ui.updateStats(this.state);
    return id;
  }

  removeWindow(id) {
    const wd = this.state.windows.find(w => w.id === id);
    if (!wd) return;
    this.windowsGroup.remove(wd.group);
    this.state.windows = this.state.windows.filter(w => w.id !== id);
    this.refreshWallGeometry(wd.wallId);
    if (this.state.selectedWin && this.state.selectedWin.id === id) this.state.selectedWin = null;
    this.ui.refreshWindowList(this.state, (id) => this.removeWindow(id), (id) => this.selectWindow(id));
    this.ui.updateStats(this.state);
  }

  addDoor(wallId, posT, doorWidth, doorHeight) {
    const wall = this.state.walls.find(w => w.id === wallId);
    if (!wall) return;
    const id = ++this.state.doorIdCounter;
    const label = `Door ${id} (W${wallId})`;
    const door = createDoor(this.scene, wall, { posT, doorWidth, doorHeight, label });
    
    if (door.frameGroup) { 
        this.scene.remove(door.frameGroup); 
        door.frameGroup.userData.layer = 'gate'; 
        door.frameGroup.userData.gateId = id; 
        this.gatesGroup.add(door.frameGroup); 
    }
    if (door.doorRoot) { 
        this.scene.remove(door.doorRoot); 
        door.doorRoot.userData.layer = 'gate'; 
        door.doorRoot.userData.gateId = id; 
        this.gatesGroup.add(door.doorRoot); 
    }
    if (door.panelMesh) { 
        door.panelMesh.userData.layer = 'gate'; 
        door.panelMesh.userData.gateId = id; 
    }

    this.state.doors.push({ id, wallId, posT, doorWidth, doorHeight, door });
    this.refreshWallGeometry(wallId);
    this.ui.refreshDoorList(this.state, (id) => this.removeDoor(id));
    this.ui.updateStats(this.state);
    return id;
  }

  removeDoor(id) {
    const entry = this.state.doors.find(d => d.id === id);
    if (!entry) return;
    if (entry.door && entry.door.dispose) entry.door.dispose();
    if (entry.gateMesh) this.gatesGroup.remove(entry.gateMesh);
    this.state.doors = this.state.doors.filter(d => d.id !== id);
    if (entry.wallId) this.refreshWallGeometry(entry.wallId);
    this.ui.refreshDoorList(this.state, (id) => this.removeDoor(id));
    this.ui.updateStats(this.state);
  }

  applyWindowChanges() {
    const wd = this.state.selectedWin;
    if (!wd) return;
    this.windowsGroup.remove(wd.group);
    
    wd.posT = parseFloat(document.getElementById('sel-pos').value);
    wd.winWidth = parseFloat(document.getElementById('sel-width').value);
    wd.winHeight = parseFloat(document.getElementById('sel-height').value);
    wd.sillHeight = parseFloat(document.getElementById('sel-sill').value);
    
    const wall = this.state.walls.find(w => w.id === wd.wallId);
    const group = createWindowOnWall(this.scene, wall, {
      posT: wd.posT, winWidth: wd.winWidth, winHeight: wd.winHeight, sillHeight: wd.sillHeight,
    });
    this.scene.remove(group);
    group.userData.layer = 'window';
    group.userData.winId = wd.id;
    group.children.forEach(c => { c.userData.layer = 'window'; c.userData.winId = wd.id; });
    this.windowsGroup.add(group);
    wd.group = group;
    this.refreshWallGeometry(wd.wallId);
    this.ui.refreshWindowList(this.state, (id) => this.removeWindow(id), (id) => this.selectWindow(id));
  }

  buildSimpleGate(gateData, gateId) {
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

    mesh.userData.layer = 'gate';
    mesh.userData.gateId = gateId;

    this.gatesGroup.add(mesh);
    return mesh;
  }
}
