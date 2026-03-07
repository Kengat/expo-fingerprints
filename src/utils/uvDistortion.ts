/**
 * UV Distortion Map — computes per-triangle stretch from a mesh's UV→3D mapping,
 * then provides fast spatial-grid lookups so the 2D canvas can counter-distort
 * its drawing to appear uniform when mapped onto the 3D model.
 */

import type * as THREE from 'three';

export interface UVDistortionMap {
  getDistortion(u: number, v: number): { scaleU: number; scaleV: number };
}

interface TriData {
  u0: number; v0: number;
  u1: number; v1: number;
  u2: number; v2: number;
  stretchU: number;
  stretchV: number;
}

const GRID_SIZE = 64;

export function buildUVDistortionMap(geometry: THREE.BufferGeometry): UVDistortionMap {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | null;
  const index = geometry.getIndex();

  if (!position || !uv) {
    return { getDistortion: () => ({ scaleU: 1, scaleV: 1 }) };
  }

  const triangles: TriData[] = [];
  const triCount = index ? index.count / 3 : position.count / 3;

  let totalStretchU = 0;
  let totalStretchV = 0;
  let totalWeight = 0;

  for (let i = 0; i < triCount; i++) {
    const i0 = index ? index.getX(i * 3) : i * 3;
    const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;

    // UV coordinates
    const u0 = uv.getX(i0), v0 = uv.getY(i0);
    const u1 = uv.getX(i1), v1 = uv.getY(i1);
    const u2 = uv.getX(i2), v2 = uv.getY(i2);

    // UV edge vectors
    const du1 = u1 - u0, dv1 = v1 - v0;
    const du2 = u2 - u0, dv2 = v2 - v0;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-10) continue; // degenerate UV triangle

    // 3D edge vectors
    const e1x = position.getX(i1) - position.getX(i0);
    const e1y = position.getY(i1) - position.getY(i0);
    const e1z = position.getZ(i1) - position.getZ(i0);
    const e2x = position.getX(i2) - position.getX(i0);
    const e2y = position.getY(i2) - position.getY(i0);
    const e2z = position.getZ(i2) - position.getZ(i0);

    // Jacobian columns: ∂P/∂u and ∂P/∂v
    const invDet = 1 / det;
    const dPdu_x = (dv2 * e1x - dv1 * e2x) * invDet;
    const dPdu_y = (dv2 * e1y - dv1 * e2y) * invDet;
    const dPdu_z = (dv2 * e1z - dv1 * e2z) * invDet;

    const dPdv_x = (-du2 * e1x + du1 * e2x) * invDet;
    const dPdv_y = (-du2 * e1y + du1 * e2y) * invDet;
    const dPdv_z = (-du2 * e1z + du1 * e2z) * invDet;

    const stretchU = Math.sqrt(dPdu_x * dPdu_x + dPdu_y * dPdu_y + dPdu_z * dPdu_z);
    const stretchV = Math.sqrt(dPdv_x * dPdv_x + dPdv_y * dPdv_y + dPdv_z * dPdv_z);

    // UV area for weighted average
    const uvArea = Math.abs(det) * 0.5;
    totalStretchU += stretchU * uvArea;
    totalStretchV += stretchV * uvArea;
    totalWeight += uvArea;

    triangles.push({ u0, v0, u1, v1, u2, v2, stretchU, stretchV });
  }

  if (triangles.length === 0 || totalWeight === 0) {
    return { getDistortion: () => ({ scaleU: 1, scaleV: 1 }) };
  }

  // Reference stretch = weighted average across the surface
  const refStretchU = totalStretchU / totalWeight;
  const refStretchV = totalStretchV / totalWeight;

  console.log(
    `[UVDistortion] Built map: ${triangles.length} tris, ` +
    `refStretchU=${refStretchU.toFixed(3)}, refStretchV=${refStretchV.toFixed(3)}`
  );

  // ── Spatial grid for O(1) triangle lookup ──
  const grid: number[][] = new Array(GRID_SIZE * GRID_SIZE);
  for (let i = 0; i < grid.length; i++) grid[i] = [];

  for (let triIdx = 0; triIdx < triangles.length; triIdx++) {
    const tri = triangles[triIdx];
    const minU = Math.min(tri.u0, tri.u1, tri.u2);
    const maxU = Math.max(tri.u0, tri.u1, tri.u2);
    const minV = Math.min(tri.v0, tri.v1, tri.v2);
    const maxV = Math.max(tri.v0, tri.v1, tri.v2);

    const cMinU = Math.max(0, Math.floor(minU * GRID_SIZE));
    const cMaxU = Math.min(GRID_SIZE - 1, Math.floor(maxU * GRID_SIZE));
    const cMinV = Math.max(0, Math.floor(minV * GRID_SIZE));
    const cMaxV = Math.min(GRID_SIZE - 1, Math.floor(maxV * GRID_SIZE));

    for (let cy = cMinV; cy <= cMaxV; cy++) {
      for (let cx = cMinU; cx <= cMaxU; cx++) {
        grid[cy * GRID_SIZE + cx].push(triIdx);
      }
    }
  }

  // Barycentric point-in-triangle test — returns true if (px, py) is inside tri
  function hitTest(px: number, py: number, tri: TriData): boolean {
    const dx1 = tri.u1 - tri.u0, dy1 = tri.v1 - tri.v0;
    const dx2 = tri.u2 - tri.u0, dy2 = tri.v2 - tri.v0;
    const dpx = px - tri.u0, dpy = py - tri.v0;

    const d00 = dx1 * dx1 + dy1 * dy1;
    const d01 = dx1 * dx2 + dy1 * dy2;
    const d11 = dx2 * dx2 + dy2 * dy2;
    const d20 = dpx * dx1 + dpy * dy1;
    const d21 = dpx * dx2 + dpy * dy2;

    const denom = d00 * d11 - d01 * d01;
    if (Math.abs(denom) < 1e-10) return false;

    const bv = (d11 * d20 - d01 * d21) / denom;
    const bw = (d00 * d21 - d01 * d20) / denom;
    const bu = 1 - bv - bw;
    return bu >= -0.01 && bv >= -0.01 && bw >= -0.01;
  }

  function findTriangle(u: number, v: number): TriData | null {
    const cellX = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor(u * GRID_SIZE)));
    const cellY = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor(v * GRID_SIZE)));

    // Check primary cell
    const candidates = grid[cellY * GRID_SIZE + cellX];
    for (const idx of candidates) {
      if (hitTest(u, v, triangles[idx])) return triangles[idx];
    }

    // Fallback: check 8 neighbours
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cellX + dx, ny = cellY + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        const nbr = grid[ny * GRID_SIZE + nx];
        for (const idx of nbr) {
          if (hitTest(u, v, triangles[idx])) return triangles[idx];
        }
      }
    }
    return null;
  }

  function getDistortion(u: number, v: number): { scaleU: number; scaleV: number } {
    u = Math.max(0, Math.min(0.9999, u));
    v = Math.max(0, Math.min(0.9999, v));

    const tri = findTriangle(u, v);
    if (tri) {
      return {
        scaleU: Math.max(tri.stretchU, 0.001) / refStretchU,
        scaleV: Math.max(tri.stretchV, 0.001) / refStretchV,
      };
    }
    return { scaleU: 1, scaleV: 1 };
  }

  return { getDistortion };
}
