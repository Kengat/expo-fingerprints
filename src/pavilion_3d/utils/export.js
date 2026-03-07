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

export function exportGLTF(scene) {
  const rootGroup = findRootGroup(scene);
  const bakePromise = getBakePromise(rootGroup);

  bakePromise.then(() => {
    const shell = findShellMesh(scene);
    const target = shell || scene;

    const exporter = new GLTFExporter();
    exporter.parse(
      target,
      (result) => {
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
        console.error('GLTF export error:', error);
      },
      { binary: false }
    );
  });
}

export function exportOBJ(scene) {
  const rootGroup = findRootGroup(scene);
  const bakePromise = getBakePromise(rootGroup);

  bakePromise.then(() => {
    const shell = findShellMesh(scene);
    const target = shell || scene;

    const exporter = new OBJExporter();
    const result = exporter.parse(target);
    const blob = new Blob([result], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `pavilion-shell-${Date.now()}.obj`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  });
}

export function exportSTL(scene) {
  const rootGroup = findRootGroup(scene);
  const bakePromise = getBakePromise(rootGroup);

  bakePromise.then(() => {
    const shell = findShellMesh(scene);
    const target = shell || scene;

    const exporter = new STLExporter();
    const result = exporter.parse(target);
    const blob = new Blob([result], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `pavilion-shell-${Date.now()}.stl`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  });
}
