import * as THREE from 'three';
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';

function hyperboloidShell(u, v, target, p) {
  const angle = u * p.openingAngle;
  const t = (v - 0.5) * 2; // -1 to 1
  const h = t * p.height / 2;

  // Hyperboloid radius varies with height
  const waist = 0.6;
  const r = Math.sqrt(waist * waist + t * t);
  const radiusAtHeight = THREE.MathUtils.lerp(p.radiusBottom, p.radiusTop, v) * r * p.taper;

  // Asymmetry
  const asymX = p.asymmetryX * Math.sin(v * Math.PI);
  const asymZ = p.asymmetryZ * Math.sin(v * Math.PI);

  // Twist
  const twistAngle = angle + p.twist * v;

  const x = radiusAtHeight * Math.cos(twistAngle) + asymX;
  const z = radiusAtHeight * Math.sin(twistAngle) + asymZ;
  const y = h + p.height / 2;

  target.set(x, y, z);
}

function hyperbolicParaboloid(u, v, target, p) {
  const x = (u - 0.5) * p.radiusBottom * 2;
  const z = (v - 0.5) * p.radiusBottom * 2;
  const curvature = Math.max(p.radiusTop, 0.1);
  const y = (x * x / (curvature * 2) - z * z / (curvature * 2)) * p.taper + p.height / 2;

  // Apply twist
  const angle = p.twist * ((u + v) / 2 - 0.5);
  const rx = x * Math.cos(angle) - z * Math.sin(angle);
  const rz = x * Math.sin(angle) + z * Math.cos(angle);

  target.set(rx + p.asymmetryX, y, rz + p.asymmetryZ);
}

function toroidalShell(u, v, target, p) {
  const angle = u * p.openingAngle;
  const phi = v * Math.PI * 2;
  const R = p.radiusBottom;
  const r = p.radiusTop * 0.4;

  const tubeX = R + r * Math.cos(phi);
  const tubeY = r * Math.sin(phi);

  // Twist
  const twistAngle = angle + p.twist * v;

  const x = tubeX * Math.cos(twistAngle) * p.taper;
  const y = tubeY + p.height / 2;
  const z = tubeX * Math.sin(twistAngle) * p.taper;

  target.set(x + p.asymmetryX * Math.sin(v * Math.PI), y, z + p.asymmetryZ * Math.sin(v * Math.PI));
}

function superformula(theta, m, n1, n2, n3) {
  const t1 = Math.abs(Math.cos(m * theta / 4));
  const t2 = Math.abs(Math.sin(m * theta / 4));
  const r = Math.pow(Math.pow(t1, n2) + Math.pow(t2, n3), -1 / n1);
  return isFinite(r) ? r : 1;
}

function blobShell(u, v, target, p) {
  const theta = u * Math.PI * 2;
  const phi = v * Math.PI;

  // Superformula with variable complexity
  const m = 3 + Math.floor(p.radiusTop / 3);
  const r1 = superformula(theta, m, 1, 1, 1);
  const r2 = superformula(phi, m, 1, 1, 1);
  const r = r1 * r2 * p.radiusBottom * 0.5 * p.taper;

  let x = r * Math.sin(phi) * Math.cos(theta);
  let z = r * Math.sin(phi) * Math.sin(theta);
  let y = r * Math.cos(phi) * (p.height / Math.max(p.radiusBottom, 1)) + p.height / 2;

  // Twist
  const twistAngle = p.twist * (v - 0.5);
  const rx = x * Math.cos(twistAngle) - z * Math.sin(twistAngle);
  const rz = x * Math.sin(twistAngle) + z * Math.cos(twistAngle);

  target.set(rx + p.asymmetryX, y, rz + p.asymmetryZ);
}

const shellFunctions = {
  hyperboloid: hyperboloidShell,
  paraboloid: hyperbolicParaboloid,
  torus: toroidalShell,
  blob: blobShell,
};

export function getShellFunction(p) {
  const fn = shellFunctions[p.shellType] || hyperboloidShell;
  return (u, v, target) => fn(u, v, target, p);
}

export function createShellGeometry(p) {
  const func = getShellFunction(p);
  const geom = new ParametricGeometry(func, p.segments, p.segments);
  return geom;
}
