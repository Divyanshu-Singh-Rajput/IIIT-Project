// src/builders/WindowBuilder.js
import * as THREE from 'three';
import { WALL_HEIGHT, WALL_THICKNESS } from '../config/constants.js';
// SCALE intentionally not imported — caller passes `scale` per-image.

// ─── Materials ─────────────────────────────────────────────────────────────────

const frameMaterial = new THREE.MeshStandardMaterial({
  color: 0x8ab4d4,
  roughness: 0.3,
  metalness: 0.5,
  // Slightly negative polygon offset so frame renders in front of wall
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});

const glassMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x88ccff,
  transparent: true,
  opacity: 0.25,
  roughness: 0.05,
  metalness: 0.1,
  side: THREE.DoubleSide,
  depthWrite: false,
  // Glass renders in front of everything coplanar
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});

// ─── Window group ──────────────────────────────────────────────────────────────

/**
 * Creates a 3D window (glass pane + frame) and places it on a wall segment.
 *
 * @param {THREE.Scene}  scene
 * @param {object}  wallSeg   – { x1, y1, x2, y2 } in 2D floor-plan space
 * @param {object}  opts
 * @param {number}  opts.posT       – 0..1 position along the wall (default 0.5)
 * @param {number}  opts.winWidth   – window width in world units (default 20)
 * @param {number}  opts.winHeight  – window height in world units (default 8)
 * @param {number}  opts.sillHeight – height of bottom sill from floor (default 3)
 * @returns {THREE.Group}   the window group (transform to move/resize later)
 */
export function createWindowOnWall(scene, wallSeg, opts = {}) {
  const {
    posT       = 0.5,
    winWidth   = 20,
    winHeight  = 8,
    sillHeight = 3,
    scale      = 0.2,   // px→world scale factor (per-image, from EntityManager)
  } = opts;

  // ── Wall geometry in scaled world space ──
  const x1 = wallSeg.x1 * scale, z1 = wallSeg.y1 * scale;
  const x2 = wallSeg.x2 * scale, z2 = wallSeg.y2 * scale;
  const dx = x2 - x1, dz = z2 - z1;
  const wallAngle = Math.atan2(dz, dx);

  // Centre of the window along the wall
  const cx = x1 + dx * posT;
  const cz = z1 + dz * posT;
  const cy = sillHeight + winHeight / 2; // vertical centre

  // ── Group ──
  const group = new THREE.Group();
  group.position.set(cx, cy, cz);
  group.rotation.y = -wallAngle;

  // ── Glass pane ──
  const glassGeo = new THREE.BoxGeometry(winWidth, winHeight, WALL_THICKNESS * 0.1);
  const glass    = new THREE.Mesh(glassGeo, glassMaterial);
  group.add(glass);

  // ── Frame (four thin bars around the pane) ──
  const fw = 0.8; // frame bar width
  // Depth is slightly LARGER than WALL_THICKNESS so frame protrudes
  // through both wall faces — eliminates coplanar z-fighting entirely.
  const frameDepth = WALL_THICKNESS + 0.2;

  // Each frame bar: [ widthX, heightY, depthZ, offsetX, offsetY ]
  const bars = [
    // Top
    [winWidth + fw * 2, fw, frameDepth,  0,                  winHeight / 2 + fw / 2],
    // Bottom
    [winWidth + fw * 2, fw, frameDepth,  0,                 -winHeight / 2 - fw / 2],
    // Left
    [fw, winHeight, frameDepth, -winWidth / 2 - fw / 2,     0],
    // Right
    [fw, winHeight, frameDepth,  winWidth / 2 + fw / 2,     0],
    // Middle crossbar (horizontal)
    [winWidth, fw * 0.6, frameDepth,  0,  0],
    // Middle crossbar (vertical)
    [fw * 0.6, winHeight, frameDepth,  0,  0],
  ];

  bars.forEach(([bw, bh, bd, ox, oy]) => {
    const geo  = new THREE.BoxGeometry(bw, bh, bd);
    const mesh = new THREE.Mesh(geo, frameMaterial);
    mesh.position.set(ox, oy, 0);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });

  scene.add(group);
  return group;
}

// ─── Batch helper ─────────────────────────────────────────────────────────────

/**
 * Builds multiple windows from a descriptor array.
 *
 * @param {THREE.Scene} scene
 * @param {Array<{ wall: object, posT?: number, winWidth?: number, winHeight?: number, sillHeight?: number }>} windowData
 * @returns {THREE.Group[]}
 */
export function buildWindows(scene, windowData) {
  return windowData.map(({ wall, ...opts }) =>
    createWindowOnWall(scene, wall, opts)
  );
}
