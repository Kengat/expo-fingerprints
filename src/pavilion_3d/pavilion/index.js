import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createShellGeometry, getShellFunction, stitchGeometrySeam, thickenGeometry, thickenGeometryGeneric } from './shell.js';
import { applyDeformations } from './deform.js';
import { createRibs, createColumns, createGlassFrameSystem } from './structure.js';
import { applySkin } from './skin.js';
import { createScatter } from './scatter.js';
import { createFabricDrape } from './fabric.js';
import { generateUVCheckerTexture } from '../utils/importModel.js';
// import { Evaluator, Brush, SUBTRACTION } from 'three-bvh-csg'; // Removed in favor of manifold-3d

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

const DRILL_HEIGHT = 12;
const DRILL_SEGMENTS = 8;
const MIN_WORLD_RADIUS = 0.02;
const MAX_WORLD_RADIUS = 2.0;
const MIN_CIRCLE_DISTANCE_SQ = 0.001;
const MIN_TUBE_SEGMENTS = 4;
const MAX_TUBE_SEGMENTS = 40;

function deduplicateCircles(circles) {
  const result = [];
  for (let i = 0; i < circles.length; i++) {
    let dominated = false;
    for (let j = 0; j < result.length; j++) {
      const dx = circles[i].x - result[j].x;
      const dy = circles[i].y - result[j].y;
      if (dx * dx + dy * dy < MIN_CIRCLE_DISTANCE_SQ) {
        dominated = true;
        break;
      }
    }
    if (!dominated) result.push(circles[i]);
  }
  return result;
}

function computeSurfacePointAndNormal(shellFunc, u, v) {
  const pt = new THREE.Vector3();
  shellFunc(u, v, pt);

  const ptU = new THREE.Vector3();
  const ptV = new THREE.Vector3();
  const du = u < 0.99 ? 0.01 : -0.01;
  const dv = v < 0.99 ? 0.01 : -0.01;
  shellFunc(u + du, v, ptU);
  shellFunc(u, v + dv, ptV);

  const tangentU = ptU.sub(pt).multiplyScalar(Math.sign(du)).normalize();
  const tangentV = ptV.sub(pt).multiplyScalar(Math.sign(dv)).normalize();
  const normal = new THREE.Vector3().crossVectors(tangentU, tangentV).normalize();

  return { pt, normal };
}

function estimateWorldRadius(shellFunc, u, v, radiusUV) {
  const base = new THREE.Vector3();
  shellFunc(u, v, base);

  const sampleU = new THREE.Vector3();
  const sampleV = new THREE.Vector3();
  shellFunc(Math.min(1, u + radiusUV), v, sampleU);
  shellFunc(u, Math.min(1, v + radiusUV), sampleV);

  const distU = base.distanceTo(sampleU);
  const distV = base.distanceTo(sampleV);

  return Math.max(MIN_WORLD_RADIUS, Math.min(MAX_WORLD_RADIUS, (distU + distV) / 2));
}

function measurePolylineLength2D(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    total += Math.hypot(dx, dy);
  }
  return total;
}

function measurePolylineCurviness2D(points) {
  if (!points || points.length < 3) {
    return { straightness: 1, turniness: 0 };
  }

  const lineLength = measurePolylineLength2D(points);
  if (lineLength <= 1e-6) {
    return { straightness: 1, turniness: 0 };
  }

  const start = points[0];
  const end = points[points.length - 1];
  const directDistance = Math.hypot(end.x - start.x, end.y - start.y);
  const straightness = THREE.MathUtils.clamp(directDistance / lineLength, 0, 1);

  let totalTurn = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const ax = points[i].x - points[i - 1].x;
    const ay = points[i].y - points[i - 1].y;
    const bx = points[i + 1].x - points[i].x;
    const by = points[i + 1].y - points[i].y;
    const lenA = Math.hypot(ax, ay);
    const lenB = Math.hypot(bx, by);

    if (lenA <= 1e-6 || lenB <= 1e-6) continue;

    const dot = THREE.MathUtils.clamp((ax * bx + ay * by) / (lenA * lenB), -1, 1);
    totalTurn += Math.acos(dot);
  }

  return {
    straightness,
    turniness: totalTurn,
  };
}

function getAdaptiveTubeSegmentCount(line2D, canvasW, canvasH) {
  if (!line2D || line2D.length < 2) return MIN_TUBE_SEGMENTS;

  const lineLength = measurePolylineLength2D(line2D);
  const maxCanvasSpan = Math.max(canvasW, canvasH, 1);
  const targetSegmentLength = maxCanvasSpan / MAX_TUBE_SEGMENTS;
  const lengthBasedSegments = lineLength / Math.max(targetSegmentLength, 1e-6);
  const { straightness, turniness } = measurePolylineCurviness2D(line2D);
  const windingScore = THREE.MathUtils.clamp((1 - straightness) * 0.85 + (turniness / (Math.PI * 1.5)) * 0.75, 0, 1);
  const detailFactor = THREE.MathUtils.lerp(0.65, 1.6, windingScore);
  const segmentCount = Math.round(lengthBasedSegments * detailFactor);

  return THREE.MathUtils.clamp(segmentCount, MIN_TUBE_SEGMENTS, MAX_TUBE_SEGMENTS);
}

function buildDrillGeometries(circles, canvasW, canvasH, shellFunc, thickness = 0) {
  const drillGeometries = [];
  const dummyObj = new THREE.Object3D();

  for (const circle of circles) {
    const u = circle.x / canvasW;
    const v = 1.0 - (circle.y / canvasH);

    if (u < 0.005 || u > 0.995 || v < 0.005 || v > 0.995) continue;

    const radiusUV = circle.r / Math.max(canvasW, canvasH);
    const { pt, normal } = computeSurfacePointAndNormal(shellFunc, u, v);

    if (normal.lengthSq() < 0.5) continue;

    const worldRadius = estimateWorldRadius(shellFunc, u, v, radiusUV);

    const drillHeight = thickness > 0 ? thickness * 2 : 5.0;
    const drillGeom = new THREE.CylinderGeometry(
      worldRadius, worldRadius, drillHeight, DRILL_SEGMENTS
    );

    dummyObj.position.copy(pt);
    dummyObj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    dummyObj.updateMatrix();

    drillGeom.applyMatrix4(dummyObj.matrix);
    drillGeometries.push(drillGeom);
  }

  return drillGeometries;
}

/**
 * Build drill geometries by sampling positions from an actual mesh's UV mapping.
 * Used for imported models that don't have a parametric shellFunc.
 */
