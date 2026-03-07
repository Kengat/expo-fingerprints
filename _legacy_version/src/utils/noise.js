import { createNoise3D } from 'simplex-noise';

export function createSeededNoise3D(seed) {
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return createNoise3D(rng);
}

export function fractalNoise3D(noise3D, x, y, z, octaves, frequency, amplitude) {
  let value = 0;
  let amp = amplitude;
  let freq = frequency;

  for (let i = 0; i < octaves; i++) {
    value += amp * noise3D(x * freq, y * freq, z * freq);
    amp *= 0.5;
    freq *= 2.0;
  }

  return value;
}
