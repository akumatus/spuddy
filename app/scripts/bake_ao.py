# Bake per-part ambient occlusion atlases for a Rodin part-separated PBR GLB.
#
# Two atlases come out of one run:
#   <out_ao.png>      ISOLATED — each part baked with every other part hidden
#                     from rays. Cross-part contact shadows (the "black hole"
#                     source: arm-on-body, eye-in-socket, card-in-slot) never
#                     enter this map; the part's own stitch-level crevice
#                     shading, the core of the yarn look, is fully kept.
#   <out_ao_all.png>  ALL-VISIBLE — same bake with every part visible, i.e.
#                     the occlusion Rodin's own shaded bake saw. The per-texel
#                     ratio all/iso measures exactly how much a texel was
#                     darkened by NEIGHBOR parts — process_rodin_pbr.mjs
#                     divides the shaded texture by it to un-bake the contact
#                     shadows without touching clean texels.
#
# Parts share one non-overlapping UV atlas, so all bakes accumulate into a
# single image per pass.
#
# The AO term is an explicit shader node (AO -> Emission, baked as EMIT)
# instead of Blender's built-in AO bake: the node exposes the ray distance
# directly, which the built-in bake buries in world settings.
#
# process_rodin_pbr.mjs packs the isolated atlas into the R channel of the
# metallicRoughness textures (glTF ORM layout — zero extra texture memory)
# and registers it as occlusionTexture.
#
# Usage:
#   /Applications/Blender.app/Contents/MacOS/Blender -b -P bake_ao.py -- \
#     <in_pbr.glb> <out_ao.png> [out_ao_all.png] [size=2048] [distance_scale=0.12] [samples=32]
#
# distance_scale: AO ray distance as a fraction of the model bbox diagonal.
# Smaller = only tight crevices darken; larger = broader soft form shading.
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
# absolute paths: Blender resolves relative image paths against the blend file
# (there is none in headless mode), not the shell cwd
SRC, OUT = os.path.abspath(argv[0]), os.path.abspath(argv[1])
OUT_ALL = os.path.abspath(argv[2]) if len(argv) > 2 else None
SIZE = int(argv[3]) if len(argv) > 3 else 2048
DIST_SCALE = float(argv[4]) if len(argv) > 4 else 0.12
SAMPLES = int(argv[5]) if len(argv) > 5 else 32

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
if not meshes:
    raise SystemExit("no mesh objects in " + SRC)

# AO ray distance from the whole model's bbox diagonal
lo = Vector((1e18, 1e18, 1e18))
hi = Vector((-1e18, -1e18, -1e18))
for o in meshes:
    for corner in o.bound_box:
        w = o.matrix_world @ Vector(corner)
        lo = Vector(map(min, lo, w))
        hi = Vector(map(max, hi, w))
dist = (hi - lo).length * DIST_SCALE
print(f"AO distance: {dist:.4f} ({DIST_SCALE} x bbox diagonal {(hi - lo).length:.4f})")

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = False
try:  # Metal GPU when available, silently fall back to CPU
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = "GPU"
    print("cycles device: GPU (Metal)")
except Exception as e:
    print("cycles device: CPU (", e, ")")

# shared bake targets — white background so unbaked atlas texels stay neutral
def make_target(name):
    im = bpy.data.images.new(name, SIZE, SIZE, alpha=False)
    im.generated_color = (1.0, 1.0, 1.0, 1.0)
    im.colorspace_settings.name = "Non-Color"
    return im

img = make_target("ao_bake")

# one bake material for all parts: AO node -> Emission, image node active
mat = bpy.data.materials.new("ao_bake_mat")
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
ao.inputs["Distance"].default_value = dist
ao.samples = 8
emit = nt.nodes.new("ShaderNodeEmission")
out = nt.nodes.new("ShaderNodeOutputMaterial")
tex = nt.nodes.new("ShaderNodeTexImage")
tex.image = img
nt.links.new(ao.outputs["Color"], emit.inputs["Color"])
nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
nt.nodes.active = tex

for o in meshes:
    o.data.materials.clear()
    o.data.materials.append(mat)


def bake_pass(target, isolated):
    tex.image = target
    for o in meshes:
        for other in meshes:
            other.hide_render = (other is not o) if isolated else False
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        # never clear: bakes from all parts accumulate into the shared atlas
        bpy.ops.object.bake(type="EMIT", use_clear=False, margin=16)
        print("baked:", o.name, "(isolated)" if isolated else "(all-visible)")


bake_pass(img, isolated=True)
img.filepath_raw = OUT
img.file_format = "PNG"
img.save()
print("written:", OUT)

if OUT_ALL:
    img_all = make_target("ao_bake_all")
    bake_pass(img_all, isolated=False)
    img_all.filepath_raw = OUT_ALL
    img_all.file_format = "PNG"
    img_all.save()
    print("written:", OUT_ALL)
