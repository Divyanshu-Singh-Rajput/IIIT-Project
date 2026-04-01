// src/state.js
import * as THREE from 'three';

export const state = {
  walls: [],    // { id, x1, y1, x2, y2, meshes: THREE.Mesh[] }
  windows: [],  // { id, wallId, posT, winWidth, winHeight, sillHeight, group }
  doors: [],    // { id, wallId, posT, doorWidth, doorHeight, door }
  wallIdCounter: 0,
  winIdCounter: 0,
  doorIdCounter: 0,
  selectedWin: null,
  activeView: '3d', // '3d' | '2d'
  selectedObject: null, // THREE.Object3D
};

// Selection helpers
export function getSelectableRoot(obj, wallsGroup, windowsGroup, gatesGroup) {
  let cur = obj;
  while (cur && cur.parent) {
    if (cur.parent === wallsGroup || cur.parent === windowsGroup || cur.parent === gatesGroup) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}
