// Sleeping, activation control and waking against the real Box3D wasm.

import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsActivationControl, PhysicsMotionType, PhysicsPrestepType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { afterEach, describe, expect, it } from "vitest";
import { CreateBoxBody, CreateWasmScene, type IWasmScene } from "./wasmScene";

let world: IWasmScene | undefined;
afterEach(() => {
    world?.dispose();
    world = undefined;
});

const IsAwake = (w: IWasmScene, body: any) => w.b3._bx_Body_IsAwake(body._pluginData.slot) === 1;

describe("Box3D activation (real wasm)", () => {
    it("wakes a sleeping body for an impulse, a force and a velocity change", async () => {
        world = await CreateWasmScene();
        const w = world;
        CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        const box = CreateBoxBody(w.scene, "box", new Vector3(0, 0.5, 0), new Vector3(1, 1, 1), PhysicsMotionType.DYNAMIC, 1);
        w.step(180);
        expect(IsAwake(w, box.body)).toBe(false);

        box.body.applyImpulse(new Vector3(0, 4, 0), box.node.position);
        expect(IsAwake(w, box.body)).toBe(true);
        w.step(1);
        expect(box.body.getLinearVelocity().y).toBeGreaterThan(3);

        w.step(240);
        expect(IsAwake(w, box.body)).toBe(false);
        box.body.setLinearVelocity(new Vector3(2, 0, 0));
        expect(IsAwake(w, box.body)).toBe(true);
        w.step(1);
        expect(box.body.getLinearVelocity().x).toBeGreaterThan(1);

        w.step(300);
        expect(IsAwake(w, box.body)).toBe(false);
        box.body.applyForce(new Vector3(0, 400, 0), box.node.position);
        expect(IsAwake(w, box.body)).toBe(true);
        w.step(1);
        expect(box.body.getLinearVelocity().y).toBeGreaterThan(1);

        w.step(300);
        expect(IsAwake(w, box.body)).toBe(false);
        box.body.applyAngularImpulse(new Vector3(0, 1, 0));
        expect(IsAwake(w, box.body)).toBe(true);
    });

    it("applies an impulse given in the same frame a body switches from animated to dynamic", async () => {
        world = await CreateWasmScene();
        const w = world;
        CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        const box = CreateBoxBody(w.scene, "box", new Vector3(0, 2, 0), new Vector3(1, 1, 1), PhysicsMotionType.ANIMATED);
        box.body.disablePreStep = false;
        w.step(30);
        expect(box.node.position.y).toBeCloseTo(2);

        // the ragdoll handover: dynamic, prestep off, mass set, impulse, all before the next step
        box.body.setMotionType(PhysicsMotionType.DYNAMIC);
        box.body.disablePreStep = true;
        box.body.setPrestepType(PhysicsPrestepType.TELEPORT);
        box.body.setMassProperties({ mass: 5 });
        box.body.applyImpulse(new Vector3(0, 0, 20), box.node.position);
        expect(box.body.getLinearVelocity().z).toBeCloseTo(4, 3);
        w.step(1);
        expect(box.body.getLinearVelocity().z).toBeCloseTo(4, 1);
        w.step(30);
        expect(box.node.position.z).toBeGreaterThan(1);
    });

    it("parks a body with ALWAYS_INACTIVE and keeps it solid, like Havok", async () => {
        world = await CreateWasmScene();
        const w = world;
        const parked = CreateBoxBody(w.scene, "parked", new Vector3(0, 3, 0), new Vector3(2, 1, 2), PhysicsMotionType.DYNAMIC, 1);
        w.plugin.setActivationControl(parked.body, PhysicsActivationControl.ALWAYS_INACTIVE);
        w.step(60);
        expect(parked.node.position.y).toBeCloseTo(3);
        // impulses and velocity changes are ignored while parked, like Havok
        parked.body.applyImpulse(new Vector3(0, 50, 0), parked.node.position);
        parked.body.setLinearVelocity(new Vector3(0, 10, 0));
        w.step(30);
        expect(parked.node.position.y).toBeCloseTo(3);
        expect(parked.body.getLinearVelocity().length()).toBe(0);
        // it still blocks other bodies
        const faller = CreateBoxBody(w.scene, "faller", new Vector3(0, 6, 0), new Vector3(1, 1, 1), PhysicsMotionType.DYNAMIC, 1);
        w.step(120);
        expect(faller.node.position.y).toBeCloseTo(4, 1);
        expect(parked.node.position.y).toBeCloseTo(3);
        expect(parked.body.getMotionType()).toBe(PhysicsMotionType.DYNAMIC);

        // back to simulation control: asleep until something wakes it, then it falls
        w.plugin.setActivationControl(parked.body, PhysicsActivationControl.SIMULATION_CONTROLLED);
        expect(IsAwake(w, parked.body)).toBe(false);
        expect(parked.body.getMassProperties().mass).toBeCloseTo(1);
        parked.body.applyImpulse(new Vector3(0, -1, 0), parked.node.position);
        w.step(60);
        expect(parked.node.position.y).toBeLessThan(2);
    });

    it("gives thin instances added later the same events and activation as their siblings", async () => {
        world = await CreateWasmScene();
        const w = world;
        const mesh = MeshBuilder.CreateBox("instances", { size: 1 }, w.scene);
        // NullEngine has no vertex buffers, so the thin instance storage the plugin reads is filled in directly
        const matrices = new Float32Array(16 * 6);
        for (let i = 0; i < 6; i++) {
            Matrix.Translation(i * 3, 5, 0).copyToArray(matrices, i * 16);
        }
        const storage = (mesh as any)._thinInstanceDataStorage;
        storage.matrixData = matrices;
        storage.instancesCount = 4;
        Object.defineProperty(mesh, "hasThinInstances", { get: () => true });
        const body = new PhysicsBody(mesh, PhysicsMotionType.DYNAMIC, true, w.scene);
        body.shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(1, 1, 1), w.scene);
        body.setCollisionCallbackEnabled(true);
        w.plugin.setActivationControl(body, PhysicsActivationControl.ALWAYS_ACTIVE);
        // shim event flags: bit 1 begin/end touch, bit 2 hit events
        const flags = () => (body as any)._pluginDataInstances.map((data: any) => w.b3._bx_Body_GetEventFlags(data.slot));
        expect(flags()).toEqual([3, 3, 3, 3]);

        // two more instances: they have to behave like the ones already there
        storage.instancesCount = 6;
        body.updateBodyInstances();
        expect(flags()).toEqual([3, 3, 3, 3, 3, 3]);
        expect((body as any)._pluginDataInstances.every((data: any) => data.eventMask === 7)).toBe(true);
        // ALWAYS_ACTIVE means sleeping is off for every instance, the new ones included
        w.step(400);
        expect((body as any)._pluginDataInstances.every((data: any) => w.b3._bx_Body_IsAwake(data.slot) === 1)).toBe(true);
    });

    it("never sleeps with ALWAYS_ACTIVE and sleeps again under simulation control", async () => {
        world = await CreateWasmScene();
        const w = world;
        CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        const box = CreateBoxBody(w.scene, "box", new Vector3(0, 0.5, 0), new Vector3(1, 1, 1), PhysicsMotionType.DYNAMIC, 1);
        w.plugin.setActivationControl(box.body, PhysicsActivationControl.ALWAYS_ACTIVE);
        w.step(300);
        expect(IsAwake(w, box.body)).toBe(true);
        w.plugin.setActivationControl(box.body, PhysicsActivationControl.SIMULATION_CONTROLLED);
        w.step(300);
        expect(IsAwake(w, box.body)).toBe(false);
    });
});
