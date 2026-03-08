import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { FingerprintParams } from '../presets';
import { generateStreamlines, Point } from './FingerprintGenerator';

export type CanvasItem = {
    id: string;
    x: number;
    y: number;
    rotation: number;
    scale: number;
    params: FingerprintParams;
};

interface MergedFingerprintsCanvasProps {
    items: CanvasItem[];
    view: { x: number; y: number; zoom: number };
    width: number;
    height: number;
}

// Check if a point (x, y) in canvas coordinates falls inside the bounding ellipse of a fingerprint item
function isInsideFingerprint(px: number, py: number, item: CanvasItem, cullingOffset: number = 0) {
    // 1. Un-translate
    let dx = px - item.x;
    let dy = py - item.y;

    // 2. Un-scale
    dx /= item.scale;
    dy /= item.scale;

    // 3. Un-rotate
    const cos = Math.cos(-item.rotation * Math.PI / 180);
    const sin = Math.sin(-item.rotation * Math.PI / 180);
    const nx = dx * cos - dy * sin;
    const ny = dx * sin + dy * cos;

    // 4. Bounding ellipse/squircle check
    const boundsX = item.params.boundsX ?? 0.7;
    const boundsY = item.params.boundsY ?? 0.875;
    const shapePower = item.params.shapePower ?? 2.0;

    const rx = 256 * boundsX;
    const ry = 256 * boundsY;
    const cy = 64;

    const normX = nx / rx;
    const normY = (ny - cy) / ry;

    const threshold = Math.pow(1.0 + cullingOffset, shapePower);
    return (Math.pow(Math.abs(normX), shapePower) + Math.pow(Math.abs(normY), shapePower)) <= threshold;
}

export type DotCircle = { x: number; y: number; r: number };

// Compute a view that fits all items into the given canvas dimensions
function computeFitView(items: CanvasItem[], canvasWidth: number, canvasHeight: number): { x: number; y: number; zoom: number } {
    if (items.length === 0) return { x: 0, y: 0, zoom: 1 };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of items) {
        // Conservative bounding box: 256 * scale * sqrt(2) to account for rotation
        const halfSize = 256 * item.scale * 1.42;
        minX = Math.min(minX, item.x - halfSize);
        minY = Math.min(minY, item.y - halfSize);
        maxX = Math.max(maxX, item.x + halfSize);
        maxY = Math.max(maxY, item.y + halfSize);
    }

    const padding = 20;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const zoom = Math.min(canvasWidth / bboxW, canvasHeight / bboxH);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    return {
        x: canvasWidth / 2 - centerX * zoom,
        y: canvasHeight / 2 - centerY * zoom,
        zoom,
    };
}

