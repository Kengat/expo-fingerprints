import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { params as defaultParams, presets } from '../pavilion_3d/params.js';
import { setupEnvironment, updateEnvironment } from '../pavilion_3d/environment.js';
import { setupPostProcessing, updatePostProcessing, resizePostProcessing } from '../pavilion_3d/postprocessing.js';
import { buildPavilion } from '../pavilion_3d/pavilion/index.js';
import { setupGUI } from '../pavilion_3d/gui.js';
import { captureScreenshot, exportGLTF, exportOBJ, exportSTL } from '../pavilion_3d/utils/export.js';
import { importModelFile } from '../pavilion_3d/utils/importModel.js';
import type { DotCircle } from './MergedFingerprintsCanvas';

interface Pavilion3DProps {
    fingerprintCanvas: HTMLCanvasElement | null;
    bakeHolesTrigger?: number;
    dotCircles?: DotCircle[];
    onBaseGeometryUpdate?: (geom: THREE.BufferGeometry | null) => void;
    editing3D?: boolean;
}

export interface Pavilion3DHandle {
    getEngine: () => {
        renderer: THREE.WebGLRenderer;
        scene: THREE.Scene;
        camera: THREE.PerspectiveCamera;
        controls: import('three/addons/controls/OrbitControls.js').OrbitControls;
        params: any;
    } | null;
}

export const Pavilion3D = forwardRef<Pavilion3DHandle, Pavilion3DProps>(function Pavilion3D({ fingerprintCanvas, bakeHolesTrigger = 0, dotCircles = [], onBaseGeometryUpdate, editing3D = false }, ref) {
    const mountRef = useRef<HTMLDivElement>(null);
    const onBaseGeomRef = useRef(onBaseGeometryUpdate);
    onBaseGeomRef.current = onBaseGeometryUpdate;
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

            // 3. Environment & Assets
            setupEnvironment(scene, localParams);
            const composer = setupPostProcessing(renderer, scene, camera, localParams);

            // Initial build
            const initialGroup = buildPavilion(scene, localParams);
            onBaseGeomRef.current?.(initialGroup.userData.baseGeometry ?? null);

            // Debounced rebuild for GUI
            let rebuildTimeout: number | null = null;
            const onParamChange = () => {
                if (rebuildTimeout) clearTimeout(rebuildTimeout);
                rebuildTimeout = window.setTimeout(() => {
                    const g = buildPavilion(scene, localParams);
                    onBaseGeomRef.current?.(g.userData.baseGeometry ?? null);
                    updateEnvironment(scene, localParams);
                    updatePostProcessing(localParams);
                }, 50);
            };

            const guiObj = setupGUI(localParams, {
                onParamChange,
                onScreenshot: () => { captureScreenshot(renderer); },
                onExportGLTF: () => { exportGLTF(scene, localParams); },
                onExportOBJ: () => { exportOBJ(scene, localParams); },
                onExportSTL: () => { exportSTL(scene, localParams); },
                onImportModel: () => {
                    importModelFile(localParams.importUVMethod, (geometry: any) => {
                        localParams._importedGeometry = geometry;
                        localParams.importMode = true;
                        const g = buildPavilion(scene, localParams);
                        onBaseGeomRef.current?.(g.userData.baseGeometry ?? null);
                        updateEnvironment(scene, localParams);
                    });
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
        } : null,
    }), []);

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
            engineRef.current.params._fingerprintCanvasWidth = fingerprintCanvas.width;
            engineRef.current.params._fingerprintCanvasHeight = fingerprintCanvas.height;
            
            const isBake = bakeHolesTrigger > 0;
            engineRef.current.params.bakeHoles = isBake;

            if (editing3D && !isBake) {
                // Fast path for live 3D editing: just update the texture without rebuilding geometry
                let shellMesh = null;
                engineRef.current.scene.traverse((child) => {
                    if (child.name === 'pavilion-shell' && child.isMesh) {
                        shellMesh = child;
                    }
                });
                if (shellMesh && shellMesh.material) {
                    if (Array.isArray(shellMesh.material)) {
                        shellMesh.material.forEach(m => {
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
                // Full rebuild for bake or initial apply
                const g = buildPavilion(engineRef.current.scene, engineRef.current.params);
                onBaseGeomRef.current?.(g.userData.baseGeometry ?? null);
            }

            if (engineRef.current.params.skinType !== 'fingerprint') {
                engineRef.current.params.skinType = 'fingerprint';
            }
        }
    }, [fingerprintCanvas, bakeHolesTrigger, dotCircles, editing3D]);

    return (
        <div
            ref={mountRef}
            className="w-full h-full absolute inset-0 z-0 bg-transparent overflow-hidden"
            style={{ display: 'block' }}
        />
    );
});