function buildDrillGeometriesFromMesh(circles, canvasW, canvasH, geometry, thickness = 0) {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const nrm = geometry.getAttribute('normal');

  if (!uv) {
    console.warn('[Bake] Imported geometry has no UVs — cannot place drills');
    return [];
  }

  if (!nrm) geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');

  // Build triangle UV lookup
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;

  // For each circle, find the containing UV triangle via barycentric test
  const drillGeometries = [];
  const dummyObj = new THREE.Object3D();

  // Pre-extract UV triangle data for efficiency
  const triData = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

    triData.push({
      uv0x: uv.getX(i0), uv0y: uv.getY(i0),
      uv1x: uv.getX(i1), uv1y: uv.getY(i1),
      uv2x: uv.getX(i2), uv2y: uv.getY(i2),
      i0, i1, i2
    });
  }

  for (const circle of circles) {
    const cu = circle.x / canvasW;
    const cv = 1.0 - (circle.y / canvasH);

    if (cu < 0.005 || cu > 0.995 || cv < 0.005 || cv > 0.995) continue;

    const candidates = [];
    // Find all triangles containing this UV point (to support overlapping UVs like Box projection)
    for (const tri of triData) {
      const bary = barycentricUV(cu, cv, tri);
      if (!bary) continue;

      // Interpolate 3D position
      const pt = new THREE.Vector3(
        pos.getX(tri.i0) * bary.u + pos.getX(tri.i1) * bary.v + pos.getX(tri.i2) * bary.w,
        pos.getY(tri.i0) * bary.u + pos.getY(tri.i1) * bary.v + pos.getY(tri.i2) * bary.w,
        pos.getZ(tri.i0) * bary.u + pos.getZ(tri.i1) * bary.v + pos.getZ(tri.i2) * bary.w
      );

      // Interpolate normal
      const normal = new THREE.Vector3(
        normals.getX(tri.i0) * bary.u + normals.getX(tri.i1) * bary.v + normals.getX(tri.i2) * bary.w,
        normals.getY(tri.i0) * bary.u + normals.getY(tri.i1) * bary.v + normals.getY(tri.i2) * bary.w,
        normals.getZ(tri.i0) * bary.u + normals.getZ(tri.i1) * bary.v + normals.getZ(tri.i2) * bary.w
      ).normalize();

      if (normal.lengthSq() < 0.5) continue;

      // Estimate world radius from UV neighborhood
      const radiusUV = circle.r / Math.max(canvasW, canvasH);
      const worldRadius = Math.max(MIN_WORLD_RADIUS, Math.min(MAX_WORLD_RADIUS, radiusUV * 15));

      const drillHeight = thickness > 0 ? thickness * 2 : 5.0;
      const drillGeom = new THREE.CylinderGeometry(
        worldRadius, worldRadius, drillHeight, DRILL_SEGMENTS
      );

      const dummyObj = new THREE.Object3D();
      dummyObj.position.copy(pt);
      dummyObj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      dummyObj.updateMatrix();
      drillGeom.applyMatrix4(dummyObj.matrix);

      candidates.push({ pt, drillGeom });
    }

    if (candidates.length === 0) continue;

    // Filter overlapping candidates (e.g. inner vs outer shell of the same wall sharing UV)
    // We only want ONE drill per "wall" surface to avoid inside-out cuts.
    const uniqueCandidates = [];
    const MERGE_DIST = (thickness > 0 ? thickness : 2.0) * 1.5;

    for (const c of candidates) {
      let isDupe = false;
      for (const u of uniqueCandidates) {
        if (c.pt.distanceTo(u.pt) < MERGE_DIST) {
          isDupe = true;
          break;
        }
      }
      if (!isDupe) uniqueCandidates.push(c);
    }

    for (const u of uniqueCandidates) {
      drillGeometries.push(u.drillGeom);
    }
  }

  return drillGeometries;
}

/**
 * Create a watertight, manifold tube geometry with smooth hemisphere end caps.
 * Builds vertices directly from Frenet frames with exactly `radialSegments`
 * per ring and uses modulo wrapping, so every edge is shared by exactly 2 faces.
 * Hemisphere caps are derived from actual ring vertex positions (not Frenet N/B)
 * for robustness at high-curvature areas where Frenet frames can become unstable.
 */
function createClosedTubeGeometry(curve, tubularSegments, radius, radialSegments) {
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const positions = [];
  const indices = [];
  const CAP_RINGS = 4; // latitude rings on each hemisphere cap
  const rings = [];
  
  function stabilizeEndFrame(targetIndex, neighborIndex) {
    const tangent = frames.tangents[targetIndex].clone().normalize();
    let normal = frames.normals[neighborIndex].clone();
    normal.sub(tangent.clone().multiplyScalar(normal.dot(tangent)));

    if (normal.lengthSq() < 1e-8) {
      normal = frames.binormals[neighborIndex].clone();
      normal.sub(tangent.clone().multiplyScalar(normal.dot(tangent)));
    }

    if (normal.lengthSq() < 1e-8) return;

    normal.normalize();
    const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    const orthoNormal = new THREE.Vector3().crossVectors(binormal, tangent).normalize();
    frames.normals[targetIndex] = orthoNormal;
    frames.binormals[targetIndex] = binormal;
  }

  if (tubularSegments >= 2) {
    stabilizeEndFrame(0, 1);
    stabilizeEndFrame(tubularSegments, tubularSegments - 1);
  }

  // 1. Generate tube ring vertices — exactly radialSegments per ring
  for (let i = 0; i <= tubularSegments; i++) {
    const P = curve.getPointAt(i / tubularSegments);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    const ring = [];

    for (let j = 0; j < radialSegments; j++) {
      const theta = (j / radialSegments) * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);

      ring.push(new THREE.Vector3(
        P.x + radius * (cosT * N.x + sinT * B.x),
        P.y + radius * (cosT * N.y + sinT * B.y),
        P.z + radius * (cosT * N.z + sinT * B.z)
      ));
    }

    rings.push(ring);
  }

  for (let i = 1; i <= tubularSegments; i++) {
    const prevRing = rings[i - 1];
    const ring = rings[i];
    let bestShift = 0;
    let bestScore = Infinity;

    for (let shift = 0; shift < radialSegments; shift++) {
      let score = 0;
      for (let j = 0; j < radialSegments; j++) {
        score += prevRing[j].distanceToSquared(ring[(j + shift) % radialSegments]);
      }
      if (score < bestScore) {
        bestScore = score;
        bestShift = shift;
      }
    }

    if (bestShift !== 0) {
      rings[i] = ring.map((_, j) => ring[(j + bestShift) % radialSegments]);
    }
  }

  for (let i = 0; i <= tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const p = rings[i][j];
      positions.push(p.x, p.y, p.z);
    }
  }

  // 2. Generate tube body quad faces (two triangles per quad)
  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * radialSegments + j;
      const b = i * radialSegments + (j + 1) % radialSegments;
      const c = (i + 1) * radialSegments + (j + 1) % radialSegments;
      const d = (i + 1) * radialSegments + j;

      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }
  const bodyIndexCount = indices.length;

  // Helper: compute ring center from actual vertex positions
  function getRingCenter(ringStartIdx) {
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < radialSegments; j++) {
      const idx = (ringStartIdx + j) * 3;
      cx += positions[idx];
      cy += positions[idx + 1];
      cz += positions[idx + 2];
    }
    return new THREE.Vector3(cx / radialSegments, cy / radialSegments, cz / radialSegments);
  }

  // Helper: build hemisphere cap from actual ring vertex positions
  // tangent: unit vector pointing outward from tube end (away from tube body)
  // flipWinding: true for start cap (rings go opposite to tube body), false for end cap
  function buildHemisphereCap(ringStartIdx, tangent, flipWinding) {
    const center = getRingCenter(ringStartIdx);
    let prevRingStart = ringStartIdx;

    for (let ring = 1; ring <= CAP_RINGS; ring++) {
      const phi = (ring / CAP_RINGS) * (Math.PI / 2);
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);

      if (ring < CAP_RINGS) {
        // Intermediate ring — shrink radially from actual ring, offset along tangent
        const currentRingStart = positions.length / 3;
        for (let j = 0; j < radialSegments; j++) {
          const origIdx = (ringStartIdx + j) * 3;
          const dx = positions[origIdx] - center.x;
          const dy = positions[origIdx + 1] - center.y;
          const dz = positions[origIdx + 2] - center.z;

          positions.push(
            center.x + cosP * dx + sinP * radius * tangent.x,
            center.y + cosP * dy + sinP * radius * tangent.y,
            center.z + cosP * dz + sinP * radius * tangent.z
          );
        }

        // Connect this ring to the previous ring with quads
        for (let j = 0; j < radialSegments; j++) {
          const a = prevRingStart + j;
          const b = prevRingStart + (j + 1) % radialSegments;
          const c = currentRingStart + (j + 1) % radialSegments;
          const d = currentRingStart + j;

          if (flipWinding) {
            indices.push(a, d, b);
            indices.push(b, d, c);
          } else {
            indices.push(a, b, d);
            indices.push(b, c, d);
          }
        }

        prevRingStart = currentRingStart;
      } else {
        // Pole vertex
        const poleIdx = positions.length / 3;
        positions.push(
          center.x + radius * tangent.x,
          center.y + radius * tangent.y,
          center.z + radius * tangent.z
        );

        for (let j = 0; j < radialSegments; j++) {
          if (flipWinding) {
            indices.push(prevRingStart + j, poleIdx, prevRingStart + (j + 1) % radialSegments);
          } else {
            indices.push(prevRingStart + (j + 1) % radialSegments, poleIdx, prevRingStart + j);
          }
        }
      }
    }
  }

  // 3. Start cap — tangent points outward from tube start, needs flipped winding
  const startCenter = getRingCenter(0);
  const nextCenter = getRingCenter(radialSegments);
  const startTangent = new THREE.Vector3().subVectors(startCenter, nextCenter).normalize();
  if (startTangent.lengthSq() < 0.5) {
    startTangent.copy(curve.getTangentAt(0).normalize().negate());
  }
  const startCapIndexStart = indices.length;
  buildHemisphereCap(0, startTangent, true);
  const startCapIndexCount = indices.length - startCapIndexStart;

  // 4. End cap — tangent points outward from tube end, normal winding
  const endRingStart = tubularSegments * radialSegments;
  const endCenter = getRingCenter(endRingStart);
  const prevCenter = getRingCenter((tubularSegments - 1) * radialSegments);
  const endTangent = new THREE.Vector3().subVectors(endCenter, prevCenter).normalize();
  if (endTangent.lengthSq() < 0.5) {
    endTangent.copy(curve.getTangentAt(1).normalize());
  }
  const endCapIndexStart = indices.length;
  buildHemisphereCap(endRingStart, endTangent, false);
  const endCapIndexCount = indices.length - endCapIndexStart;

  const closedGeom = new THREE.BufferGeometry();
  closedGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  closedGeom.setIndex(indices);
  closedGeom.computeVertexNormals();
  closedGeom.userData.seamDebug = {
    radialSegments,
    tubularSegments,
    bodyIndexCount,
    startCapIndexStart,
    startCapIndexCount,
    endCapIndexStart,
    endCapIndexCount,
  };
  return closedGeom;
}

