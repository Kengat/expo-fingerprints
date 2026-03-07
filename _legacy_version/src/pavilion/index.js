import * as THREE from 'three';
import { createShellGeometry, getShellFunction } from './shell.js';
import { applyDeformations } from './deform.js';
import { createRibs, createColumns } from './structure.js';
import { applySkin } from './skin.js';
import { createScatter } from './scatter.js';

let rootGroup = null;

function disposeGroup(group) {
  group.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach(m => {
          if (m.map) m.map.dispose();
          if (m.alphaMap) m.alphaMap.dispose();
          m.dispose();
        });
      } else {
        if (child.material.map) child.material.map.dispose();
        if (child.material.alphaMap) child.material.alphaMap.dispose();
        child.material.dispose();
      }
    }
  });
}

function buildSinglePavilion(p) {
  const pavilionGroup = new THREE.Group();

  // 1. Shell geometry
  const shellGeom = createShellGeometry(p);
  applyDeformations(shellGeom, p);

  // 2. Material
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.materialColor),
    metalness: p.metalness,
    roughness: p.roughness,
    side: THREE.DoubleSide,
    wireframe: p.wireframe,
  });

  // 3. Skin (modifies material)
  applySkin(material, p);

  // 4. Shell mesh
  const shellMesh = new THREE.Mesh(shellGeom, material);
  shellMesh.castShadow = true;
  shellMesh.receiveShadow = true;
  pavilionGroup.add(shellMesh);

  // 5. Structure
  const structMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.materialColor).multiplyScalar(0.8),
    metalness: Math.min(p.metalness + 0.1, 1),
    roughness: p.roughness,
  });

  const shellFunc = getShellFunction(p);

  const ribs = createRibs(shellFunc, p, structMaterial);
  if (ribs) pavilionGroup.add(ribs);

  const columns = createColumns(shellFunc, p, structMaterial);
  if (columns) pavilionGroup.add(columns);

  // 6. Scatter
  const scatter = createScatter(shellGeom, p);
  if (scatter) pavilionGroup.add(scatter);

  return pavilionGroup;
}

function createPodium(p) {
  const podiumGroup = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.materialColor).multiplyScalar(0.9),
    metalness: Math.min(p.metalness + 0.15, 1),
    roughness: Math.max(p.roughness - 0.1, 0),
  });

  let geom;
  switch (p.podiumShape) {
    case 'rectangle':
      geom = new THREE.BoxGeometry(p.podiumRadius * 2, p.podiumHeight, p.podiumRadius * 2);
      break;
    case 'organic': {
      // Cylinder with noise-deformed top edge
      geom = new THREE.CylinderGeometry(
        p.podiumRadius, p.podiumRadius * 1.05, p.podiumHeight, 64
      );
      const pos = geom.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y > p.podiumHeight * 0.3) {
          const angle = Math.atan2(pos.getZ(i), pos.getX(i));
          const wave = Math.sin(angle * 5) * 0.3 + Math.sin(angle * 3) * 0.2;
          pos.setY(i, y + wave);
        }
      }
      pos.needsUpdate = true;
      geom.computeVertexNormals();
      break;
    }
    default: // circle
      geom = new THREE.CylinderGeometry(
        p.podiumRadius, p.podiumRadius * 1.02, p.podiumHeight, 64
      );
      break;
  }

  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.y = p.podiumHeight / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  podiumGroup.add(mesh);

  return podiumGroup;
}

function applyComposition(scene, singlePavilion, p) {
  const compositionGroup = new THREE.Group();

  // Podium (below everything)
  if (p.podiumEnabled) {
    const podium = createPodium(p);
    compositionGroup.add(podium);
    // Shift pavilion up by podium height
    singlePavilion.position.y = p.podiumHeight;
  }

  compositionGroup.add(singlePavilion);

  switch (p.compositionMode) {
    case 'mirror': {
      const mirror = singlePavilion.clone();
      mirror.scale.x = -1;
      mirror.position.x = p.copySpacing;
      if (p.podiumEnabled) mirror.position.y = p.podiumHeight;
      compositionGroup.add(mirror);
      break;
    }
    case 'radial': {
      for (let i = 1; i < p.copyCount; i++) {
        const angle = (i / p.copyCount) * Math.PI * 2;
        const copy = singlePavilion.clone();
        copy.position.x = Math.cos(angle) * p.copySpacing;
        copy.position.z = Math.sin(angle) * p.copySpacing;
        if (p.podiumEnabled) copy.position.y = p.podiumHeight;
        copy.rotation.y = angle + p.copyRotation * i;
        const scale = Math.pow(p.copyScaleDecay, i);
        copy.scale.set(scale, scale, scale);
        compositionGroup.add(copy);
      }
      break;
    }
    case 'linear': {
      for (let i = 1; i < p.copyCount; i++) {
        const copy = singlePavilion.clone();
        copy.position.x = i * p.copySpacing;
        if (p.podiumEnabled) copy.position.y = p.podiumHeight;
        copy.rotation.y = p.copyRotation * i;
        const scale = Math.pow(p.copyScaleDecay, i);
        copy.scale.set(scale, scale, scale);
        compositionGroup.add(copy);
      }
      break;
    }
    // 'single' — no copies needed
  }

  return compositionGroup;
}

export function buildPavilion(scene, p) {
  // Remove old
  if (rootGroup) {
    scene.remove(rootGroup);
    disposeGroup(rootGroup);
  }

  const singlePavilion = buildSinglePavilion(p);
  rootGroup = applyComposition(scene, singlePavilion, p);

  scene.add(rootGroup);
  return rootGroup;
}
