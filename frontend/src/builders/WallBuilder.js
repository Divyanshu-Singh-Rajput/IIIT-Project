// src/builders/WallBuilder.js
import * as THREE from 'three';
import { WALL_HEIGHT, WALL_THICKNESS, MATERIALS } from '../config/constants.js';
// Note: SCALE is intentionally NOT imported here. The caller passes a `scale`
// parameter so every floor plan is rendered at a consistent world size regardless
// of the pixel resolution of the source image.

// Reuse a single material across all walls for better performance
const wallMaterial = new THREE.MeshStandardMaterial({
  color: MATERIALS.WALL.COLOR,
  roughness: MATERIALS.WALL.ROUGHNESS,
  metalness: MATERIALS.WALL.METALNESS,
  // Polygon offset pushes wall surfaces slightly back in the depth buffer so
  // frames, glass and door panels that sit on the same plane always win.
  polygonOffset: true,
  polygonOffsetFactor: 2,
  polygonOffsetUnits: 2,
});

// ─── Low-level segment helper ─────────────────────────────────────────────────

/**
 * Creates ONE rectangular box segment of a wall in local wall-space and adds
 * it to the scene.
 *
 * @param {THREE.Scene} scene
 * @param {number}  ox, oz   – world origin (start point) of the wall
 * @param {number}  angle    – wall rotation angle (atan2 of direction)
 * @param {number}  localStart – distance along wall where segment begins
 * @param {number}  localEnd   – distance along wall where segment ends
 * @param {number}  yBottom  – bottom Y of segment (world units)
 * @param {number}  yTop     – top    Y of segment (world units)
 * @returns {THREE.Mesh}
 */
function makeWallSegment(scene, ox, oz, angle, localStart, localEnd, yBottom, yTop) {
  const segLen = localEnd   - localStart;
  const segH   = yTop       - yBottom;
  if (segLen < 0.01 || segH < 0.01) return null;

  const localCentre = (localStart + localEnd) / 2;
  const yCentre     = (yBottom + yTop) / 2;

  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  const geo  = new THREE.BoxGeometry(segLen, segH, WALL_THICKNESS);
  const mesh = new THREE.Mesh(geo, wallMaterial);
  mesh.position.set(ox + cosA * localCentre, yCentre, oz + sinA * localCentre);
  mesh.rotation.y  = -angle;
  mesh.castShadow    = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a simple solid wall between two 2D floor-plan points (no openings).
 * Used by the main app for the initial build.
 *
 * @param {THREE.Scene} scene
 * @param {{ x: number, y: number }} start
 * @param {{ x: number, y: number }} end
 * @param {number} [scale=0.2]  px→world scale factor (dynamic, per-image)
 * @returns {THREE.Mesh[]}
 */
export function createWall(scene, start, end, scale = 0.2) {
  const x1 = start.x * scale, z1 = start.y * scale;
  const x2 = end.x   * scale, z2 = end.y   * scale;
  const dx = x2 - x1, dz = z2 - z1;
  const L  = Math.sqrt(dx * dx + dz * dz);
  if (L < 0.1) return [];

  const angle = Math.atan2(dz, dx);
  const mesh  = makeWallSegment(scene, x1, z1, angle, 0, L, 0, WALL_HEIGHT);
  return mesh ? [mesh] : [];
}

/**
 * Builds all walls from an array of wall segment data objects (no openings).
 *
 * @param {THREE.Scene} scene
 * @param {Array<{ start: { x, y }, end: { x, y } }>} wallData
 * @param {number} [scale=0.2]
 */
export function buildWalls(scene, wallData, scale = 0.2) {
  wallData.forEach(({ start, end }) => createWall(scene, start, end, scale));
}

/**
 * Rebuilds a wall's mesh collection accounting for window openings.
 * Removes old meshes from the scene, then creates the segmented replacement.
 *
 * @param {THREE.Scene}  scene
 * @param {object}       wallInfo   – { x1, y1, x2, y2 } in floor-plan coords
 * @param {THREE.Mesh[]} oldMeshes  – existing meshes to remove
 * @param {Array<{posT: number, winWidth: number, winHeight: number, sillHeight: number}>} openings
 *   All dimensions in WORLD units (already scaled); posT is 0-1 along the wall.
 * @param {number} [scale=0.2]  px→world scale factor
 * @returns {THREE.Mesh[]}  new mesh list
 */
export function rebuildWallWithOpenings(scene, wallInfo, oldMeshes, openings, scale = 0.2) {
  // ── Remove old meshes ──
  oldMeshes.forEach(m => scene.remove(m));

  // ── Wall geometry in scaled world space ──
  const x1 = wallInfo.x1 * scale, z1 = wallInfo.y1 * scale;
  const x2 = wallInfo.x2 * scale, z2 = wallInfo.y2 * scale;
  const dx = x2 - x1, dz = z2 - z1;
  const L  = Math.sqrt(dx * dx + dz * dz);
  if (L < 0.1) return [];

  const angle = Math.atan2(dz, dx);

  // ── Sort openings left→right along the wall ──
  const sorted = [...openings].sort((a, b) => a.posT - b.posT);

  const newMeshes = [];

  const add = (ls, le, yb, yt) => {
    const m = makeWallSegment(scene, x1, z1, angle, ls, le, yb, yt);
    if (m) newMeshes.push(m);
  };

  let cursor = 0; // position along the wall (local, world units)

  for (const op of sorted) {
    const halfW  = op.winWidth / 2;
    const wLeft  = Math.max(0, op.posT * L - halfW);
    const wRight = Math.min(L, op.posT * L + halfW);
    const topOfWin = op.sillHeight + op.winHeight;

    // ── Full-height segment before this window ──
    if (wLeft > cursor + 0.01) {
      add(cursor, wLeft, 0, WALL_HEIGHT);
    }

    // ── Sill (below window) ──
    if (op.sillHeight > 0.01) {
      add(wLeft, wRight, 0, op.sillHeight);
    }

    // ── Lintel (above window) ──
    if (WALL_HEIGHT - topOfWin > 0.01) {
      add(wLeft, wRight, topOfWin, WALL_HEIGHT);
    }

    cursor = Math.max(cursor, wRight);
  }

  // ── Full-height segment after the last window ──
  if (L > cursor + 0.01) {
    add(cursor, L, 0, WALL_HEIGHT);
  }

  return newMeshes;
}
