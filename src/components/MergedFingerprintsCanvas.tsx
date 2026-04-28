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
    surfaceAnchor?: {
        position: [number, number, number];
        normal: [number, number, number];
        faceIndex?: number;
    };
};

export type StreamlinePoint = { x: number; y: number; thickness: number };
export type Streamline = StreamlinePoint[];

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

    const px_512 = nx + 256;
    const py_512 = ny + 256;

    if (item.params.customPolygon && item.params.customPolygon.length >= 3) {
        let inside = false;
        const poly = item.params.customPolygon;
        
        let cx = 0, cy = 0;
        for (const p of poly) { cx += p.x; cy += p.y; }
        cx /= poly.length; cy /= poly.length;

        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = cx + (poly[i].x - cx) * (1.0 + cullingOffset);
            const yi = cy + (poly[i].y - cy) * (1.0 + cullingOffset);
            const xj = cx + (poly[j].x - cx) * (1.0 + cullingOffset);
            const yj = cy + (poly[j].y - cy) * (1.0 + cullingOffset);
            const intersect = ((yi > py_512) !== (yj > py_512))
                && (px_512 < (xj - xi) * (py_512 - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    // 4. Bounding ellipse/squircle check
    const boundsX = item.params.boundsX ?? 0.7;
    const boundsY = item.params.boundsY ?? 0.875;
    const shapePower = item.params.shapePower ?? 2.0;

    const rx = 256 * boundsX;
    const ry = 256 * boundsY;
    const cy_ellipse = 64; // Offset for the ellipse center

    const normX = nx / rx;
    const normY = (ny - cy_ellipse) / ry;

    // To prevent dots from bleeding slightly outside the bounds due to their radius,
    // we slightly tighten the threshold when checking if a point is inside.
    const edgeBleedMargin = 0.05; 
    const threshold = Math.pow(1.0 + cullingOffset - edgeBleedMargin, shapePower);
    return (Math.pow(Math.abs(normX), shapePower) + Math.pow(Math.abs(normY), shapePower)) <= threshold;
}

export const UV_SIZE = 2048;

export type DotCircle = { x: number; y: number; r: number };
type VisibleDotPoint = { x: number; y: number; gx: number; gy: number };

export type EdgeDistanceField = {
    field: Float32Array;
    islandIds: Int32Array;
    islandCount: number;
    gridWidth: number;
    gridHeight: number;
    canvasWidth: number;
    canvasHeight: number;
} | null;

export function getRenderCanvasDimensions(globalSettings: any = null) {
    const stretchX = Math.max(0.2, globalSettings?.canvasStretchX ?? 1);
    const stretchY = Math.max(0.2, globalSettings?.canvasStretchY ?? 1);
    return {
        width: Math.max(1, Math.round(UV_SIZE * stretchX)),
        height: Math.max(1, Math.round(UV_SIZE * stretchY)),
    };
}

function getBackgroundRenderMetrics(globalSettings: any = null) {
    const { width, height } = getRenderCanvasDimensions(globalSettings);
    return {
        renderWidth: width,
        renderHeight: height,
        centerX: width / 2,
        centerY: height / 2,
        radius: Math.hypot(width, height) * 0.55,
    };
}

/**
 * Rasterizes the geometry's UV triangles as a filled mask,
 * then computes a distance field: for each inside pixel, how far (in UV_SIZE units)
 * it is from the nearest outside pixel (= nearest geometry edge).
 * Outside pixels get Infinity (won't trigger culling).
 */
export function createGeometryEdgeDistField(
    geometry: any,
    gridSize: number = 256,
    canvasWidth: number = UV_SIZE,
    canvasHeight: number = UV_SIZE,
): EdgeDistanceField {
    const uv = geometry.getAttribute('uv');
    const index = geometry.getIndex();
    if (!uv) return null;

    const baseScale = gridSize / UV_SIZE;
    const gridWidth = Math.max(8, Math.round(canvasWidth * baseScale));
    const gridHeight = Math.max(8, Math.round(canvasHeight * baseScale));

    const canvas = document.createElement('canvas');
    canvas.width = gridWidth;
    canvas.height = gridHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, gridWidth, gridHeight);

    ctx.fillStyle = 'white';
    const triCount = index ? index.count / 3 : uv.count / 3;
    for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

        const u0 = uv.getX(i0) * gridWidth;
        const v0 = (1 - uv.getY(i0)) * gridHeight;
        const u1 = uv.getX(i1) * gridWidth;
        const v1 = (1 - uv.getY(i1)) * gridHeight;
        const u2 = uv.getX(i2) * gridWidth;
        const v2 = (1 - uv.getY(i2)) * gridHeight;

        ctx.beginPath();
        ctx.moveTo(u0, v0);
        ctx.lineTo(u1, v1);
        ctx.lineTo(u2, v2);
        ctx.closePath();
        ctx.fill();
    }

    const imageData = ctx.getImageData(0, 0, gridWidth, gridHeight);
    const pixels = imageData.data;
    const mask = new Uint8Array(gridWidth * gridHeight);
    for (let i = 0; i < gridWidth * gridHeight; i++) {
        mask[i] = pixels[i * 4] > 128 ? 1 : 0;
    }

    const INF = Math.max(gridWidth, gridHeight) * 2;
    const N = gridWidth * gridHeight;

    function distTransform(src: Float32Array) {
        for (let y = 0; y < gridHeight; y++) {
            for (let x = 0; x < gridWidth; x++) {
                const idx = y * gridWidth + x;
                if (y > 0) src[idx] = Math.min(src[idx], src[(y - 1) * gridWidth + x] + 1);
                if (x > 0) src[idx] = Math.min(src[idx], src[y * gridWidth + x - 1] + 1);
                if (y > 0 && x > 0) src[idx] = Math.min(src[idx], src[(y - 1) * gridWidth + x - 1] + 1.414);
                if (y > 0 && x < gridWidth - 1) src[idx] = Math.min(src[idx], src[(y - 1) * gridWidth + x + 1] + 1.414);
            }
        }
        for (let y = gridHeight - 1; y >= 0; y--) {
            for (let x = gridWidth - 1; x >= 0; x--) {
                const idx = y * gridWidth + x;
                if (y < gridHeight - 1) src[idx] = Math.min(src[idx], src[(y + 1) * gridWidth + x] + 1);
                if (x < gridWidth - 1) src[idx] = Math.min(src[idx], src[y * gridWidth + x + 1] + 1);
                if (y < gridHeight - 1 && x < gridWidth - 1) src[idx] = Math.min(src[idx], src[(y + 1) * gridWidth + x + 1] + 1.414);
                if (y < gridHeight - 1 && x > 0) src[idx] = Math.min(src[idx], src[(y + 1) * gridWidth + x - 1] + 1.414);
            }
        }
    }

    const distIn = new Float32Array(N);
    const distOut = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const x = i % gridWidth;
        const y = (i - x) / gridWidth;
        const onBorder = x === 0 || x === gridWidth - 1 || y === 0 || y === gridHeight - 1;
        distIn[i] = (mask[i] === 0 || onBorder) ? 0 : INF;
        distOut[i] = (mask[i] === 1 && !onBorder) ? 0 : INF;
    }
    distTransform(distIn);
    distTransform(distOut);

    const scale = canvasWidth / gridWidth;
    const dist = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        dist[i] = (mask[i] === 1 ? distIn[i] : distOut[i]) * scale;
    }

    const islandIds = new Int32Array(N);
    let islandCount = 0;
    const stack: number[] = [];
    for (let i = 0; i < N; i++) {
        if (mask[i] !== 1 || islandIds[i] !== 0) continue;
        islandCount++;
        islandIds[i] = islandCount;
        stack.push(i);

        while (stack.length > 0) {
            const idx = stack.pop()!;
            const x = idx % gridWidth;
            const y = (idx - x) / gridWidth;
            const neighbors = [
                x > 0 ? idx - 1 : -1,
                x < gridWidth - 1 ? idx + 1 : -1,
                y > 0 ? idx - gridWidth : -1,
                y < gridHeight - 1 ? idx + gridWidth : -1,
            ];

            for (const next of neighbors) {
                if (next < 0 || mask[next] !== 1 || islandIds[next] !== 0) continue;
                islandIds[next] = islandCount;
                stack.push(next);
            }
        }
    }

    return { field: dist, islandIds, islandCount, gridWidth, gridHeight, canvasWidth, canvasHeight };
}