function createClosedTubeGeometryTransport(curveOrCenters, tubularSegments, radius, radialSegments) {
  const positions = [];
  const indices = [];
  const CAP_RINGS = 4;
  const rings = [];
  const centers = Array.isArray(curveOrCenters)
    ? curveOrCenters.map((point) => point.clone())
    : [];
  const tangents = [];
  const normals = [];
  const binormals = [];
  const quat = new THREE.Quaternion();

  function choosePerpendicular(tangent) {
    const axes = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
    ];
    axes.sort((a, b) => Math.abs(a.dot(tangent)) - Math.abs(b.dot(tangent)));

    const normal = new THREE.Vector3().crossVectors(axes[0], tangent);
    if (normal.lengthSq() < 1e-8) {
      normal.crossVectors(axes[1], tangent);
    }
    return normal.normalize();
  }

  if (!Array.isArray(curveOrCenters)) {
    for (let i = 0; i <= tubularSegments; i++) {
      centers.push(curveOrCenters.getPointAt(i / tubularSegments));
    }
  }

  tubularSegments = centers.length - 1;

  for (let i = 0; i <= tubularSegments; i++) {
    const tangent = new THREE.Vector3();
    if (i === 0) {
      tangent.subVectors(centers[Math.min(2, tubularSegments)], centers[0]);
    } else if (i === tubularSegments) {
      tangent.subVectors(centers[i], centers[Math.max(0, i - 2)]);
    } else {
      tangent.subVectors(centers[i + 1], centers[i - 1]);
    }

    if (tangent.lengthSq() < 1e-8) {
      tangent.copy(i > 0 ? tangents[i - 1] : new THREE.Vector3(0, 0, 1));
    }
    tangents.push(tangent.normalize());
  }

  normals.push(choosePerpendicular(tangents[0]));
  binormals.push(new THREE.Vector3().crossVectors(tangents[0], normals[0]).normalize());

  for (let i = 1; i <= tubularSegments; i++) {
    quat.setFromUnitVectors(tangents[i - 1], tangents[i]);

    const normal = normals[i - 1].clone().applyQuaternion(quat);
    normal.sub(tangents[i].clone().multiplyScalar(normal.dot(tangents[i])));
    if (normal.lengthSq() < 1e-8) {
      normal.copy(choosePerpendicular(tangents[i]));
    } else {
      normal.normalize();
    }

    const binormal = new THREE.Vector3().crossVectors(tangents[i], normal);
    if (binormal.lengthSq() < 1e-8) {
      normal.copy(choosePerpendicular(tangents[i]));
      binormal.crossVectors(tangents[i], normal);
    }

    normals.push(normal);
    binormals.push(binormal.normalize());
  }

  for (let i = 0; i <= tubularSegments; i++) {
    const ring = [];
    for (let j = 0; j < radialSegments; j++) {
      const theta = (j / radialSegments) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      ring.push(new THREE.Vector3(
        centers[i].x + radius * (cosT * normals[i].x + sinT * binormals[i].x),
        centers[i].y + radius * (cosT * normals[i].y + sinT * binormals[i].y),
        centers[i].z + radius * (cosT * normals[i].z + sinT * binormals[i].z)
      ));
    }
    rings.push(ring);
  }

  for (let i = 1; i <= tubularSegments; i++) {
    const prevRing = rings[i - 1];
    const ring = rings[i];
    let bestShift = 0;
    let bestScore = Infinity;

    for (let shift = 0; shift < radialSegments; shift++) {
      let score = 0;
      for (let j = 0; j < radialSegments; j++) {
        score += prevRing[j].distanceToSquared(ring[(j + shift) % radialSegments]);
      }
      if (score < bestScore) {
        bestScore = score;
        bestShift = shift;
      }
    }

    if (bestShift !== 0) {
      rings[i] = ring.map((_, j) => ring[(j + bestShift) % radialSegments]);
    }
  }

  for (let i = 0; i <= tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const p = rings[i][j];
      positions.push(p.x, p.y, p.z);
    }
  }

  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * radialSegments + j;
      const b = i * radialSegments + (j + 1) % radialSegments;
      const c = (i + 1) * radialSegments + (j + 1) % radialSegments;
      const d = (i + 1) * radialSegments + j;

      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }
  const bodyIndexCount = indices.length;

  function getRingCenter(ringStartIdx) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let j = 0; j < radialSegments; j++) {
      const idx = (ringStartIdx + j) * 3;
      cx += positions[idx];
      cy += positions[idx + 1];
      cz += positions[idx + 2];
    }
    return new THREE.Vector3(cx / radialSegments, cy / radialSegments, cz / radialSegments);
  }

  function buildHemisphereCap(ringStartIdx, tangent, flipWinding) {
    const center = getRingCenter(ringStartIdx);
    let prevRingStart = ringStartIdx;

    for (let ring = 1; ring <= CAP_RINGS; ring++) {
      const phi = (ring / CAP_RINGS) * (Math.PI / 2);
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);

      if (ring < CAP_RINGS) {
        const currentRingStart = positions.length / 3;
        for (let j = 0; j < radialSegments; j++) {
          const origIdx = (ringStartIdx + j) * 3;
          const dx = positions[origIdx] - center.x;
          const dy = positions[origIdx + 1] - center.y;
          const dz = positions[origIdx + 2] - center.z;

          positions.push(
            center.x + cosP * dx + sinP * radius * tangent.x,
            center.y + cosP * dy + sinP * radius * tangent.y,
            center.z + cosP * dz + sinP * radius * tangent.z
          );
        }

        for (let j = 0; j < radialSegments; j++) {
          const a = prevRingStart + j;
          const b = prevRingStart + (j + 1) % radialSegments;
          const c = currentRingStart + (j + 1) % radialSegments;
          const d = currentRingStart + j;

          if (flipWinding) {
            indices.push(a, d, b);
            indices.push(b, d, c);
          } else {
            indices.push(a, b, d);
            indices.push(b, c, d);
          }
        }

        prevRingStart = currentRingStart;
      } else {
        const poleIdx = positions.length / 3;
        positions.push(
          center.x + radius * tangent.x,
          center.y + radius * tangent.y,
          center.z + radius * tangent.z
        );

        for (let j = 0; j < radialSegments; j++) {
          if (flipWinding) {
            indices.push(prevRingStart + j, poleIdx, prevRingStart + (j + 1) % radialSegments);
          } else {
            indices.push(prevRingStart + (j + 1) % radialSegments, poleIdx, prevRingStart + j);
          }
        }
      }
    }
  }

  const startCapIndexStart = indices.length;
  buildHemisphereCap(0, tangents[0].clone().negate(), true);
  const startCapIndexCount = indices.length - startCapIndexStart;

  const endRingStart = tubularSegments * radialSegments;
  const endCapIndexStart = indices.length;
  buildHemisphereCap(endRingStart, tangents[tubularSegments], false);
  const endCapIndexCount = indices.length - endCapIndexStart;

  const closedGeom = new THREE.BufferGeometry();
  closedGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  closedGeom.setIndex(indices);
  closedGeom.computeVertexNormals();
  closedGeom.userData.seamDebug = {
    radialSegments,
    tubularSegments,
    bodyIndexCount,
    startCapIndexStart,
    startCapIndexCount,
    endCapIndexStart,
    endCapIndexCount,
  };
  return closedGeom;
}

