import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { FingerprintGenerator, Point } from './FingerprintGenerator';
import { RotateCw, Plus, Trash2, Save, FolderOpen, RotateCcw } from 'lucide-react';
import { DEFAULT_PARAMS, DEFAULT_DOTS_PARAMS, PRESETS, FingerprintParams } from '../presets';
import { MergedFingerprintsCanvas, UV_SIZE, getComputedItems } from './MergedFingerprintsCanvas';
import type { CanvasItem, EdgeDistanceField } from './MergedFingerprintsCanvas';
export type { CanvasItem };

// CanvasItem type is now imported from MergedFingerprintsCanvas

type DragAction =
    | { type: 'pan', startX: number, startY: number, viewStartX: number, viewStartY: number }
    | { type: 'move', id: string, startX: number, startY: number, itemStartX: number, itemStartY: number }
    | { type: 'rotate', id: string, startAngle: number, itemStartRotation: number, centerX: number, centerY: number }
    | { type: 'scale', id: string, startDist: number, itemStartScale: number, centerX: number, centerY: number }
    | null;

const LOCAL_DEFAULT_DOTS_PARAMS: FingerprintParams = {
    ...DEFAULT_DOTS_PARAMS,
    dotSpacing: 0,
    dotSizeMin: 0,
    dotSizeMax: 0,
    lineDensity: 0,
    noiseScale: 0,
};

const STORAGE_KEY_CURRENT = 'whorl_current_pattern';
const STORAGE_KEY_SAVED = 'whorl_saved_patterns';

type SavedPattern = {
    id: string;
    name: string;
    items: CanvasItem[];
    globalSettings: any;
};

interface WhorlCanvasProps {
    externalItems?: CanvasItem[];
    onItemsChange?: (items: CanvasItem[]) => void;
    externalGlobalSettings?: any;
    onGlobalSettingsChange?: (settings: any) => void;
    baseGeometry?: any;
    edgeDistField?: EdgeDistanceField;
}

