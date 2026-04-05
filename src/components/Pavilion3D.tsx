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
import type { DotCircle, Streamline } from './MergedFingerprintsCanvas';

interface Pavilion3DProps {
    fingerprintCanvas: HTMLCanvasElement | null;
    bakeHolesTrigger?: number;
    bakeTubesTrigger?: number;
    previewTubesTrigger?: number;
    showSolidCheck?: boolean;
    dotCircles?: DotCircle[];
    streamlines?: Streamline[];
    onBaseGeometryUpdate?: (geom: THREE.BufferGeometry | null) => void;
    onSecondaryGeometryUpdate?: (geom: THREE.BufferGeometry | null) => void;
    editing3D?: boolean;
    fabricEnabled?: boolean;
    fabricItems?: any[];
    metaballs?: any[];
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

export const Pavilion3D = forwardRef<Pavilion3DHandle, Pavilion3DProps>(function Pavilion3D({ fingerprintCanvas, bakeHolesTrigger = 0, bakeTubesTrigger = 0, previewTubesTrigger = 0, showSolidCheck = false, dotCircles = [], streamlines = [], onBaseGeometryUpdate, onSecondaryGeometryUpdate, editing3D = false, fabricEnabled = false, fabricItems = [], metaballs = [] }, ref) {
    const mountRef = useRef<HTMLDivElement>(null);
    const onBaseGeomRef = useRef(onBaseGeometryUpdate);
    onBaseGeomRef.current = onBaseGeometryUpdate;
    const onSecondaryGeomRef = useRef(onSecondaryGeometryUpdate);
    onSecondaryGeomRef.current = onSecondaryGeometryUpdate;
    const engineRef = useRef<{
        renderer: THREE.WebGLRenderer;
        scene: THREE.Scene;
        camera: THREE.PerspectiveCamera;
        composer: any;
        controls: OrbitControls;
        params: typeof defaultParams;
        guiObj: any;
    } | null>(null);
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

            const rebuildScene = () => {
                const g = buildPavilion(scene, localParams);
                onBaseGeomRef.current?.(g.userData.baseGeometry ?? null);
                onSecondaryGeomRef.current?.(g.userData.secondaryGeometry ?? null);
                updateEnvironment(scene, localParams);
                return g;
            };

            const applySharedImportedGeometryLayout = async (
                nextPrimaryRaw?: THREE.BufferGeometry | null,
                nextSecondaryRaw?: THREE.BufferGeometry | null
            ) => {
                const primaryRaw = nextPrimaryRaw === undefined
                    ? (localParams._importedGeometry ? denormalizeImportedGeometry(localParams._importedGeometry) : null)
                    : nextPrimaryRaw;
                const secondaryRaw = nextSecondaryRaw === undefined
                    ? (localParams._secondaryImportedGeometry ? denormalizeImportedGeometry(localParams._secondaryImportedGeometry) : null)
                    : nextSecondaryRaw;

                if (!primaryRaw) {
                    localParams.importMode = false;
                    localParams._importedGeometry = null;
                    localParams._secondaryImportedGeometry = null;
                    clearImportedBakeCaches();
                    rebuildScene();
                    return;
                }

                const sources = secondaryRaw ? [primaryRaw, secondaryRaw] : [primaryRaw];
                const [normalizedPrimary, normalizedSecondary] = normalizeImportedGeometries(sources, 15);

                if (normalizedPrimary) {
                    await applyUVMethod(normalizedPrimary, localParams.importUVMethod);
                    normalizedPrimary.computeVertexNormals();
                }
                if (normalizedSecondary) {
                    await applyUVMethod(normalizedSecondary, localParams.importUVMethod);
                    normalizedSecondary.computeVertexNormals();
                }

                localParams._importedGeometry = normalizedPrimary ?? null;
                localParams._secondaryImportedGeometry = normalizedSecondary ?? null;
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
                onRepairImportedGeometry: async () => {
                    if (!localParams._importedGeometry) return;
                    const repairedPrimary = repairImportedGeometry(
                        denormalizeImportedGeometry(localParams._importedGeometry)
                    );
                    const secondaryRaw = localParams._secondaryImportedGeometry
                        ? denormalizeImportedGeometry(localParams._secondaryImportedGeometry)
                        : null;
                    await applySharedImportedGeometryLayout(repairedPrimary, secondaryRaw);
                    if (guiObj) {
                        guiObj.controllersRecursive().forEach((c: any) => c.updateDisplay());
                    }
                },
                onClearImportedGeometry: async () => {
                    await applySharedImportedGeometryLayout(null, null);
                },
                onClearSecondaryImportedGeometry: async () => {
                    await applySharedImportedGeometryLayout(undefined, null);
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
            const tex = new THREE.CanvasTexture(fingerprintCanvas);
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.needsUpdate = true;
            tex.colorSpace = THREE.SRGBColorSpace;

            if (engineRef.current.params._fingerprintTexture && engineRef.current.params._fingerprintTexture !== tex) {
                engineRef.current.params._fingerprintTexture.dispose();
            }
            engineRef.current.params._fingerprintTexture = tex;
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

            if (isNewBakeHoles || isNewBakeTubes || isNewPreviewTubes) {
                // Full rebuild with CSG holes
                const g = buildPavilion(engineRef.current.scene, engineRef.current.params);
                onBaseGeomRef.current?.(g.userData.baseGeometry ?? null);
                onSecondaryGeomRef.current?.(g.userData.secondaryGeometry ?? null);
            } else if (editing3D) {
                // Fast path for live 3D editing: just update the texture without rebuilding geometry
                let shellMesh: any = null;
                engineRef.current.scene.traverse((child: any) => {
                    if (child.name === 'pavilion-shell' && child.isMesh) {
                        shellMesh = child;
                    }
                });
                if (shellMesh && shellMesh.material) {
                    if (Array.isArray(shellMesh.material)) {
                        shellMesh.material.forEach((m: any) => {
                            m.alphaMap = tex;
                            m.alphaTest = 0.1;
                            m.transparent = true;
                            m.needsUpdate = true;
                        });
                    } else {
                        shellMesh.material.alphaMap = tex;
                        shellMesh.material.alphaTest = 0.1;
                        shellMesh.material.transparent = true;
                        shellMesh.material.needsUpdate = true;
                    }
                }
            } else {
                // Non-bake rebuild (preview, texture-only apply)
                const g = buildPavilion(engineRef.current.scene, engineRef.current.params);
                onBaseGeomRef.current?.(g.userData.baseGeometry ?? null);
                onSecondaryGeomRef.current?.(g.userData.secondaryGeometry ?? null);
            }

            if (engineRef.current.params.skinType !== 'fingerprint') {
                engineRef.current.params.skinType = 'fingerprint';
            }
        }
    }, [fingerprintCanvas, bakeHolesTrigger, bakeTubesTrigger, previewTubesTrigger, showSolidCheck, dotCircles, streamlines, editing3D]);

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