function sampleEdgeDistance(distField: EdgeDistanceField, worldX: number, worldY: number): number {
    if (!distField) return Infinity;
    const { field, gridWidth, gridHeight, canvasWidth, canvasHeight } = distField;
    if (worldX < 0 || worldX > canvasWidth || worldY < 0 || worldY > canvasHeight) return Infinity;
    const px = Math.min(gridWidth - 1, Math.floor((worldX / canvasWidth) * gridWidth));
    const py = Math.min(gridHeight - 1, Math.floor((worldY / canvasHeight) * gridHeight));
    return field[py * gridWidth + px];
}

function sampleIslandId(distField: EdgeDistanceField, worldX: number, worldY: number): number {
    if (!distField) return 0;
    const { islandIds, gridWidth, gridHeight, canvasWidth, canvasHeight } = distField;
    if (!islandIds || worldX < 0 || worldX > canvasWidth || worldY < 0 || worldY > canvasHeight) return 0;
    const px = Math.min(gridWidth - 1, Math.floor((worldX / canvasWidth) * gridWidth));
    const py = Math.min(gridHeight - 1, Math.floor((worldY / canvasHeight) * gridHeight));
    return islandIds[py * gridWidth + px] || 0;
}

function findNearestIslandId(distField: EdgeDistanceField, worldX: number, worldY: number, searchRadius: number): number {
    if (!distField) return 0;
    const direct = sampleIslandId(distField, worldX, worldY);
    if (direct) return direct;

    const { gridWidth, gridHeight, canvasWidth, canvasHeight, islandIds } = distField;
    if (!islandIds) return 0;
    const cx = Math.min(gridWidth - 1, Math.max(0, Math.floor((worldX / canvasWidth) * gridWidth)));
    const cy = Math.min(gridHeight - 1, Math.max(0, Math.floor((worldY / canvasHeight) * gridHeight)));
    const radiusPx = Math.max(1, Math.ceil((searchRadius / Math.max(canvasWidth, canvasHeight)) * Math.max(gridWidth, gridHeight)));

    for (let r = 1; r <= radiusPx; r++) {
        for (let y = Math.max(0, cy - r); y <= Math.min(gridHeight - 1, cy + r); y++) {
            for (let x = Math.max(0, cx - r); x <= Math.min(gridWidth - 1, cx + r); x++) {
                if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
                const id = islandIds[y * gridWidth + x];
                if (id) return id;
            }
        }
    }

    return 0;
}

function isOutsideTargetIsland(distField: EdgeDistanceField, targetIslandId: number, worldX: number, worldY: number): boolean {
    if (!distField || !targetIslandId) return false;
    return sampleIslandId(distField, worldX, worldY) !== targetIslandId;
}

function isNearGeometryEdge(distField: EdgeDistanceField, worldX: number, worldY: number, dotRadius: number, edgeCullRadius: number): boolean {
    if (!distField) return false;
    const dist = sampleEdgeDistance(distField, worldX, worldY);
    return dist < dotRadius + edgeCullRadius;
}

function collectVisibleDotSegments(
    line: Point[],
    transformPoint: (lx: number, ly: number) => { x: number; y: number },
    isCulled: (gx: number, gy: number, customOffset?: number) => boolean,
    getLineThickness: (lx: number, ly: number) => number,
    itemScale: number,
    edgeDistField: EdgeDistanceField,
    edgeCullRadius: number,
): VisibleDotPoint[][] {
    const segments: VisibleDotPoint[][] = [];
    let currentSegment: VisibleDotPoint[] = [];

    for (let i = 0; i < line.length; i++) {
        const p = line[i];
        const globalP = transformPoint(p.x, p.y);
        const lw = getLineThickness(p.x, p.y) * itemScale;
        const halfLw = lw / 2;
        const culled =
            isCulled(globalP.x, globalP.y) ||
            isNearGeometryEdge(edgeDistField, globalP.x, globalP.y, halfLw, edgeCullRadius);

        if (!culled) {
            currentSegment.push({ x: p.x, y: p.y, gx: globalP.x, gy: globalP.y });
        } else {
            if (currentSegment.length > 1) {
                segments.push(currentSegment);
            }
            currentSegment = [];
        }
    }

    if (currentSegment.length > 1) {
        segments.push(currentSegment);
    }

    return segments;
}

