import * as THREE from 'three';

const envPresets = {
  desert: { bg: '#d4c5a9', ground: '#d4b896', sunColor: '#ffeedd', fog: '#d4c5a9', hemiSky: '#ffeeb1', hemiGround: '#080820' },
  green: { bg: '#87CEEB', ground: '#4a7c3f', sunColor: '#ffffff', fog: '#c8dcc8', hemiSky: '#b1d8ff', hemiGround: '#2d5a1e' },
  evening: { bg: '#2d1b4e', ground: '#1a1a2e', sunColor: '#ff8c42', fog: '#1a1a2e', hemiSky: '#ff8c42', hemiGround: '#0a0a1a' },
  studio: { bg: '#e0e0e0', ground: '#cccccc', sunColor: '#ffffff', fog: '#e0e0e0', hemiSky: '#ffffff', hemiGround: '#888888' },
};

let sun = null;
let ground = null;
let hemi = null;
let bgTexture = null;

function createGradientBackground(topColor, bottomColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, topColor);
  gradient.addColorStop(1, bottomColor);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

export function setupEnvironment(scene, p) {
  const env = envPresets[p.envType] || envPresets.green;

  // Gradient sky background
  bgTexture = createGradientBackground(env.bg, env.ground);
  scene.background = bgTexture;

  // Directional light (sun)
  const sunAngleRad = THREE.MathUtils.degToRad(p.sunAngle);
  sun = new THREE.DirectionalLight(new THREE.Color(env.sunColor), p.sunIntensity);
  sun.position.set(
    50 * Math.cos(sunAngleRad),
    50 * Math.sin(sunAngleRad),
    -40
  );
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -50;
  sun.shadow.camera.right = 50;
  sun.shadow.camera.top = 50;
  sun.shadow.camera.bottom = -50;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.001;
  scene.add(sun);

  // Hemisphere light for ambient fill
  hemi = new THREE.HemisphereLight(
    new THREE.Color(env.hemiSky),
    new THREE.Color(env.hemiGround),
    0.6
  );
  scene.add(hemi);

  // Ground plane
  const groundGeom = new THREE.PlaneGeometry(300, 300);
  const groundMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.groundColor),
    roughness: 0.95,
    metalness: 0.0,
  });
  ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  // Fog
  scene.fog = new THREE.FogExp2(new THREE.Color(env.fog), p.fogDensity);
}

export function updateEnvironment(scene, p) {
  const env = envPresets[p.envType] || envPresets.green;

  // Update background
  if (bgTexture) bgTexture.dispose();
  bgTexture = createGradientBackground(env.bg, env.ground);
  scene.background = bgTexture;

  if (sun) {
    const sunAngleRad = THREE.MathUtils.degToRad(p.sunAngle);
    sun.position.set(
      50 * Math.cos(sunAngleRad),
      50 * Math.sin(sunAngleRad),
      -40
    );
    sun.intensity = p.sunIntensity;
    sun.color.set(env.sunColor);
  }

  if (hemi) {
    hemi.color.set(env.hemiSky);
    hemi.groundColor.set(env.hemiGround);
  }

  if (ground) {
    ground.material.color.set(p.groundColor);
  }

  if (scene.fog) {
    scene.fog.color.set(env.fog);
    scene.fog.density = p.fogDensity;
  }
}
