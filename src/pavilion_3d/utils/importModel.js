import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import xatlasWasmUrl from 'xatlasjs/dist/xatlas.wasm?url';
import xatlasWorkerUrl from 'xatlasjs/dist/xatlas.js?url';

// ---------------------------------------------------------------------------
// UV Checker Texture — colorful numbered grid for debugging UV mapping
// ---------------------------------------------------------------------------

let _cachedCheckerTexture = null;
const _originalGeometryStates = new WeakMap();
let _smartUvUnwrapperPromise = null;

const NATIVE_UV_METHODS = new Set([
    'native-minimum-stretch',
    'native-angle-based',
    'native-conformal',
]);

export function isNativeUVMethod(method) {
    return NATIVE_UV_METHODS.has(method);
}

function toAbsoluteAssetUrl(url) {
    if (!url) return url;
    if (/^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('blob:') || url.startsWith('data:')) {
        return url;
    }
    return new URL(url, window.location.href).href;
}

/**
 * Generates a colorful UV checker texture with numbered cells.
 * Each cell has a unique color + number so you can immediately see:
 * - Stretching (cells become rectangles instead of squares)
 * - Distortion (cells are warped/curved)
 * - Seams (numbers don't flow continuously)
 * - Orientation (numbers show direction)
 */
export function generateUVCheckerTexture() {
    if (_cachedCheckerTexture) return _cachedCheckerTexture;

    const size = 1024;
    const gridCount = 8;
    const cellSize = size / gridCount;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Color palette — distinct, saturated colors for each cell
    const colors = [
        '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
        '#9b59b6', '#1abc9c', '#e67e22', '#2980b9',
        '#27ae60', '#c0392b', '#8e44ad', '#16a085',
        '#d35400', '#2c3e50', '#f1c40f', '#7f8c8d',
    ];

    for (let row = 0; row < gridCount; row++) {
        for (let col = 0; col < gridCount; col++) {
            const x = col * cellSize;
            const y = row * cellSize;
            const colorIdx = (row * gridCount + col) % colors.length;
            const isEven = (row + col) % 2 === 0;

            // Base cell color
            ctx.fillStyle = isEven ? colors[colorIdx] : '#222222';
            ctx.fillRect(x, y, cellSize, cellSize);

            // Lighter inner square to show cell boundaries
            const inset = cellSize * 0.08;
            ctx.fillStyle = isEven
                ? shadeColor(colors[colorIdx], 30)
                : '#333333';
            ctx.fillRect(x + inset, y + inset, cellSize - inset * 2, cellSize - inset * 2);

            // Grid line border
            ctx.strokeStyle = 'rgba(255,255,255,0.4)';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, cellSize, cellSize);

            // Cell number label
            const cellNum = row * gridCount + col;
            ctx.fillStyle = isEven ? '#fff' : '#aaa';
            ctx.font = `bold ${Math.floor(cellSize * 0.3)}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(cellNum), x + cellSize / 2, y + cellSize / 2);

            // Small U/V coordinate label
            ctx.font = `${Math.floor(cellSize * 0.12)}px monospace`;
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(`${col},${row}`, x + 4, y + 2);
        }
    }

    // Draw thick axes on U=0 (left edge) and V=0 (bottom edge mapped to top in canvas)
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, size);
    ctx.stroke();

    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size, 0);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    _cachedCheckerTexture = texture;
    return texture;
}

function shadeColor(hex, percent) {
    const num = parseInt(hex.slice(1), 16);
    const r = Math.min(255, (num >> 16) + percent);
    const g = Math.min(255, ((num >> 8) & 0x00FF) + percent);
    const b = Math.min(255, (num & 0x0000FF) + percent);
    return `rgb(${r},${g},${b})`;
}

function cloneGeometryState(geometry) {
    const attributes = {};
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
        attributes[name] = attribute.clone();
    }

    return {
        attributes,
        index: geometry.index ? geometry.index.clone() : null,
        groups: geometry.groups.map((group) => ({ ...group })),
        drawRange: { ...geometry.drawRange },
    };
}

function applyGeometryState(geometry, state) {
    for (const name of Object.keys(geometry.attributes)) {
        if (!(name in state.attributes)) {
            geometry.deleteAttribute(name);
        }
    }

    for (const [name, attribute] of Object.entries(state.attributes)) {
        geometry.setAttribute(name, attribute.clone());
    }

    geometry.setIndex(state.index ? state.index.clone() : null);
    geometry.clearGroups();
    for (const group of state.groups) {
        geometry.addGroup(group.start, group.count, group.materialIndex);
    }
    geometry.setDrawRange(state.drawRange.start, state.drawRange.count);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
}

function createGeometryFromState(state) {
    const geometry = new THREE.BufferGeometry();
    applyGeometryState(geometry, state);
    return geometry;
}

function ensureOriginalGeometryState(geometry) {
    if (!_originalGeometryStates.has(geometry)) {
        _originalGeometryStates.set(geometry, cloneGeometryState(geometry));
    }
    return _originalGeometryStates.get(geometry);
}

function getGeometryMaxDimension(geometry) {
    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox?.getSize(size);
    return Math.max(size.x, size.y, size.z, 1);
}

function buildSmartUvSourceGeometry(geometry) {
    let source = clonePositionOnlyGeometry(geometry);
    ensureIndexedGeometry(source);

    const weldTolerance = Math.max(getGeometryMaxDimension(source) * 1e-6, 1e-6);
    source = mergeVertices(source, weldTolerance);
    source = removeDegenerateTriangles(source, (getGeometryMaxDimension(source) ** 2) * 1e-12);
    source = removeDuplicateTriangles(source);
    if (!source.index || source.index.count === 0) {
        return source;
    }
    source = orientTrianglesConsistently(source);
    source.computeVertexNormals();
    source.computeBoundingBox();
    source.computeBoundingSphere();
    return source;
}

function getSmartUvOptions(geometry) {
    const faceCount = geometry.index ? geometry.index.count / 3 : geometry.getAttribute('position').count / 3;
    const resolution = 2048;
    const padding = Math.max(4, Math.round(resolution / 512));
    const isLargeMesh = faceCount > 20000;

    return {
        chartOptions: {
            fixWinding: true,
            maxIterations: faceCount > 120000 ? 1 : isLargeMesh ? 2 : 4,
            maxCost: 3,
            normalDeviationWeight: 2.5,
            normalSeamWeight: 4.5,
            roundnessWeight: 0.001,
            straightnessWeight: 8,
            textureSeamWeight: 0,
            useInputMeshUvs: false,
        },
        packOptions: {
            resolution,
            padding,
            bilinear: true,
            blockAlign: true,
            bruteForce: faceCount <= 2000,
            createImage: false,
            maxChartSize: 0,
            rotateCharts: true,
            rotateChartsToAxis: true,
            texelsPerUnit: 0,
        },
    };
}

async function getSmartUvUnwrapper() {
    if (!_smartUvUnwrapperPromise) {
        _smartUvUnwrapperPromise = (async () => {
            const { UVUnwrapper } = await import('xatlas-three');
            const unwrapper = new UVUnwrapper({ BufferAttribute: THREE.BufferAttribute });
            unwrapper.useNormals = true;
            const wasmUrl = toAbsoluteAssetUrl(xatlasWasmUrl);
            const workerUrl = toAbsoluteAssetUrl(xatlasWorkerUrl);
            await unwrapper.loadLibrary(
                (mode, progress) => { console.log(`[SmartUV] ${mode}: ${progress}%`); },
                wasmUrl,
                workerUrl
            );
            return unwrapper;
        })().catch((error) => {
            _smartUvUnwrapperPromise = null;
            throw error;
        });
    }

    return _smartUvUnwrapperPromise;
}


// ---------------------------------------------------------------------------
// Auto UV Generation — three projection methods
// ---------------------------------------------------------------------------

/**
 * Box (triplanar) UV projection.
 * For each triangle, picks the dominant axis and projects from that side.
 * Best for complex, arbitrary shapes.
 */
function generateBoxUV(geometry) {
    const pos = geometry.getAttribute('position');
    const count = pos.count;
    const uvs = new Float32Array(count * 2);

    // Compute bounding box for normalization
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const size = new THREE.Vector3();
    bb.getSize(size);
    const center = new THREE.Vector3();
    bb.getCenter(center);

    // Avoid division by zero
    const sx = size.x || 1;
    const sy = size.y || 1;
    const sz = size.z || 1;

    // We need face normals to decide projection axis
    // Process per-triangle
    const index = geometry.getIndex();
    const isIndexed = !!index;
    const triCount = isIndexed ? index.count / 3 : count / 3;

    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();

    for (let t = 0; t < triCount; t++) {
        const i0 = isIndexed ? index.getX(t * 3) : t * 3;
        const i1 = isIndexed ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = isIndexed ? index.getX(t * 3 + 2) : t * 3 + 2;

        a.fromBufferAttribute(pos, i0);
        b.fromBufferAttribute(pos, i1);
        c.fromBufferAttribute(pos, i2);

        ab.subVectors(b, a);
        ac.subVectors(c, a);
        normal.crossVectors(ab, ac);

        const nx = Math.abs(normal.x);
        const ny = Math.abs(normal.y);
        const nz = Math.abs(normal.z);

        const verts = [
            { idx: i0, v: a },
            { idx: i1, v: b },
            { idx: i2, v: c },
        ];

        for (const { idx, v } of verts) {
            let u, vv;
            if (nx >= ny && nx >= nz) {
                // Project from X axis (use Y, Z)
                u = (v.z - center.z) / sz + 0.5;
                vv = (v.y - center.y) / sy + 0.5;
            } else if (ny >= nx && ny >= nz) {
                // Project from Y axis (use X, Z)
                u = (v.x - center.x) / sx + 0.5;
                vv = (v.z - center.z) / sz + 0.5;
            } else {
                // Project from Z axis (use X, Y)
                u = (v.x - center.x) / sx + 0.5;
                vv = (v.y - center.y) / sy + 0.5;
            }
            uvs[idx * 2] = u;
            uvs[idx * 2 + 1] = vv;
        }
    }

    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

/**
 * Spherical UV projection.
 * Maps longitude → U, latitude → V.
 * Best for roughly spherical objects.
 */
function generateSphericalUV(geometry) {
    const pos = geometry.getAttribute('position');
    const count = pos.count;
    const uvs = new Float32Array(count * 2);

    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);

    for (let i = 0; i < count; i++) {
        const x = pos.getX(i) - center.x;
        const y = pos.getY(i) - center.y;
        const z = pos.getZ(i) - center.z;

        const r = Math.sqrt(x * x + y * y + z * z) || 1;
        const theta = Math.atan2(z, x); // longitude
        const phi = Math.acos(Math.max(-1, Math.min(1, y / r))); // latitude

        uvs[i * 2] = (theta + Math.PI) / (2 * Math.PI);
        uvs[i * 2 + 1] = phi / Math.PI;
    }

    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

/**
 * Cylindrical UV projection.
 * Maps angle around Y axis → U, height → V.
 * Best for elongated/tower-like objects.
 */
function generateCylindricalUV(geometry) {
    const pos = geometry.getAttribute('position');
    const count = pos.count;
    const uvs = new Float32Array(count * 2);

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const center = new THREE.Vector3();
    bb.getCenter(center);
    const height = bb.max.y - bb.min.y || 1;

    for (let i = 0; i < count; i++) {
        const x = pos.getX(i) - center.x;
        const y = pos.getY(i) - bb.min.y;
        const z = pos.getZ(i) - center.z;

        const theta = Math.atan2(z, x);
        uvs[i * 2] = (theta + Math.PI) / (2 * Math.PI);
        uvs[i * 2 + 1] = y / height;
    }

    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

/**
 * Planar UV projection.
 * Maps X -> U, Y -> V, as if projecting directly from the front (Z axis).
 * Best for applying a decal pattern across flat or gently curved forward-facing surfaces.
 */
function generatePlanarUV(geometry) {
    const pos = geometry.getAttribute('position');
    const count = pos.count;
    const uvs = new Float32Array(count * 2);

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const size = new THREE.Vector3();
    bb.getSize(size);
    const center = new THREE.Vector3();
    bb.getCenter(center);

    const sx = size.x || 1;
    const sy = size.y || 1;

    for (let i = 0; i < count; i++) {
        uvs[i * 2] = (pos.getX(i) - center.x) / sx + 0.5;
        uvs[i * 2 + 1] = (pos.getY(i) - center.y) / sy + 0.5;
    }

    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

// ---------------------------------------------------------------------------
// UV application helper
// ---------------------------------------------------------------------------

export async function applyUVMethod(geometry, method) {
    if (method === 'smart') {
        const originalState = ensureOriginalGeometryState(geometry);
        const unwrapper = await getSmartUvUnwrapper();
        const sourceGeometry = createGeometryFromState(originalState);
        const workingGeometry = buildSmartUvSourceGeometry(sourceGeometry);
        if (!workingGeometry.index || workingGeometry.index.count === 0) {
            console.warn('[SmartUV] Geometry has no valid faces after cleanup, falling back to box UV mapping');
            applyGeometryState(geometry, originalState);
            generateBoxUV(geometry);
            return;
        }
        const { chartOptions, packOptions } = getSmartUvOptions(workingGeometry);
        unwrapper.chartOptions = chartOptions;
        unwrapper.packOptions = packOptions;

        console.log(
            `[SmartUV] Unwrapping geometry: ${Math.round(workingGeometry.index.count / 3)} faces, ` +
            `${workingGeometry.getAttribute('position').count} vertices, ` +
            `bruteForce=${packOptions.bruteForce}, maxIterations=${chartOptions.maxIterations}`
        );
        const savedImportTransform = geometry.userData.importTransform;
        await unwrapper.unwrapGeometry(workingGeometry);
        applyGeometryState(geometry, cloneGeometryState(workingGeometry));
        if (savedImportTransform) geometry.userData.importTransform = savedImportTransform;
        console.log('[SmartUV] UV unwrapping complete.');
        return;
    }

    const originalState = _originalGeometryStates.get(geometry);

    if (method === 'original') {
        if (originalState) {
            applyGeometryState(geometry, originalState);
        } else if (geometry.userData.originalUVs && geometry.userData.originalUVs.count === geometry.attributes.position.count) {
            geometry.setAttribute('uv', geometry.userData.originalUVs.clone());
        } else if (!geometry.attributes.uv) {
            console.warn('[Import] No original UVs found, falling back to box UV mapping');
            generateBoxUV(geometry);
        } else if (geometry.userData.originalUVs) {
            console.warn('[Import] Original UVs no longer match repaired topology, keeping current UVs');
        }
        return;
    }

    if (originalState) {
        applyGeometryState(geometry, originalState);
    }

    switch (method) {
        case 'spherical':
            generateSphericalUV(geometry);
            break;
        case 'cylindrical':
            generateCylindricalUV(geometry);
            break;
        case 'planar':
            generatePlanarUV(geometry);
            break;
        case 'box':
        default:
            generateBoxUV(geometry);
            break;
    }
}

// ---------------------------------------------------------------------------
// Normalize geometry: shared center + shared scale for one or more imports
// ---------------------------------------------------------------------------

function buildCombinedImportTransform(geometries, targetHeight = 15) {
    const bbox = new THREE.Box3();
    let hasGeometry = false;

    for (const geometry of geometries) {
        if (!geometry) continue;
        geometry.computeBoundingBox();
        if (!geometry.boundingBox) continue;
        bbox.union(geometry.boundingBox);
        hasGeometry = true;
    }

    if (!hasGeometry) return null;

    const center = new THREE.Vector3();
    bbox.getCenter(center);

    const size = new THREE.Vector3();
    bbox.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = targetHeight / maxDim;

    return {
        centerX: center.x,
        centerY: center.y,
        centerZ: center.z,
        scale,
        targetHeight,
    };
}

function applyImportTransform(geometry, transform) {
    if (!geometry || !transform) return geometry;

    const normalized = geometry.clone();
    normalized.userData = {
        ...geometry.userData,
        importTransform: { ...transform },
    };
    if (geometry.userData?.originalUVs) {
        normalized.userData.originalUVs = geometry.userData.originalUVs.clone();
    }

    const pos = normalized.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
        pos.setX(i, (pos.getX(i) - transform.centerX) * transform.scale);
        pos.setY(i, (pos.getY(i) - transform.centerY) * transform.scale + transform.targetHeight / 2);
        pos.setZ(i, (pos.getZ(i) - transform.centerZ) * transform.scale);
    }
    pos.needsUpdate = true;
    normalized.computeBoundingBox();
    normalized.computeBoundingSphere();
    return normalized;
}

export function denormalizeImportedGeometry(geometry) {
    if (!geometry) return null;
    const transform = geometry.userData?.importTransform;
    if (!transform) return geometry.clone();

    const raw = geometry.clone();
    const pos = raw.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
        pos.setX(i, pos.getX(i) / transform.scale + transform.centerX);
        pos.setY(i, (pos.getY(i) - transform.targetHeight / 2) / transform.scale + transform.centerY);
        pos.setZ(i, pos.getZ(i) / transform.scale + transform.centerZ);
    }
    pos.needsUpdate = true;
    raw.computeBoundingBox();
    raw.computeBoundingSphere();
    raw.userData = { ...raw.userData };
    if (geometry.userData?.originalUVs) {
        raw.userData.originalUVs = geometry.userData.originalUVs.clone();
    }
    delete raw.userData.importTransform;
    return raw;
}

export function normalizeImportedGeometries(geometries, targetHeight = 15) {
    const transform = buildCombinedImportTransform(geometries, targetHeight);
    if (!transform) return [];
    return geometries.map((geometry) => applyImportTransform(geometry, transform));
}

function ensureIndexedGeometry(geometry) {
    if (!geometry.index) {
        const posCount = geometry.attributes.position.count;
        const idx = new Uint32Array(posCount);
        for (let i = 0; i < posCount; i++) idx[i] = i;
        geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    return geometry;
}

function clonePositionOnlyGeometry(geometry) {
    const clone = new THREE.BufferGeometry();
    clone.setAttribute('position', geometry.getAttribute('position').clone());
    if (geometry.index) clone.setIndex(geometry.index.clone());
    return clone;
}

function createIndexedGeometryFromIndices(positionAttr, indices) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', positionAttr.clone());
    geom.setIndex(indices);
    return geom;
}

function computeTopologyStats(geometry) {
    const index = geometry.index.array;
    const edgeCounts = new Map();

    for (let i = 0; i < index.length; i += 3) {
        const tri = [index[i], index[i + 1], index[i + 2]];
        for (let e = 0; e < 3; e++) {
            const a = tri[e];
            const b = tri[(e + 1) % 3];
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;
            edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
        }
    }

    let boundaryEdges = 0;
    let nonManifoldEdges = 0;
    for (const count of edgeCounts.values()) {
        if (count === 1) boundaryEdges++;
        else if (count > 2) nonManifoldEdges++;
    }

    return {
        faceCount: index.length / 3,
        boundaryEdges,
        nonManifoldEdges,
        uniqueEdges: edgeCounts.size,
    };
}

function removeDegenerateTriangles(geometry, minAreaSq) {
    const pos = geometry.getAttribute('position');
    const index = geometry.index.array;
    const kept = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const cross = new THREE.Vector3();

    for (let i = 0; i < index.length; i += 3) {
        const i0 = index[i];
        const i1 = index[i + 1];
        const i2 = index[i + 2];
        if (i0 === i1 || i1 === i2 || i2 === i0) continue;

        a.fromBufferAttribute(pos, i0);
        b.fromBufferAttribute(pos, i1);
        c.fromBufferAttribute(pos, i2);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        cross.crossVectors(ab, ac);
        if (cross.lengthSq() <= minAreaSq) continue;

        kept.push(i0, i1, i2);
    }

    return createIndexedGeometryFromIndices(pos, kept);
}

function removeDuplicateTriangles(geometry) {
    const pos = geometry.getAttribute('position');
    const index = geometry.index.array;
    const kept = [];
    const seen = new Set();

    for (let i = 0; i < index.length; i += 3) {
        const tri = [index[i], index[i + 1], index[i + 2]];
        const key = [...tri].sort((a, b) => a - b).join('_');
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(tri[0], tri[1], tri[2]);
    }

    return createIndexedGeometryFromIndices(pos, kept);
}

function extractLargestConnectedComponent(geometry) {
    const pos = geometry.getAttribute('position');
    const index = geometry.index.array;
    const faceCount = index.length / 3;
    if (faceCount <= 1) return geometry;

    const vertexToFaces = new Map();
    for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
        for (let j = 0; j < 3; j++) {
            const vertexIndex = index[faceIndex * 3 + j];
            if (!vertexToFaces.has(vertexIndex)) vertexToFaces.set(vertexIndex, []);
            vertexToFaces.get(vertexIndex).push(faceIndex);
        }
    }

    const visited = new Uint8Array(faceCount);
    let largestComponent = [];

    for (let start = 0; start < faceCount; start++) {
        if (visited[start]) continue;
        const stack = [start];
        const faces = [];
        visited[start] = 1;

        while (stack.length > 0) {
            const faceIndex = stack.pop();
            faces.push(faceIndex);

            for (let j = 0; j < 3; j++) {
                const vertexIndex = index[faceIndex * 3 + j];
                const neighbors = vertexToFaces.get(vertexIndex) || [];
                for (const neighbor of neighbors) {
                    if (!visited[neighbor]) {
                        visited[neighbor] = 1;
                        stack.push(neighbor);
                    }
                }
            }
        }

        if (faces.length > largestComponent.length) {
            largestComponent = faces;
        }
    }

    if (largestComponent.length === faceCount) return geometry;

    const kept = [];
    for (const faceIndex of largestComponent) {
        const offset = faceIndex * 3;
        kept.push(index[offset], index[offset + 1], index[offset + 2]);
    }

    return createIndexedGeometryFromIndices(pos, kept);
}

function orientTrianglesConsistently(geometry) {
    const pos = geometry.getAttribute('position');
    const index = Array.from(geometry.index.array);
    const faceCount = index.length / 3;
    if (faceCount === 0) return geometry;

    const edgeMap = new Map();
    const makeKey = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;

    for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
        const offset = faceIndex * 3;
        const tri = [index[offset], index[offset + 1], index[offset + 2]];
        const edges = [
            [tri[0], tri[1]],
            [tri[1], tri[2]],
            [tri[2], tri[0]],
        ];

        for (const [a, b] of edges) {
            const key = makeKey(a, b);
            if (!edgeMap.has(key)) edgeMap.set(key, []);
            edgeMap.get(key).push({ faceIndex, sameAsCanonical: a < b });
        }
    }

    const flips = new Int8Array(faceCount);
    const visited = new Uint8Array(faceCount);

    for (let start = 0; start < faceCount; start++) {
        if (visited[start]) continue;
        const stack = [start];
        visited[start] = 1;

        while (stack.length > 0) {
            const faceIndex = stack.pop();
            const offset = faceIndex * 3;
            const tri = [index[offset], index[offset + 1], index[offset + 2]];
            const edges = [
                [tri[0], tri[1]],
                [tri[1], tri[2]],
                [tri[2], tri[0]],
            ];

            for (const [a, b] of edges) {
                const key = makeKey(a, b);
                const refs = edgeMap.get(key) || [];
                const currentRef = refs.find(ref => ref.faceIndex === faceIndex);
                for (const ref of refs) {
                    if (ref.faceIndex === faceIndex || visited[ref.faceIndex]) continue;
                    const sameDirection = currentRef.sameAsCanonical === ref.sameAsCanonical;
                    flips[ref.faceIndex] = flips[faceIndex] ^ (sameDirection ? 1 : 0);
                    visited[ref.faceIndex] = 1;
                    stack.push(ref.faceIndex);
                }
            }
        }
    }

    for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
        if (!flips[faceIndex]) continue;
        const offset = faceIndex * 3;
        const tmp = index[offset + 1];
        index[offset + 1] = index[offset + 2];
        index[offset + 2] = tmp;
    }

    const oriented = createIndexedGeometryFromIndices(pos, index);
    oriented.computeBoundingBox();
    const center = new THREE.Vector3();
    oriented.boundingBox.getCenter(center);

    let score = 0;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const centroid = new THREE.Vector3();

    for (let i = 0; i < index.length; i += 3) {
        a.fromBufferAttribute(pos, index[i]);
        b.fromBufferAttribute(pos, index[i + 1]);
        c.fromBufferAttribute(pos, index[i + 2]);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        normal.crossVectors(ab, ac);
        centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        score += normal.dot(centroid.sub(center));
    }

    if (score < 0) {
        for (let i = 0; i < index.length; i += 3) {
            const tmp = index[i + 1];
            index[i + 1] = index[i + 2];
            index[i + 2] = tmp;
        }
        return createIndexedGeometryFromIndices(pos, index);
    }

    return oriented;
}

export function repairImportedGeometry(sourceGeometry, options = {}) {
    const weldTolerance = options.weldTolerance ?? 0.01;
    let geometry = clonePositionOnlyGeometry(sourceGeometry);
    geometry.userData = { ...sourceGeometry.userData };

    ensureIndexedGeometry(geometry);
    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const minAreaSq = (maxDim * maxDim) * 1e-12;

    const before = computeTopologyStats(geometry);

    geometry = mergeVertices(geometry, weldTolerance);
    geometry = removeDegenerateTriangles(geometry, minAreaSq);
    geometry = removeDuplicateTriangles(geometry);
    geometry = extractLargestConnectedComponent(geometry);
    if (!geometry.index || geometry.index.count === 0) {
        console.warn('[Import] Repair removed all faces, keeping original geometry');
        return sourceGeometry.clone();
    }
    geometry = orientTrianglesConsistently(geometry);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.userData = {
        ...sourceGeometry.userData,
        topologyStats: {
            before,
            after: computeTopologyStats(geometry),
        },
    };

    console.log('[Import] Repair stats:', geometry.userData.topologyStats);
    return geometry;
}

// ---------------------------------------------------------------------------
// Collect all geometries from an OBJ scene graph
// ---------------------------------------------------------------------------

function collectGeometries(object) {
    const geometries = [];

    object.traverse((child) => {
        if (child.isMesh && child.geometry) {
            // Clone so we can manipulate without affecting the original
            const geom = child.geometry.clone();

            // Apply any transforms from the object hierarchy
            if (child.matrixWorld) {
                child.updateMatrixWorld(true);
                geom.applyMatrix4(child.matrixWorld);
            }

            // Ensure indexed geometry for mergeGeometries
            if (!geom.index) {
                const posCount = geom.attributes.position.count;
                const idx = [];
                for (let i = 0; i < posCount; i++) idx.push(i);
                geom.setIndex(idx);
            }

            geometries.push(geom);
        }
    });

    return geometries;
}

// ---------------------------------------------------------------------------
// Main import function
// ---------------------------------------------------------------------------

function objTextToGeometry(text) {
    const loader = new OBJLoader();
    const object = loader.parse(text);
    const geometries = collectGeometries(object);

    if (geometries.length === 0) {
        throw new Error('No geometry found in OBJ file');
    }

    console.log(`[Import] OBJ loaded: ${geometries.length} component(s)`);

    let merged;
    if (geometries.length === 1) {
        merged = geometries[0];
    } else {
        merged = mergeGeometries(geometries, false);
        for (const g of geometries) g.dispose();
    }

    if (!merged) {
        throw new Error('Failed to merge geometries');
    }

    if (merged.attributes.uv) {
        merged.userData.originalUVs = merged.attributes.uv.clone();
    }

    console.log(`[Import] Merged geometry: ${merged.attributes.position.count} vertices`);
    return merged;
}

async function loadNativeUvModelGeometry(file, uvMethod) {
    const response = await fetch(
        `http://127.0.0.1:3100/unwrap?method=${encodeURIComponent(uvMethod)}&filename=${encodeURIComponent(file.name)}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-File-Name': file.name,
            },
            body: await file.arrayBuffer(),
        }
    );

    if (!response.ok) {
        let message = await response.text();
        try {
            const parsed = JSON.parse(message);
            message = parsed.error || message;
        } catch {
            // Keep raw error text.
        }
        throw new Error(`Native UV unwrap failed: ${message}`);
    }

    const text = await response.text();
    console.log(`[NativeUV] Blender unwrap complete: ${file.name}`);
    return objTextToGeometry(text);
}