function forEachDotPlacement(
    segment: VisibleDotPoint[],
    spacing: number,
    callback: (dot: { x: number; y: number; gx: number; gy: number; distAlong: number; segmentLength: number }) => void,
) {
    if (segment.length < 2 || spacing <= 1e-8) return;

    const segmentLength = segment.reduce((sum, point, index) => {
        if (index === 0) return 0;
        const prev = segment[index - 1];
        return sum + Math.hypot(point.x - prev.x, point.y - prev.y);
    }, 0);

    let distUntilNextDot = spacing / 2;
    let distAtSegmentStart = 0;

    for (let i = 1; i < segment.length; i++) {
        const p1 = segment[i - 1];
        const p2 = segment[i];
        const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (d <= 1e-8) continue;

        while (distUntilNextDot <= d + 1e-8) {
            const t = Math.max(0, Math.min(1, distUntilNextDot / d));
            callback({
                x: p1.x + (p2.x - p1.x) * t,
                y: p1.y + (p2.y - p1.y) * t,
                gx: p1.gx + (p2.gx - p1.gx) * t,
                gy: p1.gy + (p2.gy - p1.gy) * t,
                distAlong: distAtSegmentStart + distUntilNextDot,
                segmentLength,
            });
            distUntilNextDot += spacing;
        }

        distAtSegmentStart += d;
        distUntilNextDot -= d;
    }
}

function isNearVisibleSegmentEndpoint(
    segment: VisibleDotPoint[],
    dotGX: number,
    dotGY: number,
    forbiddenRadius: number,
): boolean {
    if (segment.length < 2) return false;
    const start = segment[0];
    const end = segment[segment.length - 1];
    const startDx = dotGX - start.gx;
    const startDy = dotGY - start.gy;
    const endDx = dotGX - end.gx;
    const endDy = dotGY - end.gy;
    const r2 = forbiddenRadius * forbiddenRadius;
    return (startDx * startDx + startDy * startDy) <= r2 || (endDx * endDx + endDy * endDy) <= r2;
}

