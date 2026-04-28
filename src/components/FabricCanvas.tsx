import React, { useState, useRef, useEffect, forwardRef } from 'react';
import { Waves, Plus, Trash2 } from 'lucide-react';
import { createNoise2D } from 'simplex-noise';
import * as THREE from 'three';

export interface FabricItem {
    id: string;
    type: 'bezier' | 'polyline';
    // bezier props
    start?: { x: number, z: number };
    cp1?: { x: number, z: number };
    cp2?: { x: number, z: number };
    end?: { x: number, z: number };
    // polyline props
    points?: { x: number, z: number }[];
    // old props
    z?: number;
    waviness?: number;
    noiseFreq?: number;
    noiseOffset?: number;
    // dashed lines config
    isDashed?: boolean;
    dashLength?: number;
    gapLength?: number;
}

export interface Attractor {
    id: string;
    x: number;
    z: number;
    type: 'core' | 'delta';
}

interface FabricCanvasProps {
    externalItems?: FabricItem[];
    onItemsChange?: (items: FabricItem[]) => void;
    baseGeometry?: THREE.BufferGeometry | null;
    secondaryGeometry?: THREE.BufferGeometry | null;
    radius?: number;
}

const noise2D = createNoise2D();

function extractGeometryEdgesXZ(geom: THREE.BufferGeometry): { x1: number; z1: number; x2: number; z2: number }[] {
    const pos = geom.getAttribute('position');
    const index = geom.getIndex();
    if (!pos) return [];

    const edgeSet = new Set<string>();
    const edges: { x1: number; z1: number; x2: number; z2: number }[] = [];

    const addEdge = (i0: number, i1: number) => {
        const a = Math.min(i0, i1);
        const b = Math.max(i0, i1);
        const key = `${a}-${b}`;
        if (edgeSet.has(key)) return;
        edgeSet.add(key);
        edges.push({
            x1: pos.getX(i0), z1: pos.getZ(i0),
            x2: pos.getX(i1), z2: pos.getZ(i1),
        });
    };

    const triCount = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        addEdge(i0, i1);
        addEdge(i1, i2);
        addEdge(i2, i0);
    }
    return edges;
}

function extractGeometryOutlineXZ(geom: THREE.BufferGeometry): { x: number; z: number }[][] {
    const pos = geom.getAttribute('position');
    const index = geom.getIndex();
    if (!pos) return [];

    const edgeCount = new Map<string, number>();
    const edgeVerts = new Map<string, [number, number]>();

    const makeKey = (a: number, b: number) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return `${lo}-${hi}`;
    };

    const triCount = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]]) {
            const key = makeKey(a, b);
            edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
            if (!edgeVerts.has(key)) edgeVerts.set(key, [a, b]);
        }
    }

    const boundaryEdges: [number, number][] = [];
    for (const [key, count] of edgeCount) {
        if (count === 1) {
            boundaryEdges.push(edgeVerts.get(key)!);
        }
    }

    if (boundaryEdges.length === 0) return [];

    const adj = new Map<number, number[]>();
    for (const [a, b] of boundaryEdges) {
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a)!.push(b);
        adj.get(b)!.push(a);
    }

    const visited = new Set<number>();
    const chains: { x: number; z: number }[][] = [];

    for (const startVert of adj.keys()) {
        if (visited.has(startVert)) continue;
        const chain: { x: number; z: number }[] = [];
        let current = startVert;
        while (current !== undefined && !visited.has(current)) {
            visited.add(current);
            chain.push({ x: pos.getX(current), z: pos.getZ(current) });
            const neighbors = adj.get(current) || [];
            current = neighbors.find(n => !visited.has(n))!;
        }
        if (chain.length > 2) chains.push(chain);
    }

    return chains;
}

const getBezierPoint = (t: number, p0: number, p1: number, p2: number, p3: number) => {
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;
    return uuu * p0 + 3 * uu * t * p1 + 3 * u * tt * p2 + ttt * p3;
};

const defaultFlowConfig = { 
    density: 0.15, 
    noiseFreq: 0.04, 
    angleAmp: 0.6, 
    seed: 123,
    rotation: 0,
    attractors: [] as Attractor[],
    isDashed: false,
    dashLength: 5,
    gapLength: 5
};

