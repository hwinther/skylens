# Headless Blender export of one mesh object to GLB with its authored flat colours.
# Run by build-models.mjs: blender --background --factory-startup --disable-autoexec <file.blend>
#   --python blend2glb.py -- <out.glb> <object> [reset]
# The source .blend files use old-style materials (two outputs: Principled + Diffuse); the glTF exporter
# then writes white. Each material is rebuilt as one Principled BSDF with the colour read from the
# Principled node (else the Diffuse node, else diffuse_color). "reset" also clears the object's own
# location/rotation (one model is stored turned and moved within its scene).
import bpy, sys

args = sys.argv[sys.argv.index("--") + 1:]
out, name = args[0], args[1]
reset = "reset" in args[2:]
# Window glass is pure white in the source; a pale blue reads as glass on a flat-shaded model.
OVERRIDES = {"Glass": (0.32, 0.5, 0.68, 1.0)}

keep = bpy.data.objects[name]

def authored_colour(m):
    if m.name in OVERRIDES:
        return OVERRIDES[m.name]
    if m.node_tree:
        for t, inp in (("BSDF_PRINCIPLED", "Base Color"), ("BSDF_DIFFUSE", "Color")):
            for n in m.node_tree.nodes:
                if n.type == t and not n.inputs[inp].is_linked:
                    return tuple(n.inputs[inp].default_value)
    return tuple(m.diffuse_color)

for m in {s.material for s in keep.material_slots if s.material}:
    c = authored_colour(m)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = c
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.7
    outn = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(bsdf.outputs["BSDF"], outn.inputs["Surface"])
    print("MAT", m.name, tuple(round(x, 3) for x in c))

# Drop the rig / parenting but keep the visual shape (the armature is at rest).
wm = keep.matrix_world.copy()
for mod in list(keep.modifiers):
    keep.modifiers.remove(mod)
keep.parent = None
keep.matrix_world = wm
if reset:
    keep.location = (0, 0, 0)
    keep.rotation_euler = (0, 0, 0)
for o in list(bpy.data.objects):
    if o is not keep:
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
keep.select_set(True)
bpy.context.view_layer.objects.active = keep
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=False,
                          export_animations=False, export_skins=False, export_cameras=False, export_lights=False)
print("EXPORTED", out)