// Compute a view that fits all items into the given canvas dimensions
export function computeFitView(items: CanvasItem[], canvasWidth: number, canvasHeight: number): { x: number; y: number; zoom: number } {
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
export function renderFingerprints(
    ctx: CanvasRenderingContext2D,
    items: CanvasItem[],
    view: { x: number; y: number; zoom: number },
    width: number,
    height: number,
    cullingOffset: number,
    edgeCullRadius: number = 0,
    edgeDistField: EdgeDistanceField = null,
    globalSettings: any = null,
) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.zoom, view.zoom);

    const isCulledByAny = (gx: number, gy: number, customOffset: number = cullingOffset, startLayer: number = 0) => {
        for (let aboveIndex = startLayer; aboveIndex < items.length; aboveIndex++) {
            if (isInsideFingerprint(gx, gy, items[aboveIndex], customOffset)) {
                return true;
            }
        }
        return false;
    };

    // --- Render Background ---
    if (globalSettings?.enableVerticalBackground) {
        const gs = globalSettings.globalScale || 1.0;
        const bgRotation = globalSettings.bgRotation ?? 0;
        const bgSpacing = (globalSettings.bgSpacing ?? 16.0) * gs;
        const bgDotSizeMin = (globalSettings.bgDotSizeMin ?? 1.5) * gs;
        const bgDotSizeMax = (globalSettings.bgDotSizeMax ?? 4.0) * gs;
        const bgLineDensity = (globalSettings.bgLineDensity ?? 31.0) / gs;
        const bgNoiseScale = (globalSettings.bgNoiseScale ?? 7.0) / gs;
        const bgLineThickness = (globalSettings.bgLineThickness ?? 3) * gs;
        const {
            renderWidth,
            renderHeight,
            centerX: cx,
            centerY: cy,
            radius,
        } = getBackgroundRenderMetrics(globalSettings);
        const lineSpacing = 512 / bgLineDensity;

        const cos = Math.cos(bgRotation * Math.PI / 180);
        const sin = Math.sin(bgRotation * Math.PI / 180);

        const transformBgPoint = (lx: number, ly: number) => {
            const nx = lx * cos - ly * sin;
            const ny = lx * sin + ly * cos;
            return { x: cx + nx, y: cy + ny };
        };

        function getBgSize(gx: number, gy: number) {
            const nx = (gx / renderWidth) * 2 - 1;
            const ny = -((gy / renderHeight) * 2 - 1);
            let v = 0;
            v += Math.sin(nx * bgNoiseScale) * Math.cos(ny * bgNoiseScale);
            v += 0.5 * Math.sin(nx * (bgNoiseScale * 2)) * Math.cos(ny * (bgNoiseScale * 2));
            v = (v + 1.5) / 3;
            return bgDotSizeMin + v * (bgDotSizeMax - bgDotSizeMin);
        }

        function getBgLineThickness(gx: number, gy: number) {
            return bgLineThickness; // Can add noise if needed
        }

        // Generate lines
        const bgLines: {x: number, y: number}[][] = [];
        for (let x = -radius; x <= radius; x += lineSpacing) {
            const line: {x: number, y: number}[] = [];
            for (let y = -radius; y <= radius; y += 10) { // Small step to allow culling checks
                line.push({x, y});
            }
            bgLines.push(line);
        }

        // Draw Background Lines
        ctx.strokeStyle = '#b0b0b0';
        for (const line of bgLines) {
            for (let i = 1; i < line.length; i++) {
                const p1 = transformBgPoint(line[i - 1].x, line[i - 1].y);
                const p2 = transformBgPoint(line[i].x, line[i].y);

                // Cull against ALL fingerprints (startLayer = 0) and UV bounds
                if (p1.x >= 0 && p1.x <= renderWidth && p1.y >= 0 && p1.y <= renderHeight &&
                    p2.x >= 0 && p2.x <= renderWidth && p2.y >= 0 && p2.y <= renderHeight &&
                    !isCulledByAny(p1.x, p1.y, cullingOffset, 0) && !isCulledByAny(p2.x, p2.y, cullingOffset, 0)) {
                    
                    const lw = getBgLineThickness(p1.x, p1.y);
                    const halfLw = lw / 2;
                    if (isNearGeometryEdge(edgeDistField, p1.x, p1.y, halfLw, edgeCullRadius) ||
                        isNearGeometryEdge(edgeDistField, p2.x, p2.y, halfLw, edgeCullRadius)) continue;
                    
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.lineWidth = lw;
                    ctx.stroke();
                }
            }
        }

        // Draw Background Dots
        ctx.fillStyle = '#111111';
        for (const line of bgLines) {
            if (line.length === 0) continue;
            const lineX = line[0].x;
            const randomOffset = (Math.abs(Math.sin(lineX * 12.9898 + 78.233)) * 43758.5453) % bgSpacing;
            let distSinceLastDot = randomOffset;
            for (let i = 1; i < line.length; i++) {
                const p1 = line[i - 1];
                const p2 = line[i];
                const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                distSinceLastDot += d;
                if (distSinceLastDot >= bgSpacing) {
                    distSinceLastDot -= bgSpacing;

                    const globalP2 = transformBgPoint(p2.x, p2.y);
                    
                    if (globalP2.x >= 0 && globalP2.x <= renderWidth && globalP2.y >= 0 && globalP2.y <= renderHeight) {
                        const radius = getBgSize(globalP2.x, globalP2.y);
                        const bleedMargin = radius / 256;
                        if (!isCulledByAny(globalP2.x, globalP2.y, cullingOffset - bleedMargin, 0) &&
                            !isNearGeometryEdge(edgeDistField, globalP2.x, globalP2.y, radius, edgeCullRadius)) {
                            ctx.beginPath();
                            ctx.arc(globalP2.x, globalP2.y, radius, 0, Math.PI * 2);
                            ctx.fill();
                        }
                    }
                }
            }
        }
    }
    // --- End Background ---

    for (let layerIndex = 0; layerIndex < items.length; layerIndex++) {
        const item = items[layerIndex];
        const lines = generateStreamlines(item.params, 512, 512, item.scale);

        const lineThicknessMin = item.params.lineThicknessMin ?? 3;
        const lineThicknessMax = item.params.lineThicknessMax ?? 3;
        const noiseScale = item.params.noiseScale ?? 10;

        function getLineThickness(lx: number, ly: number) {
            const scaledMin = lineThicknessMin / item.scale;
            const scaledMax = lineThicknessMax / item.scale;
            if (scaledMin === scaledMax) return scaledMin;
            const nx = (lx / 512) * 2 - 1;
            const ny = -((ly / 512) * 2 - 1);
            let v = 0;
            v += Math.sin(nx * noiseScale + item.params.seed + 10) * Math.cos(ny * noiseScale + item.params.seed + 10);
            v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed + 10) * Math.cos(ny * (noiseScale * 2) + item.params.seed + 10);
            v = (v + 1.5) / 3;
            return scaledMin + v * (scaledMax - scaledMin);
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

        const isCulled = (gx: number, gy: number, customOffset: number = cullingOffset) => {
            for (let aboveIndex = layerIndex + 1; aboveIndex < items.length; aboveIndex++) {
                if (isInsideFingerprint(gx, gy, items[aboveIndex], customOffset)) {
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
                    const lw = getLineThickness(line[i].x, line[i].y) * item.scale;
                    const halfLw = lw / 2;
                    if (isNearGeometryEdge(edgeDistField, p1.x, p1.y, halfLw, edgeCullRadius) ||
                        isNearGeometryEdge(edgeDistField, p2.x, p2.y, halfLw, edgeCullRadius)) continue;
                    ctx.beginPath();
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.lineWidth = lw;
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
            const scaledMin = dotSizeMin / item.scale;
            const scaledMax = dotSizeMax / item.scale;
            const nx = (lx / 512) * 2 - 1;
            const ny = -((ly / 512) * 2 - 1);
            let v = 0;
            v += Math.sin(nx * noiseScale + item.params.seed) * Math.cos(ny * noiseScale + item.params.seed);
            v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed) * Math.cos(ny * (noiseScale * 2) + item.params.seed);
            v = (v + 1.5) / 3;
            return scaledMin + v * (scaledMax - scaledMin);
        }

        const scaledDotSpacing = dotSpacing / item.scale;

        for (const line of lines) {
            const visibleSegments = collectVisibleDotSegments(
                line,
                transformPoint,
                isCulled,
                getLineThickness,
                item.scale,
                edgeDistField,
                edgeCullRadius
            );

            for (const segment of visibleSegments) {
                forEachDotPlacement(segment, scaledDotSpacing, ({ x: dotX, y: dotY, gx: dotGX, gy: dotGY }) => {
                    const baseRadius = getSize(dotX, dotY) * item.scale;
                    const lineRadius = (getLineThickness(dotX, dotY) * item.scale) / 2;
                    const endpointRadius = lineRadius + baseRadius * 0.1;
                    if (isNearVisibleSegmentEndpoint(segment, dotGX, dotGY, endpointRadius)) {
                        return;
                    }

                    const bleedMargin = baseRadius / 256;
                    if (!isCulled(dotGX, dotGY, cullingOffset - bleedMargin) &&
                        !isNearGeometryEdge(edgeDistField, dotGX, dotGY, baseRadius, edgeCullRadius)) {
                        ctx.beginPath();
                        ctx.arc(dotGX, dotGY, baseRadius, 0, Math.PI * 2);
                        ctx.fill();
                    }
                });
            }
        }

        ctx.globalCompositeOperation = 'source-over';
    }

    ctx.restore();
}

