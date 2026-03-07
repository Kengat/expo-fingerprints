import * as THREE from 'three';
import { seededRandom } from '../utils/math.js';

// Create a simple sunflower geometry (merged)
function createSunflowerGeom() {
  const group = new THREE.Group();

  // Stem
  const stemGeom = new THREE.CylinderGeometry(0.03, 0.04, 0.6, 6);
  stemGeom.translate(0, 0.3, 0);

  // Center disc
  const centerGeom = new THREE.SphereGeometry(0.12, 8, 6);
  centerGeom.translate(0, 0.62, 0);

  // Petals (ring of elongated shapes)
  const petalGeoms = [];
  const petalCount = 12;
  for (let i = 0; i < petalCount; i++) {
    const angle = (i / petalCount) * Math.PI * 2;
    const petal = new THREE.SphereGeometry(0.08, 4, 3);
    petal.scale(1, 0.3, 2.5);
    const m = new THREE.Matrix4();
    m.makeRotationZ(angle);
    m.setPosition(
      Math.cos(angle) * 0.2,
      0.6,
      Math.sin(angle) * 0.2
    );
    petal.applyMatrix4(m);
    petalGeoms.push(petal);
  }

  // Merge all into one geometry
  const allGeoms = [stemGeom, centerGeom, ...petalGeoms];
  const merged = mergeSimple(allGeoms);
  allGeoms.forEach(g => g.dispose());
  return merged;
}

// Create gont (wooden shingle) geometry
function createGontGeom() {
  const geom = new THREE.BoxGeometry(0.3, 0.02, 0.5);
  // Slight curve: bend vertices
  const pos = geom.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    pos.setY(i, pos.getY(i) + z * z * 0.3);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  return geom;
}

// Create abstract flower
function createFlowerGeom() {
  const petalGeoms = [];
  const petalCount = 6;
  for (let i = 0; i < petalCount; i++) {
    const angle = (i / petalCount) * Math.PI * 2;
    const petal = new THREE.SphereGeometry(0.1, 5, 4);
    petal.scale(0.6, 0.2, 1.5);
    const m = new THREE.Matrix4();
    m.makeRotationY(angle);
    m.setPosition(Math.cos(angle) * 0.12, 0.05, Math.sin(angle) * 0.12);
    petal.applyMatrix4(m);
    petalGeoms.push(petal);
  }
  // Center
  const center = new THREE.SphereGeometry(0.06, 6, 4);
  center.translate(0, 0.05, 0);
  petalGeoms.push(center);

  const merged = mergeSimple(petalGeoms);
  petalGeoms.forEach(g => g.dispose());
  return merged;
}

// Create spike/wheat element
function createSpikeGeom() {
  return new THREE.ConeGeometry(0.06, 0.5, 6);
}

// Create cube element
function createCubeGeom() {
  return new THREE.BoxGeometry(0.2, 0.2, 0.2);
}

// Create kalyna (viburnum berry cluster)
function createKalynaGeom() {
  const geoms = [];
  const rng = seededRandom(123);
  const berryCount = 8;
  for (let i = 0; i < berryCount; i++) {
    const berry = new THREE.SphereGeometry(0.04, 5, 4);
    berry.translate(
      (rng() - 0.5) * 0.15,
      rng() * 0.1,
      (rng() - 0.5) * 0.15
    );
    geoms.push(berry);
  }
  // Small stem
  const stem = new THREE.CylinderGeometry(0.01, 0.015, 0.12, 4);
  stem.translate(0, -0.06, 0);
  geoms.push(stem);

  const merged = mergeSimple(geoms);
  geoms.forEach(g => g.dispose());
  return merged;
}

// Simple geometry merge (no dependencies)
function mergeSimple(geometries) {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of geometries) {
    totalVerts += g.getAttribute('position').count;
    totalIndices += g.index ? g.index.count : g.getAttribute('position').count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = [];
  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of geometries) {
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      positions[(vertOffset + i) * 3] = pos.getX(i);
      positions[(vertOffset + i) * 3 + 1] = pos.getY(i);
      positions[(vertOffset + i) * 3 + 2] = pos.getZ(i);
      if (norm) {
        normals[(vertOffset + i) * 3] = norm.getX(i);
        normals[(vertOffset + i) * 3 + 1] = norm.getY(i);
        normals[(vertOffset + i) * 3 + 2] = norm.getZ(i);
      }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        indices.push(g.index.getX(i) + vertOffset);
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        indices.push(i + vertOffset);
      }
    }
    vertOffset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setIndex(indices);
  return merged;
}

const scatterFactories = {
  sunflower: createSunflowerGeom,
  gont: createGontGeom,
  flower: createFlowerGeom,
  spike: createSpikeGeom,
  cube: createCubeGeom,
  kalyna: createKalynaGeom,
};

export function createScatter(shellGeom, p) {
  if (!p.scatterEnabled || p.scatterDensity === 0) return null;

  const factory = scatterFactories[p.scatterType];
  if (!factory) return null;

  const baseGeom = factory();
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.scatterColor),
    metalness: 0.1,
    roughness: 0.6,
  });

  const count = p.scatterDensity;
  const instancedMesh = new THREE.InstancedMesh(baseGeom, material, count);
  instancedMesh.castShadow = true;
  instancedMesh.receiveShadow = true;

  const rng = seededRandom(p.scatterSeed);
  const posAttr = shellGeom.getAttribute('position');
  const normalAttr = shellGeom.getAttribute('normal');
  const vertexCount = posAttr.count;

  const dummy = new THREE.Object3D();
  const normal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion();

  for (let i = 0; i < count; i++) {
    // Pick random vertex on the shell
    const vertIdx = Math.floor(rng() * vertexCount);
    const x = posAttr.getX(vertIdx);
    const y = posAttr.getY(vertIdx);
    const z = posAttr.getZ(vertIdx);

    dummy.position.set(x, y, z);

    // Orient to surface normal
    if (p.scatterAlignToNormal && normalAttr) {
      normal.set(
        normalAttr.getX(vertIdx),
        normalAttr.getY(vertIdx),
        normalAttr.getZ(vertIdx)
      ).normalize();

      quat.setFromUnitVectors(up, normal);
      dummy.quaternion.copy(quat);

      // Add random rotation around normal
      const randomRot = new THREE.Quaternion().setFromAxisAngle(normal, rng() * Math.PI * 2);
      dummy.quaternion.multiply(randomRot);
    } else {
      dummy.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    }

    // Scale with variation
    const baseScale = p.scatterScale;
    const variation = 1 + (rng() - 0.5) * 2 * p.scatterScaleVariation;
    const s = baseScale * Math.max(variation, 0.1);
    dummy.scale.set(s, s, s);

    dummy.updateMatrix();
    instancedMesh.setMatrixAt(i, dummy.matrix);
  }

  instancedMesh.instanceMatrix.needsUpdate = true;
  return instancedMesh;
}
