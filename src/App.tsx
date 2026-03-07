/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import * as THREE from 'three';
import { Fingerprint, MonitorPlay, X } from 'lucide-react';
import { Pavilion3D } from './components/Pavilion3D';
import { WhorlCanvas } from './components/WhorlCanvas';
import type { DotCircle } from './components/MergedFingerprintsCanvas';

export default function App() {
  const [isEditingPattern, setIsEditingPattern] = useState(false);
  const [fingerprintCanvas, setFingerprintCanvas] = useState<HTMLCanvasElement | null>(null);
  const [bakeHolesTrigger, setBakeHolesTrigger] = useState<number>(0);
  const [dotCircles, setDotCircles] = useState<DotCircle[]>([]);
  const [baseGeometry, setBaseGeometry] = useState<THREE.BufferGeometry | null>(null);

  const editorCanvasRef = useRef<{ getCanvas: () => HTMLCanvasElement | null; getDotCircles: () => DotCircle[] }>(null);

  const applyPatternPreview = () => {
    if (editorCanvasRef.current) {
      const cvs = editorCanvasRef.current.getCanvas();
      if (cvs) setFingerprintCanvas(cvs);
    }
    setDotCircles([]);
    setBakeHolesTrigger(0);
    setIsEditingPattern(false);
  };

  const applyPatternBake = () => {
    if (editorCanvasRef.current) {
      const cvs = editorCanvasRef.current.getCanvas();
      if (cvs) setFingerprintCanvas(cvs);
      setDotCircles(editorCanvasRef.current.getDotCircles());
    }
    setBakeHolesTrigger(Date.now());
    setIsEditingPattern(false);
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#1a1a1a] text-white font-sans">

      {/* 3D Background Layer */}
      <div className={`absolute inset-0 transition-opacity duration-500 ${isEditingPattern ? 'opacity-20 pointer-events-none' : 'opacity-100'}`}>
        <Pavilion3D fingerprintCanvas={fingerprintCanvas} bakeHolesTrigger={bakeHolesTrigger} dotCircles={dotCircles} onBaseGeometryUpdate={setBaseGeometry} />
      </div>

      {/* Main 3D HUD (Visible only when NOT editing) */}
      {!isEditingPattern && (
        <div className="absolute top-6 left-6 z-20">
          <button
            onClick={() => setIsEditingPattern(true)}
            className="flex items-center gap-3 bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-xl shadow-[0_0_20px_rgba(37,99,235,0.3)] transition-all font-medium border border-blue-400/30"
          >
            <Fingerprint className="w-5 h-5" />
            Edit Surface Pattern
          </button>
        </div>
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
              <button
                onClick={applyPatternBake}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-lg shadow-md transition-all font-medium"
                title="Calculates actual circular geometry holes via CSG"
              >
                <Fingerprint className="w-4 h-4" />
                Bake 3D Holes
              </button>
            </div>
          </div>

          {/* Editor Workspace */}
          <div className="flex-1 w-full relative">
            <WhorlCanvas ref={editorCanvasRef} baseGeometry={baseGeometry} />
          </div>
        </div>
      )}

      {/* Info footer */}
      {!isEditingPattern && (
        <div id="info" className="absolute bottom-5 left-1/2 -translate-x-1/2 text-white/50 text-xs tracking-widest uppercase pointer-events-none">
          EXPO 2030 Riyadh Pavilion — Parametric Design Tool
        </div>
      )}
    </div>
  );
}
