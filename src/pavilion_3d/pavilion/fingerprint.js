import * as THREE from 'three';
import { seededRandom } from '../utils/math.js';

/**
 * Fingerprint pattern texture generator.
 *
 * Pipeline:
 * 1. Collect active fingerprints from flat params
 * 2. Build per-fingerprint orientation field (whorl / loop / arch)
 * 3. Blend overlapping fields via circular mean (2θ trick for π-periodicity)
 * 4. Trace streamlines through the blended field
 * 5. Place dots along streamlines
 * 6. Render dots to Canvas2D → THREE.CanvasTexture (alphaMap)
 */

// ---------------------------------------------------------------------------
// Geometry constants for realistic fingerprint shapes
// ---------------------------------------------------------------------------

const WHORL_ASPECT_RATIO = 1.35; // base height:width ratio
const WHORL_DELTA_SPREAD = 38;   // horizontal offset of each delta from core
const WHORL_DELTA_DROP   = 25;   // vertical offset of deltas below core

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFingerprintParams(p, i) {
  return {
    x:         p[`fp${i}X`],
    y:         p[`fp${i}Y`],
    scale:     p[`fp${i}Scale`],
    rotation:  p[`fp${i}Rotation`],
    type:      p[`fp${i}Type`],
    tightness: p[`fp${i}Tightness`],
    priority:  p[`fp${i}Priority`],
    index:     i,
  };
}

/** Orientation angle for a single fingerprint type at local coordinates (lx, ly). */
function computeOrientation(lx, ly, type, tightness) {
  const dist = Math.sqrt(lx * lx + ly * ly);
  const baseAngle = Math.atan2(ly, lx);

  switch (type) {
    case 'whorl': {
      // Zero-pole singularity model for realistic whorl topology.
      // One core (+½ index) at origin; two deltas (−½) below and to the sides.
      // Φ(z) = (z − z_core) / ((z − z_δ1)(z − z_δ2))
      // θ = ½ · arg(Φ)
      const ds = WHORL_DELTA_SPREAD;
      const dd = WHORL_DELTA_DROP;

      // Numerator: z − z_core  (core at origin)
      const nRe = lx, nIm = ly;
      // z − z_δ1  (delta 1: left-below)
      const d1Re = lx + ds, d1Im = ly - dd;
      // z − z_δ2  (delta 2: right-below)
      const d2Re = lx - ds, d2Im = ly - dd;

      // Denominator: (z−z_δ1)·(z−z_δ2)
      const denRe = d1Re * d2Re - d1Im * d2Im;
      const denIm = d1Re * d2Im + d1Im * d2Re;
      const denMag2 = denRe * denRe + denIm * denIm + 0.1;

      // Complex quotient
      const qRe = (nRe * denRe + nIm * denIm) / denMag2;
      const qIm = (nIm * denRe - nRe * denIm) / denMag2;

      let theta = 0.5 * Math.atan2(qIm, qRe);

      // Distance-dependent spiral: ridges wind more as they move outward.
      // With the π-periodicity fix in the streamline tracer, streamlines
      // now properly wrap around the core, making the spiral visible.
      theta += tightness * dist * 3;

      return theta;
    }
    case 'loop': {
      // Two singularities (core + delta) create a U-shaped pattern
      const deltaY = 120; // delta below core
      const angleToCore = Math.atan2(ly, lx);
      const angleToDelta = Math.atan2(ly - deltaY, lx);
      return 0.5 * (angleToCore + angleToDelta) + tightness * dist * 40;
    }
    case 'arch':
    default:
      // Gentle wave across the print
      return tightness * 80 * Math.atan2(ly, Math.max(Math.abs(lx), 1));
  }
}

/** Transform pixel (px,py) into local fingerprint coords */
function toLocal(px, py, fp, resolution) {
  const cx = fp.x * resolution;
  const cy = fp.y * resolution;
  // translate then rotate
  const dx = px - cx;
  const dy = py - cy;
  const cosR = Math.cos(-fp.rotation);
  const sinR = Math.sin(-fp.rotation);
  const lx = (dx * cosR - dy * sinR) / fp.scale;
  const ly = (dx * sinR + dy * cosR) / fp.scale;
  return [lx, ly];
}

/** Finger-shaped distance — egg-like oval: rounded tip, slightly wider pad */
function ellipticalDist(lx, ly, type) {
  if (type !== 'whorl') return Math.sqrt(lx * lx + ly * ly);
  // Asymmetric squeeze: narrower toward fingertip (−ly), wider at pad (+ly).
  // Using ly/norm makes it resolution-independent (always in [−1,1]).
  const norm = Math.sqrt(lx * lx + ly * ly) + 1;
  const squeeze = WHORL_ASPECT_RATIO + 0.15 * (ly / norm);
  return Math.sqrt((lx * squeeze) * (lx * squeeze) + ly * ly);
}

