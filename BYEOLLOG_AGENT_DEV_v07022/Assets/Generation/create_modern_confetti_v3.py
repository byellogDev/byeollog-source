import argparse
import math
import os
import random

import bpy
from mathutils import Vector


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--percentage", type=int, default=100)
    parser.add_argument("--end-frame", type=int, default=108)
    values = []
    if "--" in os.sys.argv:
        values = os.sys.argv[os.sys.argv.index("--") + 1 :]
    return parser.parse_args(values)


def material(name, color, metallic=0.0, roughness=0.7):
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*color, 1.0)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Specular IOR Level"].default_value = 0.28 if metallic == 0 else 0.48
    return result


def add_thin_finish(obj, thickness, bevel_width):
    solidify = obj.modifiers.new("Paper thinness", "SOLIDIFY")
    solidify.thickness = thickness
    solidify.offset = 0.0
    bevel = obj.modifiers.new("Soft torn edge", "BEVEL")
    bevel.width = bevel_width
    bevel.segments = 2


def create_fleck(index, rng, mats):
    width = rng.uniform(0.16, 0.34)
    height = rng.uniform(0.38, 0.82)
    columns = 4
    rows = 3
    vertices = []
    faces = []
    bend_x = rng.uniform(-0.24, 0.24)
    bend_y = rng.uniform(-0.18, 0.18)
    twist = rng.uniform(-0.28, 0.28)
    for row in range(rows):
        v = row / (rows - 1)
        y = (v - 0.5) * height
        for column in range(columns):
            u = column / (columns - 1)
            x = (u - 0.5) * width
            edge = column in (0, columns - 1) or row in (0, rows - 1)
            jitter_x = rng.uniform(-0.018, 0.018) if edge else 0
            jitter_y = rng.uniform(-0.024, 0.024) if edge else 0
            z = bend_x * (u - 0.5) ** 2 + bend_y * (v - 0.5) ** 2 + twist * (u - 0.5) * (v - 0.5)
            z += rng.uniform(-0.014, 0.014)
            vertices.append((x + jitter_x, y + jitter_y, z))
    for row in range(rows - 1):
        for column in range(columns - 1):
            a = row * columns + column
            faces.append((a, a + 1, a + columns + 1, a + columns))
    mesh = bpy.data.meshes.new(f"ModernFleckMesh{index:03d}")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(f"ModernFleck{index:03d}", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(rng.choice(mats))
    add_thin_finish(obj, 0.008, 0.007)
    return obj


def create_flat_ribbon(index, rng, mats):
    segments = 14
    length = rng.uniform(1.15, 2.2)
    width = rng.uniform(0.12, 0.23)
    wave = rng.uniform(0.10, 0.23)
    curl = rng.uniform(1.0, 1.8)
    vertices = []
    faces = []
    for segment in range(segments):
        u = segment / (segments - 1)
        x = (u - 0.5) * length
        centre_y = math.sin(u * math.tau * curl) * wave
        centre_z = math.cos(u * math.tau * curl) * wave * 0.42
        tangent_y = math.cos(u * math.tau * curl) * wave * math.tau * curl
        normal = Vector((-tangent_y, 1.0, 0.0)).normalized() * (width * 0.5)
        vertices.append((x + normal.x, centre_y + normal.y, centre_z + rng.uniform(-0.008, 0.008)))
        vertices.append((x - normal.x, centre_y - normal.y, centre_z + rng.uniform(-0.008, 0.008)))
    for segment in range(segments - 1):
        a = segment * 2
        faces.append((a, a + 2, a + 3, a + 1))
    mesh = bpy.data.meshes.new(f"FlatRibbonMesh{index:03d}")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(f"FlatRibbon{index:03d}", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(rng.choice(mats))
    add_thin_finish(obj, 0.006, 0.005)
    return obj


def animate_piece(obj, index, rng, end_frame):
    fps = 30.0
    group = index % 7
    start_frame = rng.randint(1, 13)
    if group == 0:
        start_x = rng.uniform(-6.6, 6.6)
        start_y = rng.uniform(-10.4, -8.8)
        vx = rng.uniform(-5.2, 5.2)
        vy = rng.uniform(18.2, 23.2)
    else:
        side = -1 if index % 2 == 0 else 1
        start_x = side * rng.uniform(14.8, 19.0)
        start_y = rng.uniform(-10.2, -7.8)
        vx = -side * rng.uniform(8.4, 14.2)
        vy = rng.uniform(16.8, 22.2)
    start_z = rng.uniform(-2.4, 2.6)
    gravity = rng.uniform(14.1, 17.1)
    wind = rng.uniform(-0.9, 0.9)
    flutter = rng.uniform(0.10, 0.42)
    phase = rng.uniform(0, math.tau)
    layer = rng.random()
    if layer < 0.35:
        depth_scale = rng.uniform(0.44, 0.72)
    elif layer < 0.9:
        depth_scale = rng.uniform(0.72, 1.06)
    else:
        depth_scale = rng.uniform(1.06, 1.36)
    angular = Vector((rng.uniform(-6.2, 6.2), rng.uniform(-7.4, 7.4), rng.uniform(-5.8, 5.8)))
    initial_rotation = Vector((rng.uniform(0, math.tau), rng.uniform(0, math.tau), rng.uniform(0, math.tau)))

    obj.scale = (0.001, 0.001, 0.001)
    obj.location = (start_x, start_y, start_z)
    obj.keyframe_insert("scale", frame=max(1, start_frame - 1))
    obj.keyframe_insert("location", frame=max(1, start_frame - 1))
    obj.scale = (depth_scale, depth_scale, depth_scale)
    obj.keyframe_insert("scale", frame=start_frame + 1)

    for frame in range(start_frame, end_frame + 1, 2):
        elapsed = (frame - start_frame) / fps
        drag = max(0.54, 1.0 - 0.10 * elapsed)
        x = start_x + vx * elapsed * drag + wind * elapsed * elapsed
        x += math.sin(elapsed * 4.7 + phase) * flutter
        y = start_y + vy * elapsed - 0.5 * gravity * elapsed * elapsed
        z = start_z + math.sin(elapsed * 3.8 + phase) * 0.48
        obj.location = (x, y, z)
        obj.rotation_euler = initial_rotation + angular * elapsed + Vector(
            (math.sin(elapsed * 6.5 + phase) * 0.24, math.cos(elapsed * 5.8 + phase) * 0.20, 0)
        )
        obj.keyframe_insert("location", frame=frame)
        obj.keyframe_insert("rotation_euler", frame=frame)

    obj.location.y = min(obj.location.y, -13.0)
    obj.keyframe_insert("location", frame=end_frame)
    obj.scale = (0.001, 0.001, 0.001)
    obj.keyframe_insert("scale", frame=end_frame)

    for curve in obj.animation_data.action.fcurves:
        for key in curve.keyframe_points:
            key.interpolation = "BEZIER"


def build_scene(output, percentage, end_frame):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    rng = random.Random(8272104)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = percentage
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.film_transparent = True
    scene.render.fps = 30
    scene.frame_start = 1
    scene.frame_end = end_frame
    scene.render.filepath = os.path.join(output, "modern_confetti_")
    scene.render.image_settings.compression = 45
    scene.view_settings.look = "AgX - Medium High Contrast"
    if hasattr(scene.render, "use_motion_blur"):
        scene.render.use_motion_blur = True
    if hasattr(scene.render, "motion_blur_shutter"):
        scene.render.motion_blur_shutter = 0.34

    world = bpy.data.worlds.new("Modern Confetti World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.08, 0.085, 0.095, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.33
    scene.world = world

    bpy.ops.object.camera_add(location=(0, 0, 24))
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 20.0
    scene.camera = camera

    for location, energy, size, color in [
        ((-10, -4, 14), 920, 10, (1.0, 0.82, 0.68)),
        ((10, 4, 12), 760, 9, (0.66, 0.78, 1.0)),
        ((0, -10, 9), 420, 8, (1.0, 0.96, 0.90)),
    ]:
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.data.energy = energy
        light.data.shape = "DISK"
        light.data.size = size
        light.data.color = color

    paper_mats = [
        material("Warm ivory tissue", (0.78, 0.66, 0.52), roughness=0.82),
        material("Muted coral tissue", (0.58, 0.12, 0.10), roughness=0.78),
        material("Dusty rose tissue", (0.50, 0.22, 0.25), roughness=0.80),
        material("Deep navy tissue", (0.018, 0.045, 0.11), roughness=0.74),
        material("Desaturated teal tissue", (0.025, 0.22, 0.23), roughness=0.78),
    ]
    ribbon_mats = paper_mats + [
        material("Champagne satin mylar", (0.54, 0.30, 0.08), metallic=0.56, roughness=0.34),
        material("Soft rose mylar", (0.50, 0.18, 0.20), metallic=0.32, roughness=0.42),
    ]

    for index in range(186):
        obj = create_flat_ribbon(index, rng, ribbon_mats) if index % 5 == 0 else create_fleck(index, rng, paper_mats)
        animate_piece(obj, index, rng, end_frame)

    os.makedirs(output, exist_ok=True)
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output, "modern_confetti_vfx_v3.blend"))
    bpy.ops.render.render(animation=True)


if __name__ == "__main__":
    options = parse_args()
    build_scene(os.path.abspath(options.output), options.percentage, options.end_frame)
