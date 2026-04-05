import GUI from 'lil-gui';
import { presets } from './params.js';

export function setupGUI(params, callbacks) {
  const gui = new GUI({ width: 320, title: 'EXPO 2030 — Pavilion UA', autoPlace: false });

  const {
    onParamChange,
    onScreenshot,
    onExportGLTF,
    onExportOBJ,
    onExportSTL,
    onImportModel,
    onImportSecondaryModel,
    onClearImportedGeometry,
    onClearSecondaryImportedGeometry,
    onRepairImportedGeometry
  } = callbacks;

  // Presets
  const presetNames = Object.keys(presets);
  const presetObj = { preset: '— Select Preset —' };
  let onPresetApplied = null; // set later for fingerprint subfolder refresh
  gui.add(presetObj, 'preset', ['— Select Preset —', ...presetNames]).name('Preset').onChange(name => {

    if (name === '— Select Preset —') return;
    const preset = presets[name];
    if (!preset) return;
    Object.keys(preset).forEach(key => {
      if (key in params) params[key] = preset[key];
    });
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    if (onPresetApplied) onPresetApplied();
    onParamChange();
  });

  // Shell Form
  const shell = gui.addFolder('Shell Form');
  shell.add(params, 'shellType', ['hyperboloid', 'paraboloid', 'torus', 'blob']).name('Type').onChange(onParamChange);
  shell.add(params, 'height', 3, 40, 0.5).name('Height').onChange(onParamChange);
  shell.add(params, 'radiusBottom', 2, 30, 0.5).name('Radius Bottom').onChange(onParamChange);
  shell.add(params, 'radiusTop', 1, 25, 0.5).name('Radius Top').onChange(onParamChange);
  shell.add(params, 'segments', 32, 256, 1).name('Resolution').onChange(onParamChange);
  shell.add(params, 'twist', -Math.PI * 2, Math.PI * 2, 0.01).name('Twist').onChange(onParamChange);
  shell.add(params, 'taper', 0.1, 3.0, 0.01).name('Taper').onChange(onParamChange);
  shell.add(params, 'asymmetryX', -5, 5, 0.1).name('Asymmetry X').onChange(onParamChange);
  shell.add(params, 'asymmetryZ', -5, 5, 0.1).name('Asymmetry Z').onChange(onParamChange);
  shell.add(params, 'openingAngle', 0.3, Math.PI * 2, 0.01).name('Opening Angle').onChange(onParamChange);
  shell.open();

  // Deformation
  const deform = gui.addFolder('Deformation');
  deform.add(params, 'noiseAmplitude', 0, 5, 0.01).name('Noise Amplitude').onChange(onParamChange);
  deform.add(params, 'noiseFrequency', 0.01, 2, 0.01).name('Noise Frequency').onChange(onParamChange);
  deform.add(params, 'noiseOctaves', 1, 6, 1).name('Noise Octaves').onChange(onParamChange);
  deform.add(params, 'noiseSeed', 0, 1000, 1).name('Seed').onChange(onParamChange);
  deform.add(params, 'attractorStrength', -5, 5, 0.1).name('Attractor Force').onChange(onParamChange);
  deform.add(params, 'attractorX', -20, 20, 0.5).name('Attractor X').onChange(onParamChange);
  deform.add(params, 'attractorY', 0, 30, 0.5).name('Attractor Y').onChange(onParamChange);
  deform.add(params, 'attractorZ', -20, 20, 0.5).name('Attractor Z').onChange(onParamChange);
  deform.add(params, 'waveAmplitude', 0, 5, 0.01).name('Wave Amplitude').onChange(onParamChange);
  deform.add(params, 'waveFrequency', 0.1, 10, 0.1).name('Wave Frequency').onChange(onParamChange);
  deform.add(params, 'bendAngle', -2, 2, 0.01).name('Bend').onChange(onParamChange);
  deform.close();

  // Structure
  const struct = gui.addFolder('Structure');
  struct.add(params, 'ribCount', 0, 40, 1).name('Rib Count').onChange(onParamChange);
  struct.add(params, 'ribThickness', 0.05, 0.5, 0.01).name('Rib Thickness').onChange(onParamChange);
  struct.add(params, 'ribDirection', ['meridional', 'parallel', 'diagonal']).name('Rib Direction').onChange(onParamChange);
  struct.add(params, 'columnCount', 0, 12, 1).name('Columns').onChange(onParamChange);
  struct.add(params, 'columnBranching', 1, 6, 1).name('Column Branches').onChange(onParamChange);
  struct.close();

  // Skin / Facade
  const skin = gui.addFolder('Skin / Facade');
  skin.add(params, 'skinType', ['none', 'vyshyvanka', 'voronoi', 'islamic', 'hexagonal', 'perforated', 'fingerprint']).name('Skin Type').onChange(onParamChange);
  skin.add(params, 'voronoiCells', 10, 200, 1).name('Voronoi Cells').onChange(onParamChange);
  skin.add(params, 'voronoiDepth', 0, 1, 0.01).name('Voronoi Depth').onChange(onParamChange);
  skin.add(params, 'islamicStarPoints', 4, 16, 1).name('Star Points').onChange(onParamChange);
  skin.add(params, 'hexScale', 0.3, 3, 0.1).name('Hex Scale').onChange(onParamChange);
  skin.add(params, 'perforationDensity', 0.1, 1, 0.01).name('Perforation Density').onChange(onParamChange);
  skin.close();

  // Fingerprint Pattern
  const fp = gui.addFolder('Fingerprint Pattern');
  fp.add(params, 'fpCount', 1, 8, 1).name('Count').onChange(() => {
    updateFPSubfolders();
    onParamChange();
  });
  fp.add(params, 'fpResolution', [512, 1024, 2048, 4096]).name('Resolution').onChange(onParamChange);
  fp.add(params, 'fpRidgeSpacing', 6, 30, 1).name('Ridge Spacing').onChange(onParamChange);
  fp.add(params, 'fpDotSize', 1, 8, 0.5).name('Dot Size').onChange(onParamChange);
  fp.add(params, 'fpDotGap', 3, 20, 1).name('Dot Gap').onChange(onParamChange);
  fp.add(params, 'fpLineExtrusion', 0.1, 10.0, 0.1).name('Line Extrusion').onChange(onParamChange);
  fp.add(params, 'fpBackgroundOpacity', 0, 1, 0.05).name('BG Opacity').onChange(onParamChange);
  fp.add(params, 'fpSeed', 0, 1000, 1).name('Seed').onChange(onParamChange);
  fp.add(params, 'fpShowPreview').name('Show Preview').onChange(onParamChange);

  // Dynamic per-fingerprint subfolders
  const fpSubfolders = [];
  function updateFPSubfolders() {
    // Remove old subfolders
    for (const sf of fpSubfolders) {
      sf.destroy();
    }
    fpSubfolders.length = 0;

    // Create subfolders for active fingerprints
    for (let i = 0; i < params.fpCount; i++) {
      const sf = fp.addFolder(`Fingerprint ${i + 1}`);
      sf.add(params, `fp${i}X`, 0, 1, 0.01).name('Position X').onChange(onParamChange);
      sf.add(params, `fp${i}Y`, 0, 1, 0.01).name('Position Y').onChange(onParamChange);
      sf.add(params, `fp${i}Scale`, 0.1, 1.0, 0.05).name('Scale').onChange(onParamChange);
      sf.add(params, `fp${i}Rotation`, -Math.PI, Math.PI, 0.05).name('Rotation').onChange(onParamChange);
      sf.add(params, `fp${i}Type`, ['whorl', 'loop', 'arch']).name('Type').onChange(onParamChange);
      sf.add(params, `fp${i}Tightness`, 0.0005, 0.01, 0.0005).name('Tightness').onChange(onParamChange);
      sf.add(params, `fp${i}Priority`, 1, 8, 1).name('Priority').onChange(onParamChange);
      sf.close();
      fpSubfolders.push(sf);
    }
  }
  updateFPSubfolders();
  onPresetApplied = updateFPSubfolders;
  fp.close();

  // Scatter
  const scatter = gui.addFolder('Scatter Objects');
  scatter.add(params, 'scatterEnabled').name('Enabled').onChange(onParamChange);
  scatter.add(params, 'scatterType', ['sunflower', 'gont', 'flower', 'spike', 'cube', 'kalyna']).name('Object Type').onChange(onParamChange);
  scatter.add(params, 'scatterDensity', 1, 500, 1).name('Density').onChange(onParamChange);
  scatter.add(params, 'scatterScale', 0.05, 3, 0.05).name('Scale').onChange(onParamChange);
  scatter.add(params, 'scatterScaleVariation', 0, 1, 0.05).name('Scale Variation').onChange(onParamChange);
  scatter.add(params, 'scatterSeed', 0, 1000, 1).name('Seed').onChange(onParamChange);
  scatter.add(params, 'scatterAlignToNormal').name('Align to Surface').onChange(onParamChange);
  scatter.addColor(params, 'scatterColor').name('Color').onChange(onParamChange);
  scatter.close();

  // Composition
  const comp = gui.addFolder('Composition');
  comp.add(params, 'compositionMode', ['single', 'mirror', 'radial', 'linear']).name('Mode').onChange(onParamChange);
  comp.add(params, 'copyCount', 2, 12, 1).name('Copy Count').onChange(onParamChange);
  comp.add(params, 'copySpacing', 5, 60, 1).name('Spacing').onChange(onParamChange);
  comp.add(params, 'copyScaleDecay', 0.5, 1.0, 0.01).name('Scale Decay').onChange(onParamChange);
  comp.add(params, 'copyRotation', -Math.PI, Math.PI, 0.01).name('Rotation Step').onChange(onParamChange);
  comp.add(params, 'podiumEnabled').name('Podium').onChange(onParamChange);
  comp.add(params, 'podiumHeight', 0.3, 5, 0.1).name('Podium Height').onChange(onParamChange);
  comp.add(params, 'podiumRadius', 5, 40, 1).name('Podium Radius').onChange(onParamChange);
  comp.add(params, 'podiumShape', ['circle', 'rectangle', 'organic']).name('Podium Shape').onChange(onParamChange);
  comp.close();

  // Material
  const mat = gui.addFolder('Material');
  mat.addColor(params, 'materialColor').name('Color').onChange(onParamChange);
  mat.add(params, 'metalness', 0, 1, 0.01).name('Metalness').onChange(onParamChange);
  mat.add(params, 'roughness', 0, 1, 0.01).name('Roughness').onChange(onParamChange);
  mat.add(params, 'wireframe').name('Wireframe').onChange(onParamChange);
  mat.close();

  // Environment
  const env = gui.addFolder('Environment');
  env.add(params, 'envType', ['desert', 'green', 'evening', 'studio']).name('Environment').onChange(onParamChange);
  env.add(params, 'sunIntensity', 0, 10, 0.1).name('Sun Intensity').onChange(onParamChange);
  env.add(params, 'sunAngle', 5, 85, 1).name('Sun Elevation').onChange(onParamChange);
  env.add(params, 'sunAzimuth', 0, 360, 1).name('Sun Position').onChange(onParamChange);
  env.add(params, 'fogDensity', 0, 0.02, 0.0005).name('Fog').onChange(onParamChange);
  env.addColor(params, 'groundColor').name('Ground Color').onChange(onParamChange);
  env.close();

  // Post-Processing
  const pp = gui.addFolder('Post-Processing');
  pp.add(params, 'bloomStrength', 0, 2, 0.01).name('Bloom Strength').onChange(onParamChange);
  pp.add(params, 'bloomRadius', 0, 1, 0.01).name('Bloom Radius').onChange(onParamChange);
  pp.add(params, 'bloomThreshold', 0, 1, 0.01).name('Bloom Threshold').onChange(onParamChange);
  pp.close();

  // Import Model
  const imp = gui.addFolder('Import Model');
  const importActions = {
    import() { onImportModel(); },
    importSecond() {
      if (onImportSecondaryModel) {
        onImportSecondaryModel();
      }
    },
    repair() {
      if (params._importedGeometry && onRepairImportedGeometry) {
        onRepairImportedGeometry();
      }
    },
    clear() {
      if (onClearImportedGeometry) {
        onClearImportedGeometry();
      } else {
        params.importMode = false;
        params._importedGeometry = null;
        params._secondaryImportedGeometry = null;
        onParamChange();
      }
      gui.controllersRecursive().forEach(c => c.updateDisplay());
    },
    clearSecond() {
      if (onClearSecondaryImportedGeometry) {
        onClearSecondaryImportedGeometry();
      } else {
        params._secondaryImportedGeometry = null;
        onParamChange();
      }
      gui.controllersRecursive().forEach(c => c.updateDisplay());
    },
  };
  imp.add(importActions, 'import').name('📂 Import OBJ / STL');
  imp.add(importActions, 'repair').name('Repair / Make Solid');
  imp.add(importActions, 'importSecond').name('Import Second OBJ / STL');
  imp.add(params, 'importUVMethod', ['original', 'smart', 'planar', 'box', 'spherical', 'cylindrical']).name('UV Method').onChange(async () => {
    const geometries = [params._importedGeometry, params._secondaryImportedGeometry].filter(Boolean);
    if (geometries.length === 0) return;

    const { applyUVMethod } = await import('./utils/importModel.js');
    for (const geometry of geometries) {
      await applyUVMethod(geometry, params.importUVMethod);
      geometry.computeVertexNormals();
    }
    onParamChange();
  });
  imp.add(params, 'importScale', 0.1, 5.0, 0.1).name('Scale').onChange(onParamChange);
  imp.add(params, 'importShowUVCheck').name('🔲 UV Check Texture').onChange(onParamChange);
  imp.add(importActions, 'clear').name('🗑️ Clear Import');
  imp.add(importActions, 'clearSecond').name('Clear Second Import');
  imp.close();

  // Export
  const exp = gui.addFolder('Export');
  const exportActions = {
    screenshot() { onScreenshot(); },
    gltf() { onExportGLTF(); },
    obj() { onExportOBJ(); },
    stl() { onExportSTL(); },
  };
  exp.add(exportActions, 'screenshot').name('Screenshot (PNG)');
  exp.add(exportActions, 'gltf').name('Export GLTF');
  exp.add(exportActions, 'obj').name('Export OBJ');
  exp.add(exportActions, 'stl').name('Export STL');
  exp.close();

  return gui;
}