/**
 * Blended orientation at (px, py) across all active fingerprints.
 * Uses the 2θ trick: orientations are π-periodic so we double the angle,
 * average as vectors, then halve.
 */
function getBlendedOrientation(px, py, fingerprints, resolution) {
  let sumX = 0, sumY = 0;
  let totalWeight = 0;
  const maxRadius = resolution * 0.45; // fingerprint influence radius

  for (const fp of fingerprints) {
    const [lx, ly] = toLocal(px, py, fp, resolution);
    const localDist = ellipticalDist(lx, ly, fp.type);
    const effectiveRadius = maxRadius * fp.scale;

    if (localDist > effectiveRadius) continue;

    // Normalise local coords to 250px-equivalent so orientation is
    // resolution-independent (pattern looks the same at any resolution).
    const normFactor = 250 / resolution;
    const theta = computeOrientation(lx * normFactor, ly * normFactor, fp.type, fp.tightness);

    // Weight: Gaussian falloff from center
    const sigma = effectiveRadius * 0.5;
    const w = Math.exp(-(localDist * localDist) / (2 * sigma * sigma));

    // 2θ trick for π-periodic averaging
    sumX += w * Math.cos(2 * theta);
    sumY += w * Math.sin(2 * theta);
    totalWeight += w;
  }

  if (totalWeight < 0.001) return null; // no fingerprint influence here

  return Math.atan2(sumY, sumX) / 2;
}

/**
 * Which fingerprint "owns" this pixel? Returns the one with highest priority
 * (lowest priority number = foreground) that covers this point.
 */
