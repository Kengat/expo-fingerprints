import * as THREE from 'three';
import Module from 'manifold-3d';

async function test() {
    const m = await Module();
    m.setup();

    const box = new THREE.BoxGeometry(10, 10, 10);
    const boxPos = box.attributes.position.array;
    const boxIdx = box.index.array;

    const mesh = new m.Mesh({
        numProp: 3,
        vertProperties: new Float32Array(boxPos),
        triVerts: new Uint32Array(boxIdx)
    });
    mesh.merge();

    const manifoldObj = new m.Manifold(mesh);
    console.log("Status:", manifoldObj.status());
    console.log("Original Volume:", manifoldObj.volume());

    // Cut a cylinder
    const cyl = m.Manifold.cylinder(20, 2, 2, 32, true);
    // Rotate and Translate if necessary

    const diff = m.Manifold.difference(manifoldObj, cyl);
    console.log("Difference Volume:", diff.volume());

    const outMesh = diff.getMesh();
    console.log("Output Verts:", outMesh.numVert, outMesh.vertProperties.length);
}

test().catch(console.error);
