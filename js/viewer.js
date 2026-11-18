import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Viewer {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(80, -120, 110);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const d = new THREE.DirectionalLight(0xffffff, 1.6);
    d.position.set(60, -80, 150);
    this.scene.add(d);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.5);
    d2.position.set(-80, 60, 40);
    this.scene.add(d2);
    this.grid = new THREE.GridHelper(300, 30, 0x5a6b7d, 0x2c3540);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);
    this.mat = new THREE.MeshStandardMaterial({ color: 0xff9f43, roughness: 0.55, metalness: 0.05, flatShading: true });
    this.mesh = null;
    this.needsFit = true;
    new ResizeObserver(() => this.resize()).observe(el);
    const loop = () => { requestAnimationFrame(loop); if (this.el.offsetParent !== null) { this.controls.update(); this.renderer.render(this.scene, this.camera); } };
    loop();
  }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  setMesh(m) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
    if (!m) return;
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g = g.toNonIndexed();
    g.computeVertexNormals();
    this.mesh = new THREE.Mesh(g, this.mat);
    this.scene.add(this.mesh);
    if (this.needsFit) { this.fit(m.size); this.needsFit = false; }
  }
  fit(size) {
    const r = Math.max(20, Math.hypot(size[0], size[1], size[2]));
    this.controls.target.set(0, 0, size[2] / 2);
    this.camera.position.set(r * 0.7, -r * 1.1, r * 1.0);
    this.camera.near = r / 100; this.camera.far = r * 50;
    this.camera.updateProjectionMatrix();
  }
}