function trimPolylineEnds(points, trimDistance) {
  if (!points || points.length < 2 || trimDistance <= 1e-6) {
    return points.map((p) => p.clone());
  }

  const cleaned = [points[0].clone()];
  for (let i = 1; i < points.length; i++) {
    if (cleaned[cleaned.length - 1].distanceToSquared(points[i]) > 1e-8) {
      cleaned.push(points[i].clone());
    }
  }

  if (cleaned.length < 2) return cleaned;

  const cumulative = [0];
  for (let i = 1; i < cleaned.length; i++) {
    cumulative.push(cumulative[i - 1] + cleaned[i].distanceTo(cleaned[i - 1]));
  }

  const totalLength = cumulative[cumulative.length - 1];
  if (totalLength <= trimDistance * 2 + 1e-6) {
    return cleaned;
  }

  function pointAt(distance) {
    let segIndex = 0;
    while (segIndex < cumulative.length - 2 && cumulative[segIndex + 1] < distance) {
      segIndex++;
    }

    const start = cleaned[segIndex];
    const end = cleaned[segIndex + 1];
    const len0 = cumulative[segIndex];
    const len1 = cumulative[segIndex + 1];
    const span = Math.max(1e-8, len1 - len0);
    const t = THREE.MathUtils.clamp((distance - len0) / span, 0, 1);
    return start.clone().lerp(end, t);
  }

  const startDistance = trimDistance;
  const endDistance = totalLength - trimDistance;
  const trimmed = [pointAt(startDistance)];

  for (let i = 1; i < cleaned.length - 1; i++) {
    if (cumulative[i] > startDistance && cumulative[i] < endDistance) {
      trimmed.push(cleaned[i].clone());
    }
  }

  trimmed.push(pointAt(endDistance));
  return trimmed;
}

function resamplePolylineEquidistant(points, segmentCount) {
  if (!points || points.length < 2 || segmentCount < 1) {
    return points ? points.map((point) => point.clone()) : [];
  }

  const cleaned = [points[0].clone()];
  for (let i = 1; i < points.length; i++) {
    if (cleaned[cleaned.length - 1].distanceToSquared(points[i]) > 1e-8) {
      cleaned.push(points[i].clone());
    }
  }

  if (cleaned.length < 2) return cleaned;

  const cumulative = [0];
  for (let i = 1; i < cleaned.length; i++) {
    cumulative.push(cumulative[i - 1] + cleaned[i].distanceTo(cleaned[i - 1]));
  }

  const totalLength = cumulative[cumulative.length - 1];
  if (totalLength <= 1e-8) {
    return [cleaned[0].clone(), cleaned[cleaned.length - 1].clone()];
  }

  const result = [];
  let segIndex = 0;

  for (let i = 0; i <= segmentCount; i++) {
    const target = (totalLength * i) / segmentCount;
    while (segIndex < cumulative.length - 2 && cumulative[segIndex + 1] < target) {
      segIndex++;
    }

    const start = cleaned[segIndex];
    const end = cleaned[segIndex + 1];
    const len0 = cumulative[segIndex];
    const len1 = cumulative[segIndex + 1];
    const span = Math.max(1e-8, len1 - len0);
    const t = THREE.MathUtils.clamp((target - len0) / span, 0, 1);
    result.push(start.clone().lerp(end, t));
  }

  return result;
}

function stabilizeTubeCenters(centers, radius, cleanup = { start: true, end: true }) {
  const cleaned = centers.map((point) => point.clone());
  if (cleaned.length < 4) return cleaned;

  const minEndSpan = radius * 0.6;
  const turnLimitDeg = 135;
  const maxDropsPerSide = 6;
  const minRemainingPoints = 4;
  const minRemainingLength = radius * 4.5;

  function segmentLength(points, i0, i1) {
    if (i0 < 0 || i1 >= points.length) return 0;
    return points[i1].distanceTo(points[i0]);
  }

  function segmentTurnDeg(points, a, b, c) {
    if (a < 0 || c >= points.length) return 0;
    const v0 = points[b].clone().sub(points[a]);
    const v1 = points[c].clone().sub(points[b]);
    if (v0.lengthSq() < 1e-8 || v1.lengthSq() < 1e-8) return 0;
    return THREE.MathUtils.radToDeg(v0.angleTo(v1));
  }

  function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += points[i].distanceTo(points[i - 1]);
    }
    return total;
  }

  function shouldDropStart(points) {
    if (points.length < 4) return false;
    const firstLen = segmentLength(points, 0, 1);
    const secondLen = segmentLength(points, 1, 2);
    const startTurn = segmentTurnDeg(points, 0, 1, 2);
    return (
      firstLen < minEndSpan ||
      (firstLen < radius && secondLen < radius) ||
      (firstLen < radius * 1.25 && startTurn > turnLimitDeg)
    );
  }

  if (cleanup.start) {
    let startDrops = 0;
    while (
      startDrops < maxDropsPerSide &&
      shouldDropStart(cleaned) &&
      cleaned.length > minRemainingPoints &&
      polylineLength(cleaned) > minRemainingLength
    ) {
      cleaned.shift();
      startDrops++;
    }
  }

  if (cleanup.end) {
    cleaned.reverse();
    let endDrops = 0;
    while (
      endDrops < maxDropsPerSide &&
      shouldDropStart(cleaned) &&
      cleaned.length > minRemainingPoints &&
      polylineLength(cleaned) > minRemainingLength
    ) {
      cleaned.shift();
      endDrops++;
    }
    cleaned.reverse();
  }

  if (cleaned.length < 2) {
    return centers.map((point) => point.clone());
  }

  return cleaned;
}

function analyzeTriangleRange(geometry, indexStart, indexCount) {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  if (!index || !position || indexCount <= 0) {
    return { triangleCount: 0, minQuality: 1, maxAspect: 1, degenerateCount: 0 };
  }

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const bc = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let minQuality = 1;
  let maxAspect = 1;
  let degenerateCount = 0;
  let triangleCount = 0;

  for (let i = indexStart; i < indexStart + indexCount; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));

    ab.subVectors(b, a);
    ac.subVectors(c, a);
    bc.subVectors(c, b);

    const e0 = ab.length();
    const e1 = ac.length();
    const e2 = bc.length();
    const minEdge = Math.max(1e-8, Math.min(e0, e1, e2));
    const maxEdge = Math.max(e0, e1, e2);
    const area2 = cross.crossVectors(ab, ac).length();
    const quality = area2 / Math.max(1e-8, maxEdge * maxEdge);
    const aspect = maxEdge / minEdge;

    minQuality = Math.min(minQuality, quality);
    maxAspect = Math.max(maxAspect, aspect);
    if (quality < 1e-3 || aspect > 25) degenerateCount++;
    triangleCount++;
  }

  return { triangleCount, minQuality, maxAspect, degenerateCount };
}

function analyzeTubeSeams(geometry) {
  const seamDebug = geometry.userData?.seamDebug;
  if (!seamDebug) return null;

  const stripIndexCount = seamDebug.radialSegments * 6;
  const startBody = analyzeTriangleRange(geometry, 0, stripIndexCount);
  const endBody = analyzeTriangleRange(
    geometry,
    Math.max(0, seamDebug.bodyIndexCount - stripIndexCount),
    Math.min(stripIndexCount, seamDebug.bodyIndexCount)
  );
  const startCap = analyzeTriangleRange(geometry, seamDebug.startCapIndexStart, seamDebug.startCapIndexCount);
  const endCap = analyzeTriangleRange(geometry, seamDebug.endCapIndexStart, seamDebug.endCapIndexCount);

  return {
    worstQuality: Math.min(startBody.minQuality, endBody.minQuality, startCap.minQuality, endCap.minQuality),
    worstAspect: Math.max(startBody.maxAspect, endBody.maxAspect, startCap.maxAspect, endCap.maxAspect),
    badTriangles:
      startBody.degenerateCount +
      endBody.degenerateCount +
      startCap.degenerateCount +
      endCap.degenerateCount,
    startBody,
    endBody,
    startCap,
    endCap,
  };
}