function getOwnerFP(px, py, fingerprints, resolution) {
  let best = null;
  let bestPriority = Infinity;
  const maxRadius = resolution * 0.45;

  for (const fp of fingerprints) {
    const [lx, ly] = toLocal(px, py, fp, resolution);
    const localDist = ellipticalDist(lx, ly, fp.type);
    const effectiveRadius = maxRadius * fp.scale;
    if (localDist > effectiveRadius && fp.priority < bestPriority) continue;
    if (localDist <= effectiveRadius && fp.priority < bestPriority) {
      best = fp;
      bestPriority = fp.priority;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Streamline tracer
// ---------------------------------------------------------------------------

function traceStreamline(startX, startY, orientFunc, stepSize, maxSteps, width, height, coverage, cellSize) {
  const points = [];

  // Trace in both directions from the seed
  for (const direction of [1, -1]) {
    let x = startX;
    let y = startY;
    let prevDx = 0, prevDy = 0;

    for (let step = 0; step < maxSteps; step++) {
      // Bounds check
      if (x < 0 || x >= width || y < 0 || y >= height) break;

      // Coverage check — prevent overcrowding
      const ci = Math.floor(x / cellSize);
      const cj = Math.floor(y / cellSize);
      const coverageIdx = cj * Math.ceil(width / cellSize) + ci;
      if (coverage[coverageIdx] > 3) break;

      points.push([x, y]);
      coverage[coverageIdx]++;

      const theta = orientFunc(x, y);
      if (theta === null) break;

      // Step perpendicular to ridge orientation (= along the ridge)
      let dx = Math.cos(theta + Math.PI / 2) * stepSize;
      let dy = Math.sin(theta + Math.PI / 2) * stepSize;

      // π-periodicity fix: orientation is a LINE direction (mod π), so
      // theta and theta+π are the same ridge.  If the new step direction
      // flips relative to the previous one (dot-product < 0), reverse it
      // to keep the streamline continuous through ½-index singularities.
      if (step > 0 && dx * prevDx + dy * prevDy < 0) {
        dx = -dx;
        dy = -dy;
      }

      prevDx = dx;
      prevDy = dy;
      x += direction * dx;
      y += direction * dy;
    }
  }

  return points;
}

// ---------------------------------------------------------------------------
// Seed points generator
// ---------------------------------------------------------------------------

function generateSeedPoints(fingerprints, resolution, ridgeSpacing, rng) {
  const seeds = [];

  // Radial seeds from each fingerprint core (elliptical for finger-shaped types)
  for (const fp of fingerprints) {
    const cx = fp.x * resolution;
    const cy = fp.y * resolution;
    const maxR = resolution * 0.45 * fp.scale;
    const ar = fp.type === 'whorl' ? WHORL_ASPECT_RATIO : 1;
    const ringCount = Math.floor(maxR / ridgeSpacing);

    for (let ring = 2; ring < ringCount; ring++) {
      const r = ring * ridgeSpacing;
      const circumference = 2 * Math.PI * r;
      const pointsOnRing = Math.max(4, Math.floor(circumference / (ridgeSpacing * 3)));

      for (let k = 0; k < pointsOnRing; k++) {
        const angle = (k / pointsOnRing) * Math.PI * 2 + rng() * 0.3;
        const jitter = (rng() - 0.5) * ridgeSpacing * 0.4;
        const rr = r + jitter;
        // Apply rotation then place seed (elliptical: narrower in local-x)
        const cosR = Math.cos(fp.rotation);
        const sinR = Math.sin(fp.rotation);
        const sx = rr * Math.cos(angle) / ar;
        const sy = rr * Math.sin(angle);
        seeds.push([
          cx + sx * cosR - sy * sinR,
          cy + sx * sinR + sy * cosR,
        ]);
      }
    }
  }

  // Shuffle for more organic tracing order
  for (let i = seeds.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [seeds[i], seeds[j]] = [seeds[j], seeds[i]];
  }

  return seeds;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

export function generateFingerprintTexture(p, overrideResolution) {
  const resolution = overrideResolution || p.fpResolution;
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d');

  // White background = fully opaque (when used as alphaMap)
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, resolution, resolution);

  // Collect active fingerprints
  const count = Math.min(p.fpCount, 8);
  if (count === 0) return new THREE.CanvasTexture(canvas);

  const fingerprints = [];
  for (let i = 0; i < count; i++) {
    fingerprints.push(getFingerprintParams(p, i));
  }

  // Sort by priority so foreground first
  fingerprints.sort((a, b) => a.priority - b.priority);

  const rng = seededRandom(p.fpSeed);
  const ridgeSpacing = p.fpRidgeSpacing * (resolution / 2048); // scale to resolution
  const stepSize = ridgeSpacing * 0.5;
  const maxSteps = Math.floor(resolution * 1.5);
  const dotGap = p.fpDotGap * (resolution / 2048);
  const dotSize = p.fpDotSize * (resolution / 2048);

  // Coverage grid
  const cellSize = ridgeSpacing * 0.8;
  const gridW = Math.ceil(resolution / cellSize);
  const gridH = Math.ceil(resolution / cellSize);
  const coverage = new Uint8Array(gridW * gridH);

  // Orientation function
  const orientFunc = (px, py) => getBlendedOrientation(px, py, fingerprints, resolution);

  // Generate seed points
  const seeds = generateSeedPoints(fingerprints, resolution, ridgeSpacing, rng);

  // Trace streamlines and collect dots
  const fgDots = []; // foreground dots (full opacity)
  const bgDots = []; // background dots (reduced opacity)

  for (const [sx, sy] of seeds) {
    const streamline = traceStreamline(sx, sy, orientFunc, stepSize, maxSteps, resolution, resolution, coverage, cellSize);

    if (streamline.length < 3) continue;

    // Place dots along streamline at regular intervals
    let accumulated = 0;
    for (let i = 1; i < streamline.length; i++) {
      const dx = streamline[i][0] - streamline[i - 1][0];
      const dy = streamline[i][1] - streamline[i - 1][1];
      accumulated += Math.sqrt(dx * dx + dy * dy);

      if (accumulated >= dotGap) {
        accumulated = 0;
        const px = streamline[i][0];
        const py = streamline[i][1];

        // Determine if this dot is foreground or background
        const owner = getOwnerFP(px, py, fingerprints, resolution);
        if (!owner) continue;

        // Check how many fingerprints cover this point
        let coverCount = 0;
        let bestPriority = Infinity;
        for (const fp of fingerprints) {
          const [lx, ly] = toLocal(px, py, fp, resolution);
          const localDist = ellipticalDist(lx, ly, fp.type);
          const effectiveRadius = resolution * 0.45 * fp.scale;
          if (localDist <= effectiveRadius) {
            coverCount++;
            if (fp.priority < bestPriority) bestPriority = fp.priority;
          }
        }

        // If multiple fingerprints cover this point, only the highest-priority
        // one gets full dots; others get smaller, fainter dots
        if (coverCount > 1 && owner.priority !== bestPriority) {
          bgDots.push([px, py, dotSize * 0.6]);
        } else {
          fgDots.push([px, py, dotSize]);
        }
      }
    }
  }

  // Render dots — black circles on white (black = hole in alphaMap)
  // Foreground: full opacity
  ctx.fillStyle = 'black';
  ctx.beginPath();
  for (const [x, y, r] of fgDots) {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();

  // Background: reduced opacity
  if (bgDots.length > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${p.fpBackgroundOpacity})`;
    ctx.beginPath();
    for (const [x, y, r] of bgDots) {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * Export fingerprint texture as PNG download.
 */
export function exportFingerprintTexture(p) {
  const resolution = p.fpResolution;
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  // Re-use the generator but grab the canvas from the texture
  const texture = generateFingerprintTexture(p, resolution);
  const src = texture.image;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0);

  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fingerprint-texture-${resolution}px.png`;
    a.click();
    URL.revokeObjectURL(url);
  });

  texture.dispose();
}
