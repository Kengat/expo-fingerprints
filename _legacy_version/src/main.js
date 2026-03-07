import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { params } from './params.js';
import { setupEnvironment, updateEnvironment } from './environment.js';
import { setupPostProcessing, updatePostProcessing, resizePostProcessing } from './postprocessing.js';
import { buildPavilion } from './pavilion/index.js';
import { setupGUI } from './gui.js';
import { captureScreenshot, exportGLTF, exportOBJ } from './utils/export.js';
import { generateFingerprintTexture } from './pavilion/fingerprint.js';

// Renderer
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// Scene
const scene = new THREE.Scene();

// Camera
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(35, 25, 45);

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(0, 7, 0);
controls.maxPolarAngle = Math.PI / 2 + 0.1;
controls.minDistance = 5;
controls.maxDistance = 150;

// Environment
setupEnvironment(scene, params);

// Post-processing
const composer = setupPostProcessing(renderer, scene, camera, params);

// Build initial pavilion
buildPavilion(scene, params);

// Texture preview overlay
const previewContainer = document.createElement('div');
previewContainer.style.cssText = 'position:fixed;bottom:16px;left:16px;width:250px;height:250px;background:#fff;border:2px solid #444;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.3);display:none;z-index:999;overflow:hidden;';
const previewCanvas = document.createElement('canvas');
previewCanvas.width = 250;
previewCanvas.height = 250;
previewCanvas.style.cssText = 'width:100%;height:100%;';
previewContainer.appendChild(previewCanvas);
const previewLabel = document.createElement('div');
previewLabel.textContent = 'Fingerprint Preview';
previewLabel.style.cssText = 'position:absolute;top:0;left:0;right:0;background:rgba(0,0,0,0.6);color:#fff;font:11px/20px sans-serif;text-align:center;';
previewContainer.appendChild(previewLabel);
document.body.appendChild(previewContainer);

function updatePreview() {
  if (params.skinType === 'fingerprint' && params.fpShowPreview) {
    previewContainer.style.display = 'block';
    const tex = generateFingerprintTexture(params, 250);
    const ctx = previewCanvas.getContext('2d');
    ctx.drawImage(tex.image, 0, 0, 250, 250);
    tex.dispose();
  } else {
    previewContainer.style.display = 'none';
  }
}

// Debounced rebuild
let rebuildTimeout = null;
function onParamChange() {
  clearTimeout(rebuildTimeout);
  rebuildTimeout = setTimeout(() => {
    buildPavilion(scene, params);
    updateEnvironment(scene, params);
    updatePostProcessing(params);
    updatePreview();
  }, 50);
}

// GUI
setupGUI(params, {
  onParamChange,
  onScreenshot: () => captureScreenshot(renderer),
  onExportGLTF: () => exportGLTF(scene),
  onExportOBJ: () => exportOBJ(scene),
});

// Animation loop
function animate() {
  controls.update();
  composer.render();
}
renderer.setAnimationLoop(animate);

// Resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizePostProcessing(window.innerWidth, window.innerHeight);
});
