# Accurate UV Distortion Compensation for Arbitrary Meshes

## Goal
The user wants fingerprints drawn in the 2D canvas to visually deform *before* being mapped onto the 3D model, such that when they *are* mapped to the 3D model, they appear perfectly uniform and undistorted, regardless of how badly stretched the UV map is. 

Previously, we used a hardcoded algebraic formula [getCircumferenceScale](file:///c:/dev/expo/fingerprints/src/components/MergedFingerprintsCanvas.tsx#6-33) assuming a perfect hyperboloid or torus. This failed completely on imported complex OBJ/STL files with their own arbitrary unwrapping. A global slider is a temporary fix but doesn't handle localized stretching (like the top of a sphere pinching vs the equator).

## Proposed Solution: The UV Density Map

To solve this for *any* arbitrary mesh (parametric or imported), we must measure the actual 3D physical area that each 2D UV pixel represents. 
If a 10x10 block of UV pixels maps to a 50x10 physical area on the 3D model, then that region is being stretched 5x horizontally. To compensate, our 2D canvas must squash its drawing 5x horizontally in that exact spot.

### Step 1: Extract Base Geometry
- **File**: [src/pavilion_3d/pavilion/index.js](file:///c:/dev/expo/fingerprints/src/pavilion_3d/pavilion/index.js)
- **Action**: In [buildSinglePavilion](file:///c:/dev/expo/fingerprints/src/pavilion_3d/pavilion/index.js#310-560), immediately before applying thickness or deformations, we take the raw `shellGeom`. We will attach this raw geometry to the returned group's `userData.baseGeometry = shellGeom.clone()`.
- **Purpose**: We need the pristine 3D coordinates and UVs as they map to the surface.

### Step 2: Pass Geometry to Canvas
- **File**: [src/components/Pavilion3D.tsx](file:///c:/dev/expo/fingerprints/src/components/Pavilion3D.tsx)
- **Action**: Extract `rootGroup.userData.baseGeometry` after [buildPavilion](file:///c:/dev/expo/fingerprints/src/pavilion_3d/pavilion/index.js#662-675) completes. Pass this geometry UP via a new callback prop `onGeometryUpdate(geom)`.
- **File**: [App.tsx](file:///c:/dev/expo/fingerprints/src/App.tsx) (or wherever [Pavilion3D](file:///c:/dev/expo/fingerprints/src/components/Pavilion3D.tsx#19-190) and `WhorlCanvas` live together)
- **Action**: Store this geometry in state and pass it DOWN to `WhorlCanvas` as `baseGeometry`.

### Step 3: Compute Density Map (CPU or GPU)
- **File**: [src/components/MergedFingerprintsCanvas.tsx](file:///c:/dev/expo/fingerprints/src/components/MergedFingerprintsCanvas.tsx) (or a helper)
- **Action**: When `baseGeometry` is provided, we analyze its triangles.
- For every triangle, we calculate its 2D UV-space area and its 3D World-space area.
- We calculate the geometric stretch tensor (how much it stretches in U vs V).
- **Simpler robust approach (Barycentric interpolation)**: 
  Instead of a full texture bake, we can reuse the existing [barycentricUV](file:///c:/dev/expo/fingerprints/src/pavilion_3d/pavilion/index.js#232-256) logic (already used for holes!). 
  When transforming a point [(lx, ly)](file:///c:/dev/expo/fingerprints/src/App.tsx#12-114) to `globalX, globalY`:
  1. Find which UV triangle [(globalX/1024, 1 - globalY/1024)](file:///c:/dev/expo/fingerprints/src/App.tsx#12-114) falls inside.
  2. Look at that triangle's 3D physical edges vs its 2D UV edges.
  3. Calculate the local `scaleX` and `scaleY` distortion multiplier for that exact location.
  4. Apply that counter-scale to the dot/line generation.

### Step 4: Apply Counter-Distortion
- **File**: [src/components/MergedFingerprintsCanvas.tsx](file:///c:/dev/expo/fingerprints/src/components/MergedFingerprintsCanvas.tsx)
- **Action**: Modify [transformPoint](file:///c:/dev/expo/fingerprints/src/components/MergedFingerprintsCanvas.tsx#337-355). Instead of a global scale, it queries the triangle-based distortion cache. If the model stretches X by 3.0 at this UV coordinate, [transformPoint](file:///c:/dev/expo/fingerprints/src/components/MergedFingerprintsCanvas.tsx#337-355) scales the 2D offset by `1.0 / 3.0` (squashing it), so that when rendered in 3D, it stretches back to `1.0`.

## User Review Required

> [!CAUTION]
> Testing point-in-triangle for thousands of dots every frame can be extremely slow if not optimized. To make this performant in JS, we will need to build a spatial grid (e.g. 64x64 bins) over the UV space to quickly look up which triangle a dot falls into, rather than checking all 50,000 triangles. 

> [!IMPORTANT]
> Does the user want this distortion applied to the *Bounding Box UI* as well, or just the generated ink? Squashing the bounding box UI in 2D to look like a warped trapezoid might be complex. It is easier to warp just the generated lines/dots inside [MergedFingerprintsCanvas](file:///c:/dev/expo/fingerprints/src/components/MergedFingerprintsCanvas.tsx#43-49).

## Verification Plan

1. **Automated Tests**: I will load a highly distorted parametric shape (like [blob](file:///c:/dev/expo/fingerprints/src/pavilion_3d/pavilion/shell.js#68-89) or [hyperboloid](file:///c:/dev/expo/fingerprints/src/pavilion_3d/pavilion/shell.js#4-27) with severe taper) and verify the 2D canvas draws a severely warped, squashed reverse-image of the fingerprint.
2. **Manual Verification**: We will ask the user to load their complex custom OBJ file and place a fingerprint on a stretched area to visually confirm it maps uniformly in 3D.