// Standalone rendering function used by both the visible canvas and the texture export
function renderFingerprints(
    ctx: CanvasRenderingContext2D,
    items: CanvasItem[],
    view: { x: number; y: number; zoom: number },
    width: number,
    height: number,
    cullingOffset: number,
) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.zoom, view.zoom);

    for (let layerIndex = 0; layerIndex < items.length; layerIndex++) {
        const item = items[layerIndex];
        const lines = generateStreamlines(item.params, 512, 512);

        const lineThicknessMin = item.params.lineThicknessMin ?? 3;
        const lineThicknessMax = item.params.lineThicknessMax ?? 3;
        const noiseScale = item.params.noiseScale ?? 10;

        function getLineThickness(lx: number, ly: number) {
            if (lineThicknessMin === lineThicknessMax) return lineThicknessMin;
            const nx = (lx / 512) * 2 - 1;
            const ny = -((ly / 512) * 2 - 1);
            let v = 0;
            v += Math.sin(nx * noiseScale + item.params.seed + 10) * Math.cos(ny * noiseScale + item.params.seed + 10);
            v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed + 10) * Math.cos(ny * (noiseScale * 2) + item.params.seed + 10);
            v = (v + 1.5) / 3;
            return lineThicknessMin + v * (lineThicknessMax - lineThicknessMin);
        }

        const transformPoint = (lx: number, ly: number) => {
            let cx = lx - 256;
            let cy = ly - 256;
            const cos = Math.cos(item.rotation * Math.PI / 180);
            const sin = Math.sin(item.rotation * Math.PI / 180);
            let nx = cx * cos - cy * sin;
            let ny = cx * sin + cy * cos;
            nx = nx * item.scale + item.x;
            ny = ny * item.scale + item.y;
            return { x: nx, y: ny };
        };

        const isCulled = (gx: number, gy: number) => {
            for (let aboveIndex = layerIndex + 1; aboveIndex < items.length; aboveIndex++) {
                if (isInsideFingerprint(gx, gy, items[aboveIndex], cullingOffset)) {
                    return true;
                }
            }
            return false;
        };

        // 1. Draw Lines
        ctx.strokeStyle = '#b0b0b0';
        for (const line of lines) {
            for (let i = 1; i < line.length; i++) {
                const p1 = transformPoint(line[i - 1].x, line[i - 1].y);
                const p2 = transformPoint(line[i].x, line[i].y);

                if (!isCulled(p1.x, p1.y) && !isCulled(p2.x, p2.y)) {
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.lineWidth = getLineThickness(line[i].x, line[i].y) * item.scale;
                    ctx.stroke();
                }
            }
        }

        // 2. Draw Dots
        ctx.fillStyle = '#111111';

        const dotSpacing = item.params.dotSpacing ?? 18;
        const dotSizeMin = item.params.dotSizeMin ?? 1.5;
        const dotSizeMax = item.params.dotSizeMax ?? 6.0;

        function getSize(lx: number, ly: number) {
            const nx = (lx / 512) * 2 - 1;
            const ny = -((ly / 512) * 2 - 1);
            let v = 0;
            v += Math.sin(nx * noiseScale + item.params.seed) * Math.cos(ny * noiseScale + item.params.seed);
            v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed) * Math.cos(ny * (noiseScale * 2) + item.params.seed);
            v = (v + 1.5) / 3;
            return dotSizeMin + v * (dotSizeMax - dotSizeMin);
        }

        for (const line of lines) {
            let distSinceLastDot = dotSpacing / 2;
            for (let i = 1; i < line.length; i++) {
                const p1 = line[i - 1];
                const p2 = line[i];
                const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                distSinceLastDot += d;
                if (distSinceLastDot >= dotSpacing) {
                    distSinceLastDot -= dotSpacing;

                    const globalP2 = transformPoint(p2.x, p2.y);
                    if (!isCulled(globalP2.x, globalP2.y)) {
                        const radius = getSize(p2.x, p2.y) * item.scale;
                        ctx.beginPath();
                        ctx.arc(globalP2.x, globalP2.y, radius, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }
        }

        ctx.globalCompositeOperation = 'source-over';
    }

    ctx.restore();
}

function collectDotCircles(
    items: CanvasItem[],
    view: { x: number; y: number; zoom: number },
    cullingOffset: number,
): DotCircle[] {
    const circles: DotCircle[] = [];

    for (let layerIndex = 0; layerIndex < items.length; layerIndex++) {
        const item = items[layerIndex];
        const lines = generateStreamlines(item.params, 512, 512);
        const noiseScale = item.params.noiseScale ?? 10;

        const transformPoint = (lx: number, ly: number) => {
            let cx = lx - 256;
            let cy = ly - 256;
            const cos = Math.cos(item.rotation * Math.PI / 180);
            const sin = Math.sin(item.rotation * Math.PI / 180);
            let nx = cx * cos - cy * sin;
            let ny = cx * sin + cy * cos;
            nx = nx * item.scale + item.x;
            ny = ny * item.scale + item.y;
            return { x: nx, y: ny };
        };

        const isCulled = (gx: number, gy: number) => {
            for (let aboveIndex = layerIndex + 1; aboveIndex < items.length; aboveIndex++) {
                if (isInsideFingerprint(gx, gy, items[aboveIndex], cullingOffset)) {
                    return true;
                }
            }
            return false;
        };

        const dotSpacing = item.params.dotSpacing ?? 18;
        const dotSizeMin = item.params.dotSizeMin ?? 1.5;
        const dotSizeMax = item.params.dotSizeMax ?? 6.0;

        function getSize(lx: number, ly: number) {
            const nxl = (lx / 512) * 2 - 1;
            const nyl = -((ly / 512) * 2 - 1);
            let v = 0;
            v += Math.sin(nxl * noiseScale + item.params.seed) * Math.cos(nyl * noiseScale + item.params.seed);
            v += 0.5 * Math.sin(nxl * (noiseScale * 2) - item.params.seed) * Math.cos(nyl * (noiseScale * 2) + item.params.seed);
            v = (v + 1.5) / 3;
            return dotSizeMin + v * (dotSizeMax - dotSizeMin);
        }

        for (const line of lines) {
            let distSinceLastDot = dotSpacing / 2;
            for (let i = 1; i < line.length; i++) {
                const p1 = line[i - 1];
                const p2 = line[i];
                const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                distSinceLastDot += d;
                if (distSinceLastDot >= dotSpacing) {
                    distSinceLastDot -= dotSpacing;
                    const globalP2 = transformPoint(p2.x, p2.y);
                    if (!isCulled(globalP2.x, globalP2.y)) {
                        const baseRadius = getSize(p2.x, p2.y) * item.scale;
                        circles.push({
                            x: globalP2.x * view.zoom + view.x,
                            y: globalP2.y * view.zoom + view.y,
                            r: baseRadius * view.zoom,
                        });
                    }
                }
            }
        }
    }

    return circles;
}

export const MergedFingerprintsCanvas = forwardRef<HTMLCanvasElement, MergedFingerprintsCanvasProps & { cullingOffset?: number }>(
    function MergedFingerprintsCanvas({ items, view, width, height, cullingOffset = 0.05 }, ref) {

        const localRef = useRef<HTMLCanvasElement>(null);
        useImperativeHandle(ref, () => ({
            get canvas() { return localRef.current; },
            // Returns an offscreen canvas rendered with a computed "fit all" view,
            // independent of the editor's current pan/zoom.
            getTextureCanvas: () => {
                const texSize = Math.max(width, height, 2048);
                const offscreen = document.createElement('canvas');
                offscreen.width = texSize;
                offscreen.height = texSize;
                const ctx = offscreen.getContext('2d');
                if (!ctx) return offscreen;

                const fitView = computeFitView(items, texSize, texSize);
                renderFingerprints(ctx, items, fitView, texSize, texSize, cullingOffset);
                return offscreen;
            },
            // Returns dot circles using the same computed "fit all" view.
            getTextureDotCircles: () => {
                const texSize = Math.max(width, height, 2048);
                const fitView = computeFitView(items, texSize, texSize);
                return collectDotCircles(items, fitView, cullingOffset);
            },
            getDotCircles: () => collectDotCircles(items, view, cullingOffset),
            downloadSVG: () => {
                let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n`;
                svgContent += `  <rect width="100%" height="100%" fill="#f5f5f5" />\n`;

                for (let layerIndex = 0; layerIndex < items.length; layerIndex++) {
                    const item = items[layerIndex];
                    const lines = generateStreamlines(item.params, 512, 512);
                    const lineThicknessMin = item.params.lineThicknessMin ?? 3;
                    const lineThicknessMax = item.params.lineThicknessMax ?? 3;
                    const noiseScale = item.params.noiseScale ?? 10;

                    function getLineThickness(lx: number, ly: number) {
                        if (lineThicknessMin === lineThicknessMax) return lineThicknessMin;
                        const nx = (lx / 512) * 2 - 1;
                        const ny = -((ly / 512) * 2 - 1);
                        let v = 0;
                        v += Math.sin(nx * noiseScale + item.params.seed + 10) * Math.cos(ny * noiseScale + item.params.seed + 10);
                        v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed + 10) * Math.cos(ny * (noiseScale * 2) + item.params.seed + 10);
                        v = (v + 1.5) / 3;
                        return lineThicknessMin + v * (lineThicknessMax - lineThicknessMin);
                    }

                    const transformPoint = (lx: number, ly: number) => {
                        let cx = lx - 256;
                        let cy = ly - 256;
                        const cos = Math.cos(item.rotation * Math.PI / 180);
                        const sin = Math.sin(item.rotation * Math.PI / 180);
                        let nx = cx * cos - cy * sin;
                        let ny = cx * sin + cy * cos;
                        nx = nx * item.scale + item.x;
                        ny = ny * item.scale + item.y;
                        return { x: nx, y: ny };
                    };

                    const isCulled = (gx: number, gy: number) => {
                        for (let aboveIndex = layerIndex + 1; aboveIndex < items.length; aboveIndex++) {
                            if (isInsideFingerprint((gx - view.x) / view.zoom, (gy - view.y) / view.zoom, items[aboveIndex], cullingOffset)) {
                                return true;
                            }
                        }
                        return false;
                    };

                    const dotSpacing = item.params.dotSpacing ?? 18;
                    const dotSizeMin = item.params.dotSizeMin ?? 1.5;
                    const dotSizeMax = item.params.dotSizeMax ?? 6.0;

                    function getSize(lx: number, ly: number) {
                        const nx = (lx / 512) * 2 - 1;
                        const ny = -((ly / 512) * 2 - 1);
                        let v = 0;
                        v += Math.sin(nx * noiseScale + item.params.seed) * Math.cos(ny * noiseScale + item.params.seed);
                        v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed) * Math.cos(ny * (noiseScale * 2) + item.params.seed);
                        v = (v + 1.5) / 3;
                        return dotSizeMin + v * (dotSizeMax - dotSizeMin);
                    }

                    // 1. Draw Lines
                    for (const line of lines) {
                        for (let i = 1; i < line.length; i++) {
                            const p1 = transformPoint(line[i - 1].x, line[i - 1].y);
                            const p2 = transformPoint(line[i].x, line[i].y);

                            // Adjust for view
                            const v1x = p1.x * view.zoom + view.x;
                            const v1y = p1.y * view.zoom + view.y;
                            const v2x = p2.x * view.zoom + view.x;
                            const v2y = p2.y * view.zoom + view.y;

                            if (!isCulled(v1x, v1y) && !isCulled(v2x, v2y)) {
                                const baseThickness = getLineThickness(line[i].x, line[i].y) * item.scale;
                                const thickness = baseThickness * view.zoom;
                                svgContent += `  <line x1="${v1x.toFixed(2)}" y1="${v1y.toFixed(2)}" x2="${v2x.toFixed(2)}" y2="${v2y.toFixed(2)}" stroke="#b0b0b0" stroke-width="${thickness.toFixed(2)}" stroke-linecap="round" />\n`;
                            }
                        }
                    }

                    // 2. Draw Dots
                    for (const line of lines) {
                        let distSinceLastDot = dotSpacing / 2;
                        for (let i = 1; i < line.length; i++) {
                            const p1 = line[i - 1];
                            const p2 = line[i];
                            const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                            distSinceLastDot += d;
                            if (distSinceLastDot >= dotSpacing) {
                                distSinceLastDot -= dotSpacing;

                                const globalP2 = transformPoint(p2.x, p2.y);
                                const v2x = globalP2.x * view.zoom + view.x;
                                const v2y = globalP2.y * view.zoom + view.y;

                                if (!isCulled(v2x, v2y)) {
                                    const baseRadius = getSize(p2.x, p2.y) * item.scale;
                                    const radius = baseRadius * view.zoom;
                                    svgContent += `  <circle cx="${v2x.toFixed(2)}" cy="${v2y.toFixed(2)}" r="${radius.toFixed(2)}" fill="#111111" />\n`;
                                }
                            }
                        }
                    }
                }

                svgContent += `</svg>`;
                const blob = new Blob([svgContent], { type: 'image/svg+xml' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.download = 'composite-whorls.svg';
                link.href = url;
                link.click();
                URL.revokeObjectURL(url);
            }
        }));

        useEffect(() => {
            const canvas = localRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            renderFingerprints(ctx, items, view, width, height, cullingOffset);
        }, [items, view, width, height]);

        return <canvas ref={localRef} width={width} height={height} className="absolute inset-0 pointer-events-none" />;
    }
);
