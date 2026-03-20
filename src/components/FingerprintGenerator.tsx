import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';

const vertexShaderSource = `
  attribute vec2 a_position;
  varying vec2 vUv;
  void main() {
    vUv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision highp float;

  varying vec2 vUv;
  uniform sampler2D uNoise;
  uniform vec2 uResolution;

  uniform vec2 uCore1;
  uniform vec2 uCore2;
  uniform vec2 uDelta1;
  uniform vec2 uDelta2;

  uniform float uFreq;
  uniform float uThickness;
  uniform float uSmudge;
  uniform float uScratches;
  uniform float uPores;
  uniform float uSeed;
  uniform float uSpiral;

  const float PI = 3.14159265359;

  float random (in vec2 st) {
      return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
  }

  float noise (in vec2 st) {
      vec2 i = floor(st);
      vec2 f = fract(st);

      float a = random(i);
      float b = random(i + vec2(1.0, 0.0));
      float c = random(i + vec2(0.0, 1.0));
      float d = random(i + vec2(1.0, 1.0));

      vec2 u = f*f*(3.0-2.0*f);

      return mix(a, b, u.x) +
              (c - a)* u.y * (1.0 - u.x) +
              (d - b) * u.x * u.y;
  }

  float fbm (in vec2 st) {
      float value = 0.0;
      float amplitude = 0.5;
      for (int i = 0; i < 4; i++) {
          value += amplitude * noise(st);
          st *= 2.0;
          amplitude *= 0.5;
      }
      return value;
  }

  float getOrientation(vec2 uv) {
      float theta = uSpiral; 
      
      theta += 0.5 * atan(uv.y - uCore1.y, uv.x - uCore1.x);
      theta += 0.5 * atan(uv.y - uCore2.y, uv.x - uCore2.x);
      theta -= 0.5 * atan(uv.y - uDelta1.y, uv.x - uDelta1.x);
      theta -= 0.5 * atan(uv.y - uDelta2.y, uv.x - uDelta2.x);
      
      return theta;
  }

  void main() {
      vec2 uv = vUv;
      vec2 pos = (uv - 0.5) * 2.0;
      pos.x *= uResolution.x / uResolution.y;
      
      float theta = getOrientation(pos);
      
      float f = uFreq; 
      float stepSize = max(1.0, (1.0 / f) / 10.0);
      
      float sigma_x = 1.5 / f;
      float sigma_y = 0.8 / f;
      
      float sum = 0.0;
      float weightSum = 0.0;
      
      for(int i = -12; i <= 12; i++) {
          for(int j = -12; j <= 12; j++) {
              vec2 offset = vec2(float(i), float(j)) * stepSize;
              vec2 sampleUv = uv + offset / uResolution;
              
              float n = texture2D(uNoise, fract(sampleUv)).r * 2.0 - 1.0;
              
              float dx = offset.x;
              float dy = offset.y;
              
              float xPrime = dx * cos(theta) + dy * sin(theta);
              float yPrime = -dx * sin(theta) + dy * cos(theta);
              
              float w = exp(-0.5 * ( (xPrime*xPrime)/(sigma_x*sigma_x) + (yPrime*yPrime)/(sigma_y*sigma_y) )) * cos(2.0 * PI * f * yPrime);
              
              sum += n * w;
              weightSum += abs(w);
          }
      }
      
      float ridge = sum / weightSum;
      ridge = ridge * 5.0; 
      
      float lowFreq = fbm(uv * 5.0 + uSeed);
      float localThreshold = uThickness + (lowFreq - 0.5) * 0.5;
      
      float edge = 0.05;
      float col = smoothstep(localThreshold - edge, localThreshold + edge, ridge);
      
      float poreNoise = random(uv * 1000.0 + uSeed);
      if (col < 0.5 && poreNoise > (1.0 - uPores * 0.05)) {
          col = 1.0; 
      }
      
      float maskDist = length(vec2(pos.x, pos.y * 0.8 + 0.2));
      float mask = 1.0 - smoothstep(0.7, 1.0, maskDist);
      
      float smudgeNoise = fbm(uv * 3.0 + uSeed * 2.0);
      col = mix(col, smudgeNoise, uSmudge);
      
      float scratch = 0.0;
      for(int i=0; i<8; i++) {
          vec2 p1 = vec2(random(vec2(float(i), uSeed)), random(vec2(float(i), uSeed + 1.0))) * 2.0 - 1.0;
          vec2 p2 = vec2(random(vec2(float(i), uSeed + 2.0)), random(vec2(float(i), uSeed + 3.0))) * 2.0 - 1.0;
          
          vec2 pa = pos - p1;
          vec2 ba = p2 - p1;
          float h = clamp(dot(pa, ba)/dot(ba, ba), 0.0, 1.0);
          float d = length(pa - ba * h);
          
          if (d < 0.005) {
              scratch += (1.0 - smoothstep(0.0, 0.005, d)) * random(vec2(float(i), pos.x));
          }
      }
      col = mix(col, 1.0, clamp(scratch * uScratches * 5.0, 0.0, 1.0));
      
      col = mix(1.0, col, mask);
      
      vec3 paper = vec3(0.92, 0.92, 0.90);
      vec3 ink = vec3(0.15, 0.15, 0.18);
      
      paper -= random(uv * 500.0) * 0.05;
      
      vec3 finalColor = mix(ink, paper, col);
      
      gl_FragColor = vec4(finalColor, 1.0);
  }
`;

