// src/core/SceneInit.js
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createScene } from '../scene/SceneManager.js';
import { createRenderer } from '../scene/RendererManager.js';
import { createCamera } from '../scene/CameraManager.js';
import { setupLighting } from '../scene/LightingManager.js';
import { createGround } from '../scene/Ground.js';
import { setupResizeHandler } from './ResizeHandler.js';

export function initThreeJS(container) {
  const { scene } = createScene();
  const { renderer } = createRenderer(container);
  const { camera, controls: orbitControls } = createCamera(renderer);

  setupLighting(scene);
  createGround(scene);
  setupResizeHandler(camera, renderer, container);

  const wallsGroup = new THREE.Group(); wallsGroup.name = 'walls';
  const windowsGroup = new THREE.Group(); windowsGroup.name = 'windows';
  const gatesGroup = new THREE.Group(); gatesGroup.name = 'gates';
  scene.add(wallsGroup, windowsGroup, gatesGroup);

  const transformControl = new TransformControls(camera, renderer.domElement);
  transformControl.setMode('translate');
  scene.add(transformControl);

  return {
    scene,
    renderer,
    camera,
    orbitControls,
    wallsGroup,
    windowsGroup,
    gatesGroup,
    transformControl,
  };
}
