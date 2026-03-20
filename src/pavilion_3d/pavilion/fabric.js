import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

export function createFabricDrape(p, baseGeometry, sceneOriginY) {
  const group = new THREE.Group();
  group.name = 'fabric-drape';

  if (!p.fabricEnabled || !baseGeometry) return group;

  // Create a mesh for raycasting against the base geometry
  const raycastMesh = new THREE.Mesh(baseGeometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  
  const raycaster = new THREE.Raycaster();

  // For imported models, sceneOriginY is where the original modeling
  // software's y=0 ends up after normalizeGeometry + importScale.
  const fabricBottomY = (sceneOriginY !== undefined) ? sceneOriginY : 0.1;

  const numLines = p.fabricLines || 60;
  const topHeight = p.fabricTopHeight || 50.0;
  
  // Estimate bounds based on pavilion parameters
  const radius = p.radiusBottom || 20; 
  const bounds = radius * 1.5;

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.fabricColor || '#ffffff'),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: p.fabricOpacity || 0.85,
    roughness: 0.8,
    metalness: 0.1,
  });

  const noise2D = createNoise2D();

  // Use custom items from the canvas if available, otherwise generate default ones
  const items = p.fabricItems && p.fabricItems.length > 0 ? p.fabricItems : [];

  for (const item of items) {
    const segments = 200; // High resolution for smooth drape
    
    let currentStrip = [];
    const strips = [];

    // Fallback to old behavior if old items are present
    const isBezier = item.type === 'bezier' && item.start;

    for (let j = 0; j <= segments; j++) {
      let x, waveZ;
      
      if (item.type === 'polyline' && item.points && item.points.length > 1) {
        // Calculate total length
        let totalLength = 0;
        const lengths = [0];
        for (let i = 1; i < item.points.length; i++) {
            const p1 = item.points[i-1];
            const p2 = item.points[i];
            totalLength += Math.hypot(p2.x - p1.x, p2.z - p1.z);
            lengths.push(totalLength);
        }
        
        const t = j / segments;
        const targetLen = t * totalLength;
        
        // Find segment
        let idx = 1;
        while (idx < lengths.length && lengths[idx] < targetLen) {
            idx++;
        }
        if (idx >= lengths.length) idx = lengths.length - 1;
        
        const p1 = item.points[idx - 1];
        const p2 = item.points[idx];
        const l1 = lengths[idx - 1];
        const l2 = lengths[idx];
        
        const segT = l2 === l1 ? 0 : (targetLen - l1) / (l2 - l1);
        
        x = p1.x + (p2.x - p1.x) * segT;
        waveZ = p1.z + (p2.z - p1.z) * segT;
      } else if (isBezier) {
        const t = j / segments;
        const u = 1 - t;
        const tt = t * t;
        const uu = u * u;
        const uuu = uu * u;
        const ttt = tt * t;
        
        x = uuu * item.start.x + 3 * uu * t * item.cp1.x + 3 * u * tt * item.cp2.x + ttt * item.end.x;
        waveZ = uuu * item.start.z + 3 * uu * t * item.cp1.z + 3 * u * tt * item.cp2.z + ttt * item.end.z;
      } else {
        // Old horizontal noise behavior
        x = -bounds + (j / segments) * (bounds * 2);
        const noiseVal = noise2D(x * (item.noiseFreq || 0.1) + (item.noiseOffset || 0), (item.z || 0) * (item.noiseFreq || 0.1));
        waveZ = (item.z || 0) + noiseVal * (item.waviness || 2.0);
      }
      
      // Raycast straight down from the top height
      const origin = new THREE.Vector3(x, topHeight, waveZ);
      const dir = new THREE.Vector3(0, -1, 0);
      raycaster.set(origin, dir);
      
      const intersects = raycaster.intersectObject(raycastMesh, false);
      
      if (intersects.length > 0) {
        // The fabric hangs DOWN from the geometry
        const topY = intersects[0].point.y;
        const bottomY = fabricBottomY;
        
        currentStrip.push({ x, topY, bottomY, z: waveZ, u: j / segments });
      } else {
        // If we were building a strip and hit a gap, save the strip and start a new one
        if (currentStrip.length > 0) {
          strips.push(currentStrip);
          currentStrip = [];
        }
      }
    }
    
    // Push the last strip if it exists
    if (currentStrip.length > 0) {
      strips.push(currentStrip);
    }

    // Create ribbon geometry for each continuous strip
    for (const strip of strips) {
      if (strip.length < 2) continue; // Need at least 2 points to make a ribbon

      const geom = new THREE.BufferGeometry();
      const positions = [];
      const indices = [];
      const uvs = [];

      let vertexIndex = 0;
      for (let j = 0; j < strip.length - 1; j++) {
        const p1 = strip[j];
        const p2 = strip[j + 1];

        positions.push(
          p1.x, p1.topY, p1.z,
          p1.x, p1.bottomY, p1.z,
          p2.x, p2.topY, p2.z,
          p2.x, p2.bottomY, p2.z
        );

        uvs.push(
          p1.u, 1,
          p1.u, 0,
          p2.u, 1,
          p2.u, 0
        );

        const idx = vertexIndex;
        indices.push(idx, idx + 1, idx + 2);
        indices.push(idx + 1, idx + 3, idx + 2);
        
        vertexIndex += 4;
      }

      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geom.setIndex(indices);
      geom.computeVertexNormals();

      const mesh = new THREE.Mesh(geom, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  return group;
}
