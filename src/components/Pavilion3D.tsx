import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { params as defaultParams, presets } from '../pavilion_3d/params.js';
import { setupEnvironment, updateEnvironment } from '../pavilion_3d/environment.js';
import { setupPostProcessing, updatePostProcessing, resizePostProcessing } from '../pavilion_3d/postprocessing.js';
import { buildPavilion } from '../pavilion_3d/pavilion/index.js';
import { setupGUI } from '../pavilion_3d/gui.js';
import { captureScreenshot, exportGLTF, exportOBJ, exportSTL } from '../pavilion_3d/utils/export.js';
import {
    importModelFile,
    applyUVMethod,
    repairImportedGeometry,
    denormalizeImportedGeometry,
    normalizeImportedGeometries
} from '../pavilion_3d/utils/importModel.js';
import { getComputedItems } from './MergedFingerprintsCanvas';
import type { DotCircle, Streamline, CanvasItem } from './MergedFingerprintsCanvas';
import { generateStreamlines } from './FingerprintGenerator';

interface Pavilion3DProps {
    fingerprintCanvas: HTMLCanvasElement | null;
    bakeHolesTrigger?: number;
    bakeTubesTrigger?: number;
    previewTubesTrigger?: number;
    showSolidCheck?: boolean;
    dotCircles?: DotCircle[];
    streamlines?: Streamline[];
    fingerprintItems?: CanvasItem[];
    globalSettings?: any;
    onBaseGeometryUpdate?: (geom: THREE.BufferGeometry | null) => void;
    onSecondaryGeometryUpdate?: (geom: THREE.BufferGeometry | null) => void;
    editing3D?: boolean;
    fabricEnabled?: boolean;
    fabricItems?: any[];
    metaballs?: any[];
    onExtrusionPreviewAutoDisabled?: (reason: string) => void;
}

export interface Pavilion3DHandle {
    getEngine: () => {
        renderer: THREE.WebGLRenderer;
        scene: THREE.Scene;
        camera: THREE.PerspectiveCamera;
        controls: import('three/addons/controls/OrbitControls.js').OrbitControls;
        params: any;
        guiObj?: any;
    } | null;
}

