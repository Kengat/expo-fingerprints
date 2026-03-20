import React, { useEffect, useRef, useCallback, useState } from 'react'; 

import * as THREE from 'three';
import type { Pavilion3DHandle } from './Pavilion3D';
import { UV_SIZE, getComputedItems } from './MergedFingerprintsCanvas';
import type { CanvasItem } from './MergedFingerprintsCanvas';

interface FingerprintEditor3DProps {
    pavilion3DRef: React.RefObject<Pavilion3DHandle | null>;
    items: CanvasItem[];
    onItemsChange: (items: CanvasItem[]) => void;
    globalSettings: any;
}

// ── Constants ──────────────────────────────────────────────────────────────────
const MARKER_COLOR = 0x4488ff;
const MARKER_HOVER_COLOR = 0x66aaff;
const MARKER_SELECTED_COLOR = 0x9966ff;
const MARKER_OPACITY = 0.45;
const MARKER_HOVER_OPACITY = 0.65;
const MARKER_SELECTED_OPACITY = 0.75;
const OUTLINE_COLOR = 0x66bbff;
const OUTLINE_SELECTED_COLOR = 0xbb88ff;
const MARKER_SEGMENTS = 32;
const BASE_MARKER_RADIUS = 1.8;

type GizmoType = 'rotate' | 'scaleNE' | 'scaleNW' | 'scaleSE' | 'scaleSW';

// ── Helpers ────────────────────────────────────────────────────────────────────

function findShellMesh(scene: THREE.Scene): THREE.Mesh | null {
    let shell: THREE.Mesh | null = null;
    scene.traverse((child) => {
        if ((child as any).name === 'pavilion-shell' && (child as any).isMesh) {
            shell = child as THREE.Mesh;
        }
    });
    return shell;
}

function itemToUV(item: CanvasItem): { u: number; v: number } {
    const u = item.x / UV_SIZE;
    const v = 1.0 - (item.y / UV_SIZE);
    return { u: Math.max(0.001, Math.min(0.999, u)), v: Math.max(0.001, Math.min(0.999, v)) };
}

function uvToItemPos(u: number, v: number): { x: number; y: number } {
    return { x: u * UV_SIZE, y: (1.0 - v) * UV_SIZE };
}

function sampleSurfaceAtUV(
    geometry: THREE.BufferGeometry,
    u: number,
    v: number,
): { position: THREE.Vector3; normal: THREE.Vector3 } | null {
    const pos = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const nrm = geometry.getAttribute('normal');
    if (!pos || !uv || !nrm) return null;
    const index = geometry.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;

    for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        const uv0x = uv.getX(i0), uv0y = uv.getY(i0);
        const uv1x = uv.getX(i1), uv1y = uv.getY(i1);
        const uv2x = uv.getX(i2), uv2y = uv.getY(i2);

        const d00 = (uv1x - uv0x) ** 2 + (uv1y - uv0y) ** 2;
        const d01 = (uv1x - uv0x) * (uv2x - uv0x) + (uv1y - uv0y) * (uv2y - uv0y);
        const d11 = (uv2x - uv0x) ** 2 + (uv2y - uv0y) ** 2;
        const d20 = (u - uv0x) * (uv1x - uv0x) + (v - uv0y) * (uv1y - uv0y);
        const d21 = (u - uv0x) * (uv2x - uv0x) + (v - uv0y) * (uv2y - uv0y);
        const denom = d00 * d11 - d01 * d01;
        if (Math.abs(denom) < 1e-10) continue;
        const bv = (d11 * d20 - d01 * d21) / denom;
        const bw = (d00 * d21 - d01 * d20) / denom;
        const bu = 1 - bv - bw;
        if (bu >= -0.01 && bv >= -0.01 && bw >= -0.01) {
            const position = new THREE.Vector3(
                pos.getX(i0) * bu + pos.getX(i1) * bv + pos.getX(i2) * bw,
                pos.getY(i0) * bu + pos.getY(i1) * bv + pos.getY(i2) * bw,
                pos.getZ(i0) * bu + pos.getZ(i1) * bv + pos.getZ(i2) * bw,
            );
            const normal = new THREE.Vector3(
                nrm.getX(i0) * bu + nrm.getX(i1) * bv + nrm.getX(i2) * bw,
                nrm.getY(i0) * bu + nrm.getY(i1) * bv + nrm.getY(i2) * bw,
                nrm.getZ(i0) * bu + nrm.getZ(i1) * bv + nrm.getZ(i2) * bw,
            ).normalize();
            return { position, normal };
        }
    }
    return null;
}

