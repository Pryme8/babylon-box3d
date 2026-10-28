// character: Box3D's two character movers on a small course, ?demo=character&mover=dynamic|geometric
//
// The dynamic mover is a rigid capsule held up by a pogo joint and driven by a mover joint, so it pushes crates with
// its own mass and rides the moving platform. The geometric mover is no body at all: it is cast through the world and
// solved against the planes it touches, and pushes what it walks into. Both walk up the stairs and the ramp on their
// pogo and slide off the slope that is too steep to walk.

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { type Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { type LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { KeyboardEventTypes } from "@babylonjs/core/Events/keyboardEvents";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsMotionType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Box3DDynamicMover, Box3DGeometricMover } from "../../src/box3dMovers";
import { Ground, type IDemoContext } from "./common";

const HalfHeight = 0.5;
const Radius = 0.3;

export function BuildCharacter(ctx: IDemoContext): void {
    const scene = ctx.scene;
    const plugin = ctx.plugin;
    const kind = ctx.params.get("mover") === "geometric" ? "geometric" : "dynamic";
    const other = kind === "dynamic" ? "geometric" : "dynamic";
    ctx.help =
        `W/A/S/D: walk · shift: run · space: jump · drag: orbit the camera\n` +
        `${kind} mover · <a style="color:#8cf" href="?demo=character&mover=${other}">try the ${other} one</a>`;
    Ground(ctx);

    const staticBox = (name: string, center: Vector3, size: Vector3, color: number, rotation = Quaternion.Identity()): Mesh => {
        const mesh = MeshBuilder.CreateBox(name, { width: size.x, height: size.y, depth: size.z }, scene);
        mesh.position.copyFrom(center);
        mesh.rotationQuaternion = rotation;
        mesh.material = ctx.material(color);
        ctx.watch(mesh);
        new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 0, friction: 0.6 }, scene);
        return mesh;
    };

    // stairs of 20 cm steps up to a landing: the pogo steps the capsule up them without the capsule touching an edge
    const rise = 0.2;
    const run = 0.45;
    const steps = 8;
    for (let i = 0; i < steps; i++) {
        const height = (i + 1) * rise;
        staticBox(`step${i}`, new Vector3(-8, height / 2, 2 + i * run), new Vector3(3, height, run), 6);
    }
    staticBox("landing", new Vector3(-8, (steps * rise) / 2, 2 + steps * run + 1.5 - run / 2), new Vector3(3, steps * rise, 3), 6);

    // a ramp at 20 degrees, walkable, and a slope at 50 degrees, too steep: its normal's y is under minGroundNormalY
    const slab = (name: string, x: number, degrees: number, length: number, color: number): void => {
        const angle = (degrees * Math.PI) / 180;
        const thickness = 0.4;
        // the top face meets the ground at the low end, the slab rises towards +z
        const center = new Vector3(x, (length / 2) * Math.sin(angle) - (thickness / 2) * Math.cos(angle), 2 + (length / 2) * Math.cos(angle));
        staticBox(name, center, new Vector3(3, thickness, length), color, Quaternion.RotationAxis(Vector3.Right(), -angle));
    };
    slab("ramp", 0, 20, 7, 4);
    slab("slope", 8, 50, 5, 0);

    // a platform the dynamic mover rides: animated, so its mover joint holds to it
    const platformMesh = MeshBuilder.CreateBox("platform", { width: 3, height: 0.4, depth: 3 }, scene);
    platformMesh.position.set(0, 0.2, -6);
    platformMesh.material = ctx.material(3);
    ctx.watch(platformMesh);
    const platform = new PhysicsBody(platformMesh, PhysicsMotionType.ANIMATED, false, scene);
    platform.shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(3, 0.4, 3), scene);
    const platformSpeed = 2;
    platform.setLinearVelocity(new Vector3(platformSpeed, 0, 0));

    // crates to push
    for (let i = 0; i < 6; i++) {
        const size = 0.6 + 0.15 * (i % 3);
        const crate = MeshBuilder.CreateBox(`crate${i}`, { size }, scene);
        crate.position.set(-4 + (i % 3) * 1.2, size / 2 + Math.floor(i / 3) * size, -12);
        crate.material = ctx.material(1 + (i % 2));
        ctx.watch(crate);
        new PhysicsAggregate(crate, PhysicsShapeType.BOX, { mass: 8 * size * size * size, friction: 0.6 }, scene);
    }

    // the character: the mover moves `root`, which stays upright; `facing` turns to where it walks
    const root = new TransformNode("character", scene);
    root.position.set(-2, HalfHeight + 0.9, -9);
    const facing = new TransformNode("facing", scene);
    facing.parent = root;
    const capsule = MeshBuilder.CreateCapsule("capsule", { radius: Radius, height: 2 * (HalfHeight + Radius), tessellation: 24 }, scene);
    capsule.parent = facing;
    capsule.material = ctx.material(7);
    ctx.watch(capsule);
    const nose = MeshBuilder.CreateBox("nose", { width: 0.25, height: 0.12, depth: 0.2 }, scene);
    nose.parent = facing;
    nose.position.set(0, HalfHeight, Radius);
    nose.material = ctx.material(3);

    const options = { position: root.position.clone(), capsuleHalfHeight: HalfHeight, capsuleRadius: Radius, transformNode: root };
    const dynamicMover = kind === "dynamic" ? new Box3DDynamicMover(plugin, scene, options) : undefined;
    const geometricMover = kind === "geometric" ? new Box3DGeometricMover(plugin, options) : undefined;
    scene.metadata = { mover: dynamicMover ?? geometricMover };

    // the pogo's rays: green the one it stands on, yellow the other hits, grey the misses
    const probeCount = 1 + Box3DDynamicMover.SkirtCount;
    const lines: Vector3[][] = [];
    const colors: Color4[][] = [];
    for (let i = 0; i < probeCount; i++) {
        lines.push([Vector3.Zero(), Vector3.Zero()]);
        colors.push([new Color4(), new Color4()]);
    }
    let probes: LinesMesh = MeshBuilder.CreateLineSystem("probes", { lines, colors, updatable: true }, scene);
    const green = new Color4(0.3, 1, 0.4, 1);
    const yellow = new Color4(1, 0.85, 0.2, 1);
    const grey = new Color4(0.5, 0.5, 0.5, 1);

    const forward = new Vector3();
    const right = new Vector3();
    const direction = new Vector3();
    plugin.onBeforeWorldStepObservable.add((dt) => {
        // the throttles move the mover relative to the camera, flattened to the ground
        root.position.subtractToRef(ctx.camera.position, forward);
        forward.y = 0;
        forward.normalize();
        Vector3.CrossToRef(Vector3.Up(), forward, right);
        const throttleForward = (ctx.keys.has("w") || ctx.keys.has("arrowup") ? 1 : 0) - (ctx.keys.has("s") || ctx.keys.has("arrowdown") ? 1 : 0);
        const throttleRight = (ctx.keys.has("d") || ctx.keys.has("arrowright") ? 1 : 0) - (ctx.keys.has("a") || ctx.keys.has("arrowleft") ? 1 : 0);
        const speedScale = ctx.keys.has("shift") ? 1.6 : 1;
        dynamicMover?.update(dt, forward, right, throttleForward, throttleRight, speedScale);
        geometricMover?.update(dt, forward, right, throttleForward, throttleRight, speedScale);

        // the platform turns round at either end of its run
        const x = platformMesh.position.x;
        if ((x > 6 && platform.getLinearVelocity().x > 0) || (x < -6 && platform.getLinearVelocity().x < 0)) {
            platform.setLinearVelocity(new Vector3(x > 0 ? -platformSpeed : platformSpeed, 0, 0));
        }
    });

    scene.onKeyboardObservable.add((info) => {
        if (info.type === KeyboardEventTypes.KEYDOWN && info.event.key === " " && !info.event.repeat) {
            dynamicMover?.jump();
            geometricMover?.jump();
        }
    });

    scene.onBeforeRenderObservable.add(() => {
        const velocity = dynamicMover?.velocity ?? geometricMover!.velocity;
        direction.set(velocity.x, 0, velocity.z);
        if (direction.lengthSquared() > 0.25) {
            const yaw = Math.atan2(direction.x, direction.z);
            facing.rotationQuaternion = Quaternion.Slerp(facing.rotationQuaternion ?? Quaternion.Identity(), Quaternion.RotationAxis(Vector3.Up(), yaw), 0.25);
        }
        ctx.camera.target = Vector3.Lerp(ctx.camera.target, root.position, 0.12);

        for (let i = 0; i < probeCount; i++) {
            const line = lines[i];
            const color = colors[i];
            // the rays not cast this step shrink to nothing
            let c = grey;
            line[1].copyFrom(line[0]);
            if (dynamicMover && i < dynamicMover.probeCount) {
                const probe = dynamicMover.probes[i];
                line[0].copyFrom(probe.origin);
                probe.origin.addToRef(probe.translation.scale(probe.fraction), line[1]);
                c = !probe.hit ? grey : i === dynamicMover.selectedProbe ? green : yellow;
            } else if (geometricMover && i === 0) {
                const probe = geometricMover.pogoProbe;
                line[0].copyFrom(probe.origin);
                probe.origin.addToRef(probe.translation.scale(probe.fraction), line[1]);
                c = probe.hit ? green : grey;
            }
            color[0].copyFrom(c);
            color[1].copyFrom(c);
        }
        probes = MeshBuilder.CreateLineSystem("probes", { lines, colors, instance: probes });
    });

    ctx.camera.setTarget(root.position.clone());
    ctx.camera.radius = 14;
    ctx.camera.alpha = -Math.PI / 2 - 0.5;
    ctx.camera.beta = Math.PI / 3;
}
