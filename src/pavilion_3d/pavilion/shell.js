import * as THREE from 'three';
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';

function hyperboloidShell(u, v, target, p) {
  const angle = u * p.openingAngle;
  const t = (v - 0.5) * 2; // -1 to 1
  const h = t * p.height / 2;

  // Hyperboloid radius varies with height
  const waist = 0.6;
  const r = Math.sqrt(waist * waist + t * t);
  const radiusAtHeight = THREE.MathUtils.lerp(p.radiusBottom, p.radiusTop, v) * r * p.taper;

  // Asymmetry
  const asymX = p.asymmetryX * Math.sin(v * Math.PI);
  const asymZ = p.asymmetryZ * Math.sin(v * Math.PI);

  // Twist
  const twistAngle = angle + p.twist * v;

  const x = radiusAtHeight * Math.cos(twistAngle) + asymX;
  const z = radiusAtHeight * Math.sin(twistAngle) + asymZ;
  const y = h + p.height / 2;

  target.set(x, y, z);
}

function hyperbolicParaboloid(u, v, target, p) {
  const x = (u - 0.5) * p.radiusBottom * 2;
  const z = (v - 0.5) * p.radiusBottom * 2;
  const curvature = Math.max(p.radiusTop, 0.1);
  const y = (x * x / (curvature * 2) - z * z / (curvature * 2)) * p.taper + p.height / 2;

  // Apply twist
  const angle = p.twist * ((u + v) / 2 - 0.5);
  const rx = x * Math.cos(angle) - z * Math.sin(angle);
  const rz = x * Math.sin(angle) + z * Math.cos(angle);

  target.set(rx + p.asymmetryX, y, rz + p.asymmetryZ);
}

function toroidalShell(u, v, target, p) {
  const angle = u * p.openingAngle;
  const phi = v * Math.PI * 2;
  const R = p.radiusBottom;
  const r = p.radiusTop * 0.4;

  const tubeX = R + r * Math.cos(phi);
  const tubeY = r * Math.sin(phi);

  // Twist
  const twistAngle = angle + p.twist * v;

  const x = tubeX * Math.cos(twistAngle) * p.taper;
  const y = tubeY + p.height / 2;
  const z = tubeX * Math.sin(twistAngle) * p.taper;

  target.set(x + p.asymmetryX * Math.sin(v * Math.PI), y, z + p.asymmetryZ * Math.sin(v * Math.PI));
}

function superformula(theta, m, n1, n2, n3) {
  const t1 = Math.abs(Math.cos(m * theta / 4));
  const t2 = Math.abs(Math.sin(m * theta / 4));
  const r = Math.pow(Math.pow(t1, n2) + Math.pow(t2, n3), -1 / n1);
  return isFinite(r) ? r : 1;
}

function blobShell(u, v, target, p) {
  const theta = u * Math.PI * 2;
  const phi = v * Math.PI;

  // Superformula with variable complexity
  const m = 3 + Math.floor(p.radiusTop / 3);
  const r1 = superformula(theta, m, 1, 1, 1);
  const r2 = superformula(phi, m, 1, 1, 1);
  const r = r1 * r2 * p.radiusBottom * 0.5 * p.taper;

  let x = r * Math.sin(phi) * Math.cos(theta);
  let z = r * Math.sin(phi) * Math.sin(theta);
  let y = r * Math.cos(phi) * (p.height / Math.max(p.radiusBottom, 1)) + p.height / 2;

  // Twist
  const twistAngle = p.twist * (v - 0.5);
  const rx = x * Math.cos(twistAngle) - z * Math.sin(twistAngle);
  const rz = x * Math.sin(twistAngle) + z * Math.cos(twistAngle);

  target.set(rx + p.asymmetryX, y, rz + p.asymmetryZ);
}

const shellFunctions = {
  hyperboloid: hyperboloidShell,
  paraboloid: hyperbolicParaboloid,
  torus: toroidalShell,
  blob: blobShell,
};

export function getShellFunction(p) {
  const fn = shellFunctions[p.shellType] || hyperboloidShell;
  return (u, v, target) => fn(u, v, target, p);
}