function analyzeCenterline(points, radius) {
  if (!points || points.length < 2) {
    return {
      pointCount: points ? points.length : 0,
      firstLen: 0,
      secondLen: 0,
      penultLen: 0,
      lastLen: 0,
      minLen: 0,
      startTurn: 0,
      endTurn: 0,
      firstLenR: 0,
      lastLenR: 0,
    };
  }

  const lengths = [];
  for (let i = 1; i < points.length; i++) {
    lengths.push(points[i].distanceTo(points[i - 1]));
  }

  function segmentAngle(a0, a1, a2) {
    if (a2 >= points.length) return 0;
    const v0 = points[a1].clone().sub(points[a0]);
    const v1 = points[a2].clone().sub(points[a1]);
    if (v0.lengthSq() < 1e-8 || v1.lengthSq() < 1e-8) return 0;
    return THREE.MathUtils.radToDeg(v0.angleTo(v1));
  }

  const firstLen = lengths[0] ?? 0;
  const secondLen = lengths[1] ?? 0;
  const penultLen = lengths[Math.max(0, lengths.length - 2)] ?? 0;
  const lastLen = lengths[lengths.length - 1] ?? 0;
  const minLen = lengths.reduce((min, len) => Math.min(min, len), Infinity);

  return {
    pointCount: points.length,
    firstLen,
    secondLen,
    penultLen,
    lastLen,
    minLen: Number.isFinite(minLen) ? minLen : 0,
    startTurn: segmentAngle(0, 1, 2),
    endTurn: segmentAngle(points.length - 3, points.length - 2, points.length - 1),
    firstLenR: radius > 1e-8 ? firstLen / radius : 0,
    lastLenR: radius > 1e-8 ? lastLen / radius : 0,
  };
}

function buildTubeGeometries(lines, canvasW, canvasH, shellFunc, extrusionParam) {
  const tubeGeometries = [];
  const sphereGeometries = []; // kept empty for API compat
  
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line.length < 2) continue;
    const points = [];
    const filteredLine2D = [];
    let totalRadius = 0;
    
    for (const point of line) {
      const u = point.x / canvasW;
      const v = 1.0 - (point.y / canvasH);
      if (u < 0.005 || u > 0.995 || v < 0.005 || v > 0.995) continue;
      filteredLine2D.push(point);
      const { pt } = computeSurfacePointAndNormal(shellFunc, u, v);
      points.push(pt);
      const radiusUV = point.thickness / Math.max(canvasW, canvasH);
      totalRadius += estimateWorldRadius(shellFunc, u, v, radiusUV);
    }
    
    if (points.length < 2) continue;
    
    const avgRadius = (totalRadius / points.length) * 0.5;
    const curve = new THREE.CatmullRomCurve3(points, false, 'chordal');
    const segments = getAdaptiveTubeSegmentCount(filteredLine2D, canvasW, canvasH);
    const sampledCenters = Array.from({ length: segments + 1 }, (_, i) => curve.getPointAt(i / segments));
    const probeGeom = createClosedTubeGeometryTransport(sampledCenters, sampledCenters.length - 1, avgRadius, 6);
    const probeSeams = analyzeTubeSeams(probeGeom);
    probeGeom.dispose();
    const cleanup = {
      start: Boolean(probeSeams) && (
        probeSeams.startBody.minQuality < 0.08 ||
        probeSeams.startBody.maxAspect > 25 ||
        probeSeams.startBody.degenerateCount > 0
      ),
      end: Boolean(probeSeams) && (
        probeSeams.endBody.minQuality < 0.08 ||
        probeSeams.endBody.maxAspect > 25 ||
        probeSeams.endBody.degenerateCount > 0
      ),
    };
    const stableCenters = stabilizeTubeCenters(sampledCenters, avgRadius, cleanup);
    if (stableCenters.length < 2) continue;
    const finalCenters = resamplePolylineEquidistant(stableCenters, segments);
    if (finalCenters.length < 2) continue;

    const closedGeom = createClosedTubeGeometryTransport(finalCenters, finalCenters.length - 1, avgRadius, 6);
    closedGeom.userData.lineIndex = lineIndex;
    closedGeom.userData.centerlineDebug = analyzeCenterline(finalCenters, avgRadius);
    tubeGeometries.push(closedGeom);
  }
  return { tubeGeometries, sphereGeometries };
}

/**
 * Compute barycentric coordinates of point (px, py) in UV triangle.
 * Returns { u, v, w } if inside, or null if outside.
 */
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

function buildTubeGeometriesFromMesh(lines, canvasW, canvasH, geometry, extrusionParam) {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  if (!uv) return { tubeGeometries: [], sphereGeometries: [] };

  const index = geometry.getIndex();
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
      i0, i1, i2
    });
  }

  const tubeGeometries = [];
  const sphereGeometries = []; // kept empty for API compat
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line.length < 2) continue;
    const points = [];
    const filteredLine2D = [];
    let totalRadius = 0;
    
    for (const point of line) {
      const cu = point.x / canvasW;
      const cv = 1.0 - (point.y / canvasH);
      if (cu < 0.005 || cu > 0.995 || cv < 0.005 || cv > 0.995) continue;
      filteredLine2D.push(point);

      let foundPt = null;
      for (const tri of triData) {
        const bary = barycentricUV(cu, cv, tri);
        if (bary) {
          foundPt = new THREE.Vector3(
            pos.getX(tri.i0) * bary.u + pos.getX(tri.i1) * bary.v + pos.getX(tri.i2) * bary.w,
            pos.getY(tri.i0) * bary.u + pos.getY(tri.i1) * bary.v + pos.getY(tri.i2) * bary.w,
            pos.getZ(tri.i0) * bary.u + pos.getZ(tri.i1) * bary.v + pos.getZ(tri.i2) * bary.w
          );
          break;
        }
      }
      
      if (foundPt) {
        points.push(foundPt);
        const radiusUV = point.thickness / Math.max(canvasW, canvasH);
        totalRadius += Math.max(MIN_WORLD_RADIUS, Math.min(MAX_WORLD_RADIUS, radiusUV * 15));
      }
    }
    
    if (points.length < 2) continue;
    
    const avgRadius = (totalRadius / points.length) * 0.5;
    const curve = new THREE.CatmullRomCurve3(points, false, 'chordal');
    const segments = getAdaptiveTubeSegmentCount(filteredLine2D, canvasW, canvasH);
    const sampledCenters = Array.from({ length: segments + 1 }, (_, i) => curve.getPointAt(i / segments));
    const probeGeom = createClosedTubeGeometryTransport(sampledCenters, sampledCenters.length - 1, avgRadius, 6);
    const probeSeams = analyzeTubeSeams(probeGeom);
    probeGeom.dispose();
    const cleanup = {
      start: Boolean(probeSeams) && (
        probeSeams.startBody.minQuality < 0.08 ||
        probeSeams.startBody.maxAspect > 25 ||
        probeSeams.startBody.degenerateCount > 0
      ),
      end: Boolean(probeSeams) && (
        probeSeams.endBody.minQuality < 0.08 ||
        probeSeams.endBody.maxAspect > 25 ||
        probeSeams.endBody.degenerateCount > 0
      ),
    };
    const stableCenters = stabilizeTubeCenters(sampledCenters, avgRadius, cleanup);
    if (stableCenters.length < 2) continue;
    const finalCenters = resamplePolylineEquidistant(stableCenters, segments);
    if (finalCenters.length < 2) continue;

    const closedGeom = createClosedTubeGeometryTransport(finalCenters, finalCenters.length - 1, avgRadius, 6);
    closedGeom.userData.lineIndex = lineIndex;
    closedGeom.userData.centerlineDebug = analyzeCenterline(finalCenters, avgRadius);
    tubeGeometries.push(closedGeom);
  }
  return { tubeGeometries, sphereGeometries };
}

function extractOuterShell(finalGeom) {
  const keptIndices = [];
  const indexArray = finalGeom.index.array;
  for (const group of finalGeom.groups) {
    if (group.materialIndex === 0) {
      for (let i = 0; i < group.count; i++) {
        keptIndices.push(indexArray[group.start + i]);
      }
    }
  }

  const cleanGeom = finalGeom.clone();
  cleanGeom.setIndex(keptIndices);
  cleanGeom.clearGroups();
  return cleanGeom;
}

