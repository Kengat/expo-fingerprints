import argparse
import json
import os
import sys

import bpy


METHODS = {
    "native-angle-based": "ANGLE_BASED",
    "native-conformal": "CONFORMAL",
    "native-minimum-stretch": "MINIMUM_STRETCH",
}


def repair_mesh_object(obj):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    before_vertices = len(obj.data.vertices)
    before_edges = len(obj.data.edges)
    before_faces = len(obj.data.polygons)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_mode(type="VERT")
    bpy.ops.mesh.select_all(action="SELECT")

    # Conservative cleanup: weld duplicate SketchUp-style split vertices,
    # drop zero-area junk, and normalize winding before UV optimization.
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.mesh.dissolve_degenerate(threshold=0.0001)
    bpy.ops.mesh.delete_loose()
    bpy.ops.mesh.normals_make_consistent(inside=False)

    bpy.ops.object.mode_set(mode="OBJECT")
    mesh = obj.data
    mesh.validate(clean_customdata=False)
    mesh.update()
    print(
        "[NativeUV] Repair "
        f"{obj.name}: vertices {before_vertices}->{len(mesh.vertices)}, "
        f"edges {before_edges}->{len(mesh.edges)}, faces {before_faces}->{len(mesh.polygons)}"
    )
    obj.select_set(False)


def pack_all_uv_islands(mesh_objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_mode(type="FACE")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale(scale_uv=False, shear=True)
    bpy.ops.uv.pack_islands(
        udim_source="CLOSEST_UDIM",
        rotate=True,
        rotate_method="ANY",
        scale=True,
        merge_overlap=False,
        margin_method="FRACTION",
        margin=0.006,
        pin=False,
        shape_method="CONCAVE",
    )
    bpy.ops.object.mode_set(mode="OBJECT")


def fail(message):
    print(f"[NativeUV] {message}", file=sys.stderr)
    sys.exit(1)


def main():
    if os.environ.get("EXPO_NATIVE_UV_JOB"):
        payload = json.loads(os.environ["EXPO_NATIVE_UV_JOB"])
        args = argparse.Namespace(
            input=payload["input"],
            output=payload["output"],
            method=payload.get("method", "native-minimum-stretch"),
        )
    else:
        script_args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
        parser = argparse.ArgumentParser(description="Unwrap an OBJ/STL with Blender and export OBJ with UVs.")
        parser.add_argument("--input", required=True)
        parser.add_argument("--output", required=True)
        parser.add_argument("--method", default="native-minimum-stretch")
        args = parser.parse_args(script_args)

    method = METHODS.get(args.method)
    if method is None:
        fail(f"Unsupported method: {args.method}")

    if not os.path.exists(args.input):
        fail(f"Input file not found: {args.input}")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()

    ext = os.path.splitext(args.input)[1].lower()
    if ext == ".obj":
        bpy.ops.wm.obj_import(filepath=args.input)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=args.input)
    else:
        fail("Only OBJ and STL inputs are supported.")

    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not mesh_objects:
        fail("No mesh objects were imported.")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]

    for obj in mesh_objects:
        repair_mesh_object(obj)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.mode_set(mode="OBJECT")
        mesh = obj.data

        if not mesh.uv_layers:
            mesh.uv_layers.new(name="NativeUV")
        mesh.uv_layers.active = mesh.uv_layers[0]

        for poly in mesh.polygons:
            poly.select = True

        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_mode(type="FACE")
        bpy.ops.mesh.select_all(action="SELECT")

        kwargs = {
            "method": method,
            "fill_holes": True,
            "correct_aspect": False,
            "margin": 0.001,
        }
        if method == "MINIMUM_STRETCH":
            kwargs.update({
                "no_flip": True,
                "iterations": 50,
            })

        bpy.ops.uv.unwrap(**kwargs)
        bpy.ops.object.mode_set(mode="OBJECT")
        obj.select_set(False)

    pack_all_uv_islands(mesh_objects)

    for obj in mesh_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    bpy.ops.wm.obj_export(
        filepath=args.output,
        export_selected_objects=True,
        export_materials=False,
        export_uv=True,
        export_normals=True,
        export_triangulated_mesh=True,
    )

    print(f"[NativeUV] Exported {args.output} using {method}")


if __name__ == "__main__":
    main()