export const WhorlCanvas = forwardRef((props: WhorlCanvasProps, ref) => {
    const { externalItems, onItemsChange, externalGlobalSettings, onGlobalSettingsChange, edgeDistField = null } = props;
    const [internalItems, setInternalItems] = useState<CanvasItem[]>(() => {
        const saved = localStorage.getItem(STORAGE_KEY_CURRENT);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                return parsed.items;
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
    });
    const items = externalItems ?? internalItems;
    const setItems = onItemsChange ?? setInternalItems;
    const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id || null);
    const [view, setView] = useState(() => {
        const initialZoom = Math.min(window.innerWidth, window.innerHeight) / UV_SIZE * 0.8;
        return { 
            x: window.innerWidth / 2 - (UV_SIZE / 2) * initialZoom, 
            y: window.innerHeight / 2 - (UV_SIZE / 2) * initialZoom, 
            zoom: initialZoom 
        };
    });
    const [dragAction, setDragAction] = useState<DragAction>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const mergedCanvasRef = useRef<any>(null);
    const isOverPanel = useRef(false);

    const [internalGlobalSettings, setInternalGlobalSettings] = useState(() => {
        const saved = localStorage.getItem(STORAGE_KEY_CURRENT);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                return parsed.globalSettings;
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
    });
    const globalSettings = externalGlobalSettings ?? internalGlobalSettings;
    const setGlobalSettings = onGlobalSettingsChange ?? setInternalGlobalSettings;

    const [savedPatterns, setSavedPatterns] = useState<SavedPattern[]>(() => {
        const saved = localStorage.getItem(STORAGE_KEY_SAVED);
        return saved ? JSON.parse(saved) : [];
    });

    const [isSaving, setIsSaving] = useState(false);
    const [saveName, setSaveName] = useState('');

    // Persistence Effect
    useEffect(() => {
        localStorage.setItem(STORAGE_KEY_CURRENT, JSON.stringify({ items, globalSettings }));
    }, [items, globalSettings]);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY_SAVED, JSON.stringify(savedPatterns));
    }, [savedPatterns]);

    const selectedItem = items.find(it => it.id === selectedId);

    const saveCurrentPattern = () => {
        if (!saveName.trim()) return;
        const newPattern: SavedPattern = {
            id: Math.random().toString(36).substr(2, 9),
            name: saveName.trim(),
            items,
            globalSettings
        };
        setSavedPatterns([...savedPatterns, newPattern]);
        setSaveName('');
        setIsSaving(false);
    };

    const loadPattern = (pattern: SavedPattern) => {
        setItems(pattern.items);
        setGlobalSettings(pattern.globalSettings);
        setSelectedId(pattern.items[0]?.id || null);
    };

    const deletePattern = (id: string) => {
        setSavedPatterns(savedPatterns.filter(p => p.id !== id));
    };

    const resetToDefault = () => {
        if (!confirm('Reset all changes to base pattern?')) return;
        setItems([
            {
                id: 'initial',
                x: 1024,
                y: 1024,
                rotation: 0,
                scale: 1,
                params: { ...LOCAL_DEFAULT_DOTS_PARAMS, seed: Math.random() }
            }
        ]);
        setGlobalSettings({
            cullingOffset: 0.05,
            edgeCullRadius: 0,
            dotSpacing: 12.5,
            dotSizeMin: 2.4,
            dotSizeMax: 4.2,
            lineDensity: 14,
            noiseScale: 7,
            globalScale: 1.0,
        });
        setSelectedId('initial');
    };

    useImperativeHandle(ref, () => ({
        getCanvas: () => {
            return mergedCanvasRef.current?.getTextureCanvas?.() || null;
        },
        getDotCircles: () => {
            return mergedCanvasRef.current?.getTextureDotCircles?.() || [];
        }
    }));

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!dragAction) return;
        const gs = globalSettings.globalScale || 1.0;

        if (dragAction.type === 'pan') {
            setView({
                ...view,
                x: dragAction.viewStartX + (e.clientX - dragAction.startX),
                y: dragAction.viewStartY + (e.clientY - dragAction.startY),
            });
        } else if (dragAction.type === 'move') {
            setItems(items.map(it => {
                if (it.id !== dragAction.id) return it;
                return {
                    ...it,
                    x: dragAction.itemStartX + (e.clientX - dragAction.startX) / (view.zoom * gs),
                    y: dragAction.itemStartY + (e.clientY - dragAction.startY) / (view.zoom * gs),
                };
            }));
        } else if (dragAction.type === 'rotate') {
            const angle = Math.atan2(e.clientY - dragAction.centerY, e.clientX - dragAction.centerX);
            const delta = (angle - dragAction.startAngle) * (180 / Math.PI);
            setItems(items.map(it => {
                if (it.id !== dragAction.id) return it;
                return { ...it, rotation: dragAction.itemStartRotation + delta };
            }));
        } else if (dragAction.type === 'scale') {
            const dist = Math.hypot(e.clientX - dragAction.centerX, e.clientY - dragAction.centerY);
            const scaleFactor = dist / dragAction.startDist;
            setItems(items.map(it => {
                if (it.id !== dragAction.id) return it;
                return { ...it, scale: Math.max(0.1, dragAction.itemStartScale * scaleFactor) };
            }));
        }
    };

    const handlePointerUp = () => {
        setDragAction(null);
    };

    useEffect(() => {
        const div = containerRef.current;
        if (!div) return;

        const handleWheel = (e: WheelEvent) => {
            // Check if scrolling inside side panels
            if (isOverPanel.current || (e.target as HTMLElement).closest('.no-scrollbar')) return;

            e.preventDefault();
            const zoomDelta = e.deltaY * -0.001;
            const newZoom = Math.min(Math.max(0.1, view.zoom * (1 + zoomDelta)), 5);

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

    const uvCanvasRef = useRef<HTMLCanvasElement>(null);

    const [dimensions, setDimensions] = useState({ width: window.innerWidth, height: window.innerHeight });

    useEffect(() => {
        const handleResize = () => {
            setDimensions({ width: window.innerWidth, height: window.innerHeight });
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    useEffect(() => {
        const handleResize = () => {
            setDimensions({ width: window.innerWidth, height: window.innerHeight });
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Draw UV boundaries
    useEffect(() => {
        const canvas = uvCanvasRef.current;
        if (!canvas || !props.baseGeometry) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const uv = props.baseGeometry.getAttribute('uv');
        const index = props.baseGeometry.getIndex();
        if (!uv) return;

        ctx.save();
        ctx.translate(view.x, view.y);
        ctx.scale(view.zoom, view.zoom);

        // Draw the 2048x2048 bounding box
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
        ctx.lineWidth = 2 / view.zoom;
        ctx.strokeRect(0, 0, UV_SIZE, UV_SIZE);

        // Draw the UV triangles
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.05)';
        ctx.lineWidth = 1 / view.zoom;
        
        const triCount = index ? index.count / 3 : uv.count / 3;
        
        ctx.beginPath();
        for (let t = 0; t < triCount; t++) {
            const i0 = index ? index.getX(t * 3) : t * 3;
            const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
            const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

            const u0 = uv.getX(i0) * UV_SIZE;
            const v0 = (1 - uv.getY(i0)) * UV_SIZE;
            const u1 = uv.getX(i1) * UV_SIZE;
            const v1 = (1 - uv.getY(i1)) * UV_SIZE;
            const u2 = uv.getX(i2) * UV_SIZE;
            const v2 = (1 - uv.getY(i2)) * UV_SIZE;

            ctx.moveTo(u0, v0);
            ctx.lineTo(u1, v1);
            ctx.lineTo(u2, v2);
            ctx.lineTo(u0, v0);
        }
        ctx.stroke();
        ctx.restore();
    }, [props.baseGeometry, view, dimensions]);

    // Explicitly stop wheel propagation from side panels to prevent zooming
    useEffect(() => {
        const panels = containerRef.current?.querySelectorAll('.no-scrollbar');
        if (!panels) return;

        const stopProp = (e: WheelEvent) => {
            e.stopPropagation();
        };

        panels.forEach(p => p.addEventListener('wheel', stopProp, { passive: false }));
        return () => panels.forEach(p => p.removeEventListener('wheel', stopProp));
    }, [savedPatterns, items]);

    const handleParamChange = (name: keyof FingerprintParams, value: number | boolean) => {
        if (!selectedId) return;
        setItems(items.map(it => it.id === selectedId ? { ...it, params: { ...it.params, [name]: value } } : it));
    };

    const handlePointChange = (id: string, name: string, value: any) => {
        setItems(items.map(it => it.id === id ? { ...it, params: { ...it.params, [name]: value } } : it));
    };

    const handlePreset = (presetName: keyof typeof PRESETS) => {
        if (!selectedId) return;
        setItems(items.map(it => it.id === selectedId ? { ...it, params: { ...it.params, ...PRESETS[presetName] } } : it));
    };

    const addNew = () => {
        const id = Math.random().toString(36).substr(2, 9);
        const x = (-view.x + dimensions.width / 2) / view.zoom;
        const y = (-view.y + dimensions.height / 2) / view.zoom;
        setItems([...items, { id, x, y, rotation: 0, scale: 1, params: { ...LOCAL_DEFAULT_DOTS_PARAMS, seed: Math.random() } }]);
        setSelectedId(id);
    };

    const addNewRandom = () => {
        const id = Math.random().toString(36).substr(2, 9);
        const x = (-view.x + dimensions.width / 2) / view.zoom + (Math.random() - 0.5) * 100;
        const y = (-view.y + dimensions.height / 2) / view.zoom + (Math.random() - 0.5) * 100;

        const coreSpreadX = Math.random() > 0.7 ? 0.6 : 0.15;
        const coreSpreadY = Math.random() > 0.7 ? 0.5 : 0.15;

        const randomParams = {
            ...LOCAL_DEFAULT_DOTS_PARAMS,
            seed: Math.random(),
            spiral: (Math.random() - 0.5) * 0.4,
            core1: { x: (Math.random() - 0.5) * coreSpreadX, y: Math.random() * coreSpreadY },
            core2: { x: (Math.random() - 0.5) * coreSpreadX, y: Math.random() * -coreSpreadY },
            delta1: { x: -0.2 - Math.random() * 0.6, y: -0.3 - Math.random() * 0.6 },
            delta2: { x: 0.2 + Math.random() * 0.6, y: -0.3 - Math.random() * 0.6 },
            boundsX: 0.5 + Math.random() * 0.4,
            boundsY: 0.6 + Math.random() * 0.4,
            shapePower: 1.8 + Math.random() * 1.5,
        };

        const scale = 0.8 + Math.random() * 0.6;
        const rotation = (Math.random() - 0.5) * 90;

        setItems([...items, { id, x, y, rotation, scale, params: randomParams }]);
        setSelectedId(id);
    };

    const deleteSelected = () => {
        if (!selectedId) return;
        setItems(items.filter(it => it.id !== selectedId));
        setSelectedId(null);
    };

    const computedItems = getComputedItems(items, globalSettings);

    return (
        <div className="relative w-full h-[calc(100vh-140px)] overflow-hidden bg-[#f5f5f5] border border-black/10 rounded-2xl shadow-xl flex"
            ref={containerRef}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
        >
            {/* Background Pan Area */}
            <div
                className="absolute inset-0 cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => {
                    setSelectedId(null);
                    setDragAction({ type: 'pan', startX: e.clientX, startY: e.clientY, viewStartX: view.x, viewStartY: view.y });
                }}
                style={{
                    backgroundSize: `${50 * view.zoom}px ${50 * view.zoom}px`,
                    backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.05) 1px, transparent 1px)',
                    backgroundPosition: `${view.x}px ${view.y}px`
                }}
            />

            <MergedFingerprintsCanvas
                ref={mergedCanvasRef}
                items={computedItems}
                view={view}
                width={dimensions.width}
                height={dimensions.height}
                cullingOffset={globalSettings.cullingOffset}
                edgeCullRadius={globalSettings.edgeCullRadius ?? 0}
                edgeDistField={edgeDistField}
                globalSettings={globalSettings}
            />

            {/* UV Map Guide Layer */}
            <canvas
                ref={uvCanvasRef}
                width={dimensions.width}
                height={dimensions.height}
                className="absolute inset-0 pointer-events-none opacity-50 mix-blend-multiply z-0"
            />

            <div
                className="absolute top-0 left-0 origin-top-left pointer-events-none z-10"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
            >
                {computedItems.map(item => {
                    const isSelected = item.id === selectedId;
                    return (
                        <div
                            key={item.id}
                            className={`absolute w-[512px] h-[512px] pointer-events-none transition-shadow ${isSelected ? 'ring-4 ring-blue-500 rounded-2xl' : 'hover:ring-2 hover:ring-blue-400/50 rounded-2xl'
                                }`}
                            style={{
                                left: `${item.x}px`,
                                top: `${item.y}px`,
                                transform: `translate(-50%, -50%) rotate(${item.rotation}deg) scale(${item.scale})`,
                            }}
                        >
                            {/* Hitbox for selecting/moving */}
                            <div
                                className="absolute inset-0 rounded-2xl pointer-events-auto cursor-grab active:cursor-grabbing hover:bg-white/5"
                                onPointerDown={(e) => {
                                    e.stopPropagation();
                                    setSelectedId(item.id);
                                    const origItem = items.find(it => it.id === item.id) || item;
                                    setDragAction({ type: 'move', id: item.id, startX: e.clientX, startY: e.clientY, itemStartX: origItem.x, itemStartY: origItem.y });
                                }}
                            >
                                {isSelected && (item.params.showPoints || item.params.customPolygon) && (
                                    <FingerprintGenerator
                                        params={item.params}
                                        onPointChange={(name, pt) => handlePointChange(item.id, name, pt)}
                                        width={512}
                                        height={512}
                                        variant="dots"
                                        transparent={true}
                                    />
                                )}
                            </div>

                            {isSelected && (
                                <>
                                    <div
                                        className="absolute -top-12 left-1/2 -translate-x-1/2 w-8 h-8 bg-[#1C1D21] border border-white/10 shadow-lg rounded-full cursor-alias pointer-events-auto z-20 flex items-center justify-center text-blue-400 hover:text-blue-300 hover:scale-110 transition-transform"
                                        onPointerDown={(e) => {
                                            e.stopPropagation();
                                            const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                                            const cx = rect.left + rect.width / 2;
                                            const cy = rect.top + rect.height / 2;
                                            const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
                                            const origItem = items.find(it => it.id === item.id) || item;
                                            setDragAction({ type: 'rotate', id: item.id, startAngle, itemStartRotation: origItem.rotation, centerX: cx, centerY: cy });
                                        }}
                                    >
                                        <RotateCw className="w-4 h-4" />
                                    </div>

                                    {['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((pos) => (
                                        <div
                                            key={pos}
                                            className={`absolute w-5 h-5 bg-white border-[3px] border-blue-500 rounded-full pointer-events-auto z-20 shadow-md ${pos === 'top-left' ? '-top-2.5 -left-2.5 cursor-nwse-resize' :
                                                pos === 'top-right' ? '-top-2.5 -right-2.5 cursor-nesw-resize' :
                                                    pos === 'bottom-left' ? '-bottom-2.5 -left-2.5 cursor-nesw-resize' :
                                                        '-bottom-2.5 -right-2.5 cursor-nwse-resize'
                                                }`}
                                            onPointerDown={(e) => {
                                                e.stopPropagation();
                                                const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                                                const cx = rect.left + rect.width / 2;
                                                const cy = rect.top + rect.height / 2;
                                                const startDist = Math.hypot(e.clientX - cx, e.clientY - cy);
                                                const origItem = items.find(it => it.id === item.id) || item;
                                                setDragAction({ type: 'scale', id: item.id, startDist, itemStartScale: origItem.scale, centerX: cx, centerY: cy });
                                            }}
                                        />
                                    ))}
                                </>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Floating Control Panel */}
            <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-[#1C1D21]/95 backdrop-blur-md border border-white/10 shadow-2xl rounded-2xl p-2.5 flex gap-2 items-start z-50 min-w-[440px] pointer-events-auto">
                <div className="flex flex-col gap-1.5">
                    <button onClick={deleteSelected} disabled={!selectedId} className="flex items-center gap-1 bg-red-600/20 hover:bg-red-600/40 text-red-500 disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-wide font-bold transition-colors whitespace-nowrap">
                        <Trash2 className="w-3 h-3" />
                        Delete
                    </button>
                    {selectedItem && (
                        <button 
                            onClick={() => {
                                if (!selectedItem.params.customPolygon) {
                                    const boundsX = selectedItem.params.boundsX ?? 0.7;
                                    const boundsY = selectedItem.params.boundsY ?? 0.875;
                                    const cx = 256;
                                    const cy = 512 * 0.625;
                                    const rx = 256 * boundsX;
                                    const ry = 256 * boundsY;
                                    const poly = [];
                                    for (let i = 0; i < 8; i++) {
                                        const angle = (i / 8) * Math.PI * 2;
                                        poly.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
                                    }
                                    handleParamChange('customPolygon', poly);
                                    // Removed the forced showPoints=true so they can be toggled independently
                                } else {
                                    handleParamChange('customPolygon', undefined);
                                }
                            }}
                            className="flex items-center justify-center gap-1 bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-500 px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-wide font-bold transition-colors whitespace-nowrap"
                        >
                            {selectedItem.params.customPolygon ? 'Reset Shape' : 'Custom Shape'}
                        </button>
                    )}
                </div>

                <div className="w-px bg-white/10 self-stretch mx-1" />

                {selectedItem ? (
                    <div className="flex flex-col w-full">
                        <div className="flex gap-4 w-full">
                            {/* Column 1 */}
                            <div className="flex-1 space-y-2.5">
                                <div className="space-y-0.5">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-400 font-medium">Spacing Offset</span>
                                        <span className="font-mono text-gray-500">{(selectedItem.params.dotSpacing ?? 0) >= 0 ? '+' : ''}{(selectedItem.params.dotSpacing ?? 0).toFixed(1)}</span>
                                    </div>
                                    <input type="range" min="-10" max="10" step="0.5" value={selectedItem.params.dotSpacing ?? 0} onChange={e => handleParamChange('dotSpacing', parseFloat(e.target.value))} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                </div>
                                <div className="space-y-0.5">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-400 font-medium">Min Size Offset</span>
                                        <span className="font-mono text-gray-500">{(selectedItem.params.dotSizeMin ?? 0) >= 0 ? '+' : ''}{(selectedItem.params.dotSizeMin ?? 0).toFixed(1)}</span>
                                    </div>
                                    <input type="range" min="-2" max="2" step="0.1" value={selectedItem.params.dotSizeMin ?? 0} onChange={e => handleParamChange('dotSizeMin', parseFloat(e.target.value))} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                </div>
                                <div className="space-y-0.5">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-400 font-medium">Max Size Offset</span>
                                        <span className="font-mono text-gray-500">{(selectedItem.params.dotSizeMax ?? 0) >= 0 ? '+' : ''}{(selectedItem.params.dotSizeMax ?? 0).toFixed(1)}</span>
                                    </div>
                                    <input type="range" min="-5" max="5" step="0.1" value={selectedItem.params.dotSizeMax ?? 0} onChange={e => handleParamChange('dotSizeMax', parseFloat(e.target.value))} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                </div>
                            </div>

                            {/* Column 2 */}
                            <div className="flex-1 space-y-2.5">
                                <div className="space-y-0.5">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-400 font-medium">Density Offset</span>
                                        <span className="font-mono text-gray-500">{(selectedItem.params.lineDensity ?? 0) >= 0 ? '+' : ''}{(selectedItem.params.lineDensity ?? 0).toFixed(1)}</span>
                                    </div>
                                    <input type="range" min="-10" max="10" step="1" value={selectedItem.params.lineDensity ?? 0} onChange={e => handleParamChange('lineDensity', parseFloat(e.target.value))} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                </div>
                                <div className="space-y-0.5">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-400 font-medium">Noise Offset</span>
                                        <span className="font-mono text-gray-500">{(selectedItem.params.noiseScale ?? 0) >= 0 ? '+' : ''}{(selectedItem.params.noiseScale ?? 0).toFixed(1)}</span>
                                    </div>
                                    <input type="range" min="-10" max="10" step="1" value={selectedItem.params.noiseScale ?? 0} onChange={e => handleParamChange('noiseScale', parseFloat(e.target.value))} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                </div>
                                <div className="space-y-0.5">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-400 font-medium">Spiral Twist</span>
                                        <span className="font-mono text-gray-500">{selectedItem.params.spiral?.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="-1" max="1" step="0.01" value={selectedItem.params.spiral} onChange={e => handleParamChange('spiral', parseFloat(e.target.value))} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                </div>
                            </div>

                            {/* Column 3 - Info */}
                            <div className="flex-1 space-y-1.5 pt-1 border-l border-white/5 pl-4">
                                <div className="text-[9px] text-gray-500 leading-snug">
                                    <strong className="text-gray-400">Controls</strong><br />
                                    <span className="text-gray-400">Edges:</span> Drag to scale.<br />
                                    <span className="text-gray-400">Top:</span> Drag to rotate.<br />
                                    <span className="text-gray-400">Points:</span> Drag markers.
                                </div>
                            </div>
                        </div>

                        {/* Points Row */}
                        <div className="w-full mt-2 pt-2 border-t border-white/10 space-y-2">
                            <label className="flex items-center gap-1.5 text-[9px] font-medium text-gray-300 cursor-pointer uppercase tracking-wider">
                                <input type="checkbox" checked={selectedItem.params.showPoints} onChange={e => handleParamChange('showPoints', e.target.checked)} className="rounded border-gray-600 bg-gray-700 text-blue-500 scale-[0.6] m-0 -ml-1 focus:ring-blue-500 focus:ring-offset-gray-800" />
                                Show Singular Points
                            </label>

                            <div className="flex gap-4 w-full">
                                <div className="flex-1 space-y-0.5">
                                    <div className="flex justify-between text-[9px] font-medium tracking-wide">
                                        <span className="text-red-400">C1 X</span>
                                        <span className="font-mono text-gray-400">{selectedItem.params.core1.x.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="-1" max="1" step="0.01" value={selectedItem.params.core1.x} onChange={e => handlePointChange(selectedItem.id, 'core1', { ...selectedItem.params.core1, x: parseFloat(e.target.value) })} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-red-500" />
                                </div>
                                <div className="flex-1 space-y-0.5">
                                    <div className="flex justify-between text-[9px] font-medium tracking-wide">
                                        <span className="text-red-400">C1 Y</span>
                                        <span className="font-mono text-gray-400">{selectedItem.params.core1.y.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="-1" max="1" step="0.01" value={selectedItem.params.core1.y} onChange={e => handlePointChange(selectedItem.id, 'core1', { ...selectedItem.params.core1, y: parseFloat(e.target.value) })} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-red-500" />
                                </div>
                                <div className="flex-1 space-y-0.5">
                                    <div className="flex justify-between text-[9px] font-medium tracking-wide">
                                        <span className="text-blue-400">D1 X</span>
                                        <span className="font-mono text-gray-400">{selectedItem.params.delta1.x.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="-1" max="1" step="0.01" value={selectedItem.params.delta1.x} onChange={e => handlePointChange(selectedItem.id, 'delta1', { ...selectedItem.params.delta1, x: parseFloat(e.target.value) })} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                </div>
                                <div className="flex-1 space-y-0.5">
                                    <div className="flex justify-between text-[9px] font-medium tracking-wide">
                                        <span className="text-blue-400">D1 Y</span>
                                        <span className="font-mono text-gray-400">{selectedItem.params.delta1.y.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="-1" max="1" step="0.01" value={selectedItem.params.delta1.y} onChange={e => handlePointChange(selectedItem.id, 'delta1', { ...selectedItem.params.delta1, y: parseFloat(e.target.value) })} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                </div>
                            </div>
                            <div className="flex gap-4 w-full">
                                <div className="flex-1 space-y-0.5">
                                    <div className="flex justify-between text-[9px] font-medium tracking-wide">
                                        <span className="text-red-400">C2 X</span>
                                        <span className="font-mono text-gray-400">{selectedItem.params.core2.x.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="-1" max="1" step="0.01" value={selectedItem.params.core2.x} onChange={e => handlePointChange(selectedItem.id, 'core2', { ...selectedItem.params.core2, x: parseFloat(e.target.value) })} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-red-500" />
                                </div>
                                <div className="flex-1 space-y-0.5">
                                    <div className="flex justify-between text-[9px] font-medium tracking-wide">
                                        <span className="text-red-400">C2 Y</span>
                                        <span className="font-mono text-gray-400">{selectedItem.params.core2.y.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="-1" max="1" step="0.01" value={selectedItem.params.core2.y} onChange={e => handlePointChange(selectedItem.id, 'core2', { ...selectedItem.params.core2, y: parseFloat(e.target.value) })} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-red-500" />
                                </div>
                                <div className="flex-1 space-y-0.5">
                                    <div className="flex justify-between text-[9px] font-medium tracking-wide">
                                        <span className="text-blue-400">D2 X</span>
                                        <span className="font-mono text-gray-400">{selectedItem.params.delta2.x.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="-1" max="1" step="0.01" value={selectedItem.params.delta2.x} onChange={e => handlePointChange(selectedItem.id, 'delta2', { ...selectedItem.params.delta2, x: parseFloat(e.target.value) })} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                </div>
                                <div className="flex-1 space-y-0.5">
                                    <div className="flex justify-between text-[9px] font-medium tracking-wide">
                                        <span className="text-blue-400">D2 Y</span>
                                        <span className="font-mono text-gray-400">{selectedItem.params.delta2.y.toFixed(2)}</span>
                                    </div>
                                    <input type="range" min="-1" max="1" step="0.01" value={selectedItem.params.delta2.y} onChange={e => handlePointChange(selectedItem.id, 'delta2', { ...selectedItem.params.delta2, y: parseFloat(e.target.value) })} className="w-full h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-gray-500 text-sm py-4">
                        Select a fingerprint on the canvas to edit its parameters.
                    </div>
                )}
            </div>

            {/* Right Side Panels */}
            <div className="absolute top-4 right-4 flex flex-col gap-4 z-50 pointer-events-none w-[220px]">
                {/* Global Settings Panel */}
                <div 
                    onMouseEnter={() => { isOverPanel.current = true; }}
                    onMouseLeave={() => { isOverPanel.current = false; }}
                    onWheel={e => e.stopPropagation()}
                    className="bg-[#1C1D21]/95 backdrop-blur-md border border-white/10 shadow-2xl rounded-2xl p-3 flex flex-col gap-3 pointer-events-auto max-h-[50vh] overflow-y-auto no-scrollbar"
                >
                    <h3 className="text-white text-xs font-semibold opacity-90 pb-1.5 border-b border-white/10">Base Global Parameters</h3>

                    <div className="space-y-3">
                        <div className="space-y-1 mb-3 pb-3 border-b border-white/10">
                            <div className="flex justify-between text-[10px]">
                                <span className="text-blue-400 font-bold">Global Scale</span>
                                <span className="font-mono text-blue-400">{(globalSettings.globalScale || 1.0).toFixed(2)}x</span>
                            </div>
                            <input type="range" min="0.1" max="3" step="0.05" value={globalSettings.globalScale || 1.0} onChange={e => setGlobalSettings((s: any) => ({ ...s, globalScale: parseFloat(e.target.value) }))} className="w-full accent-blue-500" />
                        </div>

                        <div className="space-y-1">
                            <div className="flex justify-between text-[10px]">
                                <span className="text-gray-300">Dot Spacing</span>
                                <span className="font-mono text-gray-400">{globalSettings.dotSpacing.toFixed(1)}</span>
                            </div>
                            <input type="range" min="10" max="30" step="0.5" value={globalSettings.dotSpacing} onChange={e => setGlobalSettings(s => ({ ...s, dotSpacing: parseFloat(e.target.value) }))} className="w-full accent-purple-500" />
                        </div>

                        <div className="space-y-1">
                            <div className="flex justify-between text-[10px]">
                                <span className="text-gray-300">Min Dot Size</span>
                                <span className="font-mono text-gray-400">{globalSettings.dotSizeMin.toFixed(1)}</span>
                            </div>
                            <input type="range" min="0.5" max="4" step="0.1" value={globalSettings.dotSizeMin} onChange={e => setGlobalSettings(s => ({ ...s, dotSizeMin: parseFloat(e.target.value) }))} className="w-full accent-purple-500" />
                        </div>

                        <div className="space-y-1">
                            <div className="flex justify-between text-[10px]">
                                <span className="text-gray-300">Max Dot Size</span>
                                <span className="font-mono text-gray-400">{globalSettings.dotSizeMax.toFixed(1)}</span>
                            </div>
                            <input type="range" min="2" max="10" step="0.1" value={globalSettings.dotSizeMax} onChange={e => setGlobalSettings(s => ({ ...s, dotSizeMax: parseFloat(e.target.value) }))} className="w-full accent-purple-500" />
                        </div>

                        <div className="space-y-1">
                            <div className="flex justify-between text-[10px]">
                                <span className="text-gray-300">Line Density</span>
                                <span className="font-mono text-gray-400">{globalSettings.lineDensity.toFixed(1)}</span>
                            </div>
                            <input type="range" min="8" max="24" step="1" value={globalSettings.lineDensity} onChange={e => setGlobalSettings(s => ({ ...s, lineDensity: parseFloat(e.target.value) }))} className="w-full accent-purple-500" />
                        </div>

                        <div className="space-y-1">
                            <div className="flex justify-between text-[10px]">
                                <span className="text-gray-300">Noise Scale</span>
                                <span className="font-mono text-gray-400">{globalSettings.noiseScale.toFixed(1)}</span>
                            </div>
                            <input type="range" min="2" max="20" step="1" value={globalSettings.noiseScale} onChange={e => setGlobalSettings(s => ({ ...s, noiseScale: parseFloat(e.target.value) }))} className="w-full accent-purple-500" />
                        </div>

                        <div className="mt-3 pt-3 border-t border-white/10 space-y-1">
                            <div className="flex justify-between text-[10px]">
                                <span className="text-emerald-400">Culling Offset</span>
                                <span className="font-mono text-gray-400">{globalSettings.cullingOffset.toFixed(2)}</span>
                            </div>
                            <input
                                type="range"
                                min="-0.2"
                                max="0.5"
                                step="0.01"
                                value={globalSettings.cullingOffset}
                                onChange={e => setGlobalSettings(s => ({ ...s, cullingOffset: parseFloat(e.target.value) }))}
                                className="w-full accent-emerald-500"
                            />
                            <div className="text-[9px] text-gray-500 leading-tight mt-1">
                                Increases cut severity under prints.
                            </div>
                        </div>

                        <div className="mt-3 pt-3 border-t border-white/10 space-y-1">
                            <div className="flex justify-between text-[10px]">
                                <span className="text-amber-400">Edge Cull Radius</span>
                                <span className="font-mono text-gray-400">{(globalSettings.edgeCullRadius ?? 0).toFixed(0)}px</span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max="80"
                                step="1"
                                value={globalSettings.edgeCullRadius ?? 0}
                                onChange={e => setGlobalSettings((s: any) => ({ ...s, edgeCullRadius: parseFloat(e.target.value) }))}
                                className="w-full accent-amber-500"
                            />
                            <div className="text-[9px] text-gray-500 leading-tight mt-1">
                                Removes dots near geometry edges. 0 = only dots touching the edge line.
                            </div>
                        </div>

                        {/* Background Settings */}
                        <div className="mt-3 pt-3 border-t border-white/10 space-y-3">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    checked={!!globalSettings.enableVerticalBackground} 
                                    onChange={e => setGlobalSettings((s: any) => ({ ...s, enableVerticalBackground: e.target.checked }))}
                                    className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                                />
                                <span className="text-white text-xs font-semibold opacity-90">Vertical Background</span>
                            </label>

                            {globalSettings.enableVerticalBackground && (
                                <div className="space-y-3 pl-2 border-l-2 border-white/10">
                                    <div className="space-y-1">
                                        <div className="flex justify-between text-[10px]">
                                            <span className="text-gray-300">Rotation</span>
                                            <span className="font-mono text-gray-400">{(globalSettings.bgRotation ?? 0).toFixed(0)}°</span>
                                        </div>
                                        <input type="range" min="-180" max="180" step="1" value={globalSettings.bgRotation ?? 0} onChange={e => setGlobalSettings((s: any) => ({ ...s, bgRotation: parseFloat(e.target.value) }))} className="w-full accent-blue-500" />
                                    </div>
                                    <div className="space-y-1">
                                        <div className="flex justify-between text-[10px]">
                                            <span className="text-gray-300">Spacing</span>
                                            <span className="font-mono text-gray-400">{(globalSettings.bgSpacing ?? 16.0).toFixed(1)}</span>
                                        </div>
                                        <input type="range" min="5" max="50" step="0.5" value={globalSettings.bgSpacing ?? 16.0} onChange={e => setGlobalSettings((s: any) => ({ ...s, bgSpacing: parseFloat(e.target.value) }))} className="w-full accent-blue-500" />
                                    </div>
                                    <div className="space-y-1">
                                        <div className="flex justify-between text-[10px]">
                                            <span className="text-gray-300">Line Density</span>
                                            <span className="font-mono text-gray-400">{(globalSettings.bgLineDensity ?? 31.0).toFixed(1)}</span>
                                        </div>
                                        <input type="range" min="4" max="60" step="1" value={globalSettings.bgLineDensity ?? 31.0} onChange={e => setGlobalSettings((s: any) => ({ ...s, bgLineDensity: parseFloat(e.target.value) }))} className="w-full accent-blue-500" />
                                    </div>
                                    <div className="space-y-1">
                                        <div className="flex justify-between text-[10px]">
                                            <span className="text-gray-300">Min Dot Size</span>
                                            <span className="font-mono text-gray-400">{(globalSettings.bgDotSizeMin ?? 1.5).toFixed(1)}</span>
                                        </div>
                                        <input type="range" min="0.5" max="4" step="0.1" value={globalSettings.bgDotSizeMin ?? 1.5} onChange={e => setGlobalSettings((s: any) => ({ ...s, bgDotSizeMin: parseFloat(e.target.value) }))} className="w-full accent-blue-500" />
                                    </div>
                                    <div className="space-y-1">
                                        <div className="flex justify-between text-[10px]">
                                            <span className="text-gray-300">Max Dot Size</span>
                                            <span className="font-mono text-gray-400">{(globalSettings.bgDotSizeMax ?? 4.0).toFixed(1)}</span>
                                        </div>
                                        <input type="range" min="2" max="10" step="0.1" value={globalSettings.bgDotSizeMax ?? 4.0} onChange={e => setGlobalSettings((s: any) => ({ ...s, bgDotSizeMax: parseFloat(e.target.value) }))} className="w-full accent-blue-500" />
                                    </div>
                                    <div className="space-y-1">
                                        <div className="flex justify-between text-[10px]">
                                            <span className="text-gray-300">Noise Scale</span>
                                            <span className="font-mono text-gray-400">{(globalSettings.bgNoiseScale ?? 7.0).toFixed(1)}</span>
                                        </div>
                                        <input type="range" min="2" max="20" step="1" value={globalSettings.bgNoiseScale ?? 7.0} onChange={e => setGlobalSettings((s: any) => ({ ...s, bgNoiseScale: parseFloat(e.target.value) }))} className="w-full accent-blue-500" />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Pattern Management Panel */}
                <div 
                    onMouseEnter={() => { isOverPanel.current = true; }}
                    onMouseLeave={() => { isOverPanel.current = false; }}
                    onWheel={e => e.stopPropagation()}
                    className="bg-[#1C1D21]/95 backdrop-blur-md border border-white/10 shadow-2xl rounded-2xl p-3 flex flex-col gap-3 pointer-events-auto max-h-[40vh] overflow-y-auto no-scrollbar"
                >
                    <h4 className="text-[10px] text-gray-400 font-bold uppercase tracking-wider px-1">Pattern Management</h4>
                    
                    <div className="flex flex-col gap-2">
                        {isSaving ? (
                            <div className="flex flex-col gap-2 p-2 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                                <input 
                                    type="text" 
                                    placeholder="Pattern name..." 
                                    autoFocus
                                    value={saveName}
                                    onChange={e => setSaveName(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && saveCurrentPattern()}
                                    className="bg-black/40 border border-white/20 text-white text-[11px] px-2 py-1.5 rounded-lg focus:outline-none focus:border-blue-500/50"
                                />
                                <div className="flex gap-2">
                                    <button onClick={saveCurrentPattern} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-[10px] py-1.5 rounded-lg font-bold">Save</button>
                                    <button onClick={() => setIsSaving(false)} className="px-3 bg-white/10 hover:bg-white/20 text-white text-[10px] py-1.5 rounded-lg font-bold">Cancel</button>
                                </div>
                            </div>
                        ) : (
                            <button onClick={() => setIsSaving(true)} className="flex items-center justify-center gap-2 w-full bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all border border-blue-500/20">
                                <Save className="w-3.5 h-3.5" />
                                Save Pattern
                            </button>
                        )}
                        
                        <button onClick={resetToDefault} className="flex items-center justify-center gap-2 w-full bg-orange-600/10 hover:bg-orange-600/20 text-orange-400 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all border border-orange-500/20">
                            <RotateCcw className="w-3.5 h-3.5" />
                            Reset to Base
                        </button>
                    </div>

                    {savedPatterns.length > 0 && (
                        <div className="space-y-1.5 mt-2">
                            <div className="flex items-center gap-1.5 px-1 text-gray-500 text-[9px] font-semibold uppercase tracking-widest">
                                <FolderOpen className="w-3 h-3" />
                                Saved Patterns
                            </div>
                            <div className="grid grid-cols-1 gap-1.5">
                                {savedPatterns.map(p => (
                                    <div key={p.id} className="group relative flex items-center justify-between gap-2 p-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors border border-white/5">
                                        <button 
                                            onClick={() => loadPattern(p)}
                                            className="flex-1 text-left text-gray-300 text-[10px] font-medium truncate pr-6"
                                        >
                                            {p.name}
                                        </button>
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); deletePattern(p.id); }}
                                            className="absolute right-1 opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 text-gray-500 transition-all"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>


            {/* Global Controls */}
            <div className="absolute bottom-4 left-4 z-20 flex gap-2">
                <button
                    onClick={addNew}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl shadow-lg transition-colors font-medium"
                >
                    <Plus className="w-4 h-4" />
                    Add Print
                </button>
                <button
                    onClick={addNewRandom}
                    className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-xl shadow-lg transition-colors font-medium"
                >
                    <Plus className="w-4 h-4" />
                    Add Random
                </button>
                <button
                    onClick={() => {
                        if (mergedCanvasRef.current) {
                            mergedCanvasRef.current.downloadSVG();
                        }
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl shadow-lg transition-colors font-medium"
                >
                    Export SVG
                </button>
            </div>
        </div>
    );
});
