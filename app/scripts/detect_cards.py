"""Blender headless: locate the white card plane in each Rodin GLB.

Detection: polygons whose baked-texture sample is bright + unsaturated
(the card is achromatic; the potato body is not) and roughly front-facing,
then a RANSAC plane fit over the survivors. Outputs per-character card
transforms in glTF/three.js coordinates plus a verification render with
a red quad placed at the detected plane.

Usage:
  Blender -b -P detect_cards.py -- <model.glb> <out.json> <render_prefix>
"""
import bpy
import sys
import json
import math
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1:]
src, out_json, render_prefix = argv[0], argv[1], argv[2]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

obj = next(o for o in bpy.data.objects if o.type == "MESH")
mesh = obj.data
img = None
for mat in mesh.materials:
    if mat and mat.use_nodes:
        for n in mat.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image:
                img = n.image
                break

w, h = img.size
px = np.array(img.pixels[:]).reshape(h, w, -1)

uv = mesh.uv_layers.active.data
mw = obj.matrix_world
FRONT = np.array([0.0, -1.0, 0.0])  # Blender: front of the character

vs_world = np.array([(mw @ v.co) for v in mesh.vertices][::50])
z_min, z_max = vs_world[:, 2].min(), vs_world[:, 2].max()
z_cap = z_min + 0.55 * (z_max - z_min)  # the card sits on the lower body, never up top

cand_c = []
cand_n = []
for poly in mesh.polygons:
    n_world = (mw.to_3x3() @ poly.normal).normalized()
    nv = np.array([n_world.x, n_world.y, n_world.z])
    if nv @ FRONT < 0.5:
        continue
    if (mw @ poly.center).z > z_cap:
        continue
    us = vs = 0.0
    for li in poly.loop_indices:
        u, v = uv[li].uv
        us += u
        vs += v
    k = len(poly.loop_indices)
    u = (us / k) % 1.0
    v = (vs / k) % 1.0
    r, g, b = px[min(h - 1, int(v * h)), min(w - 1, int(u * w)), :3]
    bright = max(r, g, b)
    sat = bright - min(r, g, b)
    if bright > 0.42 and sat < 0.10:
        c = mw @ poly.center
        cand_c.append([c.x, c.y, c.z])
        cand_n.append(nv)

C = np.array(cand_c)
N = np.array(cand_n)
print(f"[cards] {src.split('/')[-1]}: candidates={len(C)}")
if len(C) < 20:
    print("[cards] FAILED: too few candidates")
    sys.exit(1)

# RANSAC plane fit
rng = np.random.default_rng(7)
best = None
for _ in range(120):
    i = rng.integers(len(C))
    p0, n0 = C[i], N[i]
    dist = np.abs((C - p0) @ n0)
    inl = (dist < 0.035) & (N @ n0 > 0.85)
    if best is None or inl.sum() > best.sum():
        best = inl
Ci, Ni = C[best], N[best]
print(f"[cards] inliers={len(Ci)}")

center = Ci.mean(axis=0)
normal = Ni.mean(axis=0)
normal /= np.linalg.norm(normal)
up = np.array([0.0, 0.0, 1.0])
right = np.cross(up, normal)
right /= np.linalg.norm(right)
up2 = np.cross(normal, right)

d = Ci - center
pr, pu = d @ right, d @ up2
r_lo, r_hi = np.percentile(pr, [2, 98])
u_lo, u_hi = np.percentile(pu, [2, 98])
width = float(r_hi - r_lo)
height = float(u_hi - u_lo)
center = center + right * (r_hi + r_lo) / 2 + up2 * (u_hi + u_lo) / 2
# scanned cards bow outward — the screen quad must clear the bulge
offset = float(np.percentile(d @ normal, 98) + 0.012)
print(f"[cards] plane center={np.round(center,3).tolist()} normal={np.round(normal,3).tolist()} size={width:.3f}x{height:.3f} offset={offset:.3f}")

def to_gltf(v):
    return [float(v[0]), float(v[2]), float(-v[1])]

result = {
    "center": to_gltf(center),
    "normal": to_gltf(normal),
    "up": to_gltf(up2),
    "width": width,
    "height": height,
    "offset": offset,
}
with open(out_json, "w") as f:
    json.dump(result, f)

# ── verification render: red quad at the detected plane ──
quad_mesh = bpy.data.meshes.new("cardquad")
hw, hh = width / 2, height / 2
verts = [tuple(center + right * sx + up2 * sy + normal * offset) for sx, sy in
         [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]]
quad_mesh.from_pydata(verts, [], [[0, 1, 2, 3]])
quad = bpy.data.objects.new("cardquad", quad_mesh)
mat = bpy.data.materials.new("red")
mat.diffuse_color = (1, 0, 0, 1)
quad_mesh.materials.append(mat)
bpy.context.collection.objects.link(quad)

scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.color_type = 'MATERIAL'
scene.display.shading.light = 'FLAT'
scene.render.resolution_x = 512
scene.render.resolution_y = 512

bb = np.array([(mw @ v.co) for v in mesh.vertices][::200])
zc = (bb[:, 2].max() + bb[:, 2].min()) / 2
extent = max(bb[:, 2].max() - bb[:, 2].min(), bb[:, 0].max() - bb[:, 0].min()) * 1.2

cam_data = bpy.data.cameras.new("cam")
cam_data.type = 'ORTHO'
cam_data.ortho_scale = extent
cam = bpy.data.objects.new("cam", cam_data)
bpy.context.collection.objects.link(cam)
scene.camera = cam

views = [
    ("front", (0, -6, zc), (math.radians(90), 0, 0)),
    ("side", (4.2, -4.2, zc), (math.radians(90), 0, math.radians(45))),
]
for suffix, loc, rot in views:
    cam.location = loc
    cam.rotation_euler = rot
    scene.render.filepath = f"{render_prefix}-{suffix}.png"
    bpy.ops.render.render(write_still=True)

# textured reference (quad hidden) to compare against the real card
quad.hide_render = True
scene.display.shading.color_type = 'TEXTURE'
cam.location, cam.rotation_euler = views[0][1], views[0][2]
scene.render.filepath = f"{render_prefix}-tex.png"
bpy.ops.render.render(write_still=True)
print(f"[cards] wrote {out_json} + renders")
