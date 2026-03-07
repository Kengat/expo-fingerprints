import * as THREE from 'three';
import { createSeededNoise3D, fractalNoise3D } from '../utils/noise.js';

export function applyDeformations(geometry, p) {
  const hasNoise = p.noiseAmplitude > 0.001;
  const hasAttractor = Math.abs(p.attractorStrength) > 0.001;
  const hasWave = p.waveAmplitude > 0.001;
  const hasBend = Math.abs(p.bendAngle) > 0.001;

  if (!hasNoise && !hasAttractor && !hasWave && !hasBend) return;

  geometry.computeVertexNormals();
  const posAttr = geometry.getAttribute('position');
  const normalAttr = geometry.getAttribute('normal');
  const count = posAttr.count;

  const noise3D = hasNoise ? createSeededNoise3D(p.noiseSeed) : null;
  const pos = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const attractor = hasAttractor ? new THREE.Vector3(p.attractorX, p.attractorY, p.attractorZ) : null;

  for (let i = 0; i < count; i++) {
    pos.fromBufferAttribute(posAttr, i);
    normal.fromBufferAttribute(normalAttr, i);

    let displacement = 0;

    // Fractal noise
    if (hasNoise) {
      displacement += fractalNoise3D(
        noise3D, pos.x, pos.y, pos.z,
        p.noiseOctaves, p.noiseFrequency, p.noiseAmplitude
      );
    }

    // Attractor
    if (hasAttractor) {
      const dist = pos.distanceTo(attractor);
      const falloff = Math.exp(-dist * dist / 50);
      displacement += p.attractorStrength * falloff;
    }

    // Wave
    if (hasWave) {
      displacement += p.waveAmplitude * Math.sin(pos.y * p.waveFrequency) * Math.cos(pos.x * 0.5);
    }

    // Displace along normal
    pos.addScaledVector(normal, displacement);

    // Bend
    if (hasBend) {
      const normalizedY = pos.y / Math.max(p.height, 1);
      const angle = p.bendAngle * normalizedY;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const x = pos.x * cosA - pos.z * sinA;
      const z = pos.x * sinA + pos.z * cosA;
      pos.x = x;
      pos.z = z;
    }

    posAttr.setXYZ(i, pos.x, pos.y, pos.z);
  }

  posAttr.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}
