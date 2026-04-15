// src/builders/DoorBuilder.js
import * as THREE from 'three';
import { WALL_HEIGHT, WALL_THICKNESS } from '../config/constants.js';
// SCALE intentionally not imported — caller passes `scale` per-image.

// ─── Materials ─────────────────────────────────────────────────────────────────

const frameMat = new THREE.MeshStandardMaterial({
  color: 0x3b2510,
  roughness: 0.7,
  metalness: 0.05,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});

const panelMat = new THREE.MeshStandardMaterial({
  color: 0x7a4e28,
  roughness: 0.55,
  metalness: 0.05,
  side: THREE.DoubleSide,
});

const insetMat = new THREE.MeshStandardMaterial({
  color: 0x5c3a1a,
  roughness: 0.65,
  metalness: 0.0,
});

const handleMat = new THREE.MeshStandardMaterial({
  color: 0xd4a843,
  roughness: 0.15,
  metalness: 0.9,
});

// ─── Door factory (hinge+strike variant) ──────────────────────────────────────

/**
 * Creates a 3D animated door using exact hinge & strike pixel coordinates.
 *
 * @param {THREE.Scene} scene
 * @param {object} gateData  — door descriptor as returned by floorPlanApi.adaptDoors
 *   {
 *     hingeX, hingeY,      – pixel-space hinge point (on wall)
 *     strikeX, strikeY,    – pixel-space strike point (opposite edge of gap)
 *     doorWidth,           – world units (already scaled)
 *     doorHeight,          – world units
 *     swingDir,            – +1 (swing "left") or -1 (swing "right" relative to wall normal)
 *     label,               – display name
 *   }
 * @returns {{ toggle, update, panelMesh, dispose, isOpen, label }}
 */
export function createDoorFromGate(scene, gateData) {
  const {
    hingeX, hingeY,
    strikeX, strikeY,
    doorWidth = 6,
    doorHeight = 9,
    swingDir = 1,
    label = 'Door',
    scale = 0.2,   // px→world scale factor
  } = gateData;

  // ── World-space hinge position ──
  const hx = hingeX * scale;
  const hz = hingeY * scale;

  // ── Direction of the door leaf (hinge → strike in pixel space) ──
  const rawDx = (strikeX - hingeX) * scale;
  const rawDz = (strikeY - hingeY) * scale;
  // wallAngle is the angle of the door leaf from hinge to strike
  const wallAngle = Math.atan2(rawDz, rawDx);

  // ── Door frame (centred on opening midpoint) ──────────────────────
  const frameCx = hx + rawDx * 0.5;
  const frameCz = hz + rawDz * 0.5;

  const frameGroup = new THREE.Group();
  frameGroup.position.set(frameCx, 0, frameCz);
  frameGroup.rotation.y = -wallAngle;

  const fw = 0.55;
  const fd = WALL_THICKNESS + 0.2;
  const halfW = doorWidth / 2;

  const frameBars = [
    [doorWidth + fw * 2, fw, fd, 0, doorHeight + fw / 2], // top
    [fw, doorHeight + fw, fd, -(halfW + fw / 2), doorHeight / 2], // left upright
    [fw, doorHeight + fw, fd, (halfW + fw / 2), doorHeight / 2],  // right upright
  ];

  frameBars.forEach(([w, h, d, ox, oy]) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, frameMat);
    mesh.position.set(ox, oy, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    frameGroup.add(mesh);
  });
  scene.add(frameGroup);

  // ── Door panel (pivots at hinge) ──────────────────────────────────
  const doorRoot = new THREE.Group();
  doorRoot.position.set(hx, 0, hz);
  doorRoot.rotation.y = -wallAngle;

  const swingPivot = new THREE.Group();
  doorRoot.add(swingPivot);

  // ── Panel body ──
  const panelW = doorWidth - fw * 0.6;
  const panelH = doorHeight - fw * 0.4;
  const panelThk = WALL_THICKNESS * 0.55;
  const panelGeo = new THREE.BoxGeometry(panelW, panelH, panelThk);
  const panel = new THREE.Mesh(panelGeo, panelMat);
  panel.position.set(panelW / 2, panelH / 2, 0);
  panel.castShadow = true;
  panel.receiveShadow = true;
  swingPivot.add(panel);

  // ── Decorative inset panels ──
  const insetW = panelW * 0.72;
  const insets = [
    { w: insetW, h: panelH * 0.30, cy: panelH * 0.28 },
    { w: insetW, h: panelH * 0.45, cy: panelH * 0.68 },
  ];
  insets.forEach(ins => {
    const geo = new THREE.BoxGeometry(ins.w, ins.h, panelThk * 0.4);
    const mesh = new THREE.Mesh(geo, insetMat);
    mesh.position.set(panelW / 2, ins.cy, panelThk * 0.3);
    swingPivot.add(mesh);
  });

  // ── Handle ──
  const plateMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 1.6, 0.18),
    handleMat
  );
  plateMesh.position.set(panelW * 0.82, panelH * 0.45, panelThk / 2 + 0.1);
  swingPivot.add(plateMesh);

  const leverMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 1.4, 10),
    handleMat
  );
  leverMesh.rotation.z = Math.PI / 2;
  leverMesh.position.set(panelW * 0.82 + 0.5, panelH * 0.45, panelThk / 2 + 0.22);
  swingPivot.add(leverMesh);

  scene.add(doorRoot);

  // ── Animation state ──────────────────────────────────────────────
  let isOpen = false;
  let openAmount = 0;
  // swingDir controls whether the door opens inward or outward
  const OPEN_ANGLE = (Math.PI / 2) * 0.9 * swingDir;

  return {
    label,
    frameGroup,   // exposed so caller can reparent to a scene group
    doorRoot,     // exposed so caller can reparent to a scene group
    get isOpen() { return isOpen; },

    update() {
      const target = isOpen ? 1 : 0;
      openAmount = THREE.MathUtils.lerp(openAmount, target, 0.08);
      swingPivot.rotation.y = openAmount * OPEN_ANGLE;
    },

    toggle() { isOpen = !isOpen; },

    get panelMesh() { return panel; },

    dispose() {
      // Remove from whatever parent they belong to (scene OR a group)
      if (frameGroup.parent) frameGroup.parent.remove(frameGroup);
      if (doorRoot.parent)   doorRoot.parent.remove(doorRoot);
    },
  };
}

