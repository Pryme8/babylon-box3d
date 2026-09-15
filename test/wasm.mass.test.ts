// Mass properties against the real Box3D wasm, with Havok's semantics (inertia per unit mass, a zero component locks
// that axis) as the reference.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { type PhysicsMassProperties, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import HavokPhysics from "@babylonjs/havok";
import { afterEach, describe, expect, it } from "vitest";
import { CreateBoxBody, CreateWasmScene, type IWasmScene } from "./wasmScene";

let world: IWasmScene | undefined;
afterEach(() => {
    world?.dispose();
    world = undefined;
});

let havokModule: any;
/** Runs the same body through Havok: set mass properties, apply an angular impulse, return the angular velocity. */
async function HavokSpin(massProps: PhysicsMassProperties, impulse: Vector3, rotation: Quaternion): Promise<Vector3> {
    havokModule ??= await HavokPhysics({
        wasmBinary: readFileSync(fileURLToPath(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url))),
    });
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.enablePhysics(Vector3.Zero(), new HavokPlugin(false, havokModule));
    const body = CreateBoxBody(scene, "body", Vector3.Zero(), new Vector3(0.6, 1.8, 0.6), PhysicsMotionType.DYNAMIC, undefined, { rotation });
    body.body.setMassProperties(massProps);
    body.body.applyAngularImpulse(impulse);
    (scene.getPhysicsEngine() as any)._step(1 / 60);
    const velocity = body.body.getAngularVelocity();
    scene.dispose();
    engine.dispose();
    return velocity;
}

async function Box3DSpin(massProps: PhysicsMassProperties, impulse: Vector3, rotation: Quaternion): Promise<{ velocity: Vector3; body: ReturnType<typeof CreateBoxBody> }> {
    world?.dispose();
    world = await CreateWasmScene(Vector3.Zero());
    const body = CreateBoxBody(world.scene, "body", Vector3.Zero(), new Vector3(0.6, 1.8, 0.6), PhysicsMotionType.DYNAMIC, undefined, { rotation });
    body.body.setMassProperties(massProps);
    body.body.applyAngularImpulse(impulse);
    world.step(1);
    return { velocity: body.body.getAngularVelocity(), body };
}

