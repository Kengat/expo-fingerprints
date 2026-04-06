import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

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

function createPositionOnlyClone(geometry) {
  const clone = new THREE.BufferGeometry();
  clone.setAttribute('position', geometry.getAttribute('position').clone());
  if (geometry.index) {
    clone.setIndex(geometry.index.clone());
  }
  return clone;
}

function createEdgeCylinder(start, end, radius) {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  if (length <= 1e-5) return null;

  const geometry = new THREE.CylinderGeometry(radius, radius, length, 8, 1, false);
  const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize()
  );
  const matrix = new THREE.Matrix4().compose(midpoint, quaternion, new THREE.Vector3(1, 1, 1));
  geometry.applyMatrix4(matrix);
  return geometry;
}

function buildGlassTriData(geometry) {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const index = geometry.getIndex();
  if (!pos || !uv) return null;

  const triCount = index ? index.count / 3 : pos.count / 3;
  const triData = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    triData.push({
      uv0x: uv.getX(i0), uv0y: uv.getY(i0),
      uv1x: uv.getX(i1), uv1y: uv.getY(i1),
      uv2x: uv.getX(i2), uv2y: uv.getY(i2),
      i0, i1, i2,
    });
  }
  return { pos, triData };
}

function barycentricUV(px, py, tri) {
  const { uv0x, uv0y, uv1x, uv1y, uv2x, uv2y } = tri;
  const d00 = (uv1x - uv0x) * (uv1x - uv0x) + (uv1y - uv0y) * (uv1y - uv0y);
  const d01 = (uv1x - uv0x) * (uv2x - uv0x) + (uv1y - uv0y) * (uv2y - uv0y);
  const d11 = (uv2x - uv0x) * (uv2x - uv0x) + (uv2y - uv0y) * (uv2y - uv0y);
  const d20 = (px - uv0x) * (uv1x - uv0x) + (py - uv0y) * (uv1y - uv0y);
  const d21 = (px - uv0x) * (uv2x - uv0x) + (py - uv0y) * (uv2y - uv0y);

  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-10) return null;

  const bv = (d11 * d20 - d01 * d21) / denom;
  const bw = (d00 * d21 - d01 * d20) / denom;
  const bu = 1 - bv - bw;

  if (bu >= -0.001 && bv >= -0.001 && bw >= -0.001) {
    return { u: bu, v: bv, w: bw };
  }
  return null;
}

function projectUVToSurface(cu, cv, surfaceData) {
  if (!surfaceData) return null;

  for (const tri of surfaceData.triData) {
    const bary = barycentricUV(cu, cv, tri);
    if (!bary) continue;
    return new THREE.Vector3(
      surfaceData.pos.getX(tri.i0) * bary.u + surfaceData.pos.getX(tri.i1) * bary.v + surfaceData.pos.getX(tri.i2) * bary.w,
      surfaceData.pos.getY(tri.i0) * bary.u + surfaceData.pos.getY(tri.i1) * bary.v + surfaceData.pos.getY(tri.i2) * bary.w,
      surfaceData.pos.getZ(tri.i0) * bary.u + surfaceData.pos.getZ(tri.i1) * bary.v + surfaceData.pos.getZ(tri.i2) * bary.w
    );
  }
  return null;
}

function buildProjectedGridPolylines(geometry, p) {
  const surfaceData = buildGlassTriData(geometry);
  if (!surfaceData) return [];

  const cellCountU = Math.max(1, Math.round(p.glassGridU || 4));
  const cellCountV = Math.max(1, Math.round(p.glassGridV || 5));
  const samplesPerCell = 6;
  const polylines = [];

  const pushLineSegments = (uvPoints) => {
    let current = [];
    for (const uvPoint of uvPoints) {
      const projected = projectUVToSurface(uvPoint.u, uvPoint.v, surfaceData);
      if (!projected) {
        if (current.length >= 2) polylines.push(current);
        current = [];
        continue;
      }

      if (current.length > 0 && projected.distanceToSquared(current[current.length - 1]) < 1e-8) {
        continue;
      }

      current.push(projected);
    }
    if (current.length >= 2) polylines.push(current);
  };

  for (let i = 0; i <= cellCountU; i++) {
    const u = i / cellCountU;
    const uvPoints = [];
    for (let s = 0; s <= cellCountV * samplesPerCell; s++) {
      uvPoints.push({ u, v: s / (cellCountV * samplesPerCell) });
    }
    pushLineSegments(uvPoints);
  }

  for (let i = 0; i <= cellCountV; i++) {
    const v = i / cellCountV;
    const uvPoints = [];
    for (let s = 0; s <= cellCountU * samplesPerCell; s++) {
      uvPoints.push({ u: s / (cellCountU * samplesPerCell), v });
    }
    pushLineSegments(uvPoints);
  }

  return polylines;
}

function dedupeNodePoints(points, tolerance) {
  const unique = [];
  const tolSq = tolerance * tolerance;

  for (const point of points) {
    let exists = false;
    for (const current of unique) {
      if (current.distanceToSquared(point) <= tolSq) {
        exists = true;
        break;
      }
    }
    if (!exists) unique.push(point);
  }

  return unique;
}

function snapPointKey(point, tolerance) {
  const tx = Math.round(point.x / tolerance);
  const ty = Math.round(point.y / tolerance);
  const tz = Math.round(point.z / tolerance);
  return `${tx}:${ty}:${tz}`;
}

