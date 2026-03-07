import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

let composer = null;
let bloomPass = null;

export function setupPostProcessing(renderer, scene, camera, p) {
  composer = new EffectComposer(renderer);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    p.bloomStrength,
    p.bloomRadius,
    p.bloomThreshold
  );
  composer.addPass(bloomPass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  return composer;
}

export function updatePostProcessing(p) {
  if (bloomPass) {
    bloomPass.strength = p.bloomStrength;
    bloomPass.radius = p.bloomRadius;
    bloomPass.threshold = p.bloomThreshold;
  }
}

export function resizePostProcessing(width, height) {
  if (composer) {
    composer.setSize(width, height);
  }
}

export function getComposer() {
  return composer;
}