async function loadRawModelGeometry(file, uvMethod = null) {
    const fileName = file.name.toLowerCase();

    if (isNativeUVMethod(uvMethod)) {
        return loadNativeUvModelGeometry(file, uvMethod);
    }

    if (fileName.endsWith('.stl')) {
        const loader = new STLLoader();
        const buffer = await file.arrayBuffer();
        const geometry = loader.parse(buffer);
        console.log(`[Import] STL loaded: ${geometry.attributes.position.count} vertices`);
        return geometry;
    }

    if (fileName.endsWith('.obj')) {
        const text = await file.text();
        return objTextToGeometry(text);
    }

    throw new Error('Unsupported file format. Use .obj or .stl');
}

/**
 * Opens a file dialog, loads OBJ or STL and calls the callback with either
 * the raw geometry or a normalized version depending on options.
 *
 * @param {string} uvMethod - 'box' | 'spherical' | 'cylindrical'
 * @param {Function} callback - (geometry: THREE.BufferGeometry, file: File) => void
 * @param {{ normalize?: boolean, targetHeight?: number }} options
 */
export function importModelFile(uvMethod, callback, options = {}) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.obj,.stl';

    input.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const rawGeometry = await loadRawModelGeometry(file, uvMethod);
            const shouldNormalize = options.normalize !== false;
            let geometry = rawGeometry;

            if (shouldNormalize) {
                const [normalizedGeometry] = normalizeImportedGeometries([rawGeometry], options.targetHeight ?? 15);
                geometry = normalizedGeometry;
            }

            if (!isNativeUVMethod(uvMethod)) {
                await applyUVMethod(geometry, uvMethod);
            }
            geometry.computeVertexNormals();
            callback(geometry, file);
        } catch (err) {
            console.error('[Import] Parse error:', err);
            alert(err instanceof Error ? err.message : String(err));
        }
    });

    input.click();
}