export function createShellGeometry(p, thickenAmount = 0) {
  const func = getShellFunction(p);
  let geom = new ParametricGeometry(func, p.segments, p.segments);
  geom.computeVertexNormals();

  if (thickenAmount > 0) {
    // We optionally stitch the seam before thickening if it's a closed object.
    // However, it's safer to let index.js control when this happens so deformations are stitched too.
    geom = thickenGeometry(geom, thickenAmount);
  }

  return geom;
}

export function stitchGeometrySeam(geom, segments) {
  const pos = geom.getAttribute('position');
  const norm = geom.getAttribute('normal');
  const cols = segments + 1;

  for (let v = 0; v <= segments; v++) {
    const iLeft = v * cols;
    const iRight = v * cols + segments;

    // Stitch positions
    const lx = pos.getX(iLeft);
    const ly = pos.getY(iLeft);
    const lz = pos.getZ(iLeft);
    const rx = pos.getX(iRight);
    const ry = pos.getY(iRight);
    const rz = pos.getZ(iRight);

    const ax = (lx + rx) / 2;
    const ay = (ly + ry) / 2;
    const az = (lz + rz) / 2;
    pos.setXYZ(iLeft, ax, ay, az);
    pos.setXYZ(iRight, ax, ay, az);

    // Stitch normals
    const nlx = norm.getX(iLeft);
    const nly = norm.getY(iLeft);
    const nlz = norm.getZ(iLeft);
    const nrx = norm.getX(iRight);
    const nry = norm.getY(iRight);
    const nrz = norm.getZ(iRight);

    const nax = nlx + nrx;
    const nay = nly + nry;
    const naz = nlz + nrz;
    const len = Math.sqrt(nax * nax + nay * nay + naz * naz);
    if (len > 0) {
      norm.setXYZ(iLeft, nax / len, nay / len, naz / len);
      norm.setXYZ(iRight, nax / len, nay / len, naz / len);
    }
  }
}