export const Pavilion3D = forwardRef<Pavilion3DHandle, Pavilion3DProps>(function Pavilion3D({ fingerprintCanvas, bakeHolesTrigger = 0, bakeTubesTrigger = 0, previewTubesTrigger = 0, showSolidCheck = false, dotCircles = [], streamlines = [], fingerprintItems = [], globalSettings = {}, onBaseGeometryUpdate, onSecondaryGeometryUpdate, editing3D = false, fabricEnabled = false, fabricItems = [], metaballs = [], onExtrusionPreviewAutoDisabled }, ref) {
    const mountRef = useRef<HTMLDivElement>(null);
    const onBaseGeomRef = useRef(onBaseGeometryUpdate);
    onBaseGeomRef.current = onBaseGeometryUpdate;
    const onSecondaryGeomRef = useRef(onSecondaryGeometryUpdate);
    onSecondaryGeomRef.current = onSecondaryGeometryUpdate;
    const onExtrusionPreviewAutoDisabledRef = useRef(onExtrusionPreviewAutoDisabled);
    onExtrusionPreviewAutoDisabledRef.current = onExtrusionPreviewAutoDisabled;
    const engineRef = useRef<{
        renderer: THREE.WebGLRenderer;
        scene: THREE.Scene;
        camera: THREE.PerspectiveCamera;
        composer: any;
        controls: OrbitControls;
        params: typeof defaultParams;
        guiObj: any;
    } | null>(null);
    const nativeWrapGenerationRef = useRef(0);

    function createFingerprintThreeTexture(source: HTMLCanvasElement, mode: string, materialColor: string) {
        let canvas = source;

        if (mode === 'paint') {
            canvas = document.createElement('canvas');
            canvas.width = source.width;
            canvas.height = source.height;
            const ctx = canvas.getContext('2d');
            const srcCtx = source.getContext('2d');
            if (ctx && srcCtx) {
                const base = new THREE.Color(materialColor || '#c8a882');
                const data = srcCtx.getImageData(0, 0, source.width, source.height);
                const out = ctx.createImageData(source.width, source.height);
                for (let i = 0; i < data.data.length; i += 4) {
                    const brightness = (data.data[i] + data.data[i + 1] + data.data[i + 2]) / (255 * 3);
                    const isPattern = brightness < 0.5;
                    out.data[i] = isPattern ? 255 : Math.round(base.r * 255);
                    out.data[i + 1] = isPattern ? 255 : Math.round(base.g * 255);
                    out.data[i + 2] = isPattern ? 255 : Math.round(base.b * 255);
                    out.data[i + 3] = 255;
                }
                ctx.putImageData(out, 0, 0);
            }
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.flipY = true;
        tex.needsUpdate = true;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.unpackAlignment = 1;
        return tex;
    }

    function forEachLocalDotPlacement(
        segment: Array<{ x: number; y: number }>,
        spacing: number,
        callback: (dot: { x: number; y: number; distAlong: number; segmentLength: number }) => void,
    ) {
        if (segment.length < 2 || spacing <= 1e-8) return;

        const segmentLength = segment.reduce((sum, point, index) => {
            if (index === 0) return 0;
            const prev = segment[index - 1];
            return sum + Math.hypot(point.x - prev.x, point.y - prev.y);
        }, 0);

        let distUntilNextDot = spacing / 2;
        let distAtSegmentStart = 0;

        for (let i = 1; i < segment.length; i++) {
            const p1 = segment[i - 1];
            const p2 = segment[i];
            const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            if (d <= 1e-8) continue;

            while (distUntilNextDot <= d + 1e-8) {
                const t = Math.max(0, Math.min(1, distUntilNextDot / d));
                callback({
                    x: p1.x + (p2.x - p1.x) * t,
                    y: p1.y + (p2.y - p1.y) * t,
                    distAlong: distAtSegmentStart + distUntilNextDot,
                    segmentLength,
                });
                distUntilNextDot += spacing;
            }

            distAtSegmentStart += d;
            distUntilNextDot -= d;
        }
    }

    function isNearLocalSegmentEndpoint(
        segment: Array<{ x: number; y: number }>,
        dotX: number,
        dotY: number,
        forbiddenRadius: number,
    ) {
        if (segment.length < 2) return false;
        const start = segment[0];
        const end = segment[segment.length - 1];
        const startDx = dotX - start.x;
        const startDy = dotY - start.y;
        const endDx = dotX - end.x;
        const endDy = dotY - end.y;
        const r2 = forbiddenRadius * forbiddenRadius;
        return (startDx * startDx + startDy * startDy) <= r2 || (endDx * endDx + endDy * endDy) <= r2;
    }

    function createSurfaceDecalTexture(source: HTMLCanvasElement, item: CanvasItem, settings: any) {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.clearRect(0, 0, size, size);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(72, 72, 72, 0.72)';
        ctx.fillStyle = 'rgba(38, 38, 38, 0.78)';

        const lines = generateStreamlines(item.params, size, size, item.scale);

        for (const line of lines) {
            for (let i = 1; i < line.length; i++) {
                const prev = line[i - 1];
                const point = line[i];
                ctx.beginPath();
                ctx.moveTo(prev.x, prev.y);
                ctx.lineTo(point.x, point.y);
                ctx.lineWidth = Math.max(0.5, getItemLocalLineThickness(item, point.x, point.y));
                ctx.stroke();
            }
        }

        const dotSpacing = (item.params.dotSpacing ?? 18) / Math.max(item.scale, 1e-6);
        for (const line of lines) {
            if (line.length < 2 || dotSpacing <= 1e-6) continue;
            forEachLocalDotPlacement(line, dotSpacing, ({ x: dotX, y: dotY }) => {
                const baseRadius = getItemLocalDotRadius(item, dotX, dotY);
                const lineRadius = getItemLocalLineThickness(item, dotX, dotY) / 2;
                const endpointRadius = lineRadius + baseRadius * 0.1;
                if (isNearLocalSegmentEndpoint(line, dotX, dotY, endpointRadius)) {
                    return;
                }
                ctx.beginPath();
                ctx.arc(dotX, dotY, Math.max(0.5, baseRadius), 0, Math.PI * 2);
                ctx.fill();
            });
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.flipY = true;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        return tex;
    }

    function createSurfaceDecals(source: HTMLCanvasElement) {
        const settings: any = globalSettings || {};
        const computedItems = getComputedItems(fingerprintItems, settings);
        const gs = settings.globalScale || 1.0;
        return computedItems
            .filter((item) => item.surfaceAnchor)
            .map((item) => {
                const texture = createSurfaceDecalTexture(source, item, settings);
                if (!texture || !item.surfaceAnchor) return null;
                const decalSize = Math.max(0.5, 7.0 * item.scale * gs);
                return {
                    id: item.id,
                    texture,
                    position: item.surfaceAnchor.position,
                    normal: item.surfaceAnchor.normal,
                    faceIndex: item.surfaceAnchor.faceIndex,
                    size: [decalSize, decalSize, Math.max(1.0, decalSize * 0.75)],
                    rotation: item.rotation || 0,
                    item,
                };
            })
            .filter(Boolean);
    }

    function getItemLocalLineThickness(item: CanvasItem, lx: number, ly: number) {
        const lineThicknessMin = item.params.lineThicknessMin ?? 3;
        const lineThicknessMax = item.params.lineThicknessMax ?? 3;
        const noiseScale = item.params.noiseScale ?? 10;
        const scaledMin = lineThicknessMin / Math.max(item.scale, 1e-6);
        const scaledMax = lineThicknessMax / Math.max(item.scale, 1e-6);
        if (scaledMin === scaledMax) return scaledMin;
        const nx = (lx / 512) * 2 - 1;
        const ny = -((ly / 512) * 2 - 1);
        let v = 0;
        v += Math.sin(nx * noiseScale + item.params.seed + 10) * Math.cos(ny * noiseScale + item.params.seed + 10);
        v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed + 10) * Math.cos(ny * (noiseScale * 2) + item.params.seed + 10);
        v = (v + 1.5) / 3;
        return scaledMin + v * (scaledMax - scaledMin);
    }

    function getItemLocalDotRadius(item: CanvasItem, lx: number, ly: number) {
        const dotSizeMin = item.params.dotSizeMin ?? 1.5;
        const dotSizeMax = item.params.dotSizeMax ?? 6.0;
        const noiseScale = item.params.noiseScale ?? 10;
        const scaledMin = dotSizeMin / Math.max(item.scale, 1e-6);
        const scaledMax = dotSizeMax / Math.max(item.scale, 1e-6);
        const nx = (lx / 512) * 2 - 1;
        const ny = -((ly / 512) * 2 - 1);
        let v = 0;
        v += Math.sin(nx * noiseScale + item.params.seed) * Math.cos(ny * noiseScale + item.params.seed);
        v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed) * Math.cos(ny * (noiseScale * 2) + item.params.seed);
        v = (v + 1.5) / 3;
        return scaledMin + v * (scaledMax - scaledMin);
    }

    function mapNativeDecalUV(decal: any, u: number, v: number) {
        const positions = decal.positions;
        const uvs = decal.uvs;
        const normals = decal.normals;
        if (!Array.isArray(positions) || !Array.isArray(uvs)) return null;

        for (let i = 0; i < positions.length; i += 9) {
            const ti = (i / 3) * 2;
            const u0 = uvs[ti], v0 = uvs[ti + 1];
            const u1 = uvs[ti + 2], v1 = uvs[ti + 3];
            const u2 = uvs[ti + 4], v2 = uvs[ti + 5];
            const d00 = (u1 - u0) * (u1 - u0) + (v1 - v0) * (v1 - v0);
            const d01 = (u1 - u0) * (u2 - u0) + (v1 - v0) * (v2 - v0);
            const d11 = (u2 - u0) * (u2 - u0) + (v2 - v0) * (v2 - v0);
            const d20 = (u - u0) * (u1 - u0) + (v - v0) * (v1 - v0);
            const d21 = (u - u0) * (u2 - u0) + (v - v0) * (v2 - v0);
            const denom = d00 * d11 - d01 * d01;
            if (Math.abs(denom) < 1e-10) continue;
            const b = (d11 * d20 - d01 * d21) / denom;
            const c = (d00 * d21 - d01 * d20) / denom;
            const a = 1 - b - c;
            if (a < -0.001 || b < -0.001 || c < -0.001) continue;

            const p0 = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
            const p1 = new THREE.Vector3(positions[i + 3], positions[i + 4], positions[i + 5]);
            const p2 = new THREE.Vector3(positions[i + 6], positions[i + 7], positions[i + 8]);
            const position = p0.multiplyScalar(a).addScaledVector(p1, b).addScaledVector(p2, c);

            let normal: THREE.Vector3;
            if (Array.isArray(normals) && normals.length === positions.length) {
                const n0 = new THREE.Vector3(normals[i], normals[i + 1], normals[i + 2]);
                const n1 = new THREE.Vector3(normals[i + 3], normals[i + 4], normals[i + 5]);
                const n2 = new THREE.Vector3(normals[i + 6], normals[i + 7], normals[i + 8]);
                normal = n0.multiplyScalar(a).addScaledVector(n1, b).addScaledVector(n2, c).normalize();
            } else {
                normal = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0)).normalize();
            }
            return { position, normal };
        }

        return null;
    }

    function nativeTextureV(localY: number) {
        return 1 - localY / 512;
    }

    function buildNativeBakeData(sourceDecals: any[], nativeDecals: any[]) {
        const nativeCircles: any[] = [];
        const nativeLines: any[] = [];

        for (const nativeDecal of nativeDecals) {
            const sourceDecal = sourceDecals[nativeDecal.index];
            const item = sourceDecal?.item as CanvasItem | undefined;
            if (!item) continue;

            const lines = generateStreamlines(item.params, 512, 512, item.scale);
            const sizeX = Math.max(1e-6, Number(sourceDecal.size?.[0]) || 1);
            const textureScaleToWorld = sizeX / Math.max(1, 512 * item.scale);

            for (const line of lines) {
                let currentLine: any[] = [];
                for (const point of line) {
                    const u = point.x / 512;
                    const v = nativeTextureV(point.y);
                    const mapped = mapNativeDecalUV(nativeDecal, u, v);
                    if (!mapped) {
                        if (currentLine.length > 1) nativeLines.push(currentLine);
                        currentLine = [];
                        continue;
                    }

                    const lineThickness = getItemLocalLineThickness(item, point.x, point.y) * item.scale * textureScaleToWorld;
                    currentLine.push({
                        x: point.x,
                        y: point.y,
                        position: mapped.position.toArray(),
                        normal: mapped.normal.toArray(),
                        thickness: lineThickness,
                    });
                }
                if (currentLine.length > 1) nativeLines.push(currentLine);
            }

            const dotSpacing = (item.params.dotSpacing ?? 18) / Math.max(item.scale, 1e-6);
            for (const line of lines) {
                if (line.length < 2 || dotSpacing <= 1e-6) continue;

                const visibleSegments: Array<Array<{ x: number; y: number }>> = [];
                let currentSegment: Array<{ x: number; y: number }> = [];
                for (const point of line) {
                    const mapped = mapNativeDecalUV(nativeDecal, point.x / 512, nativeTextureV(point.y));
                    if (mapped) {
                        currentSegment.push({ x: point.x, y: point.y });
                    } else {
                        if (currentSegment.length > 1) visibleSegments.push(currentSegment);
                        currentSegment = [];
                    }
                }
                if (currentSegment.length > 1) visibleSegments.push(currentSegment);

                for (const segment of visibleSegments) {
                    forEachLocalDotPlacement(segment, dotSpacing, ({ x: dotX, y: dotY }) => {
                        const baseRadius = getItemLocalDotRadius(item, dotX, dotY);
                        const lineRadius = getItemLocalLineThickness(item, dotX, dotY) / 2;
                        const endpointRadius = lineRadius + baseRadius * 0.1;
                        if (isNearLocalSegmentEndpoint(segment, dotX, dotY, endpointRadius)) {
                            return;
                        }

                        const mapped = mapNativeDecalUV(nativeDecal, dotX / 512, nativeTextureV(dotY));
                        if (!mapped) return;

                        nativeCircles.push({
                            position: mapped.position.toArray(),
                            normal: mapped.normal.toArray(),
                            r: baseRadius * item.scale * textureScaleToWorld,
                            x: dotX,
                            y: dotY,
                        });
                    });
                }
            }
        }

        return { nativeCircles, nativeLines };
    }

    function findSceneShellMesh(scene: THREE.Scene) {
        let shellMesh: THREE.Mesh | null = null;
        scene.traverse((child: any) => {
            if (!shellMesh && child.name === 'pavilion-shell' && child.isMesh) {
                shellMesh = child as THREE.Mesh;
            }
        });
        return shellMesh;
    }

    function findSceneBaseGeometry(scene: THREE.Scene) {
        let baseGeometry: THREE.BufferGeometry | null = null;
        scene.traverse((child: any) => {
            if (!baseGeometry && child.userData?.baseGeometry?.isBufferGeometry) {
                baseGeometry = child.userData.baseGeometry as THREE.BufferGeometry;
            }
        });
        return baseGeometry;
    }

    function serializeGeometryForNativeWrap(geometry: THREE.BufferGeometry) {
        const position = geometry.getAttribute('position');
        if (!position) return null;

        const vertices: number[] = [];
        for (let i = 0; i < position.count; i++) {
            vertices.push(position.getX(i), position.getY(i), position.getZ(i));
        }

        const indices: number[] = [];
        const index = geometry.getIndex();
        if (index) {
            for (let i = 0; i < index.count; i++) indices.push(index.getX(i));
        } else {
            for (let i = 0; i < position.count; i++) indices.push(i);
        }

        return { vertices, indices };
    }

    async function requestNativeWrappedDecals(engine: NonNullable<typeof engineRef.current>, decals: any[]) {
        if (engine.params.fingerprintRenderMode !== 'surface' || !Array.isArray(decals) || decals.length === 0) {
            engine.params._fingerprintNativeDecals = [];
            engine.params._fingerprintNativeCircles = [];
            engine.params._fingerprintNativeLines = [];
            engine.params._fingerprintNativePending = false;
            return;
        }

        const baseGeometry = findSceneBaseGeometry(engine.scene);
        const shellMesh = findSceneShellMesh(engine.scene);
        const sourceGeometry = baseGeometry || shellMesh?.geometry || null;
        const mesh = sourceGeometry ? serializeGeometryForNativeWrap(sourceGeometry) : null;
        if (!mesh) {
            engine.params._fingerprintNativeDecals = [];
            engine.params._fingerprintNativeCircles = [];
            engine.params._fingerprintNativeLines = [];
            engine.params._fingerprintNativePending = false;
            return;
        }

        const generation = ++nativeWrapGenerationRef.current;
        engine.params._fingerprintNativePending = true;
        const payload = {
            ...mesh,
            decals: decals.map((decal, index) => ({
                index,
                position: decal.position,
                normal: decal.normal,
                faceIndex: Number.isInteger(decal.faceIndex) ? decal.faceIndex : -1,
                size: decal.size,
                rotation: decal.rotation || 0,
            })),
        };

        try {
            const response = await fetch('http://127.0.0.1:3100/wrap-decals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                throw new Error(await response.text());
            }
            const result = await response.json();
            if (generation !== nativeWrapGenerationRef.current || engineRef.current !== engine) return;
            engine.params._fingerprintNativePending = false;

            const nativeDecals = Array.isArray(result.decals)
                ? result.decals.map((wrapped: any) => {
                    const sourceDecal = decals[wrapped.index];
                    if (!sourceDecal?.texture) return null;
                    return { ...wrapped, texture: sourceDecal.texture };
                }).filter(Boolean)
                : [];

            engine.params._fingerprintNativeDecals = nativeDecals;
            const { nativeCircles, nativeLines } = buildNativeBakeData(decals, nativeDecals);
            engine.params._fingerprintNativeCircles = nativeCircles;
            engine.params._fingerprintNativeLines = nativeLines;
            console.log(`[NativeWrap] ${nativeDecals.length}/${decals.length} decal(s) wrapped in ${result.ms ?? '?'}ms`);

            if (engine.params.skinType === 'fingerprint' && engine.params.fingerprintRenderMode === 'surface') {
                const isBakeBuild = Boolean(engine.params.bakeHoles || engine.params.bakeTubes || engine.params.previewTubes);
                const g = buildPavilion(engine.scene, engine.params);
                if (isBakeBuild) {
                    onBaseGeomRef.current?.(g.userData.baseGeometry ?? null);
                    onSecondaryGeomRef.current?.(g.userData.secondaryGeometry ?? null);
                }
                if (g.userData?.extrusionPreviewSuppressed) {
                    onExtrusionPreviewAutoDisabledRef.current?.(g.userData.extrusionPreviewSuppressReason || 'Extrusion preview was disabled');
                }
            }
        } catch (error) {
            if (generation !== nativeWrapGenerationRef.current || engineRef.current !== engine) return;
            engine.params._fingerprintNativeDecals = [];
            engine.params._fingerprintNativeCircles = [];
            engine.params._fingerprintNativeLines = [];
            engine.params._fingerprintNativePending = false;
            console.error('[NativeWrap] Failed to wrap decals natively:', error);
        }
    }

    useEffect(() => {
        if (!mountRef.current) return;

        // Ensure we only initialize the heavy ThreeJS engine ONCE per component lifecycle
        if (!engineRef.current) {
            // 1. Initialize Three.js Core
            // Fallback to window dimensions if the flex container hasn't resolved heights yet
            let width = mountRef.current.clientWidth;
            let height = mountRef.current.clientHeight;
            if (width === 0 || height === 0) {
                width = window.innerWidth;
                height = window.innerHeight;
            }

            const renderer = new THREE.WebGLRenderer({
                antialias: true,
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance',
                alpha: true,
            });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            renderer.setSize(width, height);
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 1.0;
            renderer.outputColorSpace = THREE.SRGBColorSpace;

            mountRef.current.appendChild(renderer.domElement);

            const scene = new THREE.Scene();

            const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 500);
            camera.position.set(-35, 25, -45);

            const controls = new OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
            controls.target.set(0, 7, 0);
            controls.maxPolarAngle = Math.PI / 2 + 0.1;
            controls.minDistance = 5;
            controls.maxDistance = 150;

            // 2. Local Params instance to prevent singleton conflicts across remounts
            // We will load the "Clay Imprint" preset by default to give a good starting geometry
            const localParams = { ...defaultParams };
            Object.assign(localParams, presets['Clay Imprint']);

            const clearImportedBakeCaches = () => {
                (localParams as any)._cachedTubeGeometries = [];
                (localParams as any)._cachedDrillGeometries = [];
            };

            const applyBuildSideEffects = (g: THREE.Group) => {
                if (g.userData?.extrusionPreviewSuppressed) {
                    onExtrusionPreviewAutoDisabledRef.current?.(g.userData.extrusionPreviewSuppressReason || 'Extrusion preview was disabled');
                }
            };

            const rebuildScene = () => {
                const g = buildPavilion(scene, localParams);
                onBaseGeomRef.current?.(g.userData.baseGeometry ?? null);
                onSecondaryGeomRef.current?.(g.userData.secondaryGeometry ?? null);
                applyBuildSideEffects(g);
                updateEnvironment(scene, localParams);
                return g;
            };

            const applySharedImportedGeometryLayout = async (
                nextPrimaryRaw?: THREE.BufferGeometry | null,
                nextSecondaryRaw?: THREE.BufferGeometry | null,
                nextGlassRaw?: THREE.BufferGeometry | null
            ) => {
                const primaryRaw = nextPrimaryRaw === undefined
                    ? (localParams._importedGeometry ? denormalizeImportedGeometry(localParams._importedGeometry) : null)
                    : nextPrimaryRaw;
                const secondaryRaw = nextSecondaryRaw === undefined
                    ? (localParams._secondaryImportedGeometry ? denormalizeImportedGeometry(localParams._secondaryImportedGeometry) : null)
                    : nextSecondaryRaw;
                const glassRaw = nextGlassRaw === undefined
                    ? (localParams._glassGeometry ? denormalizeImportedGeometry(localParams._glassGeometry) : null)
                    : nextGlassRaw;

                const sources = [primaryRaw, secondaryRaw, glassRaw].filter(Boolean) as THREE.BufferGeometry[];
                if (sources.length === 0) {
                    localParams._importedGeometry = null;
                    localParams._secondaryImportedGeometry = null;
                    localParams._glassGeometry = null;
                    localParams.importMode = false;
                    clearImportedBakeCaches();
                    rebuildScene();
                    return;
                }

                const normalizedGeometries = normalizeImportedGeometries(sources, 15);
                let normalizedIndex = 0;
                const normalizedPrimary = primaryRaw ? normalizedGeometries[normalizedIndex++] : null;
                const normalizedSecondary = secondaryRaw ? normalizedGeometries[normalizedIndex++] : null;
                const normalizedGlass = glassRaw ? normalizedGeometries[normalizedIndex++] : null;

                if (normalizedPrimary) {
                    await applyUVMethod(normalizedPrimary, localParams.importUVMethod);
                    normalizedPrimary.computeVertexNormals();
                }
                if (normalizedSecondary) {
                    await applyUVMethod(normalizedSecondary, localParams.importUVMethod);
                    normalizedSecondary.computeVertexNormals();
                }
                if (normalizedGlass) {
                    await applyUVMethod(normalizedGlass, localParams.importUVMethod);
                    normalizedGlass.computeVertexNormals();
                }

                localParams._importedGeometry = normalizedPrimary ?? null;
                localParams._secondaryImportedGeometry = normalizedSecondary ?? null;
                localParams._glassGeometry = normalizedGlass ?? null;
                localParams.importMode = !!normalizedPrimary;
                clearImportedBakeCaches();
                rebuildScene();
            };

            // 3. Environment & Assets
            setupEnvironment(scene, localParams);
            const composer = setupPostProcessing(renderer, scene, camera, localParams);

            // Initial build
            const initialGroup = buildPavilion(scene, localParams);
            onBaseGeomRef.current?.(initialGroup.userData.baseGeometry ?? null);
            onSecondaryGeomRef.current?.(initialGroup.userData.secondaryGeometry ?? null);
            applyBuildSideEffects(initialGroup);

            // Debounced rebuild for GUI
            let rebuildTimeout: number | null = null;
            const onParamChange = () => {
                if (rebuildTimeout) clearTimeout(rebuildTimeout);
                rebuildTimeout = window.setTimeout(() => {
                    rebuildScene();
                    updatePostProcessing(localParams);
                }, 50);
            };

            let guiObj: any = null;
            guiObj = setupGUI(localParams, {
                onParamChange,
                onScreenshot: () => { captureScreenshot(renderer); },
                onExportGLTF: () => { exportGLTF(scene, localParams); },
                onExportOBJ: () => { exportOBJ(scene, localParams); },
                onExportSTL: () => { exportSTL(scene, localParams); },
                onImportModel: () => {
                    importModelFile(localParams.importUVMethod, async (geometry: any) => {
                        await applySharedImportedGeometryLayout(geometry, undefined);
                        if (guiObj) {
                            guiObj.controllersRecursive().forEach((c: any) => c.updateDisplay());
                        }
                    }, { normalize: false });
                },
                onImportSecondaryModel: () => {
                    if (!localParams._importedGeometry) {
                        alert('Import the main geometry first.');
                        return;
                    }

                    importModelFile(localParams.importUVMethod, async (geometry: any) => {
                        await applySharedImportedGeometryLayout(undefined, geometry);
                        if (guiObj) {
                            guiObj.controllersRecursive().forEach((c: any) => c.updateDisplay());
                        }
                    }, { normalize: false });
                },
                onImportGlassGeometry: () => {
                    importModelFile(localParams.importUVMethod, async (geometry: any) => {
                        localParams.glassSystemEnabled = true;
                        await applySharedImportedGeometryLayout(undefined, undefined, geometry);
                        if (guiObj) {
                            guiObj.controllersRecursive().forEach((c: any) => c.updateDisplay());
                        }
                    }, { normalize: false });
                },
                onRepairImportedGeometry: async () => {
                    if (!localParams._importedGeometry) return;
                    const repairedPrimary = repairImportedGeometry(
                        denormalizeImportedGeometry(localParams._importedGeometry)
                    );
                    const secondaryRaw = localParams._secondaryImportedGeometry
                        ? denormalizeImportedGeometry(localParams._secondaryImportedGeometry)
                        : null;
                    const glassRaw = localParams._glassGeometry
                        ? denormalizeImportedGeometry(localParams._glassGeometry)
                        : null;
                    await applySharedImportedGeometryLayout(repairedPrimary, secondaryRaw, glassRaw);
                    if (guiObj) {
                        guiObj.controllersRecursive().forEach((c: any) => c.updateDisplay());
                    }
                },
                onClearImportedGeometry: async () => {
                    await applySharedImportedGeometryLayout(null, null, null);
                },
                onClearSecondaryImportedGeometry: async () => {
                    await applySharedImportedGeometryLayout(undefined, null, undefined);
                },
                onClearGlassGeometry: async () => {
                    await applySharedImportedGeometryLayout(undefined, undefined, null);
                },
            });

            // Move the GUI DOM element inside our React mount wrapper so it doesn't float over the rest of the app globally
            if (guiObj && guiObj.domElement) {
                guiObj.domElement.style.position = 'absolute';
                guiObj.domElement.style.top = '10px';
                guiObj.domElement.style.right = '10px';
                guiObj.domElement.style.zIndex = '10';
                mountRef.current.appendChild(guiObj.domElement);
            }

            // 4. Animation Loop
            function animate() {
                controls.update();
                composer.render();
            }
            renderer.setAnimationLoop(animate);

            // Store engine refs for external updates
            engineRef.current = { renderer, scene, camera, composer, controls, params: localParams, guiObj };

            // Expose engine via imperative handle on initial creation
        } else {
            // Hot Reload / Re-mount recovery: 
            // If the component re-mounted (React Strict Mode), the old DOM element might have been detached. We must reattach it.
            if (!mountRef.current.contains(engineRef.current.renderer.domElement)) {
                mountRef.current.appendChild(engineRef.current.renderer.domElement);
            }
            if (engineRef.current.guiObj && engineRef.current.guiObj.domElement && !mountRef.current.contains(engineRef.current.guiObj.domElement)) {
                mountRef.current.appendChild(engineRef.current.guiObj.domElement);
            }
        }

        // Resize Handler
        const handleResize = () => {
            if (!mountRef.current || !engineRef.current) return;
            const w = mountRef.current.clientWidth;
            const h = mountRef.current.clientHeight;
            engineRef.current.camera.aspect = w / h;
            engineRef.current.camera.updateProjectionMatrix();
            engineRef.current.renderer.setSize(w, h);
            resizePostProcessing(w, h);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            // DO NOT dispose the renderer here! Strict Mode will unmount and remount instantly. 
            // If we destroy it, the screen goes black permanently on hot-reload.
        };
    }, []);

    // Expose engine to parent via ref
    useImperativeHandle(ref, () => ({
        getEngine: () => engineRef.current ? {
            renderer: engineRef.current.renderer,
            scene: engineRef.current.scene,
            camera: engineRef.current.camera,
            controls: engineRef.current.controls,
            params: engineRef.current.params,
            guiObj: engineRef.current.guiObj,
        } : null,
    }), []);

    const lastBakeHolesTriggerRef = useRef(0);
    const lastBakeTubesTriggerRef = useRef(0);
    const lastPreviewTubesTriggerRef = useRef(0);

    useEffect(() => {
        if (engineRef.current && fingerprintCanvas && engineRef.current.params.skinType === 'fingerprint') {
            const tex = createFingerprintThreeTexture(
                fingerprintCanvas,
                engineRef.current.params.fingerprintRenderMode,
                engineRef.current.params.materialColor
            );

            if (engineRef.current.params._fingerprintTexture && engineRef.current.params._fingerprintTexture !== tex) {
                engineRef.current.params._fingerprintTexture.dispose();
            }
            if (Array.isArray(engineRef.current.params._fingerprintDecals)) {
                engineRef.current.params._fingerprintDecals.forEach((decal: any) => decal.texture?.dispose?.());
            }
            const surfaceDecals = createSurfaceDecals(fingerprintCanvas);
            engineRef.current.params._fingerprintTexture = tex;
            engineRef.current.params._fingerprintDecals = surfaceDecals;
            engineRef.current.params._fingerprintNativeDecals = [];
            engineRef.current.params._fingerprintNativeCircles = [];
            engineRef.current.params._fingerprintNativeLines = [];
            engineRef.current.params._fingerprintNativePending = engineRef.current.params.fingerprintRenderMode === 'surface' && surfaceDecals.length > 0;
            if (engineRef.current.params.fingerprintRenderMode === 'surface') {
                requestNativeWrappedDecals(engineRef.current, surfaceDecals);
            }
            engineRef.current.params._fingerprintCircles = dotCircles;
            engineRef.current.params._fingerprintLines = streamlines;
            engineRef.current.params._fingerprintCanvasWidth = fingerprintCanvas.width;
            engineRef.current.params._fingerprintCanvasHeight = fingerprintCanvas.height;
            
            const isNewBakeHoles = bakeHolesTrigger > 0 && bakeHolesTrigger !== lastBakeHolesTriggerRef.current;
            if (isNewBakeHoles) {
                lastBakeHolesTriggerRef.current = bakeHolesTrigger;
            }
            engineRef.current.params.bakeHoles = isNewBakeHoles;

            const isNewBakeTubes = bakeTubesTrigger > 0 && bakeTubesTrigger !== lastBakeTubesTriggerRef.current;
            if (isNewBakeTubes) {
                lastBakeTubesTriggerRef.current = bakeTubesTrigger;
            }
            engineRef.current.params.bakeTubes = isNewBakeTubes;

            const isNewPreviewTubes = previewTubesTrigger > 0 && previewTubesTrigger !== lastPreviewTubesTriggerRef.current;
            if (isNewPreviewTubes) {
                lastPreviewTubesTriggerRef.current = previewTubesTrigger;
            }
            engineRef.current.params.previewTubes = isNewPreviewTubes;
            engineRef.current.params.previewSolidCheck = showSolidCheck;

            const waitsForNativeSurfaceBake =
                engineRef.current.params.fingerprintRenderMode === 'surface' &&
                surfaceDecals.length > 0 &&
                (isNewBakeHoles || isNewBakeTubes || isNewPreviewTubes);

            if (isNewBakeHoles || isNewBakeTubes || isNewPreviewTubes) {
                // Full rebuild with CSG holes
                if (waitsForNativeSurfaceBake) {
                    console.log('[NativeWrap] Waiting for native surface bake data before building holes/tubes...');
                } else {
                    const g = buildPavilion(engineRef.current.scene, engineRef.current.params);
                    onBaseGeomRef.current?.(g.userData.baseGeometry ?? null);
                    onSecondaryGeomRef.current?.(g.userData.secondaryGeometry ?? null);
                    if (g.userData?.extrusionPreviewSuppressed) {
                        onExtrusionPreviewAutoDisabledRef.current?.(g.userData.extrusionPreviewSuppressReason || 'Extrusion preview was disabled');
                    }
                }
            } else if (editing3D && engineRef.current.params.fingerprintRenderMode !== 'surface') {
                // Fast path for live 3D editing: just update the texture without rebuilding geometry
                let shellMesh: any = null;
                engineRef.current.scene.traverse((child: any) => {
                    if (child.name === 'pavilion-shell' && child.isMesh) {
                        shellMesh = child;
                    }
                });
                if (shellMesh && shellMesh.material) {
                    const applyTexture = (m: any) => {
                        if (engineRef.current?.params.fingerprintRenderMode === 'paint') {
                            m.alphaMap = null;
                            m.alphaTest = 0;
                            m.transparent = false;
                            m.map = tex;
                            m.color.set('#ffffff');
                        } else {
                            m.map = null;
                            m.alphaMap = tex;
                            m.alphaTest = 0.1;
                            m.transparent = true;
                        }
                        m.needsUpdate = true;
                    };

                    if (Array.isArray(shellMesh.material)) {
                        shellMesh.material.forEach(applyTexture);
                    } else {
                        applyTexture(shellMesh.material);
                    }
                }
            } else {
                // Non-bake rebuild (preview, texture-only apply)
                const g = buildPavilion(engineRef.current.scene, engineRef.current.params);
                if (g.userData?.extrusionPreviewSuppressed) {
                    onExtrusionPreviewAutoDisabledRef.current?.(g.userData.extrusionPreviewSuppressReason || 'Extrusion preview was disabled');
                }
            }

            if (engineRef.current.params.skinType !== 'fingerprint') {
                engineRef.current.params.skinType = 'fingerprint';
            }
        }
    }, [fingerprintCanvas, bakeHolesTrigger, bakeTubesTrigger, previewTubesTrigger, showSolidCheck, dotCircles, streamlines, fingerprintItems, globalSettings, editing3D]);

    useEffect(() => {
        if (engineRef.current) {
            let needsUpdate = false;
            if (engineRef.current.params.fabricEnabled !== fabricEnabled) {
                engineRef.current.params.fabricEnabled = fabricEnabled;
                needsUpdate = true;
            }
            if (engineRef.current.params.fabricItems !== fabricItems) {
                engineRef.current.params.fabricItems = fabricItems;
                if (fabricEnabled) needsUpdate = true;
            }
            if (engineRef.current.params.metaballs !== metaballs) {
                engineRef.current.params.metaballs = metaballs;
                if (fabricEnabled) needsUpdate = true;
            }

            if (needsUpdate) {
                const g = buildPavilion(engineRef.current.scene, engineRef.current.params);
                onBaseGeomRef.current?.(g.userData.baseGeometry ?? null);
                onSecondaryGeomRef.current?.(g.userData.secondaryGeometry ?? null);
                if (g.userData?.extrusionPreviewSuppressed) {
                    onExtrusionPreviewAutoDisabledRef.current?.(g.userData.extrusionPreviewSuppressReason || 'Extrusion preview was disabled');
                }
            }
        }
    }, [fabricEnabled, fabricItems, metaballs]);

    return (
        <div
            ref={mountRef}
            className="w-full h-full absolute inset-0 z-0 bg-transparent overflow-hidden"
            style={{ display: 'block' }}
        />
    );
});
