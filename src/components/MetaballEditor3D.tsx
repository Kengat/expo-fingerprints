import React, { useEffect, useRef, useCallback, useState } from 'react';
import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import type { Pavilion3DHandle } from './Pavilion3D';

/* ───── Types ───── */

export interface MetaballData {
  id: string;
  x: number;
  y: number;
  z: number;
  radius: number;   // 0.05–0.5 in normalised MC space
  strength: number;  // blend strength, 0.5–3
}

interface Props {
  pavilion3DRef: React.RefObject<Pavilion3DHandle | null>;
  balls: MetaballData[];
  onBallsChange: (balls: MetaballData[]) => void;
}

/* ───── Constants ───── */

const MC_RESOLUTION = 48;
const MC_SCALE = 20;           // world-unit bounding box half-extent
const HELPER_COLOR = 0x44ccff;
const SELECTED_COLOR = 0xff44aa;
const HOVER_COLOR = 0x88eeff;

let _idCounter = 0;
export function newBallId() { return `mb_${Date.now()}_${_idCounter++}`; }

/* ───── Component ───── */

export function MetaballEditor3D({ pavilion3DRef, balls, onBallsChange }: Props) {
  const mcRef = useRef<MarchingCubes | null>(null);
  const helpersGroupRef = useRef<THREE.Group>(new THREE.Group());
  const raycaster = useRef(new THREE.Raycaster());
  const mouse = useRef(new THREE.Vector2());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const draggingRef = useRef(false);
  const dragPlaneRef = useRef(new THREE.Plane());
  const dragOffsetRef = useRef(new THREE.Vector3());
  const ballsRef = useRef(balls);
  ballsRef.current = balls;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  /* ── Initialise MarchingCubes + helpers ── */
  useEffect(() => {
    const engine = pavilion3DRef.current?.getEngine();
    if (!engine) return;
    const { scene } = engine;

    // Material for the metaball surface
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xccddff,
      metalness: 0.1,
      roughness: 0.25,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      envMapIntensity: 0.6,
    });

    const mc = new MarchingCubes(MC_RESOLUTION, mat, true, true, 80000);
    mc.position.set(0, MC_SCALE, 0);
    mc.scale.setScalar(MC_SCALE);
    mc.enableUvs = false;
    mc.enableColors = false;
    mc.name = 'metaballs-mc';
    scene.add(mc);
    mcRef.current = mc;

    const helpersGroup = helpersGroupRef.current;
    helpersGroup.name = 'metaballs-helpers';
    scene.add(helpersGroup);

    return () => {
      scene.remove(mc);
      mc.geometry.dispose();
      mat.dispose();
      scene.remove(helpersGroup);
      helpersGroup.children.forEach(c => {
        if ((c as any).geometry) (c as any).geometry.dispose();
        if ((c as any).material) (c as any).material.dispose();
      });
      helpersGroup.clear();
      mcRef.current = null;
    };
  }, [pavilion3DRef]);

  /* ── Rebuild MC field whenever balls change ── */
  useEffect(() => {
    const mc = mcRef.current;
    if (!mc) return;

    mc.reset();

    // MarchingCubes local space is [-1, 1], scaled by MC_SCALE, positioned at (0, MC_SCALE, 0).
    // World bounds: X [-MC_SCALE, MC_SCALE], Y [0, 2*MC_SCALE], Z [-MC_SCALE, MC_SCALE].
    // Normalised MC coords [0,1] map to local [-1,1] via: local = norm * 2 - 1.
    // So: norm = (world - mc.position) / MC_SCALE * 0.5 + 0.5
    for (const b of balls) {
      const nx = b.x / MC_SCALE * 0.5 + 0.5;
      const ny = (b.y - MC_SCALE) / MC_SCALE * 0.5 + 0.5;
      const nz = b.z / MC_SCALE * 0.5 + 0.5;
      // MC strength controls visible size; radius² * strength gives proportional blob size
      const mcStrength = b.radius * b.radius * b.strength;
      mc.addBall(nx, ny, nz, mcStrength, 12, undefined, undefined, undefined);
    }
    mc.update();

    // Rebuild wire-sphere helpers
    const group = helpersGroupRef.current;
    group.children.forEach(c => {
      if ((c as any).geometry) (c as any).geometry.dispose();
      if ((c as any).material) (c as any).material.dispose();
    });
    group.clear();

    for (const b of balls) {
      // Wireframe radius approximates the visible MC surface size
      const visRadius = b.radius * MC_SCALE;
      const geom = new THREE.SphereGeometry(visRadius, 16, 12);
      const color = b.id === selectedId ? SELECTED_COLOR : b.id === hoveredId ? HOVER_COLOR : HELPER_COLOR;
      const mat = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.45 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(b.x, b.y, b.z);
      mesh.userData.ballId = b.id;
      mesh.name = `helper-${b.id}`;
      group.add(mesh);
    }
  }, [balls, selectedId, hoveredId]);

  /* ── Hit-test helpers ── */
  const hitTestHelpers = useCallback((clientX: number, clientY: number): string | null => {
    const engine = pavilion3DRef.current?.getEngine();
    if (!engine) return null;
    const rect = engine.renderer.domElement.getBoundingClientRect();
    mouse.current.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.current.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.current.setFromCamera(mouse.current, engine.camera);
    const hits = raycaster.current.intersectObjects(helpersGroupRef.current.children, false);
    if (hits.length > 0) return hits[0].object.userData.ballId as string;
    return null;
  }, [pavilion3DRef]);

  /* ── Mouse handlers ── */
  useEffect(() => {
    const engine = pavilion3DRef.current?.getEngine();
    if (!engine) return;
    const canvas = engine.renderer.domElement;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const hitId = hitTestHelpers(e.clientX, e.clientY);
      if (hitId) {
        e.stopPropagation();
        e.preventDefault();
        setSelectedId(hitId);
        selectedIdRef.current = hitId;
        draggingRef.current = true;
        engine.controls.enabled = false;

        // Setup drag plane
        const ball = ballsRef.current.find(b => b.id === hitId);
        if (ball) {
          const camDir = new THREE.Vector3();
          engine.camera.getWorldDirection(camDir);
          const ballPos = new THREE.Vector3(ball.x, ball.y, ball.z);
          dragPlaneRef.current.setFromNormalAndCoplanarPoint(camDir, ballPos);

          // Compute offset
          const rect = canvas.getBoundingClientRect();
          mouse.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
          mouse.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.current.setFromCamera(mouse.current, engine.camera);
          const intersection = new THREE.Vector3();
          raycaster.current.ray.intersectPlane(dragPlaneRef.current, intersection);
          dragOffsetRef.current.copy(ballPos).sub(intersection);
        }
      } else {
        setSelectedId(null);
        selectedIdRef.current = null;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (draggingRef.current && selectedIdRef.current) {
        e.stopPropagation();
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        mouse.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.current.setFromCamera(mouse.current, engine.camera);
        const pt = new THREE.Vector3();
        raycaster.current.ray.intersectPlane(dragPlaneRef.current, pt);
        if (pt) {
          pt.add(dragOffsetRef.current);
          const newBalls = ballsRef.current.map(b =>
            b.id === selectedIdRef.current
              ? { ...b, x: pt.x, y: pt.y, z: pt.z }
              : b
          );
          onBallsChange(newBalls);
        }
      } else {
        // Hover
        const hitId = hitTestHelpers(e.clientX, e.clientY);
        setHoveredId(hitId);
      }
    };

    const onPointerUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false;
        engine.controls.enabled = true;
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!selectedIdRef.current) return;
      // Hold Shift to change strength, otherwise change radius
      const delta = e.deltaY > 0 ? -0.02 : 0.02;
      e.preventDefault();
      e.stopPropagation();

      const newBalls = ballsRef.current.map(b => {
        if (b.id !== selectedIdRef.current) return b;
        if (e.shiftKey) {
          return { ...b, strength: Math.max(0.1, Math.min(5, b.strength + delta * 5)) };
        } else {
          return { ...b, radius: Math.max(0.03, Math.min(0.8, b.radius + delta)) };
        }
      });
      onBallsChange(newBalls);
    };

    canvas.addEventListener('pointerdown', onPointerDown, true);
    canvas.addEventListener('pointermove', onPointerMove, true);
    canvas.addEventListener('pointerup', onPointerUp, true);
    canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown, true);
      canvas.removeEventListener('pointermove', onPointerMove, true);
      canvas.removeEventListener('pointerup', onPointerUp, true);
      canvas.removeEventListener('wheel', onWheel, true);
      engine.controls.enabled = true;
    };
  }, [pavilion3DRef, hitTestHelpers, onBallsChange]);

  /* ── UI Panel ── */
  const selectedBall = balls.find(b => b.id === selectedId);

  const addBall = () => {
    const newBall: MetaballData = {
      id: newBallId(),
      x: (Math.random() - 0.5) * 8,
      y: MC_SCALE + (Math.random() - 0.5) * 6,
      z: (Math.random() - 0.5) * 8,
      radius: 0.15,
      strength: 1.2,
    };
    onBallsChange([...balls, newBall]);
    setSelectedId(newBall.id);
  };

  const deleteBall = () => {
    if (!selectedId) return;
    onBallsChange(balls.filter(b => b.id !== selectedId));
    setSelectedId(null);
  };

  const updateSelected = (patch: Partial<MetaballData>) => {
    if (!selectedId) return;
    onBallsChange(balls.map(b => b.id === selectedId ? { ...b, ...patch } : b));
  };

  return (
    <div className="absolute bottom-6 right-6 z-20 w-72 bg-[#1C1D21]/95 backdrop-blur-md border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <span className="text-sm font-semibold text-cyan-400 uppercase tracking-wider">Metaballs</span>
        <span className="text-xs text-gray-500">{balls.length} ball{balls.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Actions */}
      <div className="px-4 py-3 flex gap-2">
        <button
          onClick={addBall}
          className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium py-2 rounded-lg transition-colors"
        >
          + Add Ball
        </button>
        <button
          onClick={deleteBall}
          disabled={!selectedId}
          className="flex-1 bg-red-700/60 hover:bg-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs font-medium py-2 rounded-lg transition-colors"
        >
          Delete
        </button>
      </div>

      {/* Ball list */}
      <div className="px-4 pb-2 max-h-32 overflow-y-auto">
        {balls.map((b, i) => (
          <button
            key={b.id}
            onClick={() => setSelectedId(b.id === selectedId ? null : b.id)}
            className={`w-full text-left text-xs px-3 py-1.5 rounded-md mb-1 transition-colors ${
              b.id === selectedId
                ? 'bg-cyan-600/40 text-cyan-200'
                : 'hover:bg-white/5 text-gray-400'
            }`}
          >
            Ball {i + 1}
            <span className="float-right font-mono text-[10px] opacity-60">
              r:{b.radius.toFixed(2)} s:{b.strength.toFixed(1)}
            </span>
          </button>
        ))}
      </div>

      {/* Selected ball properties */}
      {selectedBall && (
        <div className="px-4 py-3 border-t border-white/10 space-y-2">
          <SliderRow label="Radius" value={selectedBall.radius} min={0.03} max={0.8} step={0.01}
            onChange={v => updateSelected({ radius: v })} />
          <SliderRow label="Strength" value={selectedBall.strength} min={0.1} max={5} step={0.1}
            onChange={v => updateSelected({ strength: v })} />
          <SliderRow label="X" value={selectedBall.x} min={-MC_SCALE} max={MC_SCALE} step={0.1}
            onChange={v => updateSelected({ x: v })} />
          <SliderRow label="Y" value={selectedBall.y} min={0} max={MC_SCALE * 2} step={0.5}
            onChange={v => updateSelected({ y: v })} />
          <SliderRow label="Z" value={selectedBall.z} min={-MC_SCALE} max={MC_SCALE} step={0.1}
            onChange={v => updateSelected({ z: v })} />
          <div className="text-[9px] text-gray-500 pt-1">
            Scroll = resize · Shift+Scroll = blend · Drag = move
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Slider helper ── */
function SliderRow({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-gray-400 w-12 shrink-0">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-cyan-500 h-1" />
      <span className="text-[10px] font-mono text-gray-500 w-10 text-right">{value.toFixed(2)}</span>
    </div>
  );
}
