/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import * as THREE from 'three';
import { Fingerprint, MonitorPlay, X, Box, Save, FolderOpen, Waves, Circle, Download, Eye } from 'lucide-react';
import { Pavilion3D } from './components/Pavilion3D';
import type { Pavilion3DHandle } from './components/Pavilion3D';
import { buildPavilion } from './pavilion_3d/pavilion/index.js';
import { WhorlCanvas } from './components/WhorlCanvas';
import { FabricCanvas } from './components/FabricCanvas';
import type { FabricItem } from './components/FabricCanvas';
import { FingerprintEditor3D } from './components/FingerprintEditor3D.tsx';
import { MetaballEditor3D } from './components/MetaballEditor3D';
import type { MetaballData } from './components/MetaballEditor3D';
import { MergedFingerprintsCanvas, computeFitView, renderFingerprints, UV_SIZE, collectDotCircles, getComputedItems, createGeometryEdgeDistField, collectStreamlines, getRenderCanvasDimensions } from './components/MergedFingerprintsCanvas';
import type { DotCircle, CanvasItem, EdgeDistanceField, Streamline } from './components/MergedFingerprintsCanvas';
import { DEFAULT_DOTS_PARAMS, FingerprintParams, GLOBAL_SCALE_MAX, LINE_THICKNESS_SCALE_MIN, LINE_THICKNESS_SCALE_MAX } from './presets';

const LOCAL_DEFAULT_DOTS_PARAMS: FingerprintParams = {
  ...DEFAULT_DOTS_PARAMS,
  dotSpacing: 0,
  dotSizeMin: 0,
  dotSizeMax: 0,
  lineDensity: 0,
  noiseScale: 0,
};

const STORAGE_KEY_CURRENT = 'whorl_current_pattern';

function loadInitialItems(): CanvasItem[] {
  const saved = localStorage.getItem(STORAGE_KEY_CURRENT);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.items) return parsed.items;
    } catch (e) { console.error(e); }
  }
  return [
    {
      id: 'initial',
      x: 1024,
      y: 1024,
      rotation: 0,
      scale: 1,
      params: { ...LOCAL_DEFAULT_DOTS_PARAMS, seed: Math.random() }
    }
  ];
}

function loadInitialGlobalSettings() {
  const saved = localStorage.getItem(STORAGE_KEY_CURRENT);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.globalSettings) return parsed.globalSettings;
    } catch (e) { console.error(e); }
  }
  return {
    cullingOffset: 0.05,
    edgeCullRadius: 0,
    dotSpacing: 12.5,
    dotSizeMin: 2.4,
    dotSizeMax: 4.2,
    lineDensity: 14,
    lineThicknessScale: 1.0,
    noiseScale: 7,
    globalScale: 1.0,
    bgLinesCreateTubes: false,
    canvasStretchX: 1.0,
    canvasStretchY: 1.0,
  };
}