export function collectDotCircles(
    items: CanvasItem[],
    view: { x: number; y: number; zoom: number },
    cullingOffset: number,
    edgeCullRadius: number = 0,
    edgeDistField: EdgeDistanceField = null,
    globalSettings: any = null,
): DotCircle[] {
    const circles: DotCircle[] = [];

    const isCulledByAny = (gx: number, gy: number, customOffset: number = cullingOffset, startLayer: number = 0) => {
        for (let aboveIndex = startLayer; aboveIndex < items.length; aboveIndex++) {
            if (isInsideFingerprint(gx, gy, items[aboveIndex], customOffset)) {
                return true;
            }
        }
        return false;
    };

    if (globalSettings?.enableVerticalBackground) {
        const gs = globalSettings.globalScale || 1.0;
        const bgRotation = globalSettings.bgRotation ?? 0;
        const bgSpacing = (globalSettings.bgSpacing ?? 16.0) * gs;
        const bgDotSizeMin = (globalSettings.bgDotSizeMin ?? 1.5) * gs;
        const bgDotSizeMax = (globalSettings.bgDotSizeMax ?? 4.0) * gs;
        const bgLineDensity = (globalSettings.bgLineDensity ?? 31.0) / gs;
        const bgNoiseScale = (globalSettings.bgNoiseScale ?? 7.0) / gs;
        const {
            renderWidth,
            renderHeight,
            centerX: cx,
            centerY: cy,
            radius,
        } = getBackgroundRenderMetrics(globalSettings);
        const lineSpacing = 512 / bgLineDensity;

        const cos = Math.cos(bgRotation * Math.PI / 180);
        const sin = Math.sin(bgRotation * Math.PI / 180);

        const transformBgPoint = (lx: number, ly: number) => {
            const nx = lx * cos - ly * sin;
            const ny = lx * sin + ly * cos;
            return { x: cx + nx, y: cy + ny };
        };

        function getBgSize(gx: number, gy: number) {
            const nx = (gx / renderWidth) * 2 - 1;
            const ny = -((gy / renderHeight) * 2 - 1);
            let v = 0;
            v += Math.sin(nx * bgNoiseScale) * Math.cos(ny * bgNoiseScale);
            v += 0.5 * Math.sin(nx * (bgNoiseScale * 2)) * Math.cos(ny * (bgNoiseScale * 2));
            v = (v + 1.5) / 3;
            return bgDotSizeMin + v * (bgDotSizeMax - bgDotSizeMin);
        }

        const bgLines: {x: number, y: number}[][] = [];
        for (let x = -radius; x <= radius; x += lineSpacing) {
            const line: {x: number, y: number}[] = [];
            for (let y = -radius; y <= radius; y += 10) {
                line.push({x, y});
            }
            bgLines.push(line);
        }

        for (const line of bgLines) {
            if (line.length === 0) continue;
            const lineX = line[0].x;
            const randomOffset = (Math.abs(Math.sin(lineX * 12.9898 + 78.233)) * 43758.5453) % bgSpacing;
            let distSinceLastDot = randomOffset;
            for (let i = 1; i < line.length; i++) {
                const p1 = line[i - 1];
                const p2 = line[i];
                const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                distSinceLastDot += d;
                if (distSinceLastDot >= bgSpacing) {
                    distSinceLastDot -= bgSpacing;

                    const globalP2 = transformBgPoint(p2.x, p2.y);
                    
                    if (globalP2.x >= 0 && globalP2.x <= renderWidth && globalP2.y >= 0 && globalP2.y <= renderHeight) {
                        const baseRadius = getBgSize(globalP2.x, globalP2.y);
                        const bleedMargin = baseRadius / 256;
                        if (!isCulledByAny(globalP2.x, globalP2.y, cullingOffset - bleedMargin, 0) &&
                            !isNearGeometryEdge(edgeDistField, globalP2.x, globalP2.y, baseRadius, edgeCullRadius)) {
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
    }

    for (let layerIndex = 0; layerIndex < items.length; layerIndex++) {
        const item = items[layerIndex];
        const lines = generateStreamlines(item.params, 512, 512, item.scale);
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

        const isCulled = (gx: number, gy: number, customOffset: number = cullingOffset) => {
            for (let aboveIndex = layerIndex + 1; aboveIndex < items.length; aboveIndex++) {
                if (isInsideFingerprint(gx, gy, items[aboveIndex], customOffset)) {
                    return true;
                }
            }
            return false;
        };

        const dotSpacing = item.params.dotSpacing ?? 18;
        const dotSizeMin = item.params.dotSizeMin ?? 1.5;
        const dotSizeMax = item.params.dotSizeMax ?? 6.0;
        const lineThicknessMin = item.params.lineThicknessMin ?? 3;
        const lineThicknessMax = item.params.lineThicknessMax ?? 3;

        function getSize(lx: number, ly: number) {
            const scaledMin = dotSizeMin / item.scale;
            const scaledMax = dotSizeMax / item.scale;
            const nxl = (lx / 512) * 2 - 1;
            const nyl = -((ly / 512) * 2 - 1);
            let v = 0;
            v += Math.sin(nxl * noiseScale + item.params.seed) * Math.cos(nyl * noiseScale + item.params.seed);
            v += 0.5 * Math.sin(nxl * (noiseScale * 2) - item.params.seed) * Math.cos(nyl * (noiseScale * 2) + item.params.seed);
            v = (v + 1.5) / 3;
            return scaledMin + v * (scaledMax - scaledMin);
        }

        function getLineThickness(lx: number, ly: number) {
            const scaledMin = lineThicknessMin / item.scale;
            const scaledMax = lineThicknessMax / item.scale;
            if (scaledMin === scaledMax) return scaledMin;
            const nxl = (lx / 512) * 2 - 1;
            const nyl = -((ly / 512) * 2 - 1);
            let v = 0;
            v += Math.sin(nxl * noiseScale + item.params.seed + 10) * Math.cos(nyl * noiseScale + item.params.seed + 10);
            v += 0.5 * Math.sin(nxl * (noiseScale * 2) - item.params.seed + 10) * Math.cos(nyl * (noiseScale * 2) + item.params.seed + 10);
            v = (v + 1.5) / 3;
            return scaledMin + v * (scaledMax - scaledMin);
        }

        const scaledDotSpacing = dotSpacing / item.scale;

        for (const line of lines) {
            const visibleSegments = collectVisibleDotSegments(
                line,
                transformPoint,
                isCulled,
                getLineThickness,
                item.scale,
                edgeDistField,
                edgeCullRadius
            );

            for (const segment of visibleSegments) {
                forEachDotPlacement(segment, scaledDotSpacing, ({ x: dotX, y: dotY, gx: dotGX, gy: dotGY }) => {
                    const baseRadius = getSize(dotX, dotY) * item.scale;
                    const lineRadius = (getLineThickness(dotX, dotY) * item.scale) / 2;
                    const endpointRadius = lineRadius + baseRadius * 0.1;
                    if (isNearVisibleSegmentEndpoint(segment, dotGX, dotGY, endpointRadius)) {
                        return;
                    }

                    const bleedMargin = baseRadius / 256;
                    if (!isCulled(dotGX, dotGY, cullingOffset - bleedMargin) &&
                        !isNearGeometryEdge(edgeDistField, dotGX, dotGY, baseRadius, edgeCullRadius)) {
                        circles.push({
                            x: dotGX * view.zoom + view.x,
                            y: dotGY * view.zoom + view.y,
                            r: baseRadius * view.zoom,
                        });
                    }
                });
            }
        }
    }

    return circles;
}

export function collectStreamlines(
    items: CanvasItem[],
    view: { x: number; y: number; zoom: number },
    cullingOffset: number,
    edgeCullRadius: number = 0,
    edgeDistField: EdgeDistanceField = null,
    globalSettings: any = null,
): Streamline[] {
    const streamlines: Streamline[] = [];
    const includeBackgroundTubes = globalSettings?.bgLinesCreateTubes ?? false;

    const isCulledByAny = (gx: number, gy: number, customOffset: number = cullingOffset, startLayer: number = 0) => {
        for (let aboveIndex = startLayer; aboveIndex < items.length; aboveIndex++) {
            if (isInsideFingerprint(gx, gy, items[aboveIndex], customOffset)) {
                return true;
            }
        }
        return false;
    };

    if (globalSettings?.enableVerticalBackground && includeBackgroundTubes) {
        const gs = globalSettings.globalScale || 1.0;
        const bgRotation = globalSettings.bgRotation ?? 0;
        const bgLineDensity = (globalSettings.bgLineDensity ?? 31.0) / gs;
        const bgLineThickness = (globalSettings.bgLineThickness ?? 3) * gs;
        const {
            renderWidth,
            renderHeight,
            centerX: cx,
            centerY: cy,
            radius,
        } = getBackgroundRenderMetrics(globalSettings);
        const lineSpacing = 512 / bgLineDensity;

        const cos = Math.cos(bgRotation * Math.PI / 180);
        const sin = Math.sin(bgRotation * Math.PI / 180);

        const transformBgPoint = (lx: number, ly: number) => {
            const nx = lx * cos - ly * sin;
            const ny = lx * sin + ly * cos;
            return { x: cx + nx, y: cy + ny };
        };

        const bgLines: {x: number, y: number}[][] = [];
        for (let x = -radius; x <= radius; x += lineSpacing) {
            const line: {x: number, y: number}[] = [];
            for (let y = -radius; y <= radius; y += 10) {
                line.push({x, y});
            }
            bgLines.push(line);
        }

        for (const line of bgLines) {
            let currentSegment: Streamline = [];
            for (let i = 0; i < line.length; i++) {
                const globalP = transformBgPoint(line[i].x, line[i].y);
                
                if (globalP.x >= 0 && globalP.x <= renderWidth && globalP.y >= 0 && globalP.y <= renderHeight) {
                    const baseThickness = bgLineThickness;
                    const halfLw = baseThickness / 2;
                    const culled = isCulledByAny(globalP.x, globalP.y, cullingOffset, 0) || 
                                   isNearGeometryEdge(edgeDistField, globalP.x, globalP.y, halfLw, edgeCullRadius);
                    
                    if (!culled) {
                        currentSegment.push({
                            x: globalP.x * view.zoom + view.x,
                            y: globalP.y * view.zoom + view.y,
                            thickness: baseThickness * view.zoom
                        });
                    } else {
                        if (currentSegment.length > 1) {
                            streamlines.push(currentSegment);
                        }
                        currentSegment = [];
                    }
                } else {
                    if (currentSegment.length > 1) {
                        streamlines.push(currentSegment);
                    }
                    currentSegment = [];
                }
            }
            if (currentSegment.length > 1) {
                streamlines.push(currentSegment);
            }
        }
    }

    for (let layerIndex = 0; layerIndex < items.length; layerIndex++) {
        const item = items[layerIndex];
        const lines = generateStreamlines(item.params, 512, 512, item.scale);
        const noiseScale = item.params.noiseScale ?? 10;
        const lineThicknessMin = item.params.lineThicknessMin ?? 3;
        const lineThicknessMax = item.params.lineThicknessMax ?? 3;

        function getLineThickness(lx: number, ly: number) {
            const scaledMin = lineThicknessMin / item.scale;
            const scaledMax = lineThicknessMax / item.scale;
            if (scaledMin === scaledMax) return scaledMin;
            const nx = (lx / 512) * 2 - 1;
            const ny = -((ly / 512) * 2 - 1);
            let v = 0;
            v += Math.sin(nx * noiseScale + item.params.seed + 10) * Math.cos(ny * noiseScale + item.params.seed + 10);
            v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed + 10) * Math.cos(ny * (noiseScale * 2) + item.params.seed + 10);
            v = (v + 1.5) / 3;
            return scaledMin + v * (scaledMax - scaledMin);
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

        const isCulled = (gx: number, gy: number, customOffset: number = cullingOffset) => {
            for (let aboveIndex = layerIndex + 1; aboveIndex < items.length; aboveIndex++) {
                if (isInsideFingerprint(gx, gy, items[aboveIndex], customOffset)) {
                    return true;
                }
            }
            return false;
        };

        for (const line of lines) {
            let currentSegment: Streamline = [];
            for (let i = 0; i < line.length; i++) {
                const globalP = transformPoint(line[i].x, line[i].y);
                const lw = getLineThickness(line[i].x, line[i].y) * item.scale;
                const halfLw = lw / 2;
                
                const culled = isCulled(globalP.x, globalP.y) || isNearGeometryEdge(edgeDistField, globalP.x, globalP.y, halfLw, edgeCullRadius);
                
                if (!culled) {
                    currentSegment.push({
                        x: globalP.x * view.zoom + view.x,
                        y: globalP.y * view.zoom + view.y,
                        thickness: lw * view.zoom
                    });
                } else {
                    if (currentSegment.length > 1) {
                        streamlines.push(currentSegment);
                    }
                    currentSegment = [];
                }
            }
            if (currentSegment.length > 1) {
                streamlines.push(currentSegment);
            }
        }
    }

    return streamlines;
}

export function getComputedItems(items: CanvasItem[], globalSettings: any): CanvasItem[] {
    const gs = globalSettings.globalScale || 1.0;
    const lineThicknessScale = globalSettings.lineThicknessScale ?? 1.0;
    return items.map(it => {
        const dx = it.x - UV_SIZE / 2;
        const dy = it.y - UV_SIZE / 2;
        return {
            ...it,
            x: UV_SIZE / 2 + dx * gs,
            y: UV_SIZE / 2 + dy * gs,
            scale: it.scale * gs,
            params: {
                ...it.params,
                dotSpacing: ((it.params.dotSpacing ?? 0) + (globalSettings.dotSpacing || 0)) * gs,
                dotSizeMin: ((it.params.dotSizeMin ?? 0) + (globalSettings.dotSizeMin || 0)) * gs,
                dotSizeMax: ((it.params.dotSizeMax ?? 0) + (globalSettings.dotSizeMax || 0)) * gs,
                lineDensity: ((it.params.lineDensity ?? 0) + (globalSettings.lineDensity || 0)) * gs,
                lineThicknessMin: (it.params.lineThicknessMin ?? 3) * gs * lineThicknessScale,
                lineThicknessMax: (it.params.lineThicknessMax ?? 3) * gs * lineThicknessScale,
                noiseScale: ((it.params.noiseScale ?? 0) + (globalSettings.noiseScale || 0)) / gs,
            }
        };
    });
}

export const MergedFingerprintsCanvas = forwardRef<HTMLCanvasElement, MergedFingerprintsCanvasProps & { cullingOffset?: number; edgeCullRadius?: number; edgeDistField?: EdgeDistanceField; globalSettings?: any }>(
    function MergedFingerprintsCanvas({ items, view, width, height, cullingOffset = 0.05, edgeCullRadius = 0, edgeDistField = null, globalSettings = null }, ref) {

        const localRef = useRef<HTMLCanvasElement>(null);
        useImperativeHandle(ref, () => ({
            get canvas() { return localRef.current; },
            // Returns an offscreen canvas rendered with a computed "fit all" view,
            // independent of the editor's current pan/zoom.
            getTextureCanvas: () => {
                const { width: texWidth, height: texHeight } = getRenderCanvasDimensions(globalSettings);
                const offscreen = document.createElement('canvas');
                offscreen.width = texWidth;
                offscreen.height = texHeight;
                const ctx = offscreen.getContext('2d');
                if (!ctx) return offscreen;

                const fixedView = { x: 0, y: 0, zoom: 1 };
                renderFingerprints(ctx, items, fixedView, texWidth, texHeight, cullingOffset, edgeCullRadius, edgeDistField, globalSettings);
                return offscreen;
            },
            getTextureDotCircles: () => {
                const fixedView = { x: 0, y: 0, zoom: 1 };
                return collectDotCircles(items, fixedView, cullingOffset, edgeCullRadius, edgeDistField, globalSettings);
            },
            getDotCircles: () => collectDotCircles(items, view, cullingOffset, edgeCullRadius, edgeDistField, globalSettings),
            downloadSVG: () => {
                let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n`;
                svgContent += `  <rect width="100%" height="100%" fill="#f5f5f5" />\n`;

                const isCulledByAny = (gx: number, gy: number, customOffset: number = cullingOffset, startLayer: number = 0) => {
                    for (let aboveIndex = startLayer; aboveIndex < items.length; aboveIndex++) {
                        if (isInsideFingerprint((gx - view.x) / view.zoom, (gy - view.y) / view.zoom, items[aboveIndex], customOffset)) {
                            return true;
                        }
                    }
                    return false;
                };

                if (globalSettings?.enableVerticalBackground) {
                    const gs = globalSettings.globalScale || 1.0;
                    const bgRotation = globalSettings.bgRotation ?? 0;
                    const bgSpacing = (globalSettings.bgSpacing ?? 16.0) * gs;
                    const bgDotSizeMin = (globalSettings.bgDotSizeMin ?? 1.5) * gs;
                    const bgDotSizeMax = (globalSettings.bgDotSizeMax ?? 4.0) * gs;
                    const bgLineDensity = (globalSettings.bgLineDensity ?? 31.0) / gs;
                    const bgNoiseScale = (globalSettings.bgNoiseScale ?? 7.0) / gs;
                    const bgLineThickness = (globalSettings.bgLineThickness ?? 3) * gs;
                    const {
                        renderWidth,
                        renderHeight,
                        centerX: cx,
                        centerY: cy,
                        radius,
                    } = getBackgroundRenderMetrics(globalSettings);
                    const lineSpacing = 512 / bgLineDensity;

                    const cos = Math.cos(bgRotation * Math.PI / 180);
                    const sin = Math.sin(bgRotation * Math.PI / 180);

                    const transformBgPoint = (lx: number, ly: number) => {
                        const nx = lx * cos - ly * sin;
                        const ny = lx * sin + ly * cos;
                        return { x: cx + nx, y: cy + ny };
                    };

                    function getBgSize(gx: number, gy: number) {
                        const nx = (gx / renderWidth) * 2 - 1;
                        const ny = -((gy / renderHeight) * 2 - 1);
                        let v = 0;
                        v += Math.sin(nx * bgNoiseScale) * Math.cos(ny * bgNoiseScale);
                        v += 0.5 * Math.sin(nx * (bgNoiseScale * 2)) * Math.cos(ny * (bgNoiseScale * 2));
                        v = (v + 1.5) / 3;
                        return bgDotSizeMin + v * (bgDotSizeMax - bgDotSizeMin);
                    }

                    const bgLines: {x: number, y: number}[][] = [];
                    for (let x = -radius; x <= radius; x += lineSpacing) {
                        const line: {x: number, y: number}[] = [];
                        for (let y = -radius; y <= radius; y += 10) {
                            line.push({x, y});
                        }
                        bgLines.push(line);
                    }

                    for (const line of bgLines) {
                        for (let i = 1; i < line.length; i++) {
                            const p1 = transformBgPoint(line[i - 1].x, line[i - 1].y);
                            const p2 = transformBgPoint(line[i].x, line[i].y);

                            if (p1.x >= 0 && p1.x <= renderWidth && p1.y >= 0 && p1.y <= renderHeight &&
                                p2.x >= 0 && p2.x <= renderWidth && p2.y >= 0 && p2.y <= renderHeight) {
                                
                                const v1x = p1.x * view.zoom + view.x;
                                const v1y = p1.y * view.zoom + view.y;
                                const v2x = p2.x * view.zoom + view.x;
                                const v2y = p2.y * view.zoom + view.y;

                                if (!isCulledByAny(v1x, v1y, cullingOffset, 0) && !isCulledByAny(v2x, v2y, cullingOffset, 0)) {
                                    const baseThickness = bgLineThickness;
                                    const halfLw = baseThickness / 2;
                                    if (isNearGeometryEdge(edgeDistField, p1.x, p1.y, halfLw, edgeCullRadius) ||
                                        isNearGeometryEdge(edgeDistField, p2.x, p2.y, halfLw, edgeCullRadius)) continue;
                                    
                                    const thickness = baseThickness * view.zoom;
                                    svgContent += `  <line x1="${v1x.toFixed(2)}" y1="${v1y.toFixed(2)}" x2="${v2x.toFixed(2)}" y2="${v2y.toFixed(2)}" stroke="#b0b0b0" stroke-width="${thickness.toFixed(2)}" stroke-linecap="round" />\n`;
                                }
                            }
                        }

                        if (line.length === 0) continue;
                        const lineX = line[0].x;
                        const randomOffset = (Math.abs(Math.sin(lineX * 12.9898 + 78.233)) * 43758.5453) % bgSpacing;
                        let distSinceLastDot = randomOffset;
                        for (let i = 1; i < line.length; i++) {
                            const p1 = line[i - 1];
                            const p2 = line[i];
                            const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                            distSinceLastDot += d;
                            if (distSinceLastDot >= bgSpacing) {
                                distSinceLastDot -= bgSpacing;

                                const globalP2 = transformBgPoint(p2.x, p2.y);
                                
                                if (globalP2.x >= 0 && globalP2.x <= renderWidth && globalP2.y >= 0 && globalP2.y <= renderHeight) {
                                    const v2x = globalP2.x * view.zoom + view.x;
                                    const v2y = globalP2.y * view.zoom + view.y;

                                    const baseRadius = getBgSize(globalP2.x, globalP2.y);
                                    const radius = baseRadius * view.zoom;
                                    const bleedMargin = baseRadius / 256;

                                    if (!isCulledByAny(v2x, v2y, cullingOffset - bleedMargin, 0) &&
                                        !isNearGeometryEdge(edgeDistField, globalP2.x, globalP2.y, baseRadius, edgeCullRadius)) {
                                        svgContent += `  <circle cx="${v2x.toFixed(2)}" cy="${v2y.toFixed(2)}" r="${radius.toFixed(2)}" fill="#111111" />\n`;
                                    }
                                }
                            }
                        }
                    }
                }

                for (let layerIndex = 0; layerIndex < items.length; layerIndex++) {
                    const item = items[layerIndex];
                    const lines = generateStreamlines(item.params, 512, 512, item.scale);
                    const lineThicknessMin = item.params.lineThicknessMin ?? 3;
                    const lineThicknessMax = item.params.lineThicknessMax ?? 3;
                    const noiseScale = item.params.noiseScale ?? 10;

                    function getLineThickness(lx: number, ly: number) {
                        const scaledMin = lineThicknessMin / item.scale;
                        const scaledMax = lineThicknessMax / item.scale;
                        if (scaledMin === scaledMax) return scaledMin;
                        const nx = (lx / 512) * 2 - 1;
                        const ny = -((ly / 512) * 2 - 1);
                        let v = 0;
                        v += Math.sin(nx * noiseScale + item.params.seed + 10) * Math.cos(ny * noiseScale + item.params.seed + 10);
                        v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed + 10) * Math.cos(ny * (noiseScale * 2) + item.params.seed + 10);
                        v = (v + 1.5) / 3;
                        return scaledMin + v * (scaledMax - scaledMin);
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

                    const isCulled = (gx: number, gy: number, customOffset: number = cullingOffset) => {
                        const ux = (gx - view.x) / view.zoom;
                        const uy = (gy - view.y) / view.zoom;
                        for (let aboveIndex = layerIndex + 1; aboveIndex < items.length; aboveIndex++) {
                            if (isInsideFingerprint(ux, uy, items[aboveIndex], customOffset)) {
                                return true;
                            }
                        }
                        return false;
                    };

                    const dotSpacing = item.params.dotSpacing ?? 18;
                    const dotSizeMin = item.params.dotSizeMin ?? 1.5;
                    const dotSizeMax = item.params.dotSizeMax ?? 6.0;

                    function getSize(lx: number, ly: number) {
                        const scaledMin = dotSizeMin / item.scale;
                        const scaledMax = dotSizeMax / item.scale;
                        const nx = (lx / 512) * 2 - 1;
                        const ny = -((ly / 512) * 2 - 1);
                        let v = 0;
                        v += Math.sin(nx * noiseScale + item.params.seed) * Math.cos(ny * noiseScale + item.params.seed);
                        v += 0.5 * Math.sin(nx * (noiseScale * 2) - item.params.seed) * Math.cos(ny * (noiseScale * 2) + item.params.seed);
                        v = (v + 1.5) / 3;
                        return scaledMin + v * (scaledMax - scaledMin);
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
                                const halfLw = baseThickness / 2;
                                if (isNearGeometryEdge(edgeDistField, p1.x, p1.y, halfLw, edgeCullRadius) ||
                                    isNearGeometryEdge(edgeDistField, p2.x, p2.y, halfLw, edgeCullRadius)) continue;
                                const thickness = baseThickness * view.zoom;
                                svgContent += `  <line x1="${v1x.toFixed(2)}" y1="${v1y.toFixed(2)}" x2="${v2x.toFixed(2)}" y2="${v2y.toFixed(2)}" stroke="#b0b0b0" stroke-width="${thickness.toFixed(2)}" stroke-linecap="round" />\n`;
                            }
                        }
                    }

                    // 2. Draw Dots
                    const scaledDotSpacing = dotSpacing / item.scale;
                    for (const line of lines) {
                        const visibleSegments = collectVisibleDotSegments(
                            line,
                            transformPoint,
                            (gx, gy, customOffset) => isCulled(
                                gx * view.zoom + view.x,
                                gy * view.zoom + view.y,
                                customOffset
                            ),
                            getLineThickness,
                            item.scale,
                            edgeDistField,
                            edgeCullRadius
                        );

                        for (const segment of visibleSegments) {
                            forEachDotPlacement(segment, scaledDotSpacing, ({ x: dotX, y: dotY, gx: dotGX, gy: dotGY }) => {
                                const baseRadius = getSize(dotX, dotY) * item.scale;
                                const lineRadius = (getLineThickness(dotX, dotY) * item.scale) / 2;
                                const endpointRadius = lineRadius + baseRadius * 0.1;
                                if (isNearVisibleSegmentEndpoint(segment, dotGX, dotGY, endpointRadius)) {
                                    return;
                                }

                                const v2x = dotGX * view.zoom + view.x;
                                const v2y = dotGY * view.zoom + view.y;
                                const radius = baseRadius * view.zoom;
                                const bleedMargin = baseRadius / 256;
                                if (!isCulled(v2x, v2y, cullingOffset - bleedMargin) &&
                                    !isNearGeometryEdge(edgeDistField, dotGX, dotGY, baseRadius, edgeCullRadius)) {
                                    svgContent += `  <circle cx="${v2x.toFixed(2)}" cy="${v2y.toFixed(2)}" r="${radius.toFixed(2)}" fill="#111111" />\n`;
                                }
                            });
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

            renderFingerprints(ctx, items, view, width, height, cullingOffset, edgeCullRadius, edgeDistField, globalSettings);
        }, [items, view, width, height, edgeCullRadius, edgeDistField, globalSettings]);

        return <canvas ref={localRef} width={width} height={height} className="absolute inset-0 pointer-events-none" />;
    }
);
