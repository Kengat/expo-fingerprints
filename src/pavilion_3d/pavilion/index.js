import * as THREE from 'three';
import { createShellGeometry, getShellFunction, stitchGeometrySeam, thickenGeometry, thickenGeometryGeneric } from './shell.js';
import { applyDeformations } from './deform.js';
import { createRibs, createColumns } from './structure.js';
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

function createClosedTubeGeometry(curve, tubularSegments, radius, radialSegments) {
  const tubeGeom = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
  const pos = tubeGeom.getAttribute('position');
  const index = tubeGeom.getIndex();
  const newPos = [];
  const newIndex = [];
  
  for (let i = 0; i < pos.count; i++) {
    newPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  for (let i = 0; i < index.count; i++) {
    newIndex.push(index.getX(i));
  }
  
  // Start cap (Flat)
  let startCenterX = 0, startCenterY = 0, startCenterZ = 0;
  for (let i = 0; i < radialSegments; i++) {
    startCenterX += pos.getX(i);
    startCenterY += pos.getY(i);
    startCenterZ += pos.getZ(i);
  }
  startCenterX /= radialSegments;
  startCenterY /= radialSegments;
  startCenterZ /= radialSegments;
  
  const startCenterIdx = newPos.length / 3;
  newPos.push(startCenterX, startCenterY, startCenterZ);
  for(let i = 0; i < radialSegments; i++) {
     newIndex.push(startCenterIdx, i + 1, i);
  }
  
  // End cap (Flat)
  let endCenterX = 0, endCenterY = 0, endCenterZ = 0;
  const endRingStart = tubularSegments * (radialSegments + 1);
  for (let i = 0; i < radialSegments; i++) {
    endCenterX += pos.getX(endRingStart + i);
    endCenterY += pos.getY(endRingStart + i);
    endCenterZ += pos.getZ(endRingStart + i);
  }
  endCenterX /= radialSegments;
  endCenterY /= radialSegments;
  endCenterZ /= radialSegments;
  
  const endCenterIdx = newPos.length / 3;
  newPos.push(endCenterX, endCenterY, endCenterZ);
  for (let i = 0; i < radialSegments; i++) {
    newIndex.push(endCenterIdx, endRingStart + i, endRingStart + i + 1);
  }
  
  const closedGeom = new THREE.BufferGeometry();
  closedGeom.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  closedGeom.setIndex(new THREE.Uint32BufferAttribute(newIndex, 1));
  closedGeom.computeVertexNormals();
  return closedGeom;
}

function buildTubeGeometries(lines, canvasW, canvasH, shellFunc, extrusionParam) {
  const tubeGeometries = [];
  const sphereGeometries = [];
  // Use extrusionParam maybe as a subtle multiplier, but thickness was 2x too large.
  // We'll scale the base radius precisely.
  
  for (const line of lines) {
    if (line.length < 2) continue;
    const points = [];
    let totalRadius = 0;
    
    for (const point of line) {
      const u = point.x / canvasW;
      const v = 1.0 - (point.y / canvasH);
      if (u < 0.005 || u > 0.995 || v < 0.005 || v > 0.995) continue;
      const { pt } = computeSurfacePointAndNormal(shellFunc, u, v);
      points.push(pt);
      const radiusUV = point.thickness / Math.max(canvasW, canvasH);
      totalRadius += estimateWorldRadius(shellFunc, u, v, radiusUV);
    }
    
    if (points.length < 2) continue;
    
    // totalRadius is accumulating radius based on thickness (which is diameter)
    // We want the true radius:
    const avgRadius = (totalRadius / points.length) * 0.5;
    
    const curve = new THREE.CatmullRomCurve3(points, false, 'chordal');
    const segments = Math.max(8, Math.floor(points.length * 1.5));
    const closedGeom = createClosedTubeGeometry(curve, segments, avgRadius, 8);
    tubeGeometries.push(closedGeom);

    // Create start and end spheres for rounded caps
    const sphereGeomStart = new THREE.SphereGeometry(avgRadius, 8, 8);
    sphereGeomStart.translate(points[0].x, points[0].y, points[0].z);
    sphereGeomStart.deleteAttribute('uv');
    sphereGeometries.push(sphereGeomStart);

    const lastPt = points[points.length - 1];
    const sphereGeomEnd = new THREE.SphereGeometry(avgRadius, 8, 8);
    sphereGeomEnd.translate(lastPt.x, lastPt.y, lastPt.z);
    sphereGeomEnd.deleteAttribute('uv');
    sphereGeometries.push(sphereGeomEnd);
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
  const sphereGeometries = [];
  for (const line of lines) {
    if (line.length < 2) continue;
    const points = [];
    let totalRadius = 0;
    
    for (const point of line) {
      const cu = point.x / canvasW;
      const cv = 1.0 - (point.y / canvasH);
      if (cu < 0.005 || cu > 0.995 || cv < 0.005 || cv > 0.995) continue;

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
    const segments = Math.max(8, Math.floor(points.length * 1.5));
    const closedGeom = createClosedTubeGeometry(curve, segments, avgRadius, 8);
    tubeGeometries.push(closedGeom);

    const sphereGeomStart = new THREE.SphereGeometry(avgRadius, 8, 8);
    sphereGeomStart.translate(points[0].x, points[0].y, points[0].z);
    sphereGeomStart.deleteAttribute('uv');
    sphereGeometries.push(sphereGeomStart);

    const lastPt = points[points.length - 1];
    const sphereGeomEnd = new THREE.SphereGeometry(avgRadius, 8, 8);
    sphereGeomEnd.translate(lastPt.x, lastPt.y, lastPt.z);
    sphereGeomEnd.deleteAttribute('uv');
    sphereGeometries.push(sphereGeomEnd);
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

  const thickness = hasVectorCircles ? 5.0 : 0;

  let shellGeom;

  if (p.importMode && p._importedGeometry) {
    // Use imported model geometry instead of parametric shell
    shellGeom = p._importedGeometry.clone();

    // Apply import scale
    if (p.importScale !== 1.0) {
      const s = p.importScale;
      shellGeom.scale(s, s, s);
    }

    shellGeom.computeVertexNormals();

    // Save base geometry for UV distortion map (before thickening)
    pavilionGroup.userData.baseGeometry = shellGeom.clone();

    // Thicken into solid manifold if CSG bake is needed
    // Use generic thickener (not grid-based) for arbitrary imported meshes
    if (thickness > 0) {
      shellGeom = thickenGeometryGeneric(shellGeom, thickness);
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

    // 5. Thicken it into a solid manifold (if needed for CSG)
    if (thickness > 0) {
      shellGeom = thickenGeometry(shellGeom, thickness);
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

  let bakePromise = Promise.resolve();

  if (hasVectorCircles || hasVectorLines) {
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

    if (p.previewTubes && tubeGeometries.length > 0) {
      const allTubesForPreview = [...tubeGeometries, ...sphereGeometries];
      tubeGeometries = []; // Clear tube geometries so we bypass CSG union for previews
      sphereGeometries = [];
      
      import('three/addons/utils/BufferGeometryUtils.js').then(({ mergeGeometries }) => {
        const mergedTubes = mergeGeometries(allTubesForPreview, false);
        const materialColor = new THREE.Color(p.materialColor).multiplyScalar(0.75); // Darken match
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

    if (drillGeometries.length > 0 || tubeGeometries.length > 0) {
      bakePromise = Promise.all([
        import('three/addons/utils/BufferGeometryUtils.js'),
        import('manifold-3d')
      ]).then(async ([{ mergeGeometries: mergeGeomsUtil }, { default: Module }]) => {
        const t3 = performance.now();

        const m = await Module();
        m.setup();

        function geometryToManifold(geom, isDrill = false) {
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

          let runIndex = new Uint32Array([0, geom.index.count]);
          let runOriginalID = new Uint32Array([isDrill ? 3 : 0]);

          if (!isDrill && geom.groups && geom.groups.length > 0) {
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
          const tubeManifold = geometryToManifold(mergedTubes, false);
          console.log('[Bake] Tube Manifold Status:', tubeManifold.status(), 'Volume:', tubeManifold.volume());
          resultManifold = m.Manifold.union(resultManifold, tubeManifold);
          mergedTubes.dispose();

          if (sphereGeometries.length > 0) {
            const mergedSpheres = mergeGeomsUtil(sphereGeometries, false);
            const sphereManifold = geometryToManifold(mergedSpheres, false);
            console.log('[Bake] Sphere Manifold Status:', sphereManifold.status());
            resultManifold = m.Manifold.union(resultManifold, sphereManifold);
            mergedSpheres.dispose();
          }
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

        // Filter faces: keep only originalID == 1 (inner original shell surface)
        // Flip winding order since `thickenGeometry` originally inverted it!
        const validIndices = [];
        const numRuns = outMesh.runOriginalID.length;
        for (let r = 0; r < numRuns; r++) {
          const originalID = outMesh.runOriginalID[r];
          if (originalID === 1) {
            const startIdx = outMesh.runIndex[r];
            const endIdx = outMesh.runIndex[r + 1];
            for (let j = startIdx; j < endIdx; j += 3) {
              validIndices.push(
                outMesh.triVerts[j + 2],
                outMesh.triVerts[j + 1],
                outMesh.triVerts[j]
              );
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

  const fabric = createFabricDrape(p, shellGeom, fabricSceneOriginY);
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
