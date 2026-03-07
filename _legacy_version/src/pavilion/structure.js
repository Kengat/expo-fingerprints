import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function createRibs(shellFunc, p, material) {
  if (p.ribCount === 0) return null;

  const geometries = [];
  const steps = 64;
  const ribRadius = p.ribThickness / 2;

  for (let i = 0; i < p.ribCount; i++) {
    const t = i / p.ribCount;
    const points = [];

    for (let j = 0; j <= steps; j++) {
      const s = j / steps;
      const target = new THREE.Vector3();
      if (p.ribDirection === 'meridional') {
        shellFunc(t, s, target);
      } else if (p.ribDirection === 'parallel') {
        shellFunc(s, t, target);
      } else {
        // diagonal
        const u = (t + s * 0.3) % 1;
        shellFunc(u, s, target);
      }
      points.push(target);
    }

    if (points.length < 2) continue;

    const curve = new THREE.CatmullRomCurve3(points);
    const tubeGeom = new THREE.TubeGeometry(curve, steps, ribRadius, 6, false);
    geometries.push(tubeGeom);
  }

  if (geometries.length === 0) return null;

  const merged = mergeGeometries(geometries);
  geometries.forEach(g => g.dispose());

  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createColumns(shellFunc, p, material) {
  if (p.columnCount === 0) return null;

  const group = new THREE.Group();

  for (let i = 0; i < p.columnCount; i++) {
    const angle = (i / p.columnCount) * Math.PI * 2;
    const radius = p.radiusBottom * 0.4;

    // Base point on ground
    const base = new THREE.Vector3(
      radius * Math.cos(angle), 0, radius * Math.sin(angle)
    );

    // Shell contact point
    const shellPoint = new THREE.Vector3();
    shellFunc(i / p.columnCount, 0.3, shellPoint);

    // Main trunk
    const mid = new THREE.Vector3().lerpVectors(base, shellPoint, 0.5);
    mid.x += (Math.random() - 0.5) * 2;
    mid.z += (Math.random() - 0.5) * 2;

    const trunkCurve = new THREE.CatmullRomCurve3([base, mid, shellPoint]);
    const trunkGeom = new THREE.TubeGeometry(trunkCurve, 24, 0.25, 8, false);
    const trunkMesh = new THREE.Mesh(trunkGeom, material);
    trunkMesh.castShadow = true;
    group.add(trunkMesh);

    // Branches
    for (let b = 0; b < p.columnBranching; b++) {
      const bParam = (i / p.columnCount + (b + 1) * 0.05) % 1;
      const branchTarget = new THREE.Vector3();
      shellFunc(bParam, 0.4 + b * 0.1, branchTarget);

      const splitPoint = trunkCurve.getPointAt(0.5 + b * 0.15);
      const branchMid = new THREE.Vector3().lerpVectors(splitPoint, branchTarget, 0.5);
      branchMid.y += 1;

      const branchCurve = new THREE.CatmullRomCurve3([splitPoint, branchMid, branchTarget]);
      const branchGeom = new THREE.TubeGeometry(branchCurve, 16, 0.12, 6, false);
      const branchMesh = new THREE.Mesh(branchGeom, material);
      branchMesh.castShadow = true;
      group.add(branchMesh);
    }
  }

  return group;
}