const generateFlowPolylines = (config: typeof defaultFlowConfig, bounds: number) => {
    const newItems: FabricItem[] = [];
    
    const dsep = bounds * config.density;
    const dtest = dsep * 0.6;
    const step = dsep * 0.2;
    
    const cellSize = dsep;
    const cols = Math.ceil((bounds * 2) / cellSize);
    const rows = Math.ceil((bounds * 2) / cellSize);
    const grid: { x: number, z: number, lineId: number, idx: number }[][][] = 
        Array(cols).fill(0).map(() => Array(rows).fill(0).map(() => []));
        
    const getAngle = (x: number, z: number) => {
        // Scale coordinates by bounds so the noise pattern is proportional to the geometry size
        const nx = (x / bounds) * 30;
        const nz = (z / bounds) * 30;
        const n = noise2D(nx * config.noiseFreq + config.seed, nz * config.noiseFreq + config.seed);
        let theta = n * Math.PI * config.angleAmp;
        
        theta += (config.rotation || 0) * Math.PI / 180;
        
        if (config.attractors && config.attractors.length > 0) {
            for (const a of config.attractors) {
                const angleToAttractor = Math.atan2(z - a.z, x - a.x);
                if (a.type === 'core') {
                    theta += 0.5 * angleToAttractor;
                } else if (a.type === 'delta') {
                    theta -= 0.5 * angleToAttractor;
                }
            }
        }
        
        return theta;
    };
    
    const toGrid = (x: number, z: number) => {
        const c = Math.floor((x + bounds) / cellSize);
        const r = Math.floor((z + bounds) / cellSize);
        return { c, r };
    };

    const isValid = (x: number, z: number, lineId: number, currentIdx: number) => {
        if (x < -bounds || x > bounds || z < -bounds || z > bounds) return false;
        
        const { c, r } = toGrid(x, z);
        if (c < 0 || c >= cols || r < 0 || r >= rows) return false;
        
        for (let i = Math.max(0, c - 1); i <= Math.min(cols - 1, c + 1); i++) {
            for (let j = Math.max(0, r - 1); j <= Math.min(rows - 1, r + 1); j++) {
                for (const pt of grid[i][j]) {
                    if (pt.lineId === lineId && Math.abs(pt.idx - currentIdx) < (dtest / step * 2.5)) continue;
                    const distSq = (pt.x - x) ** 2 + (pt.z - z) ** 2;
                    if (distSq < dtest * dtest) return false;
                }
            }
        }
        return true;
    };

    let lineCount = 0;
    
    const seeds: {x: number, z: number}[] = [];
    for (let x = -bounds + dsep; x < bounds; x += dsep) {
        for (let z = -bounds + dsep; z < bounds; z += dsep) {
            seeds.push({ x, z });
        }
    }
    seeds.sort((a, b) => (a.x**2 + a.z**2) - (b.x**2 + b.z**2));

    for (const seed of seeds) {
        if (!isValid(seed.x, seed.z, -1, -1)) continue;
        
        const lineId = lineCount++;
        const points: {x: number, z: number}[] = [{ x: seed.x, z: seed.z }];
        
        const { c, r } = toGrid(seed.x, seed.z);
        grid[c][r].push({ x: seed.x, z: seed.z, lineId, idx: 0 });
        
        let px = seed.x, pz = seed.z;
        let idx = 1;
        while (true) {
            const theta = getAngle(px, pz);
            px += Math.cos(theta) * step;
            pz += Math.sin(theta) * step;
            if (!isValid(px, pz, lineId, idx)) break;
            points.push({ x: px, z: pz });
            const g = toGrid(px, pz);
            grid[g.c][g.r].push({ x: px, z: pz, lineId, idx });
            idx++;
        }
        
        px = seed.x; pz = seed.z;
        idx = -1;
        while (true) {
            const theta = getAngle(px, pz) + Math.PI;
            px += Math.cos(theta) * step;
            pz += Math.sin(theta) * step;
            if (!isValid(px, pz, lineId, idx)) break;
            points.unshift({ x: px, z: pz });
            const g = toGrid(px, pz);
            grid[g.c][g.r].push({ x: px, z: pz, lineId, idx });
            idx--;
        }
        
        if (points.length > 10) {
            newItems.push({
                id: Math.random().toString(36).substr(2, 9),
                type: 'polyline',
                points,
                isDashed: config.isDashed,
                dashLength: config.dashLength,
                gapLength: config.gapLength
            });
        }
    }
    
    return newItems;
};