function findClosestUV(point: THREE.Vector3, geometry: THREE.BufferGeometry): { u: number; v: number } | null {
    const pos = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    if (!pos || !uv) return null;
    const index = geometry.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;

    let closestDist = Infinity;
    let bestU = 0.5, bestV = 0.5;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const closestPoint = new THREE.Vector3();
    const triangle = new THREE.Triangle();

    for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0);
        b.fromBufferAttribute(pos, i1);
        c.fromBufferAttribute(pos, i2);
        triangle.set(a, b, c);
        triangle.closestPointToPoint(point, closestPoint);
        const dist = point.distanceToSquared(closestPoint);
        if (dist < closestDist) {
            closestDist = dist;
            const target = new THREE.Vector3();
            triangle.getBarycoord(closestPoint, target);
            bestU = uv.getX(i0) * target.x + uv.getX(i1) * target.y + uv.getX(i2) * target.z;
            bestV = uv.getY(i0) * target.x + uv.getY(i1) * target.y + uv.getY(i2) * target.z;
        }
    }
    return closestDist < Infinity ? { u: bestU, v: bestV } : null;
}

function findItemIdFromObject(obj: THREE.Object3D): string | null {
    let current: THREE.Object3D | null = obj;
    while (current) {
        if (current.userData.itemId) return current.userData.itemId;
        current = current.parent;
    }
    return null;
}

function createMarkerGroup(item: CanvasItem): THREE.Group {
    const group = new THREE.Group();
    group.userData.itemId = item.id;

    // Main disc
    const discGeom = new THREE.CircleGeometry(1, MARKER_SEGMENTS);
    const discMat = new THREE.MeshBasicMaterial({
        color: MARKER_COLOR,
        transparent: true,
        opacity: MARKER_OPACITY,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
    });
    const disc = new THREE.Mesh(discGeom, discMat);
    disc.userData.isMarkerDisc = true;
    disc.userData.itemId = item.id;
    group.add(disc);

    // Outline ring
    const ringGeom = new THREE.RingGeometry(0.92, 1.0, MARKER_SEGMENTS);
    const ringMat = new THREE.MeshBasicMaterial({
        color: OUTLINE_COLOR,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.position.z = 0.01;
    ring.name = 'outline-ring';
    group.add(ring);

    // Gizmo group (hidden by default)
    const gizmos = new THREE.Group();
    gizmos.name = 'gizmos';
    gizmos.visible = false;

    // Rotation handle
    const rotHandleGeom = new THREE.SphereGeometry(0.15, 12, 12);
    const rotHandleMat = new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.85, depthTest: false });
    const rotHandle = new THREE.Mesh(rotHandleGeom, rotHandleMat);
    rotHandle.position.set(0, 1.3, 0.05);
    rotHandle.userData.gizmoType = 'rotate' as GizmoType;
    rotHandle.userData.itemId = item.id;
    gizmos.add(rotHandle);

    // Scale corner handles
    for (const { name, pos } of [
        { name: 'scaleNE', pos: new THREE.Vector3(0.9, 0.9, 0.05) },
        { name: 'scaleNW', pos: new THREE.Vector3(-0.9, 0.9, 0.05) },
        { name: 'scaleSE', pos: new THREE.Vector3(0.9, -0.9, 0.05) },
        { name: 'scaleSW', pos: new THREE.Vector3(-0.9, -0.9, 0.05) },
    ]) {
        const handleGeom = new THREE.SphereGeometry(0.12, 8, 8);
        const handleMat = new THREE.MeshBasicMaterial({ color: 0xff6644, transparent: true, opacity: 0.85, depthTest: false });
        const handle = new THREE.Mesh(handleGeom, handleMat);
        handle.position.copy(pos);
        handle.userData.gizmoType = name as GizmoType;
        handle.userData.itemId = item.id;
        gizmos.add(handle);
    }

    group.add(gizmos);
    return group;
}