// Extrudes a 2D open Surface BufferGeometry along its normals to create a closed 3D solid Manifold
export function thickenGeometry(geometry, thickness) {
  // We need the geometry to be non-indexed for simpler face generation or indexed. 
  // ParametricGeometry creates indexed geometry by default.
  if (!geometry.index) {
    // If ever not indexed, we won't handle it here to keep it simple, but Parametric returns indexed.
    return geometry;
  }

  const positionAttr = geometry.getAttribute('position');
  const normalAttr = geometry.getAttribute('normal');
  const uvAttr = geometry.getAttribute('uv');

  const vCount = positionAttr.count;

  // New buffers will have exactly 2x the vertices
  const newPositions = new Float32Array(vCount * 3 * 2);
  const newNormals = new Float32Array(vCount * 3 * 2);
  const newUvs = new Float32Array(vCount * 2 * 2);

  // 1. Copy inner vertices (original) and outer vertices (extruded)
  const vec = new THREE.Vector3();
  const norm = new THREE.Vector3();

  for (let i = 0; i < vCount; i++) {
    vec.fromBufferAttribute(positionAttr, i);
    norm.fromBufferAttribute(normalAttr, i);

    // INNER vertex (i)
    newPositions[i * 3] = vec.x;
    newPositions[i * 3 + 1] = vec.y;
    newPositions[i * 3 + 2] = vec.z;

    newNormals[i * 3] = -norm.x; // Inner normals face inward
    newNormals[i * 3 + 1] = -norm.y;
    newNormals[i * 3 + 2] = -norm.z;

    if (uvAttr) {
      newUvs[i * 2] = uvAttr.getX(i);
      newUvs[i * 2 + 1] = uvAttr.getY(i);
    }

    // OUTER vertex (i + vCount)
    vec.addScaledVector(norm, thickness);

    newPositions[(i + vCount) * 3] = vec.x;
    newPositions[(i + vCount) * 3 + 1] = vec.y;
    newPositions[(i + vCount) * 3 + 2] = vec.z;

    newNormals[(i + vCount) * 3] = norm.x; // Outer normals face outward
    newNormals[(i + vCount) * 3 + 1] = norm.y;
    newNormals[(i + vCount) * 3 + 2] = norm.z;

    if (uvAttr) {
      newUvs[(i + vCount) * 2] = uvAttr.getX(i);
      newUvs[(i + vCount) * 2 + 1] = uvAttr.getY(i);
    }
  }

  // 2. Build Indices
  // Total indices = inner faces + outer faces + edge connecting faces
  // Actually, finding the boundary of an arbitrary mesh is O(n).
  // Parametric geometry is a simple grid [segments+1 x segments+1]
  // Let's rely on checking edges if we want to be robust, OR better yet:
  // We can just use Three.js ExtrudeGeometry? No, Extrude is for 2D shapes.
  // Since we only need thickness for CSG, we can try using CSG's capability to subtract from simple shapes, or build a simple bounding Solid.
  // Wait! ParametricGeometry is exactly segments * segments faces.
  // Vertices are arranged in a grid: (segments + 1) * (segments + 1).
  const segs = Math.sqrt(vCount) - 1; // Works because vCount = (segments+1)^2

  const indices = []; // We will fill this

  const oldIndices = geometry.index.array;
  // Inner faces (inverted winding)
  for (let i = 0; i < oldIndices.length; i += 3) {
    indices.push(oldIndices[i + 2], oldIndices[i + 1], oldIndices[i]); // Invert
  }
  // Outer faces (normal winding)
  for (let i = 0; i < oldIndices.length; i += 3) {
    indices.push(oldIndices[i] + vCount, oldIndices[i + 1] + vCount, oldIndices[i + 2] + vCount);
  }

  // Edge stitching (top, bottom, left, right edges of the u,v grid)
  const cols = segs + 1;
  const rows = segs + 1;

  // Helper to add a quad
  function addQuad(a, b, c, d) {
    indices.push(a, b, d);
    indices.push(b, c, d);
  }

  // Bottom edge (v = 0)
  for (let u = 0; u < segs; u++) {
    let a = u;
    let b = u + 1;
    let c = b + vCount;
    let d = a + vCount;
    addQuad(a, b, c, d);
  }
  // Top edge (v = 1)
  for (let u = 0; u < segs; u++) {
    let a = (rows - 1) * cols + u;
    let b = a + 1;
    let c = b + vCount;
    let d = a + vCount;
    addQuad(b, a, d, c); // Opposite winding
  }
  // Left edge (u = 0)
  for (let v = 0; v < segs; v++) {
    let a = v * cols;
    let b = (v + 1) * cols;
    let c = b + vCount;
    let d = a + vCount;
    addQuad(b, a, d, c); // Opposite winding
  }
  // Right edge (u = 1)
  for (let v = 0; v < segs; v++) {
    let a = v * cols + segs;
    let b = (v + 1) * cols + segs;
    let c = b + vCount;
    let d = a + vCount;
    addQuad(a, b, c, d);
  }

  const thickGeom = new THREE.BufferGeometry();
  thickGeom.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
  thickGeom.setAttribute('normal', new THREE.BufferAttribute(newNormals, 3));
  if (uvAttr) thickGeom.setAttribute('uv', new THREE.BufferAttribute(newUvs, 2));
  thickGeom.setIndex(indices);

  // Assign Material Groups for CSG filtering
  // We want the Outer shell (the true surface) to be Material Index 0.
  // We want Inner and Edge walls to be Material Index 1.
  const numFaces = oldIndices.length;
  thickGeom.addGroup(0, numFaces, 1); // Inner faces -> Material 1
  thickGeom.addGroup(numFaces, numFaces, 0); // Outer faces (The true visible shell!) -> Material 0
  thickGeom.addGroup(numFaces * 2, indices.length - (numFaces * 2), 2); // Edge faces -> Material 2

  return thickGeom;
}

/**
 * Generic thickening for arbitrary (non-grid) meshes.
 * Finds boundary edges automatically and stitches inner/outer shells.
 * Works on imported OBJ/STL geometries with any topology.
 */