export const FabricCanvas = forwardRef((props: FabricCanvasProps, ref) => {
    const { externalItems, onItemsChange, baseGeometry, secondaryGeometry, radius = 20 } = props;
    
    const getBounds = () => {
        const geometries = [baseGeometry, secondaryGeometry].filter(Boolean) as THREE.BufferGeometry[];
        if (geometries.length > 0) {
            let maxExtent = 0;
            for (const geometry of geometries) {
                if (!geometry.boundingBox) geometry.computeBoundingBox();
                const bbox = geometry.boundingBox;
                if (!bbox) continue;
                maxExtent = Math.max(
                    maxExtent,
                    Math.abs(bbox.max.x), Math.abs(bbox.min.x),
                    Math.abs(bbox.max.z), Math.abs(bbox.min.z)
                );
            }
            if (maxExtent > 0) {
                return maxExtent * 1.2; // 20% margin
            }
        }
        return radius * 1.5;
    };

    const [flowConfig, setFlowConfig] = useState(defaultFlowConfig);

    const [internalItems, setInternalItems] = useState<FabricItem[]>(() => {
        const saved = localStorage.getItem('fabric_items_v2');
        if (saved) {
            try { 
                const parsed = JSON.parse(saved);
                if (parsed && parsed.length > 0) return parsed;
            } catch (e) {}
        }
        return generateFlowPolylines(defaultFlowConfig, getBounds());
    });

    const items = externalItems ?? internalItems;
    const setItems = (newItems: FabricItem[]) => {
        if (onItemsChange) onItemsChange(newItems);
        else setInternalItems(newItems);
    };

    useEffect(() => {
        localStorage.setItem('fabric_items_v2', JSON.stringify(items));
    }, [items]);

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedAttractorId, setSelectedAttractorId] = useState<string | null>(null);
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [hoveredPoint, setHoveredPoint] = useState<string | null>(null);
    const [hoveredAttractorId, setHoveredAttractorId] = useState<string | null>(null);
    const [view, setView] = useState(() => {
        const initialBounds = radius * 1.5; // fallback
        // Try to fit the bounds into the screen (assume ~800px height)
        const initialZoom = Math.min(50, Math.max(2, (window.innerHeight - 200) / (initialBounds * 2.5)));
        return { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: initialZoom };
    });

    // Adjust zoom once geometry is loaded to ensure it fits
    useEffect(() => {
        if (baseGeometry || secondaryGeometry) {
            const b = getBounds();
            const targetZoom = Math.min(50, Math.max(2, (window.innerHeight - 200) / (b * 2.5)));
            setView(v => ({ ...v, zoom: targetZoom }));
        }
    }, [baseGeometry, secondaryGeometry]);
    const [dragAction, setDragAction] = useState<any>(null);
    
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const geomCanvasRef = useRef<HTMLCanvasElement>(null);
    const [dimensions, setDimensions] = useState({ width: window.innerWidth, height: window.innerHeight });

    const selectedItem = items.find(it => it.id === selectedId);

    useEffect(() => {
        const handleResize = () => setDimensions({ width: window.innerWidth, height: window.innerHeight });
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const handlePointerMove = (e: React.PointerEvent) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const x = (mouseX - view.x) / view.zoom;
        const z = (mouseY - view.y) / view.zoom;

        if (dragAction) {
            if (dragAction.type === 'pan') {
                setView({
                    ...view,
                    x: dragAction.viewStartX + (e.clientX - dragAction.startX),
                    y: dragAction.viewStartY + (e.clientY - dragAction.startY),
                });
            } else if (dragAction.type === 'movePoint') {
                setItems(items.map(it => {
                    if (it.id !== dragAction.id) return it;
                    return {
                        ...it,
                        [dragAction.pointName]: { x, z }
                    };
                }));
            } else if (dragAction.type === 'moveCurve') {
                const dx = x - dragAction.startX;
                const dz = z - dragAction.startZ;
                setItems(items.map(it => {
                    if (it.id !== dragAction.id) return it;
                    if (it.type === 'polyline' && it.points) {
                        return {
                            ...it,
                            points: dragAction.orig.points.map((p: any) => ({ x: p.x + dx, z: p.z + dz }))
                        };
                    } else if (it.type === 'bezier' && it.start) {
                        return {
                            ...it,
                            start: { x: dragAction.orig.start.x + dx, z: dragAction.orig.start.z + dz },
                            cp1: { x: dragAction.orig.cp1.x + dx, z: dragAction.orig.cp1.z + dz },
                            cp2: { x: dragAction.orig.cp2.x + dx, z: dragAction.orig.cp2.z + dz },
                            end: { x: dragAction.orig.end.x + dx, z: dragAction.orig.end.z + dz },
                        };
                    }
                    return it;
                }));
            } else if (dragAction.type === 'moveAttractor') {
                const newConf = { 
                    ...flowConfig, 
                    attractors: flowConfig.attractors.map(a => a.id === dragAction.id ? { ...a, x, z } : a) 
                };
                setFlowConfig(newConf);
                regenerateFlow(newConf);
            }
            return;
        }

        // Hover logic
        const target = e.target as HTMLElement;
        if (target.closest('.control-panel')) {
            setHoveredId(null);
            setHoveredPoint(null);
            setHoveredAttractorId(null);
            return;
        }

        // Check attractors first
        const hoverAttr = flowConfig.attractors?.find(a => Math.hypot(a.x - x, a.z - z) < 15 / view.zoom);
        if (hoverAttr) {
            setHoveredAttractorId(hoverAttr.id);
            setHoveredPoint(null);
            setHoveredId(null);
            return;
        }
        setHoveredAttractorId(null);

        // Check points first if selected
        if (selectedItem) {
            const pt = getControlPointAtPos(x, z, selectedItem);
            if (pt) {
                setHoveredPoint(pt);
                setHoveredId(selectedItem.id);
                return;
            }
        }
        setHoveredPoint(null);

        // Check curves
        const hoveredItem = getCurveAtPos(x, z);
        setHoveredId(hoveredItem ? hoveredItem.id : null);
    };

    const handlePointerUp = () => {
        setDragAction(null);
    };

    const handlePointerLeave = () => {
        setHoveredId(null);
        setHoveredPoint(null);
        setHoveredAttractorId(null);
        setDragAction(null);
    };

    useEffect(() => {
        const div = containerRef.current;
        if (!div) return;
        const handleWheel = (e: WheelEvent) => {
            if ((e.target as HTMLElement).closest('.no-scrollbar')) return;
            e.preventDefault();
            const zoomDelta = e.deltaY * -0.001;
            const newZoom = Math.min(Math.max(2, view.zoom * (1 + zoomDelta)), 50);
            const rect = div.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const newX = mouseX - (mouseX - view.x) * (newZoom / view.zoom);
            const newY = mouseY - (mouseY - view.y) * (newZoom / view.zoom);
            setView({ x: newX, y: newY, zoom: newZoom });
        };
        div.addEventListener('wheel', handleWheel, { passive: false });
        return () => div.removeEventListener('wheel', handleWheel);
    }, [view]);

    // Draw geometry wireframe
    useEffect(() => {
        const canvas = geomCanvasRef.current;
        if (!canvas || (!baseGeometry && !secondaryGeometry)) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = dimensions.width;
        canvas.height = dimensions.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        ctx.save();
        ctx.translate(view.x, view.y);
        ctx.scale(view.zoom, view.zoom);

        const drawGeometry = (
            geometry: THREE.BufferGeometry | null | undefined,
            palette: { edge: string; outline: string; fill: string }
        ) => {
            if (!geometry) return;

            const edges = extractGeometryEdgesXZ(geometry);
            ctx.strokeStyle = palette.edge;
            ctx.lineWidth = 0.5 / view.zoom;
            ctx.beginPath();
            for (const e of edges) {
                ctx.moveTo(e.x1, e.z1);
                ctx.lineTo(e.x2, e.z2);
            }
            ctx.stroke();

            const chains = extractGeometryOutlineXZ(geometry);
            ctx.strokeStyle = palette.outline;
            ctx.lineWidth = 2 / view.zoom;
            for (const chain of chains) {
                ctx.beginPath();
                for (let i = 0; i < chain.length; i++) {
                    if (i === 0) ctx.moveTo(chain[i].x, chain[i].z);
                    else ctx.lineTo(chain[i].x, chain[i].z);
                }
                ctx.closePath();
                ctx.stroke();
            }

            ctx.fillStyle = palette.fill;
            for (const chain of chains) {
                ctx.beginPath();
                for (let i = 0; i < chain.length; i++) {
                    if (i === 0) ctx.moveTo(chain[i].x, chain[i].z);
                    else ctx.lineTo(chain[i].x, chain[i].z);
                }
                ctx.closePath();
                ctx.fill();
            }
        };

        drawGeometry(baseGeometry, {
            edge: 'rgba(0,0,0,0.04)',
            outline: 'rgba(0,0,0,0.25)',
            fill: 'rgba(180, 160, 130, 0.08)',
        });
        drawGeometry(secondaryGeometry, {
            edge: 'rgba(37, 99, 235, 0.10)',
            outline: 'rgba(37, 99, 235, 0.65)',
            fill: 'rgba(37, 99, 235, 0.12)',
        });

        ctx.restore();
    }, [baseGeometry, secondaryGeometry, view, dimensions]);

    // Draw fabric lines
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = dimensions.width;
        canvas.height = dimensions.height;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(view.x, view.y);
        ctx.scale(view.zoom, view.zoom);

        items.forEach(item => {
            const isSelected = item.id === selectedId;
            const isHovered = item.id === hoveredId;

            ctx.beginPath();
            
            if (item.type === 'polyline' && item.points && item.points.length > 0) {
                ctx.moveTo(item.points[0].x, item.points[0].z);
                for (let i = 1; i < item.points.length; i++) {
                    ctx.lineTo(item.points[i].x, item.points[i].z);
                }
            } else if (item.type === 'bezier' && item.start && item.cp1 && item.cp2 && item.end) {
                ctx.moveTo(item.start.x, item.start.z);
                ctx.bezierCurveTo(item.cp1.x, item.cp1.z, item.cp2.x, item.cp2.z, item.end.x, item.end.z);
            } else {
                return;
            }
            
            if (flowConfig.isDashed) {
                ctx.setLineDash([flowConfig.dashLength, flowConfig.gapLength]);
            } else {
                ctx.setLineDash([]);
            }

            if (isSelected) {
                ctx.strokeStyle = '#3b82f6';
                ctx.lineWidth = 3 / view.zoom;
            } else if (isHovered) {
                ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
                ctx.lineWidth = 2 / view.zoom;
            } else {
                ctx.strokeStyle = 'rgba(0,0,0,0.5)';
                ctx.lineWidth = 1.5 / view.zoom;
            }
            ctx.stroke();
            
            // Reset line dash for controls and helpers
            ctx.setLineDash([]);

            // Draw controls if selected and bezier
            if (isSelected && item.type === 'bezier' && item.start && item.cp1 && item.cp2 && item.end) {
                // Lines to control points
                ctx.beginPath();
                ctx.moveTo(item.start.x, item.start.z);
                ctx.lineTo(item.cp1.x, item.cp1.z);
                ctx.moveTo(item.end.x, item.end.z);
                ctx.lineTo(item.cp2.x, item.cp2.z);
                ctx.strokeStyle = 'rgba(59, 130, 246, 0.4)';
                ctx.lineWidth = 1 / view.zoom;
                ctx.stroke();

                // Draw points
                const drawPoint = (p: {x: number, z: number}, name: string) => {
                    ctx.beginPath();
                    ctx.arc(p.x, p.z, (hoveredPoint === name ? 6 : 4) / view.zoom, 0, Math.PI * 2);
                    ctx.fillStyle = name.startsWith('cp') ? '#fff' : '#3b82f6';
                    ctx.fill();
                    ctx.lineWidth = 1.5 / view.zoom;
                    ctx.strokeStyle = '#3b82f6';
                    ctx.stroke();
                };

                drawPoint(item.start, 'start');
                drawPoint(item.cp1, 'cp1');
                drawPoint(item.cp2, 'cp2');
                drawPoint(item.end, 'end');
            }
        });

        // Draw attractors
        if (flowConfig.attractors) {
            flowConfig.attractors.forEach(attr => {
                const isSel = attr.id === selectedAttractorId;
                const isHov = attr.id === hoveredAttractorId;
                
                ctx.beginPath();
                ctx.arc(attr.x, attr.z, (isHov || isSel ? 6 : 4) / view.zoom, 0, Math.PI * 2);
                ctx.fillStyle = attr.type === 'core' ? '#ef4444' : '#3b82f6';
                ctx.fill();
                
                if (isSel) {
                    ctx.lineWidth = 2 / view.zoom;
                    ctx.strokeStyle = '#fff';
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(attr.x, attr.z, 10 / view.zoom, 0, Math.PI * 2);
                    ctx.lineWidth = 2 / view.zoom;
                    ctx.strokeStyle = attr.type === 'core' ? '#ef4444' : '#3b82f6';
                    ctx.stroke();
                }
            });
        }

        ctx.restore();
    }, [items, view, selectedId, hoveredId, hoveredPoint, selectedAttractorId, hoveredAttractorId, flowConfig.attractors, dimensions]);

    const getControlPointAtPos = (x: number, z: number, item: FabricItem) => {
        if (item.type !== 'bezier') return null;
        const threshold = 10 / view.zoom;
        const points = ['start', 'cp1', 'cp2', 'end'] as const;
        for (const pt of points) {
            const p = item[pt];
            if (p && Math.hypot(p.x - x, p.z - z) < threshold) {
                return pt;
            }
        }
        return null;
    };

    const getCurveAtPos = (x: number, z: number) => {
        let closest: FabricItem | null = null;
        let minDist = 15 / view.zoom;
        
        for (const item of items) {
            if (item.type === 'polyline' && item.points) {
                for (let i = 0; i < item.points.length - 1; i++) {
                    const p1 = item.points[i];
                    const p2 = item.points[i+1];
                    const l2 = (p2.x - p1.x)**2 + (p2.z - p1.z)**2;
                    let t = l2 === 0 ? 0 : ((x - p1.x) * (p2.x - p1.x) + (z - p1.z) * (p2.z - p1.z)) / l2;
                    t = Math.max(0, Math.min(1, t));
                    const projX = p1.x + t * (p2.x - p1.x);
                    const projZ = p1.z + t * (p2.z - p1.z);
                    const dist = Math.hypot(projX - x, projZ - z);
                    if (dist < minDist) {
                        minDist = dist;
                        closest = item;
                    }
                }
            } else if (item.type === 'bezier' && item.start && item.cp1 && item.cp2 && item.end) {
                // Sample points along the bezier curve
                for (let i = 0; i <= 50; i++) {
                    const t = i / 50;
                    const bx = getBezierPoint(t, item.start.x, item.cp1.x, item.cp2.x, item.end.x);
                    const bz = getBezierPoint(t, item.start.z, item.cp1.z, item.cp2.z, item.end.z);
                    const dist = Math.hypot(bx - x, bz - z);
                    if (dist < minDist) {
                        minDist = dist;
                        closest = item;
                    }
                }
            }
        }
        return closest;
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('.control-panel')) return;

        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const x = (mouseX - view.x) / view.zoom;
        const z = (mouseY - view.y) / view.zoom;

        const clickedAttr = flowConfig.attractors?.find(a => Math.hypot(a.x - x, a.z - z) < 15 / view.zoom);
        if (clickedAttr) {
            setSelectedAttractorId(clickedAttr.id);
            setSelectedId(null);
            setDragAction({ type: 'moveAttractor', id: clickedAttr.id });
            return;
        }

        if (selectedItem) {
            const pt = getControlPointAtPos(x, z, selectedItem);
            if (pt) {
                setDragAction({ type: 'movePoint', id: selectedItem.id, pointName: pt });
                return;
            }
        }

        const clickedItem = getCurveAtPos(x, z);
        if (clickedItem) {
            if (clickedItem.type === 'polyline' && clickedItem.points) {
                const pts = clickedItem.points;
                const p0 = pts[0];
                const p3 = pts[pts.length - 1];
                
                let L = 0;
                for(let i=0; i<pts.length-1; i++) L += Math.hypot(pts[i+1].x - pts[i].x, pts[i+1].z - pts[i].z);
                
                const t0 = { x: pts[Math.min(5, pts.length-1)].x - p0.x, z: pts[Math.min(5, pts.length-1)].z - p0.z };
                const len0 = Math.hypot(t0.x, t0.z) || 1;
                t0.x /= len0; t0.z /= len0;

                const t3 = { x: p3.x - pts[Math.max(0, pts.length-6)].x, z: p3.z - pts[Math.max(0, pts.length-6)].z };
                const len3 = Math.hypot(t3.x, t3.z) || 1;
                t3.x /= len3; t3.z /= len3;

                const maxDist = Math.hypot(p3.x - p0.x, p3.z - p0.z) * 0.5;
                const cpDist = Math.min(L / 3, maxDist);

                const cp1 = { x: p0.x + t0.x * cpDist, z: p0.z + t0.z * cpDist };
                const cp2 = { x: p3.x - t3.x * cpDist, z: p3.z - t3.z * cpDist };

                const newBezier: FabricItem = {
                    id: clickedItem.id,
                    type: 'bezier',
                    start: p0,
                    cp1,
                    cp2,
                    end: p3
                };

                const newItems = items.map(it => it.id === clickedItem.id ? newBezier : it);
                setItems(newItems);
                setSelectedId(clickedItem.id);
                setDragAction({ 
                    type: 'moveCurve', 
                    id: clickedItem.id, 
                    startX: x, 
                    startZ: z,
                    orig: JSON.parse(JSON.stringify(newBezier))
                });
            } else {
                setSelectedId(clickedItem.id);
                setDragAction({ 
                    type: 'moveCurve', 
                    id: clickedItem.id, 
                    startX: x, 
                    startZ: z,
                    orig: JSON.parse(JSON.stringify(clickedItem))
                });
            }
        } else {
            setSelectedId(null);
            setSelectedAttractorId(null);
            setDragAction({ 
                type: 'pan', 
                startX: e.clientX, 
                startY: e.clientY, 
                viewStartX: view.x, 
                viewStartY: view.y 
            });
        }
    };

    const addNew = () => {
        const bounds = getBounds();
        const id = Math.random().toString(36).substr(2, 9);
        const yOffset = (Math.random() - 0.5) * bounds;
        
        // Add a simple straight line as a polyline
        const points = [];
        for (let i = 0; i <= 10; i++) {
            points.push({
                x: -bounds * 0.8 + (i / 10) * bounds * 1.6,
                z: yOffset
            });
        }

        setItems([...items, { 
            id, 
            type: 'polyline',
            points
        }]);
        setSelectedId(id);
    };

    const deleteSelected = () => {
        if (selectedId) {
            setItems(items.filter(it => it.id !== selectedId));
            setSelectedId(null);
        } else if (selectedAttractorId) {
            const newConf = {
                ...flowConfig,
                attractors: flowConfig.attractors.filter(a => a.id !== selectedAttractorId)
            };
            setFlowConfig(newConf);
            regenerateFlow(newConf);
            setSelectedAttractorId(null);
        }
    };

    const regenerateFlow = (config: typeof flowConfig) => {
        const bounds = getBounds();
        const newPolylines = generateFlowPolylines(config, bounds);
        const beziers = items.filter(it => it.type === 'bezier');
        setItems([...beziers, ...newPolylines]);
    };

    const handleGenerateFlow = () => {
        const newConf = { ...flowConfig, seed: Math.random() * 100 };
        setFlowConfig(newConf);
        regenerateFlow(newConf);
        setSelectedId(null);
        setSelectedAttractorId(null);
    };

    const addAttractor = (type: 'core' | 'delta') => {
        const id = Math.random().toString(36).substr(2, 9);
        const x = (-view.x + dimensions.width / 2) / view.zoom;
        const z = (-view.y + dimensions.height / 2) / view.zoom;
        
        const newConf = {
            ...flowConfig,
            attractors: [...(flowConfig.attractors || []), { id, x, z, type }]
        };
        setFlowConfig(newConf);
        regenerateFlow(newConf);
        setSelectedAttractorId(id);
        setSelectedId(null);
    };

    return (
        <div 
            className="relative w-full h-[calc(100vh-140px)] overflow-hidden bg-[#f5f5f5] border border-black/10 rounded-2xl shadow-xl flex"
            ref={containerRef}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
        >
            {/* Background pan area */}
            <div
                className="absolute inset-0 cursor-grab active:cursor-grabbing"
                onPointerDown={handlePointerDown}
                style={{
                    backgroundSize: `${50 * view.zoom}px ${50 * view.zoom}px`,
                    backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.05) 1px, transparent 1px)',
                    backgroundPosition: `${view.x}px ${view.y}px`
                }}
            />

            {/* Geometry wireframe layer */}
            <canvas
                ref={geomCanvasRef}
                width={dimensions.width}
                height={dimensions.height}
                className="absolute inset-0 pointer-events-none opacity-60 mix-blend-multiply z-0"
            />

            {/* Fabric lines layer */}
            <canvas
                ref={canvasRef}
                width={dimensions.width}
                height={dimensions.height}
                className="absolute inset-0 pointer-events-none z-10"
            />

            {/* Floating Control Panel */}
            <div className="control-panel absolute top-2 left-1/2 -translate-x-1/2 bg-[#1C1D21]/95 backdrop-blur-md border border-white/10 shadow-2xl rounded-2xl p-2.5 flex gap-2 items-start z-50 min-w-[300px] pointer-events-auto">
                <div className="flex flex-col gap-1.5 w-full">
                    <div className="flex gap-2">
                        <button onClick={deleteSelected} disabled={!selectedId && !selectedAttractorId} className="flex-1 flex justify-center items-center gap-1 bg-red-600/20 hover:bg-red-600/40 text-red-500 disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-wide font-bold transition-colors whitespace-nowrap">
                            <Trash2 className="w-3 h-3" /> Delete
                        </button>
                        <button onClick={addNew} className="flex-1 flex justify-center items-center gap-1 bg-blue-600/20 hover:bg-blue-600/40 text-blue-500 px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-wide font-bold transition-colors whitespace-nowrap">
                            <Plus className="w-3 h-3" /> Add Line
                        </button>
                        <button onClick={handleGenerateFlow} className="flex-1 flex justify-center items-center gap-1 bg-purple-600/20 hover:bg-purple-600/40 text-purple-500 px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-wide font-bold transition-colors whitespace-nowrap">
                            <Waves className="w-3 h-3" /> Generate Flow
                        </button>
                        
                        <div className="w-px h-6 bg-white/10 mx-1 self-center" />
                        
                        <button onClick={() => addAttractor('core')} className="flex-1 flex justify-center items-center gap-1 bg-red-600/20 hover:bg-red-600/40 text-red-500 px-2 py-1.5 rounded-lg text-[10px] uppercase tracking-wide font-bold transition-colors whitespace-nowrap" title="Add Core Attractor">
                            + Core
                        </button>
                        <button onClick={() => addAttractor('delta')} className="flex-1 flex justify-center items-center gap-1 bg-blue-600/20 hover:bg-blue-600/40 text-blue-500 px-2 py-1.5 rounded-lg text-[10px] uppercase tracking-wide font-bold transition-colors whitespace-nowrap" title="Add Delta Attractor">
                            + Delta
                        </button>
                    </div>

                    <div className="w-full h-px bg-white/10 my-1" />

                    {selectedItem ? (
                        <div className="text-[10px] text-gray-400 text-center py-1">
                            {selectedItem.type === 'bezier' 
                                ? "Drag the blue points to reshape the curve. Drag the curve itself to move it."
                                : "Drag the line to move it."}
                        </div>
                    ) : (
                        <div className="flex-1 flex gap-4">
                            <div className="flex-1 space-y-2.5">
                                <div className="space-y-0.5">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-400 font-medium">Density</span>
                                        <span className="font-mono text-gray-500">{flowConfig.density.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="0.01" max="1.5" step="0.01" value={flowConfig.density} onChange={e => {
                                        const newConf = { ...flowConfig, density: parseFloat(e.target.value) };
                                        setFlowConfig(newConf);
                                        regenerateFlow(newConf);
                                    }} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                                </div>
                                <div className="space-y-0.5">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-400 font-medium">Wiggliness</span>
                                        <span className="font-mono text-gray-500">{flowConfig.noiseFreq.toFixed(3)}</span>
                                    </div>
                                    <input type="range" min="0.01" max="0.1" step="0.005" value={flowConfig.noiseFreq} onChange={e => {
                                        const newConf = { ...flowConfig, noiseFreq: parseFloat(e.target.value) };
                                        setFlowConfig(newConf);
                                        regenerateFlow(newConf);
                                    }} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                                </div>
                                
                                <div className="space-y-2 pt-2 mt-2 border-t border-white/10">
                                    <label className="flex items-center gap-2 text-[9px] text-gray-400 font-medium cursor-pointer">
                                        <input type="checkbox" checked={flowConfig.isDashed} onChange={e => {
                                            const newConf = { ...flowConfig, isDashed: e.target.checked };
                                            setFlowConfig(newConf);
                                            setItems(items.map(it => ({ ...it, isDashed: newConf.isDashed, dashLength: newConf.dashLength, gapLength: newConf.gapLength })));
                                        }} className="accent-purple-500 rounded-sm" />
                                        Dashed Lines
                                    </label>
                                    
                                    {flowConfig.isDashed && (
                                        <div className="space-y-2 pl-4">
                                            <div className="space-y-0.5">
                                                <div className="flex justify-between text-[9px]">
                                                    <span className="text-gray-400 font-medium">Dash Length</span>
                                                    <span className="font-mono text-gray-500">{flowConfig.dashLength}</span>
                                                </div>
                                                <input type="range" min="0.1" max="50" step="0.1" value={flowConfig.dashLength} onChange={e => {
                                                    const newConf = { ...flowConfig, dashLength: parseFloat(e.target.value) };
                                                    setFlowConfig(newConf);
                                                    setItems(items.map(it => ({ ...it, dashLength: newConf.dashLength })));
                                                }} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                                            </div>
                                            <div className="space-y-0.5">
                                                <div className="flex justify-between text-[9px]">
                                                    <span className="text-gray-400 font-medium">Gap Length</span>
                                                    <span className="font-mono text-gray-500">{flowConfig.gapLength}</span>
                                                </div>
                                                <input type="range" min="0.1" max="50" step="0.1" value={flowConfig.gapLength} onChange={e => {
                                                    const newConf = { ...flowConfig, gapLength: parseFloat(e.target.value) };
                                                    setFlowConfig(newConf);
                                                    setItems(items.map(it => ({ ...it, gapLength: newConf.gapLength })));
                                                }} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="flex-1 space-y-2.5">
                                <div className="space-y-0.5">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-400 font-medium">Distortion</span>
                                        <span className="font-mono text-gray-500">{flowConfig.angleAmp.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="0.0" max="1.5" step="0.05" value={flowConfig.angleAmp} onChange={e => {
                                        const newConf = { ...flowConfig, angleAmp: parseFloat(e.target.value) };
                                        setFlowConfig(newConf);
                                        regenerateFlow(newConf);
                                    }} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                                </div>
                                <div className="space-y-0.5 pt-2">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-400 font-medium">Rotation</span>
                                        <span className="font-mono text-gray-500">{(flowConfig.rotation || 0).toFixed(0)}°</span>
                                    </div>
                                    <input type="range" min="-180" max="180" step="1" value={flowConfig.rotation || 0} onChange={e => {
                                        const newConf = { ...flowConfig, rotation: parseFloat(e.target.value) };
                                        setFlowConfig(newConf);
                                        regenerateFlow(newConf);
                                    }} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                                </div>
                                <div className="text-[9px] text-gray-500 leading-snug pt-1">
                                    Click a generated line to convert it to an editable Bezier curve.
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});
