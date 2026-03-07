import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

export function captureScreenshot(renderer) {
  const dataURL = renderer.domElement.toDataURL('image/png');
  const link = document.createElement('a');
  link.download = `pavilion-${Date.now()}.png`;
  link.href = dataURL;
  link.click();
}

export function exportGLTF(scene) {
  const exporter = new GLTFExporter();
  exporter.parse(
    scene,
    (result) => {
      const output = JSON.stringify(result);
      const blob = new Blob([output], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `pavilion-${Date.now()}.gltf`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    },
    (error) => {
      console.error('GLTF export error:', error);
    },
    { binary: false }
  );
}

export function exportOBJ(scene) {
  const exporter = new OBJExporter();
  const result = exporter.parse(scene);
  const blob = new Blob([result], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = `pavilion-${Date.now()}.obj`;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}