// ─── Legacy wall-relative factory (kept for manual door-add UI) ────────────────

/**
 * Creates a 3D animated door on a wall segment using posT (0..1 along wall).
 * Used by the manual "Add Door" UI controls.
 *
 * @param {THREE.Scene}  scene
 * @param {object}       wallSeg    – { x1, y1, x2, y2 } in floor-plan pixel coords
 * @param {object}       opts
 * @param {number}       opts.posT        – 0..1 along the wall (default 0.5)
 * @param {number}       opts.doorWidth   – world units (default 6)
 * @param {number}       opts.doorHeight  – world units (default 9)
 * @param {number}       opts.swingDir    – +1 or -1 (default +1)
 * @param {string}       opts.label       – display name
 * @returns {{ toggle, update, panelMesh, dispose, isOpen, label }}
 */
export function createDoor(scene, wallSeg, opts = {}) {
  const {
    posT = 0.5,
    doorWidth = 6,
    doorHeight = 9,
    swingDir = 1,
    label = 'Door',
    scale = 0.2,   // px→world scale factor
  } = opts;

  const x1 = wallSeg.x1 * scale, z1 = wallSeg.y1 * scale;
  const x2 = wallSeg.x2 * scale, z2 = wallSeg.y2 * scale;
  const dx = x2 - x1, dz = z2 - z1;
  const L = Math.sqrt(dx * dx + dz * dz);
  const wallAngle = Math.atan2(dz, dx);

  const cosA = Math.cos(wallAngle), sinA = Math.sin(wallAngle);
  const hingeDist = posT * L - doorWidth / 2;
  const hx = x1 + cosA * hingeDist;
  const hz = z1 + sinA * hingeDist;

  // Delegate to the gate-based factory using computed hinge/strike in world space,
  // converting back to pixel-equivalent coords since createDoorFromGate accepts pixels.
  return createDoorFromGate(scene, {
    hingeX: hx / scale,
    hingeY: hz / scale,
    strikeX: (hx + cosA * doorWidth) / scale,
    strikeY: (hz + sinA * doorWidth) / scale,
    doorWidth,
    doorHeight,
    swingDir,
    label,
    scale,
  });
}

/**
 * Batch-create doors from a descriptor array.
 * Each entry may be a gateData descriptor (has hingeX) or a wall-relative descriptor.
 */
export function buildDoors(scene, doorData) {
  return doorData.map(d => {
    if (d.hingeX !== undefined) return createDoorFromGate(scene, d);
    const { wall, ...opts } = d;
    return createDoor(scene, wall, opts);
  });
}
