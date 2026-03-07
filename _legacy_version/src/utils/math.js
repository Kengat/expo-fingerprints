import * as THREE from 'three';

export function seededRandom(seed) {
  return function () {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function remap(value, inMin, inMax, outMin, outMax) {
  return outMin + (outMax - outMin) * ((value - inMin) / (inMax - inMin));
}

export function uvToSurface(shellFunc, u, v) {
  const target = new THREE.Vector3();
  shellFunc(u, v, target);
  return target;
}