export function thickenGeometryGeneric(geometry, thickness) {
  if (!geometry.index) {
    // Create index for non-indexed geometry
    const posCount = geometry.attributes.position.count;
    const idx = [];
    for (let i = 0; i < posCount; i++) idx.push(i);
    geometry.setIndex(idx);
  }

  const positionAttr = geometry.getAttribute('position');
  const normalAttr = geometry.getAttribute('normal');
  const uvAttr = geometry.getAttribute('uv');

  if (!normalAttr) geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');

  const vCount = positionAttr.count;

  // New buffers: 2x vertices (inner + outer)
  const newPositions = new Float32Array(vCount * 3 * 2);
  const newNormals = new Float32Array(vCount * 3 * 2);
  const newUvs = uvAttr ? new Float32Array(vCount * 2 * 2) : null;

  const vec = new THREE.Vector3();
  const norm = new THREE.Vector3();

  for (let i = 0; i < vCount; i++) {
    vec.fromBufferAttribute(positionAttr, i);
    norm.fromBufferAttribute(normals, i);

    // INNER vertex (i) — original position, inverted normal
    newPositions[i * 3] = vec.x;
    newPositions[i * 3 + 1] = vec.y;
    newPositions[i * 3 + 2] = vec.z;
    newNormals[i * 3] = -norm.x;
    newNormals[i * 3 + 1] = -norm.y;
    newNormals[i * 3 + 2] = -norm.z;
    if (uvAttr) {
      newUvs[i * 2] = uvAttr.getX(i);
      newUvs[i * 2 + 1] = uvAttr.getY(i);
    }

    // OUTER vertex (i + vCount) — extruded outward
    vec.addScaledVector(norm, thickness);
    newPositions[(i + vCount) * 3] = vec.x;
    newPositions[(i + vCount) * 3 + 1] = vec.y;
    newPositions[(i + vCount) * 3 + 2] = vec.z;
    newNormals[(i + vCount) * 3] = norm.x;
    newNormals[(i + vCount) * 3 + 1] = norm.y;
    newNormals[(i + vCount) * 3 + 2] = norm.z;
    if (uvAttr) {
      newUvs[(i + vCount) * 2] = uvAttr.getX(i);
      newUvs[(i + vCount) * 2 + 1] = uvAttr.getY(i);
    }
  }

  const oldIndices = geometry.index.array;
  const indices = [];

  // Inner faces (inverted winding)
  for (let i = 0; i < oldIndices.length; i += 3) {
    indices.push(oldIndices[i + 2], oldIndices[i + 1], oldIndices[i]);
  }
  // Outer faces (normal winding, offset by vCount)
  for (let i = 0; i < oldIndices.length; i += 3) {
    indices.push(oldIndices[i] + vCount, oldIndices[i + 1] + vCount, oldIndices[i + 2] + vCount);
  }

  // Find boundary edges and stitch them
  const edgeMap = new Map();
  const makeEdgeKey = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;

  for (let i = 0; i < oldIndices.length; i += 3) {
    const v0 = oldIndices[i], v1 = oldIndices[i + 1], v2 = oldIndices[i + 2];
    const edges = [[v0, v1], [v1, v2], [v2, v0]];
    for (const [a, b] of edges) {
      const key = makeEdgeKey(a, b);
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }
  }

  // Boundary edges = edges appearing exactly once
  // Stitch inner and outer shell along these edges
  for (let i = 0; i < oldIndices.length; i += 3) {
    const v0 = oldIndices[i], v1 = oldIndices[i + 1], v2 = oldIndices[i + 2];
    const edges = [[v0, v1], [v1, v2], [v2, v0]];
    for (const [a, b] of edges) {
      const key = makeEdgeKey(a, b);
      if (edgeMap.get(key) === 1) {
        // Boundary edge: create quad connecting inner and outer
        const innerA = a, innerB = b;
        const outerA = a + vCount, outerB = b + vCount;
        // Two triangles for the quad
        indices.push(innerA, innerB, outerB);
        indices.push(innerA, outerB, outerA);
      }
    }
  }

  const thickGeom = new THREE.BufferGeometry();
  thickGeom.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
  thickGeom.setAttribute('normal', new THREE.BufferAttribute(newNormals, 3));
  if (newUvs) thickGeom.setAttribute('uv', new THREE.BufferAttribute(newUvs, 2));
  thickGeom.setIndex(indices);

  // Material groups for CSG filtering
  const numFaces = oldIndices.length;
  thickGeom.addGroup(0, numFaces, 1);                                 // Inner -> Material 1
  thickGeom.addGroup(numFaces, numFaces, 0);                           // Outer -> Material 0
  thickGeom.addGroup(numFaces * 2, indices.length - (numFaces * 2), 2); // Edge  -> Material 2

  return thickGeom;
}