function postProcessGeometry(geom) {
  geom.computeVertexNormals();

  const position = geom.getAttribute('position');
  const index = geom.getIndex();
  if (!index) return geom;

  const indices = Array.from(index.array);
  const validIndices = [];
  const MIN_AREA_SQ = 1e-10;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  for (let i = 0; i < indices.length; i += 3) {
    a.fromBufferAttribute(position, indices[i]);
    b.fromBufferAttribute(position, indices[i + 1]);
    c.fromBufferAttribute(position, indices[i + 2]);

    ab.subVectors(b, a);
    ac.subVectors(c, a);
    const crossLen = ab.cross(ac).lengthSq();

    if (crossLen > MIN_AREA_SQ) {
      validIndices.push(indices[i], indices[i + 1], indices[i + 2]);
    }
  }

  geom.setIndex(validIndices);
  geom.computeVertexNormals();
  return geom;
}

function buildSinglePavilion(p) {
  const pavilionGroup = new THREE.Group();

  const hasVectorCircles = p.bakeHoles &&
    p.skinType === 'fingerprint' &&
    Array.isArray(p._fingerprintCircles) &&
    p._fingerprintCircles.length > 0;

  const hasVectorLines = (p.bakeTubes || p.previewTubes) &&
    p.skinType === 'fingerprint' &&
    Array.isArray(p._fingerprintLines) &&
    p._fingerprintLines.length > 0;

  // Check if we have cached geometries from previous bakes to combine
  const hasCachedTubes = Array.isArray(p._cachedTubeGeometries) && p._cachedTubeGeometries.length > 0;
  const hasCachedDrills = Array.isArray(p._cachedDrillGeometries) && p._cachedDrillGeometries.length > 0;

  // Thicken shell for CSG operations.
  // needsCSG is true if we're actively baking something OR if we have cached bakes to replay
  const needsCSG = hasVectorCircles || (hasVectorLines && p.bakeTubes)
    || (hasCachedTubes && hasVectorCircles)   // baking holes with cached tubes
    || (hasCachedDrills && hasVectorLines && p.bakeTubes); // baking tubes with cached drills
  const thickness = needsCSG ? 0.5 : 0;

  let shellGeom;
  let secondaryGeom = null;
  let glassGeom = null;

  if (p.importMode && p._importedGeometry) {
    // Use imported model geometry instead of parametric shell
    shellGeom = p._importedGeometry.clone();
    secondaryGeom = p._secondaryImportedGeometry ? p._secondaryImportedGeometry.clone() : null;
    glassGeom = p._glassGeometry ? p._glassGeometry.clone() : null;

    // Apply import scale
    if (p.importScale !== 1.0) {
      const s = p.importScale;
      shellGeom.scale(s, s, s);
      if (secondaryGeom) {
        secondaryGeom.scale(s, s, s);
      }
      if (glassGeom) {
        glassGeom.scale(s, s, s);
      }
    }

    shellGeom.computeVertexNormals();
    if (secondaryGeom) {
      secondaryGeom.computeVertexNormals();
    }
    if (glassGeom) {
      glassGeom.computeVertexNormals();
    }

    // Save base geometry for UV distortion map (before thickening)
    pavilionGroup.userData.baseGeometry = shellGeom.clone();
    pavilionGroup.userData.secondaryGeometry = secondaryGeom ? secondaryGeom.clone() : null;
    pavilionGroup.userData.glassGeometry = glassGeom ? glassGeom.clone() : null;

    // Thicken into solid manifold if CSG bake is needed
    // Use generic thickener (not grid-based) for arbitrary imported meshes
    // Strip UV/normals before merge so vertices at UV seams get merged by position only
    if (thickness > 0) {
      const posOnly = new THREE.BufferGeometry();
      posOnly.setAttribute('position', shellGeom.getAttribute('position').clone());
      if (shellGeom.index) posOnly.setIndex(shellGeom.index.clone());
      shellGeom = mergeVertices(posOnly, 0.01);
      shellGeom.computeVertexNormals();
      shellGeom = thickenGeometryGeneric(shellGeom, -thickness);
    }
  } else {
    // 1. Always create the thin geometry first
    shellGeom = createShellGeometry(p, 0);

    // 2. Apply deformations to the thin geometry
    applyDeformations(shellGeom, p);

    // 3. Recompute normals so they respect the new deformed surface
    shellGeom.computeVertexNormals();

    // 4. Stitch the seam so left and right edges match perfectly (fixes rip gaps)
    if (p.shellType !== 'paraboloid') { // paraboloid is an open shape
      stitchGeometrySeam(shellGeom, p.segments);
    }

    // Save base geometry for UV distortion map (before thickening)
    pavilionGroup.userData.baseGeometry = shellGeom.clone();
    pavilionGroup.userData.secondaryGeometry = null;
    glassGeom = p._glassGeometry ? p._glassGeometry.clone() : null;
    if (glassGeom && p.importScale !== 1.0) {
      glassGeom.scale(p.importScale, p.importScale, p.importScale);
    }
    if (glassGeom) {
      glassGeom.computeVertexNormals();
    }
    pavilionGroup.userData.glassGeometry = glassGeom ? glassGeom.clone() : null;

    // 5. Thicken it into a solid manifold (if needed for CSG)
    if (thickness > 0) {
      const needsTubeQualityExtrusion = (hasVectorLines && p.bakeTubes) || hasCachedTubes;
      if (needsTubeQualityExtrusion) {
        // For tube baking: position-only merge for continuous extrusion surface.
        const posOnly = new THREE.BufferGeometry();
        posOnly.setAttribute('position', shellGeom.getAttribute('position').clone());
        if (shellGeom.index) posOnly.setIndex(shellGeom.index.clone());
        shellGeom = mergeVertices(posOnly, 0.01);
        shellGeom.computeVertexNormals();
        shellGeom = thickenGeometryGeneric(shellGeom, -thickness);
      } else {
        shellGeom = thickenGeometry(shellGeom, -thickness);
      }
    }
  }

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.materialColor),
    metalness: p.metalness,
    roughness: p.roughness,
    side: THREE.DoubleSide,
    wireframe: p.wireframe,
  });

  applySkin(material, p);

  // Override with UV checker texture for debug visualization
  if (p.importShowUVCheck) {
    const checkerTex = generateUVCheckerTexture();
    material.map = checkerTex;
    material.alphaMap = null;
    material.alphaTest = 0;
    material.transparent = false;
    material.color.set('#ffffff');
    material.needsUpdate = true;
  }

  let shellMesh = new THREE.Mesh(shellGeom, material);
  shellMesh.name = 'pavilion-shell';

  // Extrusion preview: thickened shell + original as wireframe
  if (p.previewExtrusion && !needsCSG) {
    // Make the original shell a wireframe so you can see it's unchanged
    material.wireframe = true;

    const previewThickness = p.previewExtrusionThickness || 5.0;
    let baseForPreview;
    if (p.importMode && p._importedGeometry) {
      baseForPreview = shellGeom.clone();
    } else {
      const previewSegments = Math.min(p.segments, 48);
      baseForPreview = createShellGeometry({ ...p, segments: previewSegments }, 0);
      applyDeformations(baseForPreview, p);
      baseForPreview.computeVertexNormals();
      if (p.shellType !== 'paraboloid') {
        stitchGeometrySeam(baseForPreview, previewSegments);
      }
    }
    // Strip all attributes except position before merging.
    // mergeVertices compares ALL attributes — UV seams and normal splits
    // prevent co-located vertices from merging, causing per-polygon extrusion.
    const posOnly = new THREE.BufferGeometry();
    posOnly.setAttribute('position', baseForPreview.getAttribute('position').clone());
    if (baseForPreview.index) {
      posOnly.setIndex(baseForPreview.index.clone());
    }
    const merged = mergeVertices(posOnly, 0.01);
    merged.computeVertexNormals();
    const previewGeom = thickenGeometryGeneric(merged, -previewThickness);
    previewGeom.computeVertexNormals();

    const previewMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(p.materialColor),
      side: THREE.DoubleSide,
      roughness: p.roughness,
      metalness: p.metalness,
    });
    const previewMesh = new THREE.Mesh(previewGeom, previewMat);
    previewMesh.name = 'extrusion-preview';
    pavilionGroup.add(previewMesh);
  }

  let bakePromise = Promise.resolve();

  if (hasVectorCircles || hasVectorLines || (needsCSG && (hasCachedTubes || hasCachedDrills))) {
    const t0 = performance.now();

    const canvasW = p._fingerprintCanvasWidth || 1920;
    const canvasH = p._fingerprintCanvasHeight || 1080;

    let drillGeometries = [];
    if (hasVectorCircles) {
      const circles = deduplicateCircles(p._fingerprintCircles);
      console.log(`[Bake] ${circles.length} circles (${p._fingerprintCircles.length} raw)`);

      const t1 = performance.now();
      if (p.importMode && p._importedGeometry) {
        drillGeometries = buildDrillGeometriesFromMesh(circles, canvasW, canvasH, p._importedGeometry, thickness);
      } else {
        const shellFunc = getShellFunction(p);
        drillGeometries = buildDrillGeometries(circles, canvasW, canvasH, shellFunc, thickness);
      }
      const t2 = performance.now();
      console.log(`[Bake] Built ${drillGeometries.length} drill cylinders in ${(t2 - t1).toFixed(0)}ms`);
    }

    let tubeGeometries = [];
    let sphereGeometries = [];
    if (hasVectorLines) {
      const lines = p._fingerprintLines;
      console.log(`[Bake] ${lines.length} streamlines`);

      const t1 = performance.now();
      if (p.importMode && p._importedGeometry) {
        const res = buildTubeGeometriesFromMesh(lines, canvasW, canvasH, p._importedGeometry, p.fpLineExtrusion);
        tubeGeometries = res.tubeGeometries;
        sphereGeometries = res.sphereGeometries;
      } else {
        const shellFunc = getShellFunction(p);
        const res = buildTubeGeometries(lines, canvasW, canvasH, shellFunc, p.fpLineExtrusion);
        tubeGeometries = res.tubeGeometries;
        sphereGeometries = res.sphereGeometries;
      }
      const t2 = performance.now();
      console.log(`[Bake] Built ${tubeGeometries.length} tubes in ${(t2 - t1).toFixed(0)}ms`);
    }

    // Save current geometries to cache and merge with previously cached ones
    if (p.bakeTubes && tubeGeometries.length > 0) {
      p._cachedTubeGeometries = tubeGeometries.map(g => g.clone());
    }
    if (p.bakeHoles && drillGeometries.length > 0) {
      p._cachedDrillGeometries = drillGeometries.map(g => g.clone());
    }
    // Include cached geometries from previous bakes
    if (!hasVectorLines && hasCachedTubes) {
      tubeGeometries = p._cachedTubeGeometries.map(g => g.clone());
      console.log(`[Bake] Reusing ${tubeGeometries.length} cached tube geometries`);
    }
    if (!p.bakeHoles && hasCachedDrills) {
      drillGeometries = p._cachedDrillGeometries.map(g => g.clone());
      console.log(`[Bake] Reusing ${drillGeometries.length} cached drill geometries`);
    }

    if (p.previewTubes && tubeGeometries.length > 0) {
      const allTubeGeomsForPreview = tubeGeometries.slice();
      tubeGeometries = []; // Clear tube geometries so we bypass CSG union for previews
      sphereGeometries = [];
      const seamReport = allTubeGeomsForPreview
        .map((tubeGeom, previewIndex) => {
          const analysis = analyzeTubeSeams(tubeGeom);
          const centerline = tubeGeom.userData?.centerlineDebug;
          if (!analysis) return null;
          return {
            previewIndex,
            lineIndex: tubeGeom.userData?.lineIndex ?? -1,
            badTriangles: analysis.badTriangles,
            worstQuality: Number(analysis.worstQuality.toFixed(6)),
            worstAspect: Number(analysis.worstAspect.toFixed(3)),
            startBodyQ: Number(analysis.startBody.minQuality.toFixed(6)),
            startCapQ: Number(analysis.startCap.minQuality.toFixed(6)),
            endBodyQ: Number(analysis.endBody.minQuality.toFixed(6)),
            endCapQ: Number(analysis.endCap.minQuality.toFixed(6)),
            firstLen: Number((centerline?.firstLen ?? 0).toFixed(4)),
            secondLen: Number((centerline?.secondLen ?? 0).toFixed(4)),
            lastLen: Number((centerline?.lastLen ?? 0).toFixed(4)),
            penultLen: Number((centerline?.penultLen ?? 0).toFixed(4)),
            firstLenR: Number((centerline?.firstLenR ?? 0).toFixed(3)),
            lastLenR: Number((centerline?.lastLenR ?? 0).toFixed(3)),
            startTurn: Number((centerline?.startTurn ?? 0).toFixed(2)),
            endTurn: Number((centerline?.endTurn ?? 0).toFixed(2)),
          };
        })
        .filter(Boolean)
        .sort((a, b) => {
          if (b.badTriangles !== a.badTriangles) return b.badTriangles - a.badTriangles;
          if (a.worstQuality !== b.worstQuality) return a.worstQuality - b.worstQuality;
          return b.worstAspect - a.worstAspect;
        })
        .slice(0, 12);

      if (seamReport.length > 0) {
        console.groupCollapsed('[Preview] Worst tube seam metrics');
        console.table(seamReport);
        console.groupEnd();
      }
      
      if (p.previewSolidCheck) {
        // Per-tube solid check mode: each tube gets its own mesh with green/red color
        import('manifold-3d').then(async ({ default: Module }) => {
          const m = await Module();
          m.setup();

          function isSolidGeometry(geom) {
            try {
              const g = geom.clone();
              if (!g.index) {
                const posCount = g.attributes.position.count;
                const idx = new Uint32Array(posCount);
                for (let k = 0; k < posCount; k++) idx[k] = k;
                g.setIndex(new THREE.BufferAttribute(idx, 1));
              }
              const pos = g.attributes.position;
              const numProp = 3;
              const props = new Float32Array(pos.count * numProp);
              for (let k = 0; k < pos.count; k++) {
                props[k * 3] = pos.getX(k);
                props[k * 3 + 1] = pos.getY(k);
                props[k * 3 + 2] = pos.getZ(k);
              }
              const mesh = new m.Mesh({
                numProp,
                vertProperties: props,
                triVerts: new Uint32Array(g.index.array),
              });
              mesh.merge();
              const manifold = new m.Manifold(mesh);
              const vol = manifold.volume();
              return vol > 0;
            } catch (e) {
              return false;
            }
          }

          const solidMatGreen = new THREE.MeshStandardMaterial({
            color: 0x22c55e, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide
          });
          const solidMatRed = new THREE.MeshStandardMaterial({
            color: 0xef4444, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide
          });

          let solidCount = 0;
          for (let i = 0; i < allTubeGeomsForPreview.length; i++) {
            const tubeGeom = allTubeGeomsForPreview[i];
            const solid = isSolidGeometry(tubeGeom);
            if (solid) solidCount++;
            const mat = solid ? solidMatGreen : solidMatRed;
            const mesh = new THREE.Mesh(tubeGeom, mat);
            mesh.name = 'preview-tube-solid';
            pavilionGroup.add(mesh);
          }

          console.log(`[Preview] Solid check: ${solidCount}/${allTubeGeomsForPreview.length} tubes are solid`);
        }).catch(err => {
          console.error('[Preview] Solid check failed:', err);
        });
      } else {
        // Standard merged preview (no solid check)
        import('three/addons/utils/BufferGeometryUtils.js').then(({ mergeGeometries }) => {
          const mergedTubes = mergeGeometries(allTubeGeomsForPreview, false);
          const materialColor = new THREE.Color(p.materialColor).multiplyScalar(0.75);
          const tubeMat = new THREE.MeshStandardMaterial({
            color: materialColor, 
            roughness: p.roughness || 0.6,
            metalness: p.metalness || 0.1,
            side: THREE.DoubleSide
          });
          const tubeMesh = new THREE.Mesh(mergedTubes, tubeMat);
          tubeMesh.name = 'preview-tubes';
          pavilionGroup.add(tubeMesh);
        }).catch(err => {
          console.error('[Preview] Failed to generate mesh:', err);
        });
      }
    }

    if (drillGeometries.length > 0 || tubeGeometries.length > 0) {
      bakePromise = Promise.all([
        import('three/addons/utils/BufferGeometryUtils.js'),
        import('manifold-3d')
      ]).then(async ([{ mergeGeometries: mergeGeomsUtil }, { default: Module }]) => {
        const t3 = performance.now();

        const m = await Module();
        m.setup();

        // originalID mapping: 0=outer shell (thickened), 1=inner shell (original surface),
        // 2=edge stitching, 3=drill surfaces, 4=tube surfaces
        function geometryToManifold(geom, isDrill = false, isTube = false) {
          geom = geom.clone();
          if (!geom.index) {
            const posCount = geom.attributes.position.count;
            const idx = new Uint32Array(posCount);
            for (let i = 0; i < posCount; i++) idx[i] = i;
            geom.setIndex(new THREE.BufferAttribute(idx, 1));
          }
          const uvs = geom.attributes.uv;
          const pos = geom.attributes.position;
          const posCount = pos.count;
          const numProp = uvs ? 5 : 3;
          const props = new Float32Array(posCount * numProp);
          for (let i = 0; i < posCount; i++) {
            props[i * numProp + 0] = pos.getX(i);
            props[i * numProp + 1] = pos.getY(i);
            props[i * numProp + 2] = pos.getZ(i);
            if (uvs) {
              props[i * numProp + 3] = uvs.getX(i);
              props[i * numProp + 4] = uvs.getY(i);
            }
          }

          const defaultID = isDrill ? 3 : (isTube ? 4 : 0);
          let runIndex = new Uint32Array([0, geom.index.count]);
          let runOriginalID = new Uint32Array([defaultID]);

          if (!isDrill && !isTube && geom.groups && geom.groups.length > 0) {
            runIndex = new Uint32Array(geom.groups.length + 1);
            runOriginalID = new Uint32Array(geom.groups.length);
            runIndex[0] = 0;
            for (let i = 0; i < geom.groups.length; i++) {
              runIndex[i + 1] = runIndex[i] + geom.groups[i].count;
              runOriginalID[i] = geom.groups[i].materialIndex;
            }
          }

          const mesh = new m.Mesh({
            numProp,
            vertProperties: props,
            triVerts: new Uint32Array(geom.index.array),
            runIndex,
            runOriginalID
          });
          mesh.merge();
          return new m.Manifold(mesh);
        }

        let resultManifold = geometryToManifold(shellGeom, false);
        console.log('[Bake] Base Manifold Status:', resultManifold.status(), 'Volume:', resultManifold.volume());

        if (drillGeometries.length > 0) {
          const mergedDrills = mergeGeomsUtil(drillGeometries, false);
          const drillManifold = geometryToManifold(mergedDrills, true);
          console.log('[Bake] Drill Manifold Status:', drillManifold.status(), 'Volume:', drillManifold.volume());
          resultManifold = m.Manifold.difference(resultManifold, drillManifold);
          mergedDrills.dispose();
        }

        if (tubeGeometries.length > 0) {
          const mergedTubes = mergeGeomsUtil(tubeGeometries, false);
          const tubeManifold = geometryToManifold(mergedTubes, false, true);
          console.log('[Bake] Tube Manifold Status:', tubeManifold.status(), 'Volume:', tubeManifold.volume());
          resultManifold = m.Manifold.difference(resultManifold, tubeManifold);
          mergedTubes.dispose();
        }

        console.log('[Bake] Final Result Manifold Status:', resultManifold.status(), 'Volume:', resultManifold.volume());

        const t4 = performance.now();
        console.log(`[Bake] CSG in ${(t4 - t3).toFixed(0)}ms`);

        const outMesh = resultManifold.getMesh();
        const numVert = outMesh.numVert;
        const numProp = outMesh.numProp;
        const positions = new Float32Array(numVert * 3);
        let uvs = null;
        if (numProp >= 5) uvs = new Float32Array(numVert * 2);

        for (let i = 0; i < numVert; i++) {
          positions[i * 3] = outMesh.vertProperties[i * numProp];
          positions[i * 3 + 1] = outMesh.vertProperties[i * numProp + 1];
          positions[i * 3 + 2] = outMesh.vertProperties[i * numProp + 2];
          if (uvs) {
            uvs[i * 2] = outMesh.vertProperties[i * numProp + 3];
            uvs[i * 2 + 1] = outMesh.vertProperties[i * numProp + 4];
          }
        }

        // Filter faces by originalID:
        //   0 = outer thickened shell (strip away)
        //   1 = inner original shell surface (keep, flip winding)
        //   2 = edge stitching faces (strip away)
        //   3 = drill surfaces (strip away)
        //   4 = tube groove walls (keep, normal winding)
        const validIndices = [];
        const numRuns = outMesh.runOriginalID.length;
        for (let r = 0; r < numRuns; r++) {
          const originalID = outMesh.runOriginalID[r];
          if (originalID === 1 || originalID === 4) {
            const startIdx = outMesh.runIndex[r];
            const endIdx = outMesh.runIndex[r + 1];
            for (let j = startIdx; j < endIdx; j += 3) {
              if (originalID === 1) {
                // Inner shell: flip winding (thickenGeometry inverted it)
                validIndices.push(
                  outMesh.triVerts[j + 2],
                  outMesh.triVerts[j + 1],
                  outMesh.triVerts[j]
                );
              } else {
                // Tube groove walls: keep normal winding
                validIndices.push(
                  outMesh.triVerts[j],
                  outMesh.triVerts[j + 1],
                  outMesh.triVerts[j + 2]
                );
              }
            }
          }
        }

        const cleanGeom = new THREE.BufferGeometry();
        cleanGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        if (uvs) cleanGeom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        cleanGeom.setIndex(validIndices);
        cleanGeom.computeVertexNormals();

        const t5 = performance.now();
        console.log(`[Bake] Post-process & convert back in ${(t5 - t4).toFixed(0)}ms`);
        console.log(`[Bake] Total: ${(t5 - t0).toFixed(0)}ms`);

        shellMesh.geometry.dispose();
        shellMesh.geometry = cleanGeom;
      });
    }

    p.bakeHoles = false;
    p.bakeTubes = false;
    p.previewTubes = false;
  }

  shellMesh.castShadow = true;
  shellMesh.receiveShadow = true;
  pavilionGroup.add(shellMesh);

  if (secondaryGeom) {
    const secondaryMaterial = new THREE.MeshStandardMaterial({
      color: '#2563eb',
      metalness: 0.08,
      roughness: 0.85,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
    });
    const secondaryMesh = new THREE.Mesh(secondaryGeom, secondaryMaterial);
    secondaryMesh.name = 'secondary-imported-geometry';
    secondaryMesh.castShadow = true;
    secondaryMesh.receiveShadow = true;
    pavilionGroup.add(secondaryMesh);
  }

  pavilionGroup.userData.bakePromise = bakePromise;

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

  const glassFrameSystem = createGlassFrameSystem(glassGeom, p);
  if (glassFrameSystem) pavilionGroup.add(glassFrameSystem);

  const scatter = createScatter(shellGeom, p);
  if (scatter) pavilionGroup.add(scatter);

  let fabricSceneOriginY;
  if (p.importMode && p._importedGeometry) {
    const t = p._importedGeometry.userData?.importTransform;
    if (t) {
      const is = p.importScale || 1;
      fabricSceneOriginY = (-t.centerY * t.scale + t.targetHeight / 2) * is;
    }
  }

  const fabric = createFabricDrape(p, shellGeom, secondaryGeom, fabricSceneOriginY);
  if (fabric) pavilionGroup.add(fabric);

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
  if (rootGroup) {
    scene.remove(rootGroup);
    disposeGroup(rootGroup);
  }

  const singlePavilion = buildSinglePavilion(p);
  rootGroup = applyComposition(scene, singlePavilion, p);
  rootGroup.userData.bakePromise = singlePavilion.userData.bakePromise || Promise.resolve();
  rootGroup.userData.baseGeometry = singlePavilion.userData.baseGeometry;
  rootGroup.userData.secondaryGeometry = singlePavilion.userData.secondaryGeometry ?? null;
  rootGroup.userData.glassGeometry = singlePavilion.userData.glassGeometry ?? null;

  scene.add(rootGroup);
  return rootGroup;
}

export function findShellMesh(scene) {
  let shell = null;
  scene.traverse((child) => {
    if (child.name === 'pavilion-shell' && child.isMesh) {
      shell = child;
    }
  });
  return shell;
}

export function getBakePromise(group) {
  return group?.userData?.bakePromise || Promise.resolve();
}
