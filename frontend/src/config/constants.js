// src/config/constants.js

// The 3D world width (in Three.js units) that every floor plan is normalised to.
// All pixel coordinates are divided by the image width and multiplied by this
// value, so plans of any resolution always fill the same viewport.
export const TARGET_WORLD_SIZE = 200;

// Legacy alias kept so any file that still imports SCALE gets a sensible default.
// Remove once every caller has migrated to the dynamic scale from floorPlanApi.
export const SCALE = 0.2;
export const WALL_HEIGHT = 12;
export const WALL_THICKNESS = 1.2;

// In dev: Vite proxies /api/* → http://127.0.0.1:5000 (see vite.config.js)
// In production: ensure your server routes /api/* to the Flask backend.
export const API_URL          = '/api/data';
export const MATERIAL_API_URL = '/api/materials';
export const CHAT_API_URL     = '/api/chat';

export const CAMERA = {
  FOV: 50,
  NEAR: 0.1,
  FAR: 5000,
  INITIAL_POSITION: { x: 80, y: 100, z: 120 },
};

export const SHADOWS = {
  MAP_SIZE: 2048,
  CAMERA_BOUNDS: 200, // ±200 in all directions
};

export const LIGHTS = {
  HEMI: {
    SKY_COLOR: 0xffffff,
    GROUND_COLOR: 0x444444,
    INTENSITY: 1.5,
  },
  SUN: {
    COLOR: 0xffffff,
    INTENSITY: 2,
    POSITION: { x: 100, y: 200, z: 100 },
  },
};

export const MATERIALS = {
  WALL: {
    COLOR: 0xffffff,
    ROUGHNESS: 0.4,
    METALNESS: 0.1,
  },
  GROUND: {
    COLOR: 0x1a1a1a,
    ROUGHNESS: 0.8,
  },
};