const fragmentShaderVector = `
  precision highp float;

  varying vec2 vUv;
  uniform sampler2D uNoise;
  uniform vec2 uResolution;

  uniform vec2 uCore1;
  uniform vec2 uCore2;
  uniform vec2 uDelta1;
  uniform vec2 uDelta2;

  uniform float uFreq;
  uniform float uThickness;
  uniform float uSeed;
  uniform float uSpiral;

  const float PI = 3.14159265359;

  float random (in vec2 st) {
      return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
  }

  float noise (in vec2 st) {
      vec2 i = floor(st);
      vec2 f = fract(st);

      float a = random(i);
      float b = random(i + vec2(1.0, 0.0));
      float c = random(i + vec2(0.0, 1.0));
      float d = random(i + vec2(1.0, 1.0));

      vec2 u = f*f*(3.0-2.0*f);

      return mix(a, b, u.x) +
              (c - a)* u.y * (1.0 - u.x) +
              (d - b) * u.x * u.y;
  }

  float fbm (in vec2 st) {
      float value = 0.0;
      float amplitude = 0.5;
      for (int i = 0; i < 4; i++) {
          value += amplitude * noise(st);
          st *= 2.0;
          amplitude *= 0.5;
      }
      return value;
  }

  float getOrientation(vec2 uv) {
      float theta = uSpiral; 
      
      theta += 0.5 * atan(uv.y - uCore1.y, uv.x - uCore1.x);
      theta += 0.5 * atan(uv.y - uCore2.y, uv.x - uCore2.x);
      theta -= 0.5 * atan(uv.y - uDelta1.y, uv.x - uDelta1.x);
      theta -= 0.5 * atan(uv.y - uDelta2.y, uv.x - uDelta2.x);
      
      return theta;
  }

  void main() {
      vec2 uv = vUv;
      vec2 pos = (uv - 0.5) * 2.0;
      pos.x *= uResolution.x / uResolution.y;
      
      float theta = getOrientation(pos);
      
      float f = uFreq; 
      float stepSize = max(1.0, (1.0 / f) / 10.0);
      
      // Main ridges (gray lines)
      float sigma_x = 1.5 / f;
      float sigma_y = 0.8 / f;
      
      // Cross ridges (for dots)
      float f_cross = f * 0.6; // Dots are spaced slightly further apart than lines
      float sigma_x_cross = 0.8 / f_cross;
      float sigma_y_cross = 1.5 / f_cross;
      
      float sum_ridge = 0.0;
      float weightSum_ridge = 0.0;
      
      float sum_cross = 0.0;
      float weightSum_cross = 0.0;
      
      for(int i = -12; i <= 12; i++) {
          for(int j = -12; j <= 12; j++) {
              vec2 offset = vec2(float(i), float(j)) * stepSize;
              vec2 sampleUv = uv + offset / uResolution;
              
              // INDEPENDENT noise samples for ridge and cross
              float n_ridge = texture2D(uNoise, fract(sampleUv)).r * 2.0 - 1.0;
              float n_cross = texture2D(uNoise, fract(sampleUv + vec2(0.37, 0.61))).r * 2.0 - 1.0;
              
              float dx = offset.x;
              float dy = offset.y;
              
              float xPrime = dx * cos(theta) + dy * sin(theta);
              float yPrime = -dx * sin(theta) + dy * cos(theta);
              
              float w_ridge = exp(-0.5 * ( (xPrime*xPrime)/(sigma_x*sigma_x) + (yPrime*yPrime)/(sigma_y*sigma_y) )) * cos(2.0 * PI * f * yPrime);
              float w_cross = exp(-0.5 * ( (xPrime*xPrime)/(sigma_x_cross*sigma_x_cross) + (yPrime*yPrime)/(sigma_y_cross*sigma_y_cross) )) * cos(2.0 * PI * f_cross * xPrime);
              
              sum_ridge += n_ridge * w_ridge;
              weightSum_ridge += abs(w_ridge);
              
              sum_cross += n_cross * w_cross;
              weightSum_cross += abs(w_cross);
          }
      }
      
      float ridge = (sum_ridge / weightSum_ridge) * 5.0;
      float cross = (sum_cross / weightSum_cross) * 5.0;
      
      float lowFreq = fbm(uv * 5.0 + uSeed);
      float localThreshold = uThickness + (lowFreq - 0.5) * 0.5;
      
      float edge = 0.05; 
      
      // 1. Gray line mask
      float lineMask = smoothstep(localThreshold - edge, localThreshold + edge, ridge);
      
      // 2. Dot mask
      // Combine ridge and cross to form isolated peaks (dots)
      float dotField = ridge + cross;
      
      // Vary the threshold using FBM to make dots different sizes
      float sizeVar = fbm(uv * 4.0 + uSeed * 3.0);
      float dotThreshold = 1.0 + (sizeVar - 0.5) * 1.5; // Adjust this to control dot size/presence
      
      float dotMask = smoothstep(dotThreshold - edge, dotThreshold + edge, dotField);
      
      // Ensure dots only appear ON the gray lines
      dotMask *= smoothstep(localThreshold, localThreshold + edge, ridge);
      
      // Mask out the edges of the fingerprint
      float maskDist = length(vec2(pos.x, pos.y * 0.8 + 0.2));
      float mask = 1.0 - smoothstep(0.7, 0.75, maskDist);
      
      lineMask *= mask;
      dotMask *= mask;
      
      vec3 bgColor = vec3(0.96, 0.96, 0.96);
      vec3 lineColor = vec3(0.75, 0.75, 0.75); // Light grey
      vec3 dotColor = vec3(0.05, 0.05, 0.05); // Black
      
      vec3 finalColor = bgColor;
      finalColor = mix(finalColor, lineColor, lineMask);
      finalColor = mix(finalColor, dotColor, dotMask);
      
      gl_FragColor = vec4(finalColor, 1.0);
  }
`;

