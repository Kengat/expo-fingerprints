import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { findShellMesh, getBakePromise } from '../pavilion/index.js';

export function captureScreenshot(renderer) {
  const dataURL = renderer.domElement.toDataURL('image/png');
  const link = document.createElement('a');
  link.download = `pavilion-${Date.now()}.png`;
  link.href = dataURL;
  link.click();
}

function findRootGroup(scene) {
  for (const child of scene.children) {
    if (child.isGroup && child.userData.bakePromise) return child;
  }
  return scene;
}

// ---------------------------------------------------------------------------
// Reverse the normalizeGeometry + importScale transform so exported geometry
// matches the original file coordinates.
//
// Forward chain (import → display):
//   1. normalizeGeometry:  v' = (v - center) * ns + (0, h/2, 0)
//   2. buildPavilion:      v'' = v' * is            (only when is ≠ 1)
//
// Inverse:  T(center) · S(1/ns) · T(0, -h/2, 0) · S(1/is)
// ---------------------------------------------------------------------------

function buildImportInverseMatrix(params) {
  if (!params?.importMode || !params._importedGeometry) return null;
  const t = params._importedGeometry.userData?.importTransform;
  if (!t) return null;

  const is = params.importScale || 1;
  const ns = t.scale;
  const h  = t.targetHeight;

  const m = new THREE.Matrix4();
  m.makeScale(1 / is, 1 / is, 1 / is);
  m.premultiply(new THREE.Matrix4().makeTranslation(0, -h / 2, 0));
  m.premultiply(new THREE.Matrix4().makeScale(1 / ns, 1 / ns, 1 / ns));
  m.premultiply(new THREE.Matrix4().makeTranslation(t.centerX, t.centerY, t.centerZ));
  return m;
}

function applyExportTransform(geometry, params) {
  const inv = buildImportInverseMatrix(params);
  if (!inv) return null;
  geometry.applyMatrix4(inv);
  return inv;
}

function restoreExportTransform(geometry, inverseMatrix) {
  if (!inverseMatrix) return;
  const fwd = inverseMatrix.clone().invert();
  geometry.applyMatrix4(fwd);
}

export function exportGLTF(scene, params) {
  const rootGroup = findRootGroup(scene);
  const bakePromise = getBakePromise(rootGroup);

  bakePromise.then(() => {
    const shell = findShellMesh(scene);
    let target = shell || scene;

    const inv = (target === shell) ? applyExportTransform(target.geometry, params) : null;

    const exporter = new GLTFExporter();
    exporter.parse(
      target,
      (result) => {
        restoreExportTransform(target.geometry, inv);

        const output = JSON.stringify(result);
        const blob = new Blob([output], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `pavilion-shell-${Date.now()}.gltf`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
      },
      (error) => {
        restoreExportTransform(target.geometry, inv);
        console.error('GLTF export error:', error);
      },
      { binary: false }
    );
  });
}

export function exportOBJ(scene, params) {
  const rootGroup = findRootGroup(scene);
  const bakePromise = getBakePromise(rootGroup);

  bakePromise.then(() => {
    const shell = findShellMesh(scene);
    let target = shell || scene;

    const inv = (target === shell) ? applyExportTransform(target.geometry, params) : null;

    const exporter = new OBJExporter();
    const result = exporter.parse(target);

    restoreExportTransform(target.geometry, inv);

    const blob = new Blob([result], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `pavilion-shell-${Date.now()}.obj`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  });
}

export function exportSTL(scene, params) {
  const rootGroup = findRootGroup(scene);
  const bakePromise = getBakePromise(rootGroup);

  bakePromise.then(() => {
    const shell = findShellMesh(scene);
    let target = shell || scene;

    const inv = (target === shell) ? applyExportTransform(target.geometry, params) : null;

    const exporter = new STLExporter();
    const result = exporter.parse(target);

    restoreExportTransform(target.geometry, inv);

    const blob = new Blob([result], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `pavilion-shell-${Date.now()}.stl`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  });
}