function buildFrameNetworkGeometry(polylines, radius) {
  const segmentGeometries = [];
  const nodePoints = [];
  const seenSegments = new Set();
  const tolerance = Math.max(radius * 0.6, 1e-4);

  for (const polyline of polylines) {
    if (!polyline || polyline.length < 2) continue;

    nodePoints.push(...polyline.map((point) => point.clone()));

    for (let i = 1; i < polyline.length; i++) {
      const start = polyline[i - 1];
      const end = polyline[i];
      const keyA = snapPointKey(start, tolerance);
      const keyB = snapPointKey(end, tolerance);
      const segmentKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
      if (seenSegments.has(segmentKey)) continue;
      seenSegments.add(segmentKey);

      const segment = createEdgeCylinder(start, end, radius);
      if (segment) segmentGeometries.push(segment);
    }
  }

  const uniqueNodes = dedupeNodePoints(nodePoints, Math.max(radius * 1.2, 1e-4));
  const nodeGeometries = uniqueNodes.map((point) => {
    const geom = new THREE.SphereGeometry(radius, 10, 8);
    geom.translate(point.x, point.y, point.z);
    return geom;
  });

  const all = [...segmentGeometries, ...nodeGeometries];
  if (all.length === 0) return null;

  const merged = mergeGeometries(all, false);
  all.forEach((geometry) => geometry.dispose());
  return merged;
}

function edgesToPolylines(edges) {
  return edges.map(({ start, end }) => [start.clone(), end.clone()]);
}

function collectGlassFrameEdges(geometry, p) {
  const positionOnly = createPositionOnlyClone(geometry);
  const welded = mergeVertices(positionOnly, 1e-3);
  welded.computeVertexNormals();

  const pos = welded.getAttribute('position');
  const index = welded.getIndex();
  if (!pos || !index) {
    welded.dispose();
    positionOnly.dispose();
    return [];
  }

  const edgeMap = new Map();
  const thresholdRadians = THREE.MathUtils.degToRad(p.glassSharpAngle ?? 18);
  const faceNormal = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  for (let faceIndex = 0; faceIndex < index.count; faceIndex += 3) {
    const i0 = index.getX(faceIndex);
    const i1 = index.getX(faceIndex + 1);
    const i2 = index.getX(faceIndex + 2);

    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    faceNormal.crossVectors(ab, ac).normalize();
    if (faceNormal.lengthSq() < 0.5) continue;

    for (const [va, vb] of [[i0, i1], [i1, i2], [i2, i0]]) {
      const lo = Math.min(va, vb);
      const hi = Math.max(va, vb);
      const key = `${lo}_${hi}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, { a: lo, b: hi, normals: [] });
      }
      edgeMap.get(key).normals.push(faceNormal.clone());
    }
  }

  const edges = [];
  for (const entry of edgeMap.values()) {
    const normalCount = entry.normals.length;
    let keep = false;

    if (p.glassFrameMode === 'boundary') {
      keep = normalCount === 1;
    } else {
      if (normalCount === 1) {
        keep = true;
      } else if (normalCount === 2) {
        const angle = entry.normals[0].angleTo(entry.normals[1]);
        keep = angle >= thresholdRadians;
      } else {
        keep = true;
      }
    }

    if (!keep) continue;

    const start = new THREE.Vector3().fromBufferAttribute(pos, entry.a);
    const end = new THREE.Vector3().fromBufferAttribute(pos, entry.b);
    edges.push({ start, end });
  }

  welded.dispose();
  positionOnly.dispose();
  return edges;
}

export function createGlassFrameSystem(glassGeometry, p) {
  if (!glassGeometry) return null;

  const group = new THREE.Group();
  group.name = 'glass-frame-system';

  const panelMaterial = new THREE.MeshPhysicalMaterial({
    color: p.glassPanelColor || '#d8eefc',
    transmission: 0.45,
    transparent: true,
    opacity: p.glassPanelOpacity ?? 0.22,
    roughness: 0.08,
    metalness: 0.0,
    thickness: 0.15,
    ior: 1.45,
    side: THREE.DoubleSide,
  });
  const panelMesh = new THREE.Mesh(glassGeometry.clone(), panelMaterial);
  panelMesh.name = 'glass-panels';
  panelMesh.castShadow = true;
  panelMesh.receiveShadow = true;
  group.add(panelMesh);

  if (!p.glassSystemEnabled) {
    return group;
  }

  const frameMode = p.glassFrameMode === 'feature' ? 'hybrid' : (p.glassFrameMode || 'grid');
  const polylines = [];

  if (frameMode === 'grid' || frameMode === 'hybrid') {
    polylines.push(...buildProjectedGridPolylines(glassGeometry, p));
  }

  if (frameMode === 'boundary' || frameMode === 'hybrid' || polylines.length === 0) {
    const boundaryEdges = collectGlassFrameEdges(glassGeometry, {
      ...p,
      glassFrameMode: 'boundary',
    });
    polylines.push(...edgesToPolylines(boundaryEdges));
  }

  const mergedFrameGeometry = buildFrameNetworkGeometry(polylines, p.glassFrameRadius || 0.08);
  if (!mergedFrameGeometry) {
    return group;
  }

  const frameMaterial = new THREE.MeshStandardMaterial({
    color: p.glassFrameColor || '#6b7785',
    roughness: 0.45,
    metalness: 0.7,
    side: THREE.DoubleSide,
  });
  const frameMesh = new THREE.Mesh(mergedFrameGeometry, frameMaterial);
  frameMesh.name = 'glass-frame-tubes';
  frameMesh.castShadow = true;
  frameMesh.receiveShadow = true;
  group.add(frameMesh);

  return group;
}
