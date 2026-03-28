import React, { useEffect, useRef, useCallback, useState } from 'react';
import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
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

const MC_RESOLUTION = 60;
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
  const tControlRef = useRef<TransformControls | null>(null);
  const ballsRef = useRef(balls);
  ballsRef.current = balls;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  /* ── Initialise MarchingCubes + helpers ── */
  useEffect(() => {
    const engine = pavilion3DRef.current?.getEngine();
    if (!engine) return;
    const { scene } = engine;

    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xccddff,
      metalness: 0.1,
      roughness: 0.25,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      envMapIntensity: 0.6,
      depthWrite: true,
    });

    const mc = new MarchingCubes(MC_RESOLUTION, mat, true, true, 80000);
    mc.frustumCulled = false; // Prevent it from randomly disappearing during dynamic updates
    mc.isolation = 80;
    mc.position.set(0, MC_SCALE, 0);
    mc.scale.setScalar(MC_SCALE);
    mc.enableUvs = false;
    mc.enableColors = false;
    mc.name = 'metaballs-mc';

    const wrapperGroup = new THREE.Group();
    wrapperGroup.name = 'metaballs-wrapper';
    wrapperGroup.add(mc);
    mcRef.current = mc;

    const helpersGroup = helpersGroupRef.current;
    helpersGroup.name = 'metaballs-helpers';
    wrapperGroup.add(helpersGroup);
    scene.add(wrapperGroup);

    // Keep wrapper transform synced with dynamic pavilion root
    let rAFId = 0;
    const syncTransform = () => {
      rAFId = window.requestAnimationFrame(syncTransform);
      let tParent = null as THREE.Object3D | null;
      scene.traverse((child) => {
        if (child.name === 'pavilion-shell' && child.parent) {
          tParent = child.parent;
        }
      });
      if (tParent) {
        wrapperGroup.position.copy(tParent.position);
        wrapperGroup.quaternion.copy(tParent.quaternion);
        wrapperGroup.scale.copy(tParent.scale);
      }
    };
    syncTransform();

    let isDraggingGizmo = false;
    let lastDragTime = 0;
    const tControl = new TransformControls(engine.camera, engine.renderer.domElement);
    tControl.size = 1.0; // Ensure gizmo is visible
    tControl.setSpace('local'); // Recommended for working within rotated parents

    tControl.addEventListener('dragging-changed', (event) => {
      engine.controls.enabled = !event.value;
      isDraggingGizmo = event.value;
      if (!isDraggingGizmo && tControl.object && selectedIdRef.current) {
        // Final explicit save on drop
        const pos = tControl.object.position;
        onBallsChange(ballsRef.current.map(b =>
          b.id === selectedIdRef.current
            ? { ...b, x: pos.x, y: pos.y, z: pos.z }
            : b
        ));
      }
    });
    tControl.addEventListener('change', () => {
      if (!isDraggingGizmo || !tControl.object || !selectedIdRef.current) return;
      const now = performance.now();
      if (now - lastDragTime < 30) return; // Throttle to roughly 30fps to avoid lag
      lastDragTime = now;
      
      const pos = tControl.object.position;
      onBallsChange(ballsRef.current.map(b =>
        b.id === selectedIdRef.current
          ? { ...b, x: pos.x, y: pos.y, z: pos.z }
          : b
      ));
    });
    scene.add(tControl.getHelper());
    tControlRef.current = tControl;

    return () => {
      window.cancelAnimationFrame(rAFId);
      scene.remove(wrapperGroup);
      mc.geometry.dispose();
      mat.dispose();
      helpersGroup.children.forEach(c => {
        if ((c as any).geometry) (c as any).geometry.dispose();
        if ((c as any).material) (c as any).material.dispose();
      });
      helpersGroup.clear();
      tControl.dispose();
      scene.remove(tControl.getHelper());
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

    // Update wire-sphere helpers
    const group = helpersGroupRef.current;
    const currentIds = new Set(balls.map(b => b.id));

    // Remove obsolete helpers
    for (let i = group.children.length - 1; i >= 0; i--) {
      const c = group.children[i];
      if (!currentIds.has(c.userData.ballId)) {
        if (tControlRef.current && tControlRef.current.object === c) tControlRef.current.detach();
        if ((c as any).geometry) (c as any).geometry.dispose();
        if ((c as any).material) (c as any).material.dispose();
        group.remove(c);
      }
    }

    for (const b of balls) {
      // Wireframe radius must exactly math the MarchingCubes local field distance formula!
      // (strength / dist^2) - 12 (subtract) = 80 (isolation) => dist = sqrt(strength / 92)
      // True world radius is local coordinate width (2 * MC_SCALE) * dist.
      const mcStrength = b.radius * b.radius * b.strength;
      const visRadius = 2 * MC_SCALE * Math.sqrt(mcStrength / 92);
      
      const color = b.id === selectedId ? SELECTED_COLOR : b.id === hoveredId ? HOVER_COLOR : HELPER_COLOR;
      
      let mesh = group.children.find(c => c.userData.ballId === b.id) as THREE.Mesh;
      if (!mesh) {
        const geom = new THREE.SphereGeometry(visRadius, 16, 12);
        const mat = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.45 });
        mesh = new THREE.Mesh(geom, mat);
        mesh.userData.ballId = b.id;
        mesh.userData.lastVisRadius = visRadius;
        mesh.name = `helper-${b.id}`;
        group.add(mesh);

        if (b.id === selectedId && tControlRef.current) {
          tControlRef.current.attach(mesh);
        }
      } else {
        // Update geometry if radius significantly changed
        if (Math.abs(mesh.userData.lastVisRadius - visRadius) > 0.01) {
           mesh.geometry.dispose();
           mesh.geometry = new THREE.SphereGeometry(visRadius, 16, 12);
           mesh.userData.lastVisRadius = visRadius;
        }
        (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      }
      
      // Update mesh local position, BUT avoid tug-of-war if we are currently dragging THIS very mesh via TransformControls
      if (!tControlRef.current?.dragging || tControlRef.current.object !== mesh) {
        mesh.position.set(b.x, b.y, b.z);
      }
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
      // Allow Gizmo interaction to take priority
      if (e.button !== 0 || tControlRef.current?.dragging) return;
      const hitId = hitTestHelpers(e.clientX, e.clientY);
      setSelectedId(hitId);
      selectedIdRef.current = hitId;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (tControlRef.current?.dragging) return;
      const hitId = hitTestHelpers(e.clientX, e.clientY);
      setHoveredId(hitId);
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

    canvas.addEventListener('pointerdown', onPointerDown, false);
    canvas.addEventListener('pointermove', onPointerMove, false);
    canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown, false);
      canvas.removeEventListener('pointermove', onPointerMove, false);
      canvas.removeEventListener('wheel', onWheel, true);
    };
  }, [pavilion3DRef, hitTestHelpers, onBallsChange]);

  useEffect(() => {
    if (tControlRef.current) {
      if (selectedId) {
        const helper = helpersGroupRef.current.children.find(c => c.userData.ballId === selectedId);
        if (helper && tControlRef.current.object !== helper) {
          tControlRef.current.attach(helper);
        }
      } else {
        tControlRef.current.detach();
      }
    }
  }, [selectedId]);

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