function updateMarkerVisual(markerGroup: THREE.Group, isSelected: boolean, isHovered: boolean) {
    markerGroup.traverse((child) => {
        if (!(child as any).isMesh) return;
        if (child.userData.isMarkerDisc) {
            const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
            mat.color.setHex(isSelected ? MARKER_SELECTED_COLOR : isHovered ? MARKER_HOVER_COLOR : MARKER_COLOR);
            mat.opacity = isSelected ? MARKER_SELECTED_OPACITY : isHovered ? MARKER_HOVER_OPACITY : MARKER_OPACITY;
        }
        if (child.name === 'outline-ring') {
            const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
            mat.color.setHex(isSelected ? OUTLINE_SELECTED_COLOR : OUTLINE_COLOR);
            mat.opacity = isSelected ? 0.9 : isHovered ? 0.85 : 0.4;
        }
    });
}

// ── Component ──────────────────────────────────────────────────────────────────

export function FingerprintEditor3D({ pavilion3DRef, items, onItemsChange, globalSettings }: FingerprintEditor3DProps) {
    const markersGroupRef = useRef<THREE.Group | null>(null);
    const markerMeshesRef = useRef<Map<string, THREE.Group>>(new Map());
    const hoveredIdRef = useRef<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selectedIdRef = useRef<string | null>(null);
    selectedIdRef.current = selectedId;

    const dragStateRef = useRef<{
        type: 'move' | 'rotate' | 'scale';
        itemId: string;
        startMouse: THREE.Vector2;
        startItemX: number;
        startItemY: number;
        startRotation: number;
        startScale: number;
        centerScreen: THREE.Vector2;
    } | null>(null);

    const itemsRef = useRef(items);
    itemsRef.current = items;
    const onItemsChangeRef = useRef(onItemsChange);
    onItemsChangeRef.current = onItemsChange;

    const raycasterRef = useRef(new THREE.Raycaster());
    const mouseRef = useRef(new THREE.Vector2());

    // ── Create markers group ────────────────────────────────────────────────
    useEffect(() => {
        const engine = pavilion3DRef.current?.getEngine();
        if (!engine) return;
        const group = new THREE.Group();
        group.name = 'fingerprint-markers';
        engine.scene.add(group);
        markersGroupRef.current = group;

        return () => {
            engine.scene.remove(group);
            group.traverse((child) => {
                if ((child as any).geometry) (child as any).geometry.dispose();
                if ((child as any).material) {
                    const mat = (child as any).material;
                    if (Array.isArray(mat)) mat.forEach((m: any) => m.dispose());
                    else mat.dispose();
                }
            });
            markersGroupRef.current = null;
            markerMeshesRef.current.clear();
        };
    }, [pavilion3DRef]);

    // ── Update marker positions ─────────────────────────────────────────────
    useEffect(() => {
        const engine = pavilion3DRef.current?.getEngine();
        const group = markersGroupRef.current;
        if (!engine || !group) return;

        const shell = findShellMesh(engine.scene);
        if (!shell) return;

        const baseGeom = (shell.parent as any)?.userData?.baseGeometry as THREE.BufferGeometry | null;
        const geomToUse = baseGeom || shell.geometry;
        if (!geomToUse.getAttribute('uv')) return;

        const existingMap = markerMeshesRef.current;
        const newMap = new Map<string, THREE.Group>();

        const computedItems = getComputedItems(items, globalSettings);

        for (const item of computedItems) {
            const uv = itemToUV(item);
            const sample = sampleSurfaceAtUV(geomToUse, uv.u, uv.v);
            if (!sample) continue;

            const worldPos = sample.position.clone();
            shell.localToWorld(worldPos);
            const worldNormal = sample.normal.clone();
            worldNormal.transformDirection(shell.matrixWorld);

            let markerGroup = existingMap.get(item.id);
            if (!markerGroup) {
                markerGroup = createMarkerGroup(item);
                group.add(markerGroup);
            }

            markerGroup.position.copy(worldPos);
            markerGroup.position.addScaledVector(worldNormal, 0.1);
            markerGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);
            markerGroup.scale.setScalar(BASE_MARKER_RADIUS * item.scale);
            markerGroup.userData.itemId = item.id;

            const isSelected = item.id === selectedId;
            const isHovered = item.id === hoveredIdRef.current;
            updateMarkerVisual(markerGroup, isSelected, isHovered);

            const gizmoGroup = markerGroup.getObjectByName('gizmos') as THREE.Group | undefined;
            if (gizmoGroup) gizmoGroup.visible = isSelected;

            newMap.set(item.id, markerGroup);
            existingMap.delete(item.id);
        }

        // Remove stale markers
        for (const [, oldMarker] of existingMap) {
            group.remove(oldMarker);
            oldMarker.traverse((child) => {
                if ((child as any).geometry) (child as any).geometry.dispose();
                if ((child as any).material) (child as any).material.dispose();
            });
        }
        markerMeshesRef.current = newMap;
    }, [items, selectedId, pavilion3DRef, globalSettings]);

    // ── Attach event listeners to the Three.js canvas ───────────────────────
    useEffect(() => {
        const engine = pavilion3DRef.current?.getEngine();
        if (!engine) return;

        const domElement = engine.renderer.domElement;

        function getNDC(e: PointerEvent) {
            const rect = domElement.getBoundingClientRect();
            mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            return mouseRef.current;
        }

        function getMarkerMeshes(): THREE.Object3D[] {
            const meshes: THREE.Object3D[] = [];
            markersGroupRef.current?.traverse((child) => {
                if ((child as any).isMesh && child.userData.isMarkerDisc) meshes.push(child);
            });
            return meshes;
        }

        function getGizmoMeshes(): THREE.Object3D[] {
            const meshes: THREE.Object3D[] = [];
            markersGroupRef.current?.traverse((child) => {
                if ((child as any).isMesh && child.userData.gizmoType) meshes.push(child);
            });
            return meshes;
        }

        function onPointerMove(e: PointerEvent) {
            const ndc = getNDC(e);

            // If dragging, handle drag
            if (dragStateRef.current) {
                handleDragEvent(e);
                return;
            }

            // Hover detection
            raycasterRef.current.setFromCamera(ndc, engine!.camera);
            const intersects = raycasterRef.current.intersectObjects(getMarkerMeshes(), false);
            const newHoveredId = intersects.length > 0 ? findItemIdFromObject(intersects[0].object) : null;

            if (newHoveredId !== hoveredIdRef.current) {
                if (hoveredIdRef.current) {
                    const oldMarker = markerMeshesRef.current.get(hoveredIdRef.current);
                    if (oldMarker) updateMarkerVisual(oldMarker, hoveredIdRef.current === selectedIdRef.current, false);
                }
                hoveredIdRef.current = newHoveredId;
                if (newHoveredId) {
                    const newMarker = markerMeshesRef.current.get(newHoveredId);
                    if (newMarker) updateMarkerVisual(newMarker, newHoveredId === selectedIdRef.current, true);
                }
            }

            domElement.style.cursor = newHoveredId ? 'pointer' : '';
        }

        function onPointerDown(e: PointerEvent) {
            const ndc = getNDC(e);
            raycasterRef.current.setFromCamera(ndc, engine!.camera);

            // Check gizmo handles first
            const gizmoIntersects = raycasterRef.current.intersectObjects(getGizmoMeshes(), false);
            if (gizmoIntersects.length > 0 && selectedIdRef.current) {
                const gizmoType = gizmoIntersects[0].object.userData.gizmoType as GizmoType;
                const item = itemsRef.current.find(it => it.id === selectedIdRef.current);
                if (item) {
                    e.stopPropagation(); // Prevent orbit controls
                    const markerGrp = markerMeshesRef.current.get(item.id);
                    const centerWorld = markerGrp ? markerGrp.position.clone() : new THREE.Vector3();
                    const centerScreen = centerWorld.project(engine!.camera);
                    const rect = domElement.getBoundingClientRect();

                    engine!.controls.enabled = false;
                    dragStateRef.current = {
                        type: gizmoType === 'rotate' ? 'rotate' : 'scale',
                        itemId: item.id,
                        startMouse: new THREE.Vector2(e.clientX, e.clientY),
                        startItemX: item.x,
                        startItemY: item.y,
                        startRotation: item.rotation,
                        startScale: item.scale,
                        centerScreen: new THREE.Vector2(
                            (centerScreen.x * 0.5 + 0.5) * rect.width + rect.left,
                            (-centerScreen.y * 0.5 + 0.5) * rect.height + rect.top,
                        ),
                    };
                    return;
                }
            }

            // Check marker discs
            const markerIntersects = raycasterRef.current.intersectObjects(getMarkerMeshes(), false);
            if (markerIntersects.length > 0) {
                const hitId = findItemIdFromObject(markerIntersects[0].object);
                if (hitId) {
                    e.stopPropagation(); // Prevent orbit controls
                    setSelectedId(hitId);
                    const item = itemsRef.current.find(it => it.id === hitId);
                    if (item) {
                        engine!.controls.enabled = false;
                        dragStateRef.current = {
                            type: 'move',
                            itemId: hitId,
                            startMouse: new THREE.Vector2(e.clientX, e.clientY),
                            startItemX: item.x,
                            startItemY: item.y,
                            startRotation: item.rotation,
                            startScale: item.scale,
                            centerScreen: new THREE.Vector2(0, 0),
                        };
                    }
                    return;
                }
            }

            // Clicked empty space — deselect
            setSelectedId(null);
        }

        function handleDragEvent(e: PointerEvent) {
            const drag = dragStateRef.current;
            if (!drag) return;

            const currentItems = itemsRef.current;
            const item = currentItems.find(it => it.id === drag.itemId);
            if (!item) return;

            if (drag.type === 'move') {
                const ndc = getNDC(e);
                raycasterRef.current.setFromCamera(ndc, engine!.camera);
                const shell = findShellMesh(engine!.scene);
                if (!shell) return;

                const intersects = raycasterRef.current.intersectObject(shell, false);
                if (intersects.length > 0) {
                    const baseGeom = (shell.parent as any)?.userData?.baseGeometry as THREE.BufferGeometry | null;
                    const geomForUV = baseGeom || shell.geometry;
                    const localPoint = intersects[0].point.clone();
                    shell.worldToLocal(localPoint);
                    const newUV = findClosestUV(localPoint, geomForUV);
                    if (newUV) {
                        const newComputedPos = uvToItemPos(newUV.u, newUV.v);
                        const gs = globalSettings.globalScale || 1.0;
                        const origX = UV_SIZE / 2 + (newComputedPos.x - UV_SIZE / 2) / gs;
                        const origY = UV_SIZE / 2 + (newComputedPos.y - UV_SIZE / 2) / gs;

                        onItemsChangeRef.current(currentItems.map(it =>
                            it.id === drag.itemId ? { ...it, x: origX, y: origY } : it
                        ));
                    }
                }
            } else if (drag.type === 'rotate') {
                const dx = e.clientX - drag.centerScreen.x;
                const dy = e.clientY - drag.centerScreen.y;
                const currentAngle = Math.atan2(dy, dx);
                const sdx = drag.startMouse.x - drag.centerScreen.x;
                const sdy = drag.startMouse.y - drag.centerScreen.y;
                const startAngle = Math.atan2(sdy, sdx);
                const delta = (currentAngle - startAngle) * (180 / Math.PI);
                onItemsChangeRef.current(currentItems.map(it =>
                    it.id === drag.itemId ? { ...it, rotation: drag.startRotation + delta } : it
                ));
            } else if (drag.type === 'scale') {
                const currentDist = Math.hypot(e.clientX - drag.centerScreen.x, e.clientY - drag.centerScreen.y);
                const startDist = Math.hypot(drag.startMouse.x - drag.centerScreen.x, drag.startMouse.y - drag.centerScreen.y);
                const ratio = currentDist / Math.max(startDist, 1);
                const newScale = Math.max(0.1, Math.min(5, drag.startScale * ratio));
                onItemsChangeRef.current(currentItems.map(it =>
                    it.id === drag.itemId ? { ...it, scale: newScale } : it
                ));
            }
        }

        function onPointerUp() {
            if (dragStateRef.current) {
                dragStateRef.current = null;
                // Re-enable orbit controls (keep enabled in 3D mode for camera rotation)
                engine!.controls.enabled = true;
            }
        }

        // Use capture phase to intercept before OrbitControls
        domElement.addEventListener('pointermove', onPointerMove);
        domElement.addEventListener('pointerdown', onPointerDown, true);
        domElement.addEventListener('pointerup', onPointerUp);

        return () => {
            domElement.removeEventListener('pointermove', onPointerMove);
            domElement.removeEventListener('pointerdown', onPointerDown, true);
            domElement.removeEventListener('pointerup', onPointerUp);
            domElement.style.cursor = '';
        };
    }, [pavilion3DRef]);

    // This component is invisible — it manages 3D markers and events only
    return null;
}