export function isInsideBounds(x: number, y: number, params: FingerprintParams, width: number, height: number, margin: number = 0): boolean {
  if (x < margin || x >= width - margin || y < margin || y >= height - margin) return false;

  if (params.customPolygon && params.customPolygon.length >= 3) {
    let inside = false;
    for (let i = 0, j = params.customPolygon.length - 1; i < params.customPolygon.length; j = i++) {
      const xi = params.customPolygon[i].x, yi = params.customPolygon[i].y;
      const xj = params.customPolygon[j].x, yj = params.customPolygon[j].y;
      const intersect = ((yi > y) !== (yj > y))
          && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    if (!inside) return false;

    if (margin > 0) {
      for (let i = 0, j = params.customPolygon.length - 1; i < params.customPolygon.length; j = i++) {
        const xi = params.customPolygon[i].x, yi = params.customPolygon[i].y;
        const xj = params.customPolygon[j].x, yj = params.customPolygon[j].y;
        const l2 = (xj - xi)**2 + (yj - yi)**2;
        if (l2 === 0) continue;
        let t = ((x - xi) * (xj - xi) + (y - yi) * (yj - yi)) / l2;
        t = Math.max(0, Math.min(1, t));
        const projX = xi + t * (xj - xi);
        const projY = yi + t * (yj - yi);
        if (Math.hypot(x - projX, y - projY) < margin) return false;
      }
    }
  } else {
    const boundsX = params.boundsX ?? 0.7;
    const boundsY = params.boundsY ?? 0.875;
    const shapePower = params.shapePower ?? 2.0;
    const marginX = margin / (width / 2);
    const marginY = margin / (height / 2);
    const nx = (x - width / 2) / (width / 2 * boundsX - marginX);
    const ny = (y - height * 0.625) / (height / 2 * boundsY - marginY);
    if ((Math.pow(Math.abs(nx), shapePower) + Math.pow(Math.abs(ny), shapePower)) > 1.0) return false;
  }

  return true;
}

export function generateStreamlines(params: FingerprintParams, width: number, height: number, scale: number = 1) {
  const lineDensity = Math.max(4, (params.lineDensity ?? 16) / scale);
  const dsep = lineDensity;
  const dtest = dsep * 0.75;
  const step = Math.max(0.5, 2 / scale);

  const cellSize = dsep;
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const grid: { x: number, y: number, lineId: number, idx: number }[][][] =
    Array(cols).fill(0).map(() => Array(rows).fill(0).map(() => []));

  function getAngle(x: number, y: number) {
    const nx = (x / width) * 2 - 1;
    const ny = -((y / height) * 2 - 1);

    let theta = params.spiral;
    theta += 0.5 * Math.atan2(ny - params.core1.y, nx - params.core1.x);
    theta += 0.5 * Math.atan2(ny - params.core2.y, nx - params.core2.x);
    theta -= 0.5 * Math.atan2(ny - params.delta1.y, nx - params.delta1.x);
    theta -= 0.5 * Math.atan2(ny - params.delta2.y, nx - params.delta2.x);
    return theta;
  }

  function isValid(x: number, y: number, lineId: number, currentIdx: number, margin: number = 0) {
    if (x < margin || x >= width - margin || y < margin || y >= height - margin) return false;

    if (params.customPolygon && params.customPolygon.length >= 3) {
      let inside = false;
      for (let i = 0, j = params.customPolygon.length - 1; i < params.customPolygon.length; j = i++) {
        const xi = params.customPolygon[i].x, yi = params.customPolygon[i].y;
        const xj = params.customPolygon[j].x, yj = params.customPolygon[j].y;
        const intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      if (!inside) return false;
      
      // Rough margin check for custom polygon (check if we are too close to any edge)
      if (margin > 0) {
          for (let i = 0, j = params.customPolygon.length - 1; i < params.customPolygon.length; j = i++) {
              const xi = params.customPolygon[i].x, yi = params.customPolygon[i].y;
              const xj = params.customPolygon[j].x, yj = params.customPolygon[j].y;
              // Distance from point to line segment
              const l2 = (xj - xi)**2 + (yj - yi)**2;
              if (l2 === 0) continue;
              let t = ((x - xi) * (xj - xi) + (y - yi) * (yj - yi)) / l2;
              t = Math.max(0, Math.min(1, t));
              const projX = xi + t * (xj - xi);
              const projY = yi + t * (yj - yi);
              if (Math.hypot(x - projX, y - projY) < margin) return false;
          }
      }
    } else {
      // Strict ellipse/squircle boundary check
      const boundsX = params.boundsX ?? 0.7;
      const boundsY = params.boundsY ?? 0.875;
      const shapePower = params.shapePower ?? 2.0;

      // Adjust bounds slightly inward if there is a margin
      const marginX = margin / (width / 2);
      const marginY = margin / (height / 2);

      const nx = (x - width / 2) / (width / 2 * boundsX - marginX);
      const ny = (y - height * 0.625) / (height / 2 * boundsY - marginY);
      if ((Math.pow(Math.abs(nx), shapePower) + Math.pow(Math.abs(ny), shapePower)) > 1.0) return false;
    }

    const c = Math.floor(x / cellSize);
    const r = Math.floor(y / cellSize);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return false;

    for (let i = Math.max(0, c - 1); i <= Math.min(cols - 1, c + 1); i++) {
      for (let j = Math.max(0, r - 1); j <= Math.min(rows - 1, r + 1); j++) {
        for (const pt of grid[i][j]) {
          if (pt.lineId === lineId && Math.abs(pt.idx - currentIdx) < (dtest / step * 2.5 + 10)) continue;
          const distSq = (pt.x - x) ** 2 + (pt.y - y) ** 2;
          if (distSq < dtest * dtest) return false;
        }
      }
    }
    return true;
  }

  const lines: { x: number, y: number }[][] = [];
  let lineCount = 0;

  const seeds: { x: number, y: number }[] = [];
  for (let x = dsep; x < width; x += dsep) {
    for (let y = dsep; y < height; y += dsep) {
      seeds.push({ x, y });
    }
  }

  seeds.sort((a, b) => {
    const da = (a.x - width / 2) ** 2 + (a.y - height / 2) ** 2;
    const db = (b.x - width / 2) ** 2 + (b.y - height / 2) ** 2;
    return da - db;
  });

  for (const seed of seeds) {
    if (!isValid(seed.x, seed.y, -1, -1)) continue;

    const lineId = lineCount++;
    const line: { x: number, y: number }[] = [{ x: seed.x, y: seed.y }];

    const c = Math.floor(seed.x / cellSize);
    const r = Math.floor(seed.y / cellSize);
    grid[c][r].push({ x: seed.x, y: seed.y, lineId, idx: 0 });

    let px = seed.x;
    let py = seed.y;
    let idx = 1;
    while (true) {
      const theta = getAngle(px, py);
      px += Math.cos(theta) * step;
      py -= Math.sin(theta) * step;
      if (!isValid(px, py, lineId, idx)) break;
      line.push({ x: px, y: py });
      grid[Math.floor(px / cellSize)][Math.floor(py / cellSize)].push({ x: px, y: py, lineId, idx });
      idx++;
    }

    px = seed.x;
    py = seed.y;
    idx = -1;
    while (true) {
      const theta = getAngle(px, py) + Math.PI;
      px += Math.cos(theta) * step;
      py -= Math.sin(theta) * step;
      if (!isValid(px, py, lineId, idx)) break;
      line.unshift({ x: px, y: py });
      grid[Math.floor(px / cellSize)][Math.floor(py / cellSize)].push({ x: px, y: py, lineId, idx });
      idx--;
    }

    if (line.length > 5) {
      lines.push(line);
    }
  }

  return lines;
}

export const FingerprintStreamlines = forwardRef<HTMLCanvasElement, { params: FingerprintParams, width?: number, height?: number }>(function FingerprintStreamlines({ params, width = 512, height = 512 }, ref) {
  const localRef = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => localRef.current as HTMLCanvasElement);

  useEffect(() => {
    const canvas = localRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#f5f5f5';
    ctx.beginPath();
    if (params.customPolygon && params.customPolygon.length >= 3) {
        ctx.moveTo(params.customPolygon[0].x, params.customPolygon[0].y);
        for (let i = 1; i < params.customPolygon.length; i++) {
            ctx.lineTo(params.customPolygon[i].x, params.customPolygon[i].y);
        }
        ctx.closePath();
    } else {
        const boundsX = params.boundsX ?? 0.7;
        const boundsY = params.boundsY ?? 0.875;
        ctx.ellipse(width / 2, height * 0.625, (width / 2) * boundsX, (height / 2) * boundsY, 0, 0, Math.PI * 2);
    }
    ctx.fill();

    const lines = generateStreamlines(params, width, height);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1. Draw grey lines
    ctx.strokeStyle = '#b0b0b0';
    const lineThicknessMin = params.lineThicknessMin ?? 3;
    const lineThicknessMax = params.lineThicknessMax ?? 3;
    const noiseScale = params.noiseScale ?? 10;

    function getLineThickness(x: number, y: number) {
      if (lineThicknessMin === lineThicknessMax) return lineThicknessMin;
      const nx = (x / width) * 2 - 1;
      const ny = -((y / height) * 2 - 1);
      let v = 0;
      v += Math.sin(nx * noiseScale + params.seed + 10) * Math.cos(ny * noiseScale + params.seed + 10);
      v += 0.5 * Math.sin(nx * (noiseScale * 2) - params.seed + 10) * Math.cos(ny * (noiseScale * 2) + params.seed + 10);
      v = (v + 1.5) / 3;
      return lineThicknessMin + v * (lineThicknessMax - lineThicknessMin);
    }

    if (lineThicknessMin === lineThicknessMax) {
      ctx.lineWidth = lineThicknessMin;
      for (const line of lines) {
        ctx.beginPath();
        ctx.moveTo(line[0].x, line[0].y);
        for (let i = 1; i < line.length; i++) {
          ctx.lineTo(line[i].x, line[i].y);
        }
        ctx.stroke();
      }
    } else {
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          ctx.beginPath();
          ctx.moveTo(line[i - 1].x, line[i - 1].y);
          ctx.lineTo(line[i].x, line[i].y);
          ctx.lineWidth = getLineThickness(line[i].x, line[i].y);
          ctx.stroke();
        }
      }
    }

    // 2. Draw dots
    ctx.fillStyle = '#111111';
    const dotSpacing = params.dotSpacing ?? 18;
    const dotSizeMin = params.dotSizeMin ?? 1.5;
    const dotSizeMax = params.dotSizeMax ?? 6.0;

    function getSize(x: number, y: number) {
      const nx = (x / width) * 2 - 1;
      const ny = -((y / height) * 2 - 1);
      let v = 0;
      v += Math.sin(nx * noiseScale + params.seed) * Math.cos(ny * noiseScale + params.seed);
      v += 0.5 * Math.sin(nx * (noiseScale * 2) - params.seed) * Math.cos(ny * (noiseScale * 2) + params.seed);
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
          const radius = getSize(p2.x, p2.y);
          
          // Double check that the DOT ITSELF (including its radius) is fully inside the bounds
          // to prevent edge bleeding
          if (isInsideBounds(p2.x, p2.y, params, width, height, radius)) {
              ctx.beginPath();
              ctx.arc(p2.x, p2.y, radius, 0, Math.PI * 2);
              ctx.fill();
          }
        }
      }
    }

  }, [params, width, height]);

  useEffect(() => {
    const handleDownloadSVG = () => {
      const lines = generateStreamlines(params, width, height);

      const lineThicknessMin = params.lineThicknessMin ?? 3;
      const lineThicknessMax = params.lineThicknessMax ?? 3;
      const noiseScale = params.noiseScale ?? 10;
      const dotSpacing = params.dotSpacing ?? 18;
      const dotSizeMin = params.dotSizeMin ?? 1.5;
      const dotSizeMax = params.dotSizeMax ?? 6.0;

      function getLineThickness(x: number, y: number) {
        if (lineThicknessMin === lineThicknessMax) return lineThicknessMin;
        const nx = (x / width) * 2 - 1;
        const ny = -((y / height) * 2 - 1);
        let v = 0;
        v += Math.sin(nx * noiseScale + params.seed + 10) * Math.cos(ny * noiseScale + params.seed + 10);
        v += 0.5 * Math.sin(nx * (noiseScale * 2) - params.seed + 10) * Math.cos(ny * (noiseScale * 2) + params.seed + 10);
        v = (v + 1.5) / 3;
        return lineThicknessMin + v * (lineThicknessMax - lineThicknessMin);
      }

      function getSize(x: number, y: number) {
        const nx = (x / width) * 2 - 1;
        const ny = -((y / height) * 2 - 1);
        let v = 0;
        v += Math.sin(nx * noiseScale + params.seed) * Math.cos(ny * noiseScale + params.seed);
        v += 0.5 * Math.sin(nx * (noiseScale * 2) - params.seed) * Math.cos(ny * (noiseScale * 2) + params.seed);
        v = (v + 1.5) / 3;
        return dotSizeMin + v * (dotSizeMax - dotSizeMin);
      }

      let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n`;
      if (params.customPolygon && params.customPolygon.length >= 3) {
          const points = params.customPolygon.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
          svgContent += `  <polygon points="${points}" fill="#f5f5f5" />\n`;
      } else {
          const cx = width / 2;
          const cy = height * 0.625;
          const rx = (width / 2) * (params.boundsX ?? 0.7);
          const ry = (height / 2) * (params.boundsY ?? 0.875);
          svgContent += `  <ellipse cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" fill="#f5f5f5" />\n`;
      }

      // 1. Draw grey lines
      if (lineThicknessMin === lineThicknessMax) {
        let pathData = '';
        for (const line of lines) {
          pathData += `M ${line[0].x.toFixed(2)} ${line[0].y.toFixed(2)} `;
          for (let i = 1; i < line.length; i++) {
            pathData += `L ${line[i].x.toFixed(2)} ${line[i].y.toFixed(2)} `;
          }
        }
        svgContent += `  <path d="${pathData}" stroke="#b0b0b0" stroke-width="${lineThicknessMin}" stroke-linecap="round" stroke-linejoin="round" fill="none" />\n`;
      } else {
        for (const line of lines) {
          for (let i = 1; i < line.length; i++) {
            const thickness = getLineThickness(line[i].x, line[i].y);
            svgContent += `  <line x1="${line[i - 1].x.toFixed(2)}" y1="${line[i - 1].y.toFixed(2)}" x2="${line[i].x.toFixed(2)}" y2="${line[i].y.toFixed(2)}" stroke="#b0b0b0" stroke-width="${thickness.toFixed(2)}" stroke-linecap="round" />\n`;
          }
        }
      }

      // 2. Draw dots
      for (const line of lines) {
        let distSinceLastDot = dotSpacing / 2;
        for (let i = 1; i < line.length; i++) {
          const p1 = line[i - 1];
          const p2 = line[i];
          const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          distSinceLastDot += d;
          if (distSinceLastDot >= dotSpacing) {
            distSinceLastDot -= dotSpacing;
            const radius = getSize(p2.x, p2.y);
            if (isInsideBounds(p2.x, p2.y, params, width, height, radius)) {
                svgContent += `  <circle cx="${p2.x.toFixed(2)}" cy="${p2.y.toFixed(2)}" r="${radius.toFixed(2)}" fill="#111111" />\n`;
            }
          }
        }
      }

      svgContent += `</svg>`;

      const blob = new Blob([svgContent], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = 'chunky-beads.svg';
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    };

    document.addEventListener('download-svg', handleDownloadSVG);
    return () => document.removeEventListener('download-svg', handleDownloadSVG);
  }, [params, width, height]);

  return <canvas ref={localRef} width={width} height={height} className="absolute top-0 left-0 rounded-full w-full h-full object-cover" />;
});

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Cannot create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    throw new Error('Shader compile error');
  }
  return shader;
}

