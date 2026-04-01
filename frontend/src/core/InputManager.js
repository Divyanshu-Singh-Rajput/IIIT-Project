// src/core/InputManager.js
import * as THREE from 'three';
import { setStatus } from '../ui/StatusUI.js';
import { openPanel } from '../ui/StructuralPanel.js';

export class InputManager {
    constructor(scene, camera, renderer, orbitControls, transformControl, groups, state, entityManager, ui) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.orbitControls = orbitControls;
        this.transformControl = transformControl;
        this.groups = groups; // { wallsGroup, windowsGroup, gatesGroup }
        this.state = state;
        this.entityManager = entityManager;
        this.ui = ui;

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.clock = new THREE.Clock();

        this.isFlyMode = false;
        this.flyYaw = 0;
        this.flyPitch = 0;
        this.flyKeys = { w: false, a: false, s: false, d: false };

        this._mouseDown = false;
        this._mouseHasMoved = false;

        this.initListeners();
    }

    initListeners() {
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key.length === 1) this.flyKeys[e.key.toLowerCase()] = true;

            switch (e.key) {
                case 'w': case 'W': if (!this.isFlyMode) this.setTransformMode('translate'); break;
                case 'e': case 'E': if (!this.isFlyMode) this.setTransformMode('rotate'); break;
                case 'r': case 'R': if (!this.isFlyMode) this.setTransformMode('scale'); break;
                case 'Delete':
                case 'Backspace': this.deleteSelected(); break;
                case 'Escape': this.deselectObject(); break;
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.key.length === 1) this.flyKeys[e.key.toLowerCase()] = false;
        });

        this.renderer.domElement.addEventListener('pointerdown', () => {
            this._mouseDown = true;
            this._mouseHasMoved = false;
        });

        this.renderer.domElement.addEventListener('pointermove', (e) => {
            if (this._mouseDown) {
                this._mouseHasMoved = true;
                if (this.isFlyMode) {
                    this.flyYaw -= e.movementX * 0.003;
                    this.flyPitch -= e.movementY * 0.003;
                    this.flyPitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.flyPitch));
                    this.camera.quaternion.setFromEuler(new THREE.Euler(this.flyPitch, this.flyYaw, 0, 'YXZ'));
                }
            }
        });

        this.renderer.domElement.addEventListener('pointerup', (e) => {
            this._mouseDown = false;
            if (this.isFlyMode) return;
            if (this._mouseHasMoved) return;

            const rect = this.renderer.domElement.getBoundingClientRect();
            this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            this.raycaster.setFromCamera(this.mouse, this.camera);

            if (this.transformControl.dragging) return;

            const allObjects = [
                ...this.groups.wallsGroup.children,
                ...this.groups.windowsGroup.children,
                ...this.groups.gatesGroup.children,
            ];

            const hits = this.raycaster.intersectObjects(allObjects, true);

            if (hits.length > 0) {
                const hitObj = hits[0].object;
                
                // Toggle doors
                const panelMeshes = this.state.doors.filter(d => d.door).map(d => d.door.panelMesh);
                if (panelMeshes.includes(hitObj) && this.state.selectedObject === null) {
                    const entry = this.state.doors.find(d => d.door && d.door.panelMesh === hitObj);
                    if (entry) {
                        entry.door.toggle();
                        this.ui.refreshDoorList(this.state, (id) => this.entityManager.removeDoor(id));
                        setStatus(entry.door.isOpen ? `🚪 ${entry.door.label} opened` : `🚪 ${entry.door.label} closed`);
                        return;
                    }
                }

                // Structural analysis
                const wallHit = this.groups.wallsGroup.children.includes(hitObj) ||
                               this.groups.wallsGroup.children.some(g => g.children?.includes(hitObj));
                if (wallHit && window._materialAnalysis) {
                    const wallId = hitObj.userData.wallId;
                    const wall = this.state.walls.find(w => w.id === wallId);
                    if (wall) {
                        const { analysis } = window._materialAnalysis;
                        const wallIdx = this.state.walls.indexOf(wall);
                        const el = analysis[wallIdx] || analysis[0];
                        if (el) openPanel(el);
                    }
                }

                this.selectObject(hitObj);
            } else {
                this.deselectObject();
            }
        });

        this.transformControl.addEventListener('dragging-changed', (e) => {
          if (!this.isFlyMode) this.orbitControls.enabled = !e.value;
          if (e.value) {
            document.body.classList.add('transform-active');
          } else {
            document.body.classList.remove('transform-active');
            if (this.state.selectedObject) this.syncPropsToPanel(this.state.selectedObject);
          }
        });

        this.transformControl.addEventListener('change', () => {
          this.updateTransformBtns(this.transformControl.getMode());
        });
    }

    toggleFlyMode(e) {
        this.isFlyMode = !this.isFlyMode;
        e.target.classList.toggle('active', this.isFlyMode);
        if (this.isFlyMode) {
          this.orbitControls.enabled = false;
          if (this.state.selectedObject) this.deselectObject();
          const euler = new THREE.Euler(0, 0, 0, 'YXZ');
          euler.setFromQuaternion(this.camera.quaternion);
          this.flyYaw = euler.y;
          this.flyPitch = euler.x;
          setStatus("✈ Fly Mode enabled: WASD to move, Click+Drag to look");
        } else {
          this.orbitControls.enabled = true;
          this.flyKeys.w = this.flyKeys.a = this.flyKeys.s = this.flyKeys.d = false;
          setStatus("🔄 Orbit Mode restored: Click/Drag to orbit, click objects to select");
        }
    }

    setTransformMode(mode) {
        this.transformControl.setMode(mode);
        this.updateTransformBtns(mode);
    }

    updateTransformBtns(mode) {
        ['translate', 'rotate', 'scale'].forEach(m => {
            document.getElementById(`tf-${m}`)?.classList.toggle('active', m === mode);
            document.getElementById(`pp-${m}`)?.classList.toggle('active', m === mode);
        });
    }

    selectObject(obj) {
        let cur = obj;
        let root = null;
        while (cur && cur.parent) {
            if (cur.parent === this.groups.wallsGroup || cur.parent === this.groups.windowsGroup || cur.parent === this.groups.gatesGroup) {
                root = cur; break;
            }
            cur = cur.parent;
        }
        if (!root) return;
        if (this.state.selectedObject === root) return;
        this.deselectObject(true);
        this.state.selectedObject = root;
        this.applyToMeshes(root, m => { if (m.material.emissive) m.material.emissive.setHex(0x222244); });
        this.transformControl.attach(root);
        this.openPropsPanel(root);
    }

    deselectObject(silent = false) {
        if (this.state.selectedObject) {
            this.applyToMeshes(this.state.selectedObject, m => { if (m.material.emissive) m.material.emissive.setHex(0x000000); });
            this.transformControl.detach();
            this.state.selectedObject = null;
        }
        if (!silent) this.closePropsPanel();
    }

    deleteSelected() {
        if (!this.state.selectedObject) return;
        const obj = this.state.selectedObject;
        const layer = obj.userData.layer;
        this.deselectObject(true);
        this.closePropsPanel();

        if (layer === 'wall') {
            const wallId = obj.userData.wallId;
            const w = this.state.walls.find(w => w.id === wallId);
            if (w) this.entityManager.removeWall(w.id);
        } else if (layer === 'window') {
            const winId = obj.userData.winId;
            if (winId !== undefined) this.entityManager.removeWindow(winId);
            else this.groups.windowsGroup.remove(obj);
        } else if (layer === 'gate') {
            const gateId = obj.userData.gateId;
            if (gateId !== undefined) this.entityManager.removeDoor(gateId);
            else this.groups.gatesGroup.remove(obj);
        } else if (obj.parent) {
            obj.parent.remove(obj);
        }
    }

    applyToMeshes(obj, fn) {
        if (obj.isMesh && obj.material) {
            if (!obj.userData.matOwned) { obj.material = obj.material.clone(); obj.userData.matOwned = true; }
            fn(obj);
        }
        if (obj.isGroup) { obj.children.forEach(c => this.applyToMeshes(c, fn)); }
    }

    openPropsPanel(obj) {
      const panel = document.getElementById('props-panel');
      if (panel) { panel.classList.add('open'); this.syncPropsToPanel(obj); }
    }

    closePropsPanel() {
      const panel = document.getElementById('props-panel');
      if (panel) panel.classList.remove('open');
    }

    syncPropsToPanel(obj) {
      if (!obj) return;
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

    update(delta) {
        if (this.isFlyMode) {
            const speed = 100 * delta;
            const dir = new THREE.Vector3();
            this.camera.getWorldDirection(dir);
            if (this.flyKeys.w) this.camera.position.addScaledVector(dir, speed);
            if (this.flyKeys.s) this.camera.position.addScaledVector(dir, -speed);
            const right = new THREE.Vector3().crossVectors(dir, this.camera.up).normalize();
            if (this.flyKeys.d) this.camera.position.addScaledVector(right, speed);
            if (this.flyKeys.a) this.camera.position.addScaledVector(right, -speed);
        } else {
            this.orbitControls.update();
        }
    }
}
