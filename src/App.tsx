/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import * as THREE from 'three';
import { Fingerprint, MonitorPlay, X, Box, Save, FolderOpen, Waves, Circle, Download } from 'lucide-react';
import { Pavilion3D } from './components/Pavilion3D';
import type { Pavilion3DHandle } from './components/Pavilion3D';
import { WhorlCanvas } from './components/WhorlCanvas';
import { FabricCanvas } from './components/FabricCanvas';
import type { FabricItem } from './components/FabricCanvas';
import { FingerprintEditor3D } from './components/FingerprintEditor3D.tsx';
import { MetaballEditor3D } from './components/MetaballEditor3D';
import type { MetaballData } from './components/MetaballEditor3D';
import { MergedFingerprintsCanvas, computeFitView, renderFingerprints, UV_SIZE, collectDotCircles, getComputedItems, createGeometryEdgeDistField } from './components/MergedFingerprintsCanvas';
import type { DotCircle, CanvasItem, EdgeDistanceField } from './components/MergedFingerprintsCanvas';
import { DEFAULT_DOTS_PARAMS, FingerprintParams } from './presets';

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
    noiseScale: 7,
    globalScale: 1.0,
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
  const [dotCircles, setDotCircles] = useState<DotCircle[]>([]);
  const [baseGeometry, setBaseGeometry] = useState<THREE.BufferGeometry | null>(null);

  const editorCanvasRef = useRef<{ getCanvas: () => HTMLCanvasElement | null; getDotCircles: () => DotCircle[] }>(null);
  const pavilion3DRef = useRef<Pavilion3DHandle>(null);

  const edgeDistField = React.useMemo<EdgeDistanceField>(() => {
    if (!baseGeometry) return null;
    return createGeometryEdgeDistField(baseGeometry);
  }, [baseGeometry]);

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
      const texSize = 1024; // Use slightly lower res for live preview to maintain performance
      const offscreen = document.createElement('canvas');
      offscreen.width = texSize;
      offscreen.height = texSize;
      const ctx = offscreen.getContext('2d');
      if (ctx) {
        const computedItems = getComputedItems(items, globalSettings);
        const fixedView = { x: 0, y: 0, zoom: texSize / UV_SIZE };
        renderFingerprints(ctx, computedItems, fixedView, texSize, texSize, globalSettings.cullingOffset, globalSettings.edgeCullRadius ?? 0, edgeDistField, globalSettings);
        setFingerprintCanvas(offscreen);
      }
    }
  }, [items, globalSettings, isEditing3D, isEditingPattern, edgeDistField]);

  // Auto re-apply texture when edgeCullRadius changes (even outside 3D edit mode)
  const prevEdgeCullRef = useRef(globalSettings.edgeCullRadius ?? 0);
  React.useEffect(() => {
    const cur = globalSettings.edgeCullRadius ?? 0;
    if (cur === prevEdgeCullRef.current) return;
    prevEdgeCullRef.current = cur;
    if (isEditingPattern) return;
    const texSize = UV_SIZE;
    const offscreen = document.createElement('canvas');
    offscreen.width = texSize;
    offscreen.height = texSize;
    const ctx = offscreen.getContext('2d');
    if (ctx) {
      const computed = getComputedItems(items, globalSettings);
      const fixedView = { x: 0, y: 0, zoom: 1 };
      renderFingerprints(ctx, computed, fixedView, texSize, texSize, globalSettings.cullingOffset, cur, edgeDistField, globalSettings);
      setFingerprintCanvas(offscreen);
    }
  }, [globalSettings.edgeCullRadius, edgeDistField]);

  const generateTextureAndCircles = (currentItems: CanvasItem[], currentSettings: any) => {
    const texSize = UV_SIZE;
    const offscreen = document.createElement('canvas');
    offscreen.width = texSize;
    offscreen.height = texSize;
    const ctx = offscreen.getContext('2d');
    const computed = getComputedItems(currentItems, currentSettings);
    const fixedView = { x: 0, y: 0, zoom: 1 };
    
    if (ctx) {
        renderFingerprints(ctx, computed, fixedView, texSize, texSize, currentSettings.cullingOffset, currentSettings.edgeCullRadius ?? 0, edgeDistField, currentSettings);
    }
    
    const circles = collectDotCircles(computed, fixedView, currentSettings.cullingOffset, currentSettings.edgeCullRadius ?? 0, edgeDistField, currentSettings);
    return { canvas: offscreen, circles };
  };

  const applyPatternPreview = () => {
    const { canvas } = generateTextureAndCircles(items, globalSettings);
    setFingerprintCanvas(canvas);
    setDotCircles([]);
    setBakeHolesTrigger(0);
    setIsEditingPattern(false);
  };

  const applyPatternBake = () => {
    const { canvas, circles } = generateTextureAndCircles(items, globalSettings);
    setFingerprintCanvas(canvas);
    setDotCircles(circles);
    setBakeHolesTrigger(Date.now());
    setIsEditingPattern(false);
  };

  const handleSaveProject = () => {
    const engine = pavilion3DRef.current?.getEngine();
    if (!engine) return;

    const exportParams = { ...engine.params };
    // Remove non-serializable or temporary fields
    delete exportParams._fingerprintTexture;
    delete exportParams._fingerprintCircles;
    delete exportParams._fingerprintCanvasWidth;
    delete exportParams._fingerprintCanvasHeight;

    let importedGeomJson = null;
    if (exportParams._importedGeometry) {
      importedGeomJson = exportParams._importedGeometry.toJSON();
    }
    delete exportParams._importedGeometry;

    const projectData = {
      version: 1,
      items,
      globalSettings,
      params: exportParams,
      importedGeomJson
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

          // Trigger GUI update and rebuild
          if (engine.guiObj) {
            engine.guiObj.controllersRecursive().forEach((c: any) => c.updateDisplay());
          }
          
          // Force a re-render/re-bake
          const { canvas, circles } = generateTextureAndCircles(data.items || items, data.globalSettings || globalSettings);
          setFingerprintCanvas(canvas);
          setDotCircles(circles);
          setBakeHolesTrigger(Date.now());
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
          dotCircles={dotCircles}
          onBaseGeometryUpdate={setBaseGeometry}
          editing3D={isEditing3D}
          fabricEnabled={fabricEnabled}
          fabricItems={fabricItems}
          metaballs={metaballsFinal}
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

      {/* Main 3D HUD (Visible only when NOT editing 2D pattern) */}
      {!isEditingPattern && !isEditingFabric && (
        <>
        <div className="absolute top-6 left-6 z-20 flex flex-col gap-3">
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
            className={`flex items-center gap-3 px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(168,85,247,0.3)] transition-all font-medium border ${
              isEditing3D
                ? 'bg-purple-500 hover:bg-purple-400 border-purple-300/50 text-white'
                : 'bg-purple-600 hover:bg-purple-500 border-purple-400/30 text-white'
            }`}
          >
            <Box className="w-5 h-5" />
            {isEditing3D ? 'Exit 3D Edit' : 'Edit 3D Mode'}
          </button>
          <button
            onClick={applyPatternBake}
            className="flex items-center gap-3 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all font-medium border border-emerald-400/30"
            title="Calculates actual circular geometry holes via CSG"
          >
            <Fingerprint className="w-5 h-5" />
            Bake 3D Holes
          </button>
          <button
            onClick={() => setIsEditingMetaballs(!isEditingMetaballs)}
            className={`flex items-center gap-3 px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all font-medium border ${
              isEditingMetaballs
                ? 'bg-cyan-500 hover:bg-cyan-400 border-cyan-300/50 text-white'
                : 'bg-cyan-700 hover:bg-cyan-600 border-cyan-400/30 text-white'
            }`}
          >
            <Circle className="w-5 h-5" />
            {isEditingMetaballs ? 'Exit Metaballs' : 'Edit Metaballs'}
          </button>
          <button
            onClick={() => setFabricEnabled(!fabricEnabled)}
            className={`flex items-center gap-3 px-6 py-3 rounded-xl shadow-lg transition-all font-medium border ${
              fabricEnabled
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
            className={`flex items-center justify-center gap-2 mt-1 px-4 py-2.5 rounded-xl shadow-lg transition-all font-medium border text-sm w-full ${
              fabricEnabled 
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
                min="0.1" max="3" step="0.05" 
                value={globalSettings.globalScale || 1.0} 
                onChange={e => setGlobalSettings((s: any) => ({ ...s, globalScale: parseFloat(e.target.value) }))}
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
