import * as THREE from 'three';
function createWall(start, end, height = 3) {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);

  const geometry = new THREE.BoxGeometry(length, height, 0.2);
  const material = new THREE.MeshStandardMaterial({ color: 0x888888 });

  const wall = new THREE.Mesh(geometry, material);

  // position (center of line)
  wall.position.set(
    (start[0] + end[0]) / 2,
    height / 2,
    (start[1] + end[1]) / 2
  );

  // rotation
  const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
  wall.rotation.y = -angle;

  scene.add(wall);
}

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf0f0f0);

// Camera
const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(10, 10, 10);

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Light
const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(10, 10, 10);
scene.add(light);

// Grid (VERY IMPORTANT for floor plans)
const grid = new THREE.GridHelper(50, 50);
scene.add(grid);

// Simple cube (test object)
const geometry = new THREE.BoxGeometry(2, 2, 2);
const material = new THREE.MeshStandardMaterial({ color: 0x0077ff });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);

// Controls (optional but recommended)
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
const controls = new OrbitControls(camera, renderer.domElement);

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

animate();
createWall([0,0], [10,0]);
createWall([10,0], [10,8]);
createWall([10,8], [0,8]);
createWall([0,8], [0,0]);
