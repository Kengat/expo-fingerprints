import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// UV Checker Texture — colorful numbered grid for debugging UV mapping
// ---------------------------------------------------------------------------

let _cachedCheckerTexture = null;

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
        const { UVUnwrapper } = await import('xatlas-three');
        const unwrapper = new UVUnwrapper({ BufferAttribute: THREE.BufferAttribute });

        // Prevent random rotation of charts so directional patterns stay upright globally
        unwrapper.packOptions = {
            resolution: 2048,
            rotateCharts: false,
            rotateChartsToAxis: false,
            padding: 2,
            maxChartSize: 0,
            blockAlign: false,
            bruteForce: false,
            createImage: false
        };

        // Load the WASM library via CDN for Vite compatibility
        await unwrapper.loadLibrary(
            (mode, progress) => { console.log(`[SmartUV] ${mode}: ${progress}%`); },
            'https://cdn.jsdelivr.net/npm/xatlasjs@0.2.0/dist/xatlas.wasm',
            'https://cdn.jsdelivr.net/npm/xatlasjs@0.2.0/dist/xatlas.js'
        );

        console.log('[SmartUV] Unwrapping geometry...');
        const savedImportTransform = geometry.userData.importTransform;
        await unwrapper.unwrapGeometry(geometry);
        if (savedImportTransform) geometry.userData.importTransform = savedImportTransform;
        console.log('[SmartUV] UV unwrapping complete.');

        if (geometry.attributes.uv) {
            geometry.userData.originalUVs = geometry.attributes.uv.clone();
        }
        return;
    }

    if (method === 'original') {
        if (geometry.userData.originalUVs) {
            geometry.setAttribute('uv', geometry.userData.originalUVs.clone());
        } else if (!geometry.attributes.uv) {
            console.warn('[Import] No original UVs found, falling back to box UV mapping');
            generateBoxUV(geometry);
        }
        return;
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
// Normalize geometry: center + scale to target height
// ---------------------------------------------------------------------------

function normalizeGeometry(geometry, targetHeight = 15) {
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const center = new THREE.Vector3();
    bb.getCenter(center);
    const size = new THREE.Vector3();
    bb.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = targetHeight / maxDim;

    // Store the full transform so export can reverse it to original coordinates
    geometry.userData.importTransform = {
        centerX: center.x, centerY: center.y, centerZ: center.z,
        scale: scale,
        targetHeight: targetHeight,
    };

    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
        pos.setX(i, (pos.getX(i) - center.x) * scale);
        pos.setY(i, (pos.getY(i) - center.y) * scale + targetHeight / 2);
        pos.setZ(i, (pos.getZ(i) - center.z) * scale);
    }
    pos.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
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

/**
 * Opens a file dialog, loads OBJ or STL, merges all components,
 * generates UV mapping, normalizes size, and calls the callback.
 *
 * @param {string} uvMethod - 'box' | 'spherical' | 'cylindrical'
 * @param {Function} callback - (geometry: THREE.BufferGeometry) => void
 */
export function importModelFile(uvMethod, callback) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.obj,.stl';

    input.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const fileName = file.name.toLowerCase();
        const reader = new FileReader();

        if (fileName.endsWith('.stl')) {
            reader.onload = async (e) => {
                try {
                    const loader = new STLLoader();
                    const geometry = loader.parse(e.target.result);

                    normalizeGeometry(geometry);
                    await applyUVMethod(geometry, uvMethod);
                    geometry.computeVertexNormals();

                    console.log(`[Import] STL loaded: ${geometry.attributes.position.count} vertices`);
                    callback(geometry);
                } catch (err) {
                    console.error('[Import] STL parse error:', err);
                }
            };
            reader.readAsArrayBuffer(file);

        } else if (fileName.endsWith('.obj')) {
            reader.onload = async (e) => {
                try {
                    const loader = new OBJLoader();
                    const object = loader.parse(e.target.result);

                    const geometries = collectGeometries(object);
                    if (geometries.length === 0) {
                        console.error('[Import] No geometry found in OBJ file');
                        return;
                    }

                    console.log(`[Import] OBJ loaded: ${geometries.length} component(s)`);

                    let merged;
                    if (geometries.length === 1) {
                        merged = geometries[0];
                    } else {
                        merged = mergeGeometries(geometries, false);
                        // Dispose originals
                        for (const g of geometries) g.dispose();
                    }

                    if (!merged) {
                        console.error('[Import] Failed to merge geometries');
                        return;
                    }

                    if (merged.attributes.uv) {
                        merged.userData.originalUVs = merged.attributes.uv.clone();
                    }

                    normalizeGeometry(merged);
                    await applyUVMethod(merged, uvMethod);
                    merged.computeVertexNormals();

                    console.log(`[Import] Merged geometry: ${merged.attributes.position.count} vertices`);
                    callback(merged);
                } catch (err) {
                    console.error('[Import] OBJ parse error:', err);
                }
            };
            reader.readAsText(file);

        } else {
            console.error('[Import] Unsupported file format. Use .obj or .stl');
        }
    });

    input.click();
}
