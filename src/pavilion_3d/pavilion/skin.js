import * as THREE from 'three';
import { seededRandom } from '../utils/math.js';

// Generate a procedural perforation alpha map
function generatePerforationTexture(p) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1024, 1024);

  ctx.fillStyle = 'black';
  const gridSize = Math.max(5, Math.floor(30 * p.perforationDensity));
  const cellSize = 1024 / gridSize;

  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const x = (i + 0.5) * cellSize;
      const y = (j + 0.5) * cellSize;
      // Variable radius: larger at top, smaller at bottom
      const gradient = 1 - j / gridSize * 0.5;
      const radius = cellSize * 0.3 * gradient;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(radius, 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Generate voronoi-style panel texture
function generateVoronoiTexture(p) {
  const canvas = document.createElement('canvas');
  const size = 1024;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Generate seed points
  const rng = seededRandom(p.noiseSeed);
  const seeds = [];
  for (let i = 0; i < p.voronoiCells; i++) {
    seeds.push({
      x: rng() * size,
      y: rng() * size,
    });
  }

  // Draw voronoi cells using pixel-based nearest neighbor
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;

  // Assign colors per cell
  const cellColors = seeds.map(() => {
    const brightness = 140 + Math.floor(rng() * 80);
    return [brightness, brightness, brightness];
  });

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let minDist = Infinity;
      let secondDist = Infinity;
      let closestCell = 0;

      for (let i = 0; i < seeds.length; i++) {
        const dx = px - seeds[i].x;
        const dy = py - seeds[i].y;
        const dist = dx * dx + dy * dy;
        if (dist < minDist) {
          secondDist = minDist;
          minDist = dist;
          closestCell = i;
        } else if (dist < secondDist) {
          secondDist = dist;
        }
      }

      const idx = (py * size + px) * 4;
      // Edge detection: if close to boundary between cells
      const edgeDist = Math.sqrt(secondDist) - Math.sqrt(minDist);
      if (edgeDist < 3 + p.voronoiDepth * 8) {
        // Dark edge (gap between panels)
        data[idx] = 30;
        data[idx + 1] = 30;
        data[idx + 2] = 30;
      } else {
        const c = cellColors[closestCell];
        data[idx] = c[0];
        data[idx + 1] = c[1];
        data[idx + 2] = c[2];
      }
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

// Generate islamic geometric pattern texture
function generateIslamicTexture(p) {
  const canvas = document.createElement('canvas');
  const size = 1024;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#c8a882';
  ctx.fillRect(0, 0, size, size);

  const n = p.islamicStarPoints;
  const tileSize = size / 6;
  ctx.strokeStyle = '#8b7355';
  ctx.lineWidth = 2;

  for (let row = -1; row < 8; row++) {
    for (let col = -1; col < 8; col++) {
      const cx = col * tileSize + tileSize / 2;
      const cy = row * tileSize + tileSize / 2;
      const outerR = tileSize * 0.45;
      const innerR = tileSize * 0.2;

      // Star polygon
      ctx.beginPath();
      for (let i = 0; i < n * 2; i++) {
        const angle = (i * Math.PI) / n - Math.PI / 2;
        const r = i % 2 === 0 ? outerR : innerR;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();

      // Inner decoration circle
      ctx.beginPath();
      ctx.arc(cx, cy, innerR * 0.6, 0, Math.PI * 2);
      ctx.stroke();

      // Connecting lines to neighbors
      for (let i = 0; i < n; i++) {
        const angle = (i * 2 * Math.PI) / n;
        ctx.beginPath();
        ctx.moveTo(cx + outerR * Math.cos(angle), cy + outerR * Math.sin(angle));
        ctx.lineTo(cx + tileSize * 0.5 * Math.cos(angle), cy + tileSize * 0.5 * Math.sin(angle));
        ctx.stroke();
      }
    }
  }

  return new THREE.CanvasTexture(canvas);
}

// Generate hexagonal panel texture
function generateHexTexture(p) {
  const canvas = document.createElement('canvas');
  const size = 1024;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#c8a882';
  ctx.fillRect(0, 0, size, size);

  const hexR = 30 * p.hexScale;
  const hexH = hexR * Math.sqrt(3);
  const cols = Math.ceil(size / (hexR * 1.5)) + 2;
  const rows = Math.ceil(size / hexH) + 2;

  ctx.strokeStyle = '#5a4a3a';
  ctx.lineWidth = 2;

  for (let row = -1; row < rows; row++) {
    for (let col = -1; col < cols; col++) {
      const cx = col * hexR * 1.5;
      const cy = row * hexH + (col % 2 === 0 ? 0 : hexH / 2);

      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        const x = cx + hexR * 0.9 * Math.cos(angle);
        const y = cy + hexR * 0.9 * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  return new THREE.CanvasTexture(canvas);
}

// Generate Ukrainian vyshyvanka embroidery pattern texture
function generateVyshyvankaTexture(p) {
  const canvas = document.createElement('canvas');
  const size = 1024;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // White linen background
  ctx.fillStyle = '#f5f0e8';
  ctx.fillRect(0, 0, size, size);

  const tileSize = size / 8;
  const colors = ['#cc2222', '#1a1a1a', '#cc2222', '#2244aa'];

  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const cx = col * tileSize;
      const cy = row * tileSize;
      const colorIdx = (row + col) % colors.length;

      // Cross-stitch diamond motif
      ctx.strokeStyle = colors[colorIdx];
      ctx.lineWidth = 2;
      ctx.fillStyle = colors[colorIdx];

      const s = tileSize * 0.4;
      const mx = cx + tileSize / 2;
      const my = cy + tileSize / 2;

      // Diamond
      ctx.beginPath();
      ctx.moveTo(mx, my - s);
      ctx.lineTo(mx + s, my);
      ctx.lineTo(mx, my + s);
      ctx.lineTo(mx - s, my);
      ctx.closePath();
      ctx.stroke();

      // Inner smaller diamond
      const s2 = s * 0.5;
      ctx.beginPath();
      ctx.moveTo(mx, my - s2);
      ctx.lineTo(mx + s2, my);
      ctx.lineTo(mx, my + s2);
      ctx.lineTo(mx - s2, my);
      ctx.closePath();
      ctx.fill();

      // Cross lines extending from diamond
      ctx.beginPath();
      ctx.moveTo(mx - s * 0.3, my - s); ctx.lineTo(mx + s * 0.3, my - s);
      ctx.moveTo(mx - s * 0.3, my + s); ctx.lineTo(mx + s * 0.3, my + s);
      ctx.moveTo(mx - s, my - s * 0.3); ctx.lineTo(mx - s, my + s * 0.3);
      ctx.moveTo(mx + s, my - s * 0.3); ctx.lineTo(mx + s, my + s * 0.3);
      ctx.stroke();

      // Small dots at corners
      const dotR = 3;
      ctx.beginPath();
      ctx.arc(mx - s * 0.7, my - s * 0.7, dotR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      ctx.arc(mx + s * 0.7, my - s * 0.7, dotR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      ctx.arc(mx - s * 0.7, my + s * 0.7, dotR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      ctx.arc(mx + s * 0.7, my + s * 0.7, dotR, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Horizontal band accents (typical vyshyvanka horizontal stripes)
  for (let band = 0; band < 3; band++) {
    const by = (band + 1) * size / 4;
    ctx.strokeStyle = '#cc2222';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let x = 0; x < size; x += 12) {
      ctx.moveTo(x, by - 2);
      ctx.lineTo(x + 6, by + 2);
      ctx.moveTo(x + 6, by + 2);
      ctx.lineTo(x + 12, by - 2);
    }
    ctx.stroke();
  }

  return new THREE.CanvasTexture(canvas);
}

export function applySkin(material, p) {
  // Reset skin-related material properties
  material.alphaMap = null;
  material.alphaTest = 0;
  material.transparent = false;
  material.map = null;
  material.displacementMap = null;
  material.displacementScale = 0;
  material.displacementBias = 0;

  switch (p.skinType) {
    case 'perforated': {
      const tex = generatePerforationTexture(p);
      material.alphaMap = tex;
      material.alphaTest = 0.5;
      material.transparent = true;
      material.side = THREE.DoubleSide;
      break;
    }
    case 'voronoi': {
      const tex = generateVoronoiTexture(p);
      material.map = tex;
      material.side = THREE.DoubleSide;
      break;
    }
    case 'islamic': {
      const tex = generateIslamicTexture(p);
      material.map = tex;
      material.side = THREE.DoubleSide;
      break;
    }
    case 'hexagonal': {
      const tex = generateHexTexture(p);
      material.map = tex;
      material.side = THREE.DoubleSide;
      break;
    }
    case 'vyshyvanka': {
      const tex = generateVyshyvankaTexture(p);
      material.map = tex;
      material.side = THREE.DoubleSide;
      break;
    }
    case 'fingerprint': {
      // Use the direct texture generated by the React 2D Editor
      if (p._fingerprintTexture) {
        if (p.fingerprintRenderMode === 'surface') {
          material.alphaMap = null;
          material.alphaTest = 0;
          material.transparent = false;
        } else if (p.fingerprintRenderMode === 'paint') {
          material.map = p._fingerprintTexture;
          material.color.set('#ffffff');
          material.alphaMap = null;
          material.alphaTest = 0;
          material.transparent = false;
        } else if (!p.bakeHoles) {
          material.alphaMap = p._fingerprintTexture;
          material.alphaTest = 0.1;
          material.transparent = true;
        }

        // Visual shader bump map (Preview Mode)
        // material.displacementMap = p._fingerprintTexture;
        // material.displacementScale = -0.4;
        // material.displacementBias = 0.4;
      }
      material.side = THREE.DoubleSide;
      break;
    }
    default:
      material.side = THREE.DoubleSide;
      break;
  }

  material.needsUpdate = true;
}
