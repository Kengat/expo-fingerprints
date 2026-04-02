import { Point, FingerprintParams } from './components/FingerprintGenerator';

export type { FingerprintParams };

export const GLOBAL_SCALE_MAX = 10;
export const LINE_THICKNESS_SCALE_MIN = 0.2;
export const LINE_THICKNESS_SCALE_MAX = 3;

export const PRESETS = {
  plain: {
    core1: { x: -0.05, y: 0.05 },
    core2: { x: 0.05, y: -0.05 },
    delta1: { x: -0.6, y: -0.6 },
    delta2: { x: 0.6, y: -0.6 },
    spiral: 0.0,
  },
  doubleLoop: {
    core1: { x: -0.2, y: 0.2 },
    core2: { x: 0.2, y: -0.2 },
    delta1: { x: -0.6, y: -0.4 },
    delta2: { x: 0.6, y: -0.4 },
    spiral: 0.0,
  },
  centralPocket: {
    core1: { x: 0.0, y: 0.1 },
    core2: { x: 0.0, y: -0.1 },
    delta1: { x: -0.2, y: -0.3 },
    delta2: { x: 0.7, y: -0.6 },
    spiral: 0.2,
  }
};

export const DEFAULT_PARAMS: FingerprintParams = {
  ...PRESETS.plain,
  frequency: 0.05,
  thickness: 0.0,
  smudge: 0.3,
  scratches: 0.2,
  pores: 0.5,
  seed: 0,
  showPoints: true,
};

export const DEFAULT_DOTS_PARAMS: FingerprintParams = {
  ...DEFAULT_PARAMS,
  dotSpacing: 12.5,
  dotSizeMin: 2.4,
  dotSizeMax: 4.2,
  lineDensity: 14,
  noiseScale: 7,
  spiral: 0.0,
  lineThicknessMin: 1.8,
  lineThicknessMax: 7.2,
  core1: { x: -0.05, y: 0.17 },
  core2: { x: -0.03, y: 0.20 },
  delta1: { x: -0.24, y: -0.72 },
  delta2: { x: 0.44, y: -0.59 },
};