describe("Box3D mass properties (real wasm)", () => {
    it("treats inertia as per unit mass, like Havok", async () => {
        const cases: Array<[string, PhysicsMassProperties, Vector3]> = [
            ["mass only keeps the shape inertia", { mass: 10 }, new Vector3(1, 0, 0)],
            ["explicit inertia", { mass: 10, inertia: new Vector3(1, 2, 4) }, new Vector3(1, 1, 1)],
            ["inertia orientation", { mass: 10, inertia: new Vector3(1, 2, 4), inertiaOrientation: Quaternion.RotationAxis(new Vector3(0, 0, 1), Math.PI / 2) }, new Vector3(1, 0, 0)],
            ["center of mass", { mass: 4, centerOfMass: new Vector3(0, 0.9, 0) }, new Vector3(0, 0, 1)],
        ];
        for (const [name, props, impulse] of cases) {
            const havok = await HavokSpin(props, impulse, Quaternion.Identity());
            const box3d = await Box3DSpin(props, impulse, Quaternion.Identity());
            const difference = Vector3.Distance(havok, box3d.velocity);
            expect(difference / Math.max(1, havok.length()), name).toBeLessThan(0.02);
        }
    });

    it("locks rotation about a principal axis with a zero inertia component, like the player capsule", async () => {
        const props = { mass: 1, inertia: new Vector3(0, 1, 0) };
        for (const [name, impulse] of [
            ["about x", new Vector3(2, 0, 0)],
            ["about y", new Vector3(0, 2, 0)],
            ["mixed", new Vector3(2, 2, 2)],
        ] as Array<[string, Vector3]>) {
            const havok = await HavokSpin(props, impulse, Quaternion.Identity());
            const { velocity } = await Box3DSpin(props, impulse, Quaternion.Identity());
            expect(Math.abs(velocity.x), name).toBeLessThan(0.01);
            expect(Math.abs(velocity.z), name).toBeLessThan(0.01);
            expect(velocity.y, name).toBeCloseTo(havok.y, 2);
        }
        // the lock follows the body, not the world: a body lying on its side spins about its own local y
        const rotation = Quaternion.RotationAxis(new Vector3(0, 0, 1), Math.PI / 2);
        const havok = await HavokSpin(props, new Vector3(2, 0, 0), rotation);
        const { velocity } = await Box3DSpin(props, new Vector3(2, 0, 0), rotation);
        expect(velocity.x).toBeCloseTo(havok.x, 1);
        expect(Math.abs(velocity.y)).toBeLessThan(0.05);
    });

    it("keeps a locked axis locked while the body is pushed around", async () => {
        world = await CreateWasmScene(new Vector3(0, -9.81, 0));
        const w = world;
        CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        const player = CreateBoxBody(w.scene, "player", new Vector3(0, 1.2, 0), new Vector3(0.5, 1.8, 0.5), PhysicsMotionType.DYNAMIC, undefined, {});
        player.body.setMassProperties({ mass: 70, inertia: new Vector3(0, 1, 0) });
        // a Box3D motion lock is exact here: only the world y axis is free
        w.b3._bx_Body_GetMotionLocks((player.body as any)._pluginData.slot);
        const locks = Array.from(new Float32Array(w.b3.HEAPF32.buffer, w.b3._bx_Scratch(), 6));
        expect(locks).toEqual([0, 0, 0, 1, 0, 1]);
        player.body.setAngularVelocity(new Vector3(0, 2, 0));
        let maxTilt = 0;
        w.step(180, (i) => {
            if (i % 20 === 0) {
                player.body.applyImpulse(new Vector3(60, 0, 40), new Vector3(0.2, 2, 0.2));
            }
            const up = new Vector3(0, 1, 0).applyRotationQuaternion(player.node.rotationQuaternion!);
            maxTilt = Math.max(maxTilt, Math.acos(Math.min(1, up.y)));
        });
        expect((maxTilt * 180) / Math.PI).toBeLessThan(0.5);
        expect(player.body.getMassProperties().inertia!.asArray()).toEqual([0, 1, 0]);
        expect(player.body.getMassProperties().mass).toBeCloseTo(70);
    });

    it("keeps a user inertia when the mass is set with it, and reports what was set", async () => {
        world = await CreateWasmScene(Vector3.Zero());
        const w = world;
        const body = CreateBoxBody(w.scene, "body", Vector3.Zero(), new Vector3(1, 1, 1), PhysicsMotionType.DYNAMIC);
        body.body.setMassProperties({ mass: 8, inertia: new Vector3(0.5, 0.5, 0.5) });
        const props = body.body.getMassProperties();
        expect(props.mass).toBeCloseTo(8);
        expect(props.inertia!.x).toBeCloseTo(0.5);
        // absolute inertia is mass * per unit inertia: an impulse of 1 about x gives 1 / (8 * 0.5)
        body.body.applyAngularImpulse(new Vector3(1, 0, 0));
        w.step(1);
        expect(body.body.getAngularVelocity().x).toBeCloseTo(0.25, 2);
        // motion type changes re-apply the user properties
        body.body.setMotionType(PhysicsMotionType.ANIMATED);
        body.body.setMotionType(PhysicsMotionType.DYNAMIC);
        expect(body.body.getMassProperties().mass).toBeCloseTo(8);
        body.body.setLinearVelocity(Vector3.Zero());
        body.body.setAngularVelocity(Vector3.Zero());
        body.body.applyAngularImpulse(new Vector3(1, 0, 0));
        w.step(1);
        expect(body.body.getAngularVelocity().x).toBeCloseTo(0.25, 2);
    });

    it("diagonalizes a rotated inertia tensor exactly and rebuilds it unchanged", async () => {
        world = await CreateWasmScene(Vector3.Zero());
        const w = world;
        // a box rotated 30 degrees inside its body: the tensor has off diagonal terms in body space
        const rotation = Quaternion.RotationAxis(new Vector3(0, 0, 1), Math.PI / 6);
        const rotated = CreateBoxBody(w.scene, "rotated", Vector3.Zero(), new Vector3(0.5, 1.5, 0.9), PhysicsMotionType.DYNAMIC, undefined, { shapeRotation: rotation });
        // the same box without the shape rotation, well clear of the first one so they never touch
        const upright = CreateBoxBody(w.scene, "upright", new Vector3(20, 0, 0), new Vector3(0.5, 1.5, 0.9), PhysicsMotionType.DYNAMIC);
        const sorted = (v: Vector3) => v.asArray().slice().sort((a, b) => a - b);
        // the same box has the same principal moments whatever the shape rotation; a decomposition that does not
        // converge returns a permutation of the body space diagonal instead, which differs by ~20% here
        const reference = sorted(upright.body.computeMassProperties().inertia!);
        sorted(rotated.body.computeMassProperties().inertia!).forEach((value, i) => expect(value).toBeCloseTo(reference[i], 3));
        // the reported orientation is the rotation that was applied, up to the box's own symmetry
        const axis = new Vector3(0, 0, 1).applyRotationQuaternion(rotated.body.computeMassProperties().inertiaOrientation!);
        expect(Math.abs(axis.z)).toBeGreaterThan(0.999);

        // round trip: setMassProperties({ mass }) re-writes the tensor from the decomposition, so it must come back
        // unchanged apart from the mass, which is what every Babylon Ragdoll box relies on
        const before = rotated.body.getMassProperties();
        rotated.body.setMassProperties({ mass: 7 });
        const after = rotated.body.getMassProperties();
        expect(after.mass).toBeCloseTo(7);
        after.inertia!.asArray().forEach((value, i) => expect(value).toBeCloseTo(before.inertia!.asArray()[i], 4));
        // an impulse about a principal axis produces rotation about that axis only. The body turns while it spins, so
        // the axis has to be taken through its current orientation each time.
        for (const index of [0, 1, 2]) {
            const local = new Vector3(+(index === 0), +(index === 1), +(index === 2)).applyRotationQuaternion(after.inertiaOrientation!);
            const world = local.applyRotationQuaternion(rotated.node.rotationQuaternion!);
            rotated.body.setAngularVelocity(Vector3.Zero());
            rotated.body.applyAngularImpulse(world.scale(2));
            w.step(1);
            const spin = rotated.body.getAngularVelocity().normalizeToNew();
            expect(Math.abs(Vector3.Dot(spin, world.normalizeToNew())), `principal axis ${index}`).toBeGreaterThan(0.99);
        }
    });

    it("reports the mass of a static or animated body from its shapes, like Havok", async () => {
        world = await CreateWasmScene(Vector3.Zero());
        const w = world;
        for (const type of [PhysicsMotionType.STATIC, PhysicsMotionType.ANIMATED, PhysicsMotionType.DYNAMIC]) {
            const body = CreateBoxBody(w.scene, `body${type}`, Vector3.Zero(), new Vector3(1, 1, 1), type);
            // a 1 m box at the default density weighs 1000 kg; Havok reports that for every motion type, Box3D keeps
            // mass 0 on static and kinematic bodies, so the plugin computes it from the shapes
            expect(body.body.getMassProperties().mass).toBeCloseTo(1000, 0);
            expect(body.body.computeMassProperties().mass).toBeCloseTo(1000, 0);
            expect(body.body.getMassProperties().inertia!.x).toBeCloseTo(1 / 6, 2);
        }
        // a body with no shape weighs nothing rather than an invented 1 kg
        const empty = new PhysicsBody(new TransformNode("empty", w.scene), PhysicsMotionType.STATIC, false, w.scene);
        expect(empty.getMassProperties().mass).toBe(0);
    });

    it("reports the principal inertia of a rotated shape like Havok does", async () => {
        world = await CreateWasmScene(Vector3.Zero());
        const w = world;
        // a box rotated inside the body: its tensor is not diagonal in body space
        const body = CreateBoxBody(w.scene, "body", Vector3.Zero(), new Vector3(0.4, 2, 0.4), PhysicsMotionType.DYNAMIC, undefined, {
            shapeRotation: Quaternion.RotationAxis(new Vector3(0, 0, 1), Math.PI / 4),
        });
        const props = body.body.computeMassProperties();
        const moments = props.inertia!.asArray().slice().sort((a, b) => a - b);
        // two large moments across the box and one small one along it, whatever the orientation
        expect(moments[0]).toBeLessThan(moments[1] * 0.2);
        // the two moments across the box are equal to within Box3D's numerical hull inertia
        expect(Math.abs(moments[1] - moments[2]) / moments[2]).toBeLessThan(0.05);
        // the reported orientation rebuilds the tensor: spinning about the small axis is easy
        const small = props.inertia!.asArray().indexOf(moments[0]);
        const axis = new Vector3(small === 0 ? 1 : 0, small === 1 ? 1 : 0, small === 2 ? 1 : 0).applyRotationQuaternion(props.inertiaOrientation!);
        body.body.applyAngularImpulse(axis.scale(1));
        w.step(1);
        const spin = body.body.getAngularVelocity();
        expect(Vector3.Dot(spin.normalizeToNew(), axis.normalizeToNew())).toBeGreaterThan(0.99);
    });
});