export default function App() {
  // Lifted state — shared between 2D and 3D editors
  const [items, setItems] = useState<CanvasItem[]>(loadInitialItems);
  const [globalSettings, setGlobalSettings] = useState(loadInitialGlobalSettings);

  const [isEditingPattern, setIsEditingPattern] = useState(false);
  const [isEditingFabric, setIsEditingFabric] = useState(false);
  const [isEditing3D, setIsEditing3D] = useState(false);
  const [fabricEnabled, setFabricEnabled] = useState(false);
  const [isEditingMetaballs, setIsEditingMetaballs] = useState(false);
  const [metaballs, setMetaballs] = useState<MetaballData[]>([]);
  const [metaballsFinal, setMetaballsFinal] = useState<MetaballData[]>([]);
  const [fabricItems, setFabricItems] = useState<FabricItem[]>([]);
  const [fingerprintCanvas, setFingerprintCanvas] = useState<HTMLCanvasElement | null>(null);
  const [bakeHolesTrigger, setBakeHolesTrigger] = useState<number>(0);
  const [bakeTubesTrigger, setBakeTubesTrigger] = useState<number>(0);
  const [previewTubesTrigger, setPreviewTubesTrigger] = useState<number>(0);
  const [showSolidCheck, setShowSolidCheck] = useState<boolean>(false);
  const [dotCircles, setDotCircles] = useState<DotCircle[]>([]);
  const [streamlines, setStreamlines] = useState<Streamline[]>([]);
  const [baseGeometry, setBaseGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [secondaryGeometry, setSecondaryGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [extrusionPreview, setExtrusionPreview] = useState(false);
  const [extrusionThickness, setExtrusionThickness] = useState(5.0);

  const editorCanvasRef = useRef<{ getCanvas: () => HTMLCanvasElement | null; getDotCircles: () => DotCircle[] }>(null);
  const pavilion3DRef = useRef<Pavilion3DHandle>(null);

  const handleExtrusionPreviewAutoDisabled = React.useCallback((reason: string) => {
    setExtrusionPreview(false);
    const engine = pavilion3DRef.current?.getEngine();
    if (engine) {
      engine.params.previewExtrusion = false;
    }
    if (reason) {
      console.warn(`[Extrusion Preview] ${reason}`);
    }
  }, []);

  const edgeDistField = React.useMemo<EdgeDistanceField>(() => {
    if (!baseGeometry) return null;
    const { width, height } = getRenderCanvasDimensions(globalSettings);
    return createGeometryEdgeDistField(baseGeometry, 256, width, height);
  }, [baseGeometry, globalSettings.canvasStretchX, globalSettings.canvasStretchY]);

  // Persist items/globalSettings
  React.useEffect(() => {
    localStorage.setItem(STORAGE_KEY_CURRENT, JSON.stringify({ items, globalSettings }));
  }, [items, globalSettings]);

  // Debounce the metaballs physics/geometry update to avoid lag while dragging
  React.useEffect(() => {
    const t = setTimeout(() => setMetaballsFinal(metaballs), 200);
    return () => clearTimeout(t);
  }, [metaballs]);

  // Live preview for 3D editing
  React.useEffect(() => {
    if (isEditing3D && !isEditingPattern) {
      const previewScale = 1024 / UV_SIZE;
      const { width: renderWidth, height: renderHeight } = getRenderCanvasDimensions(globalSettings);
      const offscreen = document.createElement('canvas');
      offscreen.width = Math.max(1, Math.round(renderWidth * previewScale));
      offscreen.height = Math.max(1, Math.round(renderHeight * previewScale));
      const ctx = offscreen.getContext('2d');
      if (ctx) {
        const computedItems = getComputedItems(items, globalSettings);
        const fixedView = { x: 0, y: 0, zoom: previewScale };
        renderFingerprints(ctx, computedItems, fixedView, offscreen.width, offscreen.height, globalSettings.cullingOffset, globalSettings.edgeCullRadius ?? 0, edgeDistField, globalSettings);
        setFingerprintCanvas(offscreen);
      }
    }
  }, [items, globalSettings, isEditing3D, isEditingPattern, edgeDistField]);

  // Auto re-apply texture when edgeCullRadius changes (even outside 3D edit mode)
  const prevTextureLayoutRef = useRef(`${globalSettings.edgeCullRadius ?? 0}|${globalSettings.canvasStretchX ?? 1}|${globalSettings.canvasStretchY ?? 1}`);
  React.useEffect(() => {
    const textureLayoutKey = `${globalSettings.edgeCullRadius ?? 0}|${globalSettings.canvasStretchX ?? 1}|${globalSettings.canvasStretchY ?? 1}`;
    if (textureLayoutKey === prevTextureLayoutRef.current) return;
    prevTextureLayoutRef.current = textureLayoutKey;
    if (isEditingPattern) return;
    const { width: texWidth, height: texHeight } = getRenderCanvasDimensions(globalSettings);
    const offscreen = document.createElement('canvas');
    offscreen.width = texWidth;
    offscreen.height = texHeight;
    const ctx = offscreen.getContext('2d');
    if (ctx) {
      const computed = getComputedItems(items, globalSettings);
      const fixedView = { x: 0, y: 0, zoom: 1 };
      renderFingerprints(ctx, computed, fixedView, texWidth, texHeight, globalSettings.cullingOffset, globalSettings.edgeCullRadius ?? 0, edgeDistField, globalSettings);
      setFingerprintCanvas(offscreen);
    }
  }, [globalSettings.edgeCullRadius, globalSettings.canvasStretchX, globalSettings.canvasStretchY, globalSettings.cullingOffset, edgeDistField, isEditingPattern, items, globalSettings]);

  const generateTextureAndData = (currentItems: CanvasItem[], currentSettings: any) => {
    const stretchX = currentSettings.canvasStretchX ?? 1;
    const stretchY = currentSettings.canvasStretchY ?? 1;
    const texW = Math.round(UV_SIZE * stretchX);
    const texH = Math.round(UV_SIZE * stretchY);
    const offscreen = document.createElement('canvas');
    offscreen.width = texW;
    offscreen.height = texH;
    const ctx = offscreen.getContext('2d');
    const computed = getComputedItems(currentItems, currentSettings);
    const fixedView = { x: 0, y: 0, zoom: 1 };

    if (ctx) {
      renderFingerprints(ctx, computed, fixedView, texW, texH, currentSettings.cullingOffset, currentSettings.edgeCullRadius ?? 0, edgeDistField, currentSettings);
    }

    const circles = collectDotCircles(computed, fixedView, currentSettings.cullingOffset, currentSettings.edgeCullRadius ?? 0, edgeDistField, currentSettings);
    const lines = collectStreamlines(computed, fixedView, currentSettings.cullingOffset, currentSettings.edgeCullRadius ?? 0, edgeDistField, currentSettings);
    return { canvas: offscreen, circles, lines };
  };

  const applyPatternPreview = () => {
    const { canvas } = generateTextureAndData(items, globalSettings);
    setFingerprintCanvas(canvas);
    setDotCircles([]);
    setStreamlines([]);
    setBakeHolesTrigger(0);
    setBakeTubesTrigger(0);
    setPreviewTubesTrigger(0);
    setIsEditingPattern(false);
  };

  const applyPatternPreviewTubes = () => {
    const { canvas, lines } = generateTextureAndData(items, globalSettings);
    setFingerprintCanvas(canvas);
    setStreamlines(lines);
    setPreviewTubesTrigger(Date.now());
    setIsEditingPattern(false);
  };

  const applyPatternBakeHoles = () => {
    const { canvas, circles } = generateTextureAndData(items, globalSettings);
    setFingerprintCanvas(canvas);
    setDotCircles(circles);
    setBakeHolesTrigger(Date.now());
    setIsEditingPattern(false);
  };

  const applyPatternBakeTubes = () => {
    const { canvas, lines } = generateTextureAndData(items, globalSettings);
    setFingerprintCanvas(canvas);
    setStreamlines(lines);
    setBakeTubesTrigger(Date.now());
    setIsEditingPattern(false);
  };

  const handleSaveProject = () => {
    const engine = pavilion3DRef.current?.getEngine();
    if (!engine) return;

    const exportParams = { ...engine.params };
    // Remove non-serializable or temporary fields
    delete exportParams._fingerprintTexture;
    delete exportParams._fingerprintCircles;
    delete exportParams._fingerprintLines;
    delete exportParams._fingerprintDecals;
    delete exportParams._fingerprintNativeDecals;
    delete exportParams._fingerprintNativeCircles;
    delete exportParams._fingerprintNativeLines;
    delete exportParams._fingerprintCanvasWidth;
    delete exportParams._fingerprintCanvasHeight;

    let importedGeomJson = null;
    let secondaryImportedGeomJson = null;
    let glassGeomJson = null;
    if (exportParams._importedGeometry) {
      importedGeomJson = exportParams._importedGeometry.toJSON();
    }
    if (exportParams._secondaryImportedGeometry) {
      secondaryImportedGeomJson = exportParams._secondaryImportedGeometry.toJSON();
    }
    if (exportParams._glassGeometry) {
      glassGeomJson = exportParams._glassGeometry.toJSON();
    }
    delete exportParams._importedGeometry;
    delete exportParams._secondaryImportedGeometry;
    delete exportParams._glassGeometry;

    const projectData = {
      version: 3,
      items,
      globalSettings,
      params: exportParams,
      importedGeomJson,
      secondaryImportedGeomJson,
      glassGeomJson
    };

    const blob = new Blob([JSON.stringify(projectData)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `pavilion-project-${Date.now()}.json`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadProject = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (data.items) setItems(data.items);
        if (data.globalSettings) setGlobalSettings(data.globalSettings);

        const engine = pavilion3DRef.current?.getEngine();
        if (engine && data.params) {
          // Restore params
          Object.assign(engine.params, data.params);

          // Restore geometry if any
          if (data.importedGeomJson) {
            const loader = new THREE.BufferGeometryLoader();
            engine.params._importedGeometry = loader.parse(data.importedGeomJson);
          } else {
            engine.params._importedGeometry = null;
          }
          if (data.secondaryImportedGeomJson) {
            const loader = new THREE.BufferGeometryLoader();
            engine.params._secondaryImportedGeometry = loader.parse(data.secondaryImportedGeomJson);
          } else {
            engine.params._secondaryImportedGeometry = null;
          }
          if (data.glassGeomJson) {
            const loader = new THREE.BufferGeometryLoader();
            engine.params._glassGeometry = loader.parse(data.glassGeomJson);
          } else {
            engine.params._glassGeometry = null;
          }

          // Trigger GUI update and rebuild
          if (engine.guiObj) {
            engine.guiObj.controllersRecursive().forEach((c: any) => c.updateDisplay());
          }

          const g = buildPavilion(engine.scene, engine.params);
          setBaseGeometry(g.userData.baseGeometry ?? null);
          setSecondaryGeometry(g.userData.secondaryGeometry ?? null);

          // Force a re-render/re-bake
          const { canvas, circles, lines } = generateTextureAndData(data.items || items, data.globalSettings || globalSettings);
          setFingerprintCanvas(canvas);
          setDotCircles(circles);
          setStreamlines(lines);
          setBakeTubesTrigger(Date.now());
          setPreviewTubesTrigger(0);
        }
      } catch (err) {
        console.error('Failed to load project:', err);
        alert('Failed to load project file.');
      }
    };
    input.click();
  };

  const handleExportFabric = async () => {
    const engine = pavilion3DRef.current?.getEngine();
    if (!engine) return;
    const { exportFabricSTL } = await import('./pavilion_3d/utils/export.js');
    exportFabricSTL(engine.scene, engine.params);
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#1a1a1a] text-white font-sans">

      {/* 3D Background Layer */}
      <div className={`absolute inset-0 transition-opacity duration-500 ${isEditingPattern || isEditingFabric ? 'opacity-20 pointer-events-none' : 'opacity-100'}`}>
        <Pavilion3D
          ref={pavilion3DRef}
          fingerprintCanvas={fingerprintCanvas}
          bakeHolesTrigger={bakeHolesTrigger}
          bakeTubesTrigger={bakeTubesTrigger}
          previewTubesTrigger={previewTubesTrigger}
          showSolidCheck={showSolidCheck}
          dotCircles={dotCircles}
          streamlines={streamlines}
          fingerprintItems={items}
          globalSettings={globalSettings}
          onBaseGeometryUpdate={setBaseGeometry}
          onSecondaryGeometryUpdate={setSecondaryGeometry}
          editing3D={isEditing3D}
          fabricEnabled={fabricEnabled}
          fabricItems={fabricItems}
          metaballs={metaballsFinal}
          onExtrusionPreviewAutoDisabled={handleExtrusionPreviewAutoDisabled}
        />
      </div>

      {/* 3D Fingerprint Editor Overlay */}
      {isEditing3D && (
        <FingerprintEditor3D
          pavilion3DRef={pavilion3DRef}
          items={items}
          onItemsChange={setItems}
          globalSettings={globalSettings}
        />
      )}

      {/* Metaball Editor Overlay */}
      {isEditingMetaballs && (
        <MetaballEditor3D
          pavilion3DRef={pavilion3DRef}
          balls={metaballs}
          onBallsChange={setMetaballs}
        />
      )}

      {/* Extrusion Preview Panel — small left-side controls */}
      {!isEditingPattern && !isEditingFabric && (
        <div className="absolute top-6 left-6 z-30 w-52">
          <div className="bg-slate-800/90 backdrop-blur-sm rounded-lg border border-slate-600/50 p-3 shadow-lg">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 accent-blue-500 rounded"
                checked={extrusionPreview}
                onChange={(e) => {
                  const on = e.target.checked;
                  setExtrusionPreview(on);
                  const engine = pavilion3DRef.current?.getEngine();
                  if (!engine) return;
                  engine.params.previewExtrusion = on;
                  engine.params.previewExtrusionThickness = extrusionThickness;
                  const g = buildPavilion(engine.scene, engine.params);
                  setBaseGeometry(g.userData.baseGeometry ?? null);
                  setSecondaryGeometry(g.userData.secondaryGeometry ?? null);
                  if (g.userData?.extrusionPreviewSuppressed) {
                    handleExtrusionPreviewAutoDisabled(g.userData.extrusionPreviewSuppressReason || 'Extrusion preview was disabled');
                  }
                }}
              />
              <span className="text-xs font-medium text-slate-200">Extrusion Preview</span>
            </label>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[10px] text-slate-400 whitespace-nowrap">0.5</span>
              <input
                type="range"
                min="0.5"
                max="15"
                step="0.5"
                className="flex-1 h-1 accent-blue-500"
                value={extrusionThickness}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setExtrusionThickness(val);
                  const engine = pavilion3DRef.current?.getEngine();
                  if (!engine) return;
                  engine.params.previewExtrusionThickness = val;
                  if (extrusionPreview) {
                    const g = buildPavilion(engine.scene, engine.params);
                    setBaseGeometry(g.userData.baseGeometry ?? null);
                    setSecondaryGeometry(g.userData.secondaryGeometry ?? null);
                    if (g.userData?.extrusionPreviewSuppressed) {
                      handleExtrusionPreviewAutoDisabled(g.userData.extrusionPreviewSuppressReason || 'Extrusion preview was disabled');
                    }
                  }
                }}
              />
              <span className="text-[10px] text-slate-400 whitespace-nowrap">15</span>
            </div>
            <div className="text-center text-[10px] text-slate-500 mt-0.5">
              Thickness: {extrusionThickness.toFixed(1)}
            </div>
          </div>
        </div>
      )}

      {/* Main 3D HUD (Visible only when NOT editing 2D pattern) */}
      {!isEditingPattern && !isEditingFabric && (
        <>
          <div className="absolute top-6 left-6 z-20 flex flex-col gap-3" style={{ marginTop: '110px' }}>
            <button
              onClick={() => setIsEditingPattern(true)}
              className="flex items-center gap-3 bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(37,99,235,0.3)] transition-all font-medium border border-blue-400/30"
            >
              <Fingerprint className="w-5 h-5" />
              Edit Surface Pattern
            </button>
            <button
              onClick={() => setIsEditingFabric(true)}
              className="flex items-center gap-3 bg-pink-600 hover:bg-pink-500 text-white px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(236,72,153,0.3)] transition-all font-medium border border-pink-400/30"
            >
              <Waves className="w-5 h-5" />
              Edit Fabric Pattern
            </button>
            <button
              onClick={() => setIsEditing3D(!isEditing3D)}
              className={`flex items-center gap-3 px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(168,85,247,0.3)] transition-all font-medium border ${isEditing3D
                  ? 'bg-purple-500 hover:bg-purple-400 border-purple-300/50 text-white'
                  : 'bg-purple-600 hover:bg-purple-500 border-purple-400/30 text-white'
                }`}
            >
              <Box className="w-5 h-5" />
              {isEditing3D ? 'Exit 3D Edit' : 'Edit 3D Mode'}
            </button>
            <button
              onClick={() => setShowSolidCheck(!showSolidCheck)}
              className={`flex items-center gap-3 px-6 py-3 rounded-xl transition-all font-medium border ${showSolidCheck
                  ? 'bg-emerald-500/30 hover:bg-emerald-500/50 text-emerald-300 border-emerald-400/50'
                  : 'bg-slate-700/50 hover:bg-slate-600/60 text-slate-300 border-slate-500/30'
                }`}
              title="Toggle solid check: green = solid (manifold), red = not solid"
            >
              <Eye className="w-5 h-5" />
              {showSolidCheck ? 'Solid Check: ON' : 'Solid Check: OFF'}
            </button>
            <button
              onClick={applyPatternPreviewTubes}
              className="flex items-center gap-3 bg-indigo-500/20 hover:bg-indigo-500/40 text-indigo-300 px-6 py-3 rounded-xl transition-all font-medium border border-indigo-400/30"
              title="Preview 3D tubes visually before baking"
            >
              <Waves className="w-5 h-5" />
              Preview 3D Tubes
            </button>
            <button
              onClick={applyPatternBakeTubes}
              className="flex items-center gap-3 bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(79,70,229,0.3)] transition-all font-medium border border-indigo-400/30"
              title="Calculates extruded 3D tubes from streamlines"
            >
              <Waves className="w-5 h-5" />
              Bake 3D Tubes
            </button>
            <button
              onClick={applyPatternBakeHoles}
              className="flex items-center gap-3 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all font-medium border border-emerald-400/30"
              title="Calculates actual circular geometry holes via CSG"
            >
              <Fingerprint className="w-5 h-5" />
              Bake 3D Holes
            </button>
            <button
              onClick={() => setIsEditingMetaballs(!isEditingMetaballs)}
              className={`flex items-center gap-3 px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all font-medium border ${isEditingMetaballs
                  ? 'bg-cyan-500 hover:bg-cyan-400 border-cyan-300/50 text-white'
                  : 'bg-cyan-700 hover:bg-cyan-600 border-cyan-400/30 text-white'
                }`}
            >
              <Circle className="w-5 h-5" />
              {isEditingMetaballs ? 'Exit Metaballs' : 'Edit Metaballs'}
            </button>
            <button
              onClick={() => setFabricEnabled(!fabricEnabled)}
              className={`flex items-center gap-3 px-6 py-3 rounded-xl shadow-lg transition-all font-medium border ${fabricEnabled
                  ? 'bg-pink-500 hover:bg-pink-400 border-pink-300/50 text-white'
                  : 'bg-slate-700 hover:bg-slate-600 border-slate-500/50 text-white'
                }`}
            >
              <Waves className="w-5 h-5" />
              {fabricEnabled ? 'Hide Fabric Drape' : 'Show Fabric Drape'}
            </button>
            <div className="flex gap-3 mt-2">
              <button
                onClick={handleSaveProject}
                className="flex-1 flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2.5 rounded-xl shadow-lg transition-all font-medium border border-slate-500/50 text-sm"
                title="Save entire scene and pattern state"
              >
                <Save className="w-4 h-4" />
                Save Project
              </button>
              <button
                onClick={handleLoadProject}
                className="flex-1 flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2.5 rounded-xl shadow-lg transition-all font-medium border border-slate-500/50 text-sm"
                title="Load saved scene and pattern state"
              >
                <FolderOpen className="w-4 h-4" />
                Load Project
              </button>
            </div>
            <div className="bg-[#1C1D21]/95 backdrop-blur-md border border-white/10 p-3 rounded-xl shadow-lg mt-1">
              <div className="flex justify-between text-[10px] mb-1">
                <span className="text-amber-400 font-medium">Edge Cull Radius</span>
                <span className="font-mono text-gray-400">{(globalSettings.edgeCullRadius ?? 0).toFixed(0)}px</span>
              </div>
              <input
                type="range"
                min="0" max="80" step="1"
                value={globalSettings.edgeCullRadius ?? 0}
                onChange={e => setGlobalSettings((s: any) => ({ ...s, edgeCullRadius: parseFloat(e.target.value) }))}
                className="w-full accent-amber-500"
              />
              <div className="text-[9px] text-gray-500 mt-0.5">
                Removes dots near geometry edges
              </div>
            </div>
            <button
              onClick={handleExportFabric}
              disabled={!fabricEnabled}
              className={`flex items-center justify-center gap-2 mt-1 px-4 py-2.5 rounded-xl shadow-lg transition-all font-medium border text-sm w-full ${fabricEnabled
                  ? 'bg-indigo-600 hover:bg-indigo-500 text-white border-indigo-400/30'
                  : 'bg-indigo-600/30 text-white/40 border-indigo-400/10 cursor-not-allowed'
                }`}
              title="Export the final generated fabric geometry to STL"
            >
              <Download className="w-4 h-4" />
              Export Fabric (STL)
            </button>
          </div>

          {isEditing3D && (
            <div className="absolute bottom-12 left-6 z-20 bg-[#1C1D21]/95 backdrop-blur-md border border-white/10 p-4 rounded-2xl shadow-2xl w-64">
              <div className="flex justify-between text-xs text-gray-300 mb-2 font-medium uppercase tracking-wider">
                <span>Global Scale</span>
                <span className="font-mono text-blue-400">{(globalSettings.globalScale || 1.0).toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min="0.1" max={GLOBAL_SCALE_MAX} step="0.05"
                value={globalSettings.globalScale || 1.0}
                onChange={e => setGlobalSettings((s: any) => ({ ...s, globalScale: parseFloat(e.target.value) }))}
                className="w-full accent-blue-500"
              />
              <div className="flex justify-between text-xs text-gray-300 mt-4 mb-2 font-medium uppercase tracking-wider">
                <span>Line Thickness</span>
                <span className="font-mono text-blue-400">{(globalSettings.lineThicknessScale ?? 1.0).toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min={LINE_THICKNESS_SCALE_MIN} max={LINE_THICKNESS_SCALE_MAX} step="0.05"
                value={globalSettings.lineThicknessScale ?? 1.0}
                onChange={e => setGlobalSettings((s: any) => ({ ...s, lineThicknessScale: parseFloat(e.target.value) }))}
                className="w-full accent-blue-500"
              />
            </div>
          )}
        </>
      )}

      {/* 2D Pattern Editor Overlay */}
      {isEditingPattern && (
        <div className="absolute inset-0 z-30 flex flex-col bg-[#151619]/95 backdrop-blur-md">
          {/* Top Bar */}
          <div className="h-16 border-b border-white/10 px-6 flex items-center justify-between bg-[#1C1D21]">
            <div className="flex items-center gap-3">
              <Fingerprint className="w-6 h-6 text-blue-400" />
              <h1 className="text-xl font-medium tracking-tight">Parametric Surface Editor</h1>
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => setIsEditingPattern(false)}
                className="flex items-center gap-2 text-gray-400 hover:text-white px-4 py-2 hover:bg-white/5 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
                Cancel
              </button>
              <button
                onClick={applyPatternPreview}
                className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 border border-slate-500 text-white px-4 py-2 rounded-lg transition-all font-medium"
                title="Instant visual preview using shaders"
              >
                <MonitorPlay className="w-4 h-4" />
                Preview Fast
              </button>
            </div>
          </div>

          {/* Editor Workspace */}
          <div className="flex-1 w-full relative">
            <WhorlCanvas
              ref={editorCanvasRef}
              baseGeometry={baseGeometry}
              externalItems={items}
              onItemsChange={setItems}
              externalGlobalSettings={globalSettings}
              onGlobalSettingsChange={setGlobalSettings}
              edgeDistField={edgeDistField}
            />
          </div>
        </div>
      )}

      {/* Fabric Editor Overlay */}
      {isEditingFabric && (
        <div className="absolute inset-0 z-30 flex flex-col bg-[#151619]/95 backdrop-blur-md">
          {/* Top Bar */}
          <div className="h-16 border-b border-white/10 px-6 flex items-center justify-between bg-[#1C1D21]">
            <div className="flex items-center gap-3">
              <Waves className="w-6 h-6 text-pink-400" />
              <h1 className="text-xl font-medium tracking-tight">Fabric Drape Editor</h1>
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => setIsEditingFabric(false)}
                className="flex items-center gap-2 text-gray-400 hover:text-white px-4 py-2 hover:bg-white/5 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
                Close
              </button>
            </div>
          </div>

          {/* Editor Workspace */}
          <div className="flex-1 w-full relative">
            <FabricCanvas
              externalItems={fabricItems}
              onItemsChange={setFabricItems}
              baseGeometry={baseGeometry}
              secondaryGeometry={secondaryGeometry}
              radius={globalSettings.radiusBottom || 20}
            />
          </div>
        </div>
      )}

      {/* Info footer */}
      {!isEditingPattern && !isEditingFabric && (
        <div id="info" className="absolute bottom-5 left-1/2 -translate-x-1/2 text-white/50 text-xs tracking-widest uppercase pointer-events-none">
          EXPO 2030 Riyadh Pavilion — Parametric Design Tool
        </div>
      )}
    </div>
  );
}