export interface Point { x: number; y: number }

export interface FingerprintParams {
  core1: Point;
  core2: Point;
  delta1: Point;
  delta2: Point;
  frequency: number;
  thickness: number;
  smudge: number;
  scratches: number;
  pores: number;
  seed: number;
  spiral: number;
  showPoints: boolean;
  dotSpacing?: number;
  dotSizeMin?: number;
  dotSizeMax?: number;
  lineDensity?: number;
  noiseScale?: number;
  lineThicknessMin?: number;
  lineThicknessMax?: number;
  boundsX?: number;
  boundsY?: number;
  shapePower?: number;
  customPolygon?: Point[];
}

interface Props {
  params: FingerprintParams;
  onPointChange: (name: string, value: any) => void;
  width?: number;
  height?: number;
  variant?: 'realistic' | 'vector' | 'dots';
  transparent?: boolean;
}

export function FingerprintGenerator({ params, onPointChange, width = 512, height = 512, variant = 'realistic', transparent = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const textureRef = useRef<WebGLTexture | null>(null);
  const locationsRef = useRef<Record<string, WebGLUniformLocation>>({});

  useEffect(() => {
    if (variant === 'dots') return; // Handled by FingerprintStreamlines

    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return;
    glRef.current = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fsSource = variant === 'vector' ? fragmentShaderVector : fragmentShaderSource;
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return;
    }
    programRef.current = program;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);

    const positionLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    const uniforms = ['uNoise', 'uResolution', 'uCore1', 'uCore2', 'uDelta1', 'uDelta2', 'uFreq', 'uThickness', 'uSmudge', 'uScratches', 'uPores', 'uSeed', 'uSpiral'];
    uniforms.forEach(name => {
      const loc = gl.getUniformLocation(program, name);
      if (loc) locationsRef.current[name] = loc;
    });

    const texture = gl.createTexture();
    textureRef.current = texture;

    return () => {
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buffer);
      gl.deleteTexture(texture);
    };
  }, [variant]);

  useEffect(() => {
    if (variant === 'dots') return;

    const gl = glRef.current;
    const texture = textureRef.current;
    if (!gl || !texture) return;

    const noiseSize = 512;
    const noiseData = new Uint8Array(noiseSize * noiseSize * 4);

    let seedVal = params.seed * 12345.6789;
    const seededRandom = () => {
      seedVal = (seedVal * 9301 + 49297) % 233280;
      return seedVal / 233280;
    };

    for (let i = 0; i < noiseData.length; i += 4) {
      const val = Math.floor(seededRandom() * 256);
      noiseData[i] = val;
      noiseData[i + 1] = val;
      noiseData[i + 2] = val;
      noiseData[i + 3] = 255;
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, noiseSize, noiseSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, noiseData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }, [params.seed]);

  useEffect(() => {
    if (variant === 'dots') return;

    const gl = glRef.current;
    const program = programRef.current;
    const locs = locationsRef.current;
    if (!gl || !program) return;

    gl.viewport(0, 0, width, height);
    gl.useProgram(program);

    if (locs.uResolution) gl.uniform2f(locs.uResolution, width, height);
    if (locs.uCore1) gl.uniform2f(locs.uCore1, params.core1.x, params.core1.y);
    if (locs.uCore2) gl.uniform2f(locs.uCore2, params.core2.x, params.core2.y);
    if (locs.uDelta1) gl.uniform2f(locs.uDelta1, params.delta1.x, params.delta1.y);
    if (locs.uDelta2) gl.uniform2f(locs.uDelta2, params.delta2.x, params.delta2.y);
    if (locs.uFreq) gl.uniform1f(locs.uFreq, params.frequency);
    if (locs.uThickness) gl.uniform1f(locs.uThickness, params.thickness);
    if (locs.uSmudge) gl.uniform1f(locs.uSmudge, params.smudge);
    if (locs.uScratches) gl.uniform1f(locs.uScratches, params.scratches);
    if (locs.uPores) gl.uniform1f(locs.uPores, params.pores);
    if (locs.uSeed) gl.uniform1f(locs.uSeed, params.seed);
    if (locs.uSpiral) gl.uniform1f(locs.uSpiral, params.spiral);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textureRef.current);
    gl.uniform1i(locs.uNoise, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }, [params, width, height]);

  const toSvg = (p: Point) => ({
    x: (p.x + 1) / 2 * width,
    y: (-p.y + 1) / 2 * height,
  });

  const toWebgl = (x: number, y: number) => ({
    x: (x / width) * 2 - 1,
    y: -((y / height) * 2 - 1),
  });

  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const handlePointerDown = (e: React.PointerEvent, name: string) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(name);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (dragging.startsWith('poly_')) {
        const idx = parseInt(dragging.split('_')[1]);
        const newPoly = [...(params.customPolygon || [])];
        newPoly[idx] = { x: x * (512 / width), y: y * (512 / height) };
        onPointChange('customPolygon', newPoly);
    } else {
        onPointChange(dragging, toWebgl(x, y));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(null);
  };

  const renderPoint = (name: keyof FingerprintParams, point: Point, color: string, label: string) => {
    if (!params.showPoints) return null;
    const svgP = toSvg(point);
    return (
      <g
        transform={`translate(${svgP.x}, ${svgP.y})`}
        onPointerDown={(e) => handlePointerDown(e, name)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className="cursor-grab active:cursor-grabbing"
      >
        <circle r={16} fill="transparent" stroke={color} strokeWidth={2} strokeDasharray="2 2" />
        <circle r={6} fill={color} />
        <text x={20} y={4} fill={color} fontSize={14} fontFamily="monospace" fontWeight="bold" className="pointer-events-none select-none drop-shadow-md">
          {label}
        </text>
      </g>
    );
  };

  return (
    <div className="relative" style={{ width, height, pointerEvents: transparent ? 'none' : 'auto' }}>
      {!transparent && (
        variant === 'dots' ? (
          <FingerprintStreamlines params={params} width={width} height={height} />
        ) : (
          <canvas ref={canvasRef} width={width} height={height} className="absolute inset-0 rounded-xl shadow-2xl bg-[#EBEBEB]" />
        )
      )}
      <svg
        ref={svgRef}
        width={width}
        height={height}
        className="absolute inset-0 z-10"
        style={{ pointerEvents: (params.showPoints || params.customPolygon) ? 'auto' : 'none' }}
      >
        {params.customPolygon && (
            <g>
                <polygon 
                    points={params.customPolygon.map(p => `${p.x * (width/512)},${p.y * (height/512)}`).join(' ')} 
                    fill="rgba(16, 185, 129, 0.05)" 
                    stroke="#10b981" 
                    strokeWidth="2" 
                    strokeDasharray="4 4"
                />
                {params.customPolygon.map((p, i) => (
                    <g
                        key={`poly_${i}`}
                        transform={`translate(${p.x * (width/512)}, ${p.y * (height/512)})`}
                        onPointerDown={(e) => handlePointerDown(e, `poly_${i}`)}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        className="cursor-grab active:cursor-grabbing"
                    >
                        <circle r={12} fill="transparent" stroke="#10b981" strokeWidth={2} />
                        <circle r={5} fill="#10b981" />
                    </g>
                ))}
            </g>
        )}
        {params.showPoints && (
            <>
                {renderPoint('core1', params.core1, '#ef4444', 'C1')}
                {renderPoint('core2', params.core2, '#ef4444', 'C2')}
                {renderPoint('delta1', params.delta1, '#3b82f6', 'D1')}
                {renderPoint('delta2', params.delta2, '#3b82f6', 'D2')}
            </>
        )}
      </svg>
    </div>
  );
}
