// Joint behaviour against the real Box3D wasm, through Babylon's constraint classes.

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PhysicsConstraintAxis, PhysicsConstraintMotorType, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { BallAndSocketConstraint, HingeConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import { afterEach, describe, expect, it } from "vitest";
import { ConstraintFrame, CreateBoxBody, CreateWasmScene, type IWasmScene, RadToDeg, RelativeFrameRotation, SwingTwist } from "./wasmScene";

let world: IWasmScene | undefined;
afterEach(() => {
    world?.dispose();
    world = undefined;
});

describe("Box3D joints (real wasm)", () => {
    it("creates joints with Box3D's default force and torque thresholds, so no joint events are produced", async () => {
        world = await CreateWasmScene();
        const { scene, plugin, b3, step } = world;
        const anchor = CreateBoxBody(scene, "anchor", new Vector3(0, 5, 0), new Vector3(0.2, 0.2, 0.2), PhysicsMotionType.STATIC);
        let previous = anchor;
        for (let i = 0; i < 6; i++) {
            const link = CreateBoxBody(scene, `link${i}`, new Vector3(0.5 + i, 5, 0), new Vector3(0.9, 0.1, 0.1), PhysicsMotionType.DYNAMIC, 1);
            const pivotA = previous === anchor ? Vector3.Zero() : new Vector3(0.5, 0, 0);
            const constraint =
                i % 2 === 0
                    ? new HingeConstraint(pivotA, new Vector3(-0.5, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, 1), scene)
                    : new BallAndSocketConstraint(pivotA, new Vector3(-0.5, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 1, 0), scene);
            previous.body.addConstraint(link.body, constraint);
            previous = link;
        }
        const worldSlot = (plugin as any)._worldSlot;
        let jointEvents = 0;
        step(120, () => (jointEvents += b3._bx_World_GetJointEventCount(worldSlot)));
        // the chain is swinging, so every joint is awake and loaded the whole time
        expect(previous.node.position.y).toBeLessThan(4.5);
        expect(jointEvents).toBe(0);
    });

    it("drives a ball joint velocity motor about the joint's own axis, not a world axis", async () => {
        for (const parentRotation of [Quaternion.Identity(), Quaternion.RotationAxis(new Vector3(0, 0, 1), Math.PI / 2)]) {
            world?.dispose();
            world = await CreateWasmScene(Vector3.Zero());
            const { scene, plugin, step } = world;
            const axis = new Vector3(1, 0, 0);
            const perp = new Vector3(0, 1, 0);
            const parent = CreateBoxBody(scene, "parent", new Vector3(0, 5, 0), new Vector3(0.2, 0.2, 0.2), PhysicsMotionType.STATIC, undefined, { rotation: parentRotation });
            // the bar hangs off the parent's local x axis, which the parent rotation turns into world y for the second run
            const local = axis.applyRotationQuaternion(parentRotation);
            const child = CreateBoxBody(scene, "child", new Vector3(0, 5, 0).add(local.scale(0.55)), new Vector3(1, 0.1, 0.1), PhysicsMotionType.DYNAMIC, 2, {
                rotation: parentRotation,
            });
            const constraint = new BallAndSocketConstraint(Vector3.Zero(), new Vector3(-0.55, 0, 0), axis, axis, scene);
            parent.body.addConstraint(child.body, constraint);
            plugin.setAxisMotorType(constraint, PhysicsConstraintAxis.ANGULAR_X, PhysicsConstraintMotorType.VELOCITY);
            plugin.setAxisMotorMaxForce(constraint, PhysicsConstraintAxis.ANGULAR_X, 50);
            plugin.setAxisMotorTarget(constraint, PhysicsConstraintAxis.ANGULAR_X, 2);
            step(60);
            const frame = ConstraintFrame(axis, perp);
            const { twist, swing } = SwingTwist(RelativeFrameRotation(parent.node, child.node, frame, frame));
            // one second at 2 rad/s about the joint axis, and no swing away from it
            expect(twist).toBeGreaterThan(1.5);
            expect(twist).toBeLessThan(2.4);
            expect(swing * RadToDeg).toBeLessThan(3);
            // the motor turns the bar about the joint's axis in world space, which the parent rotation moved
            const spin = child.body.getAngularVelocity();
            const expected = local.normalizeToNew();
            expect(Vector3.Dot(spin.normalizeToNew(), expected)).toBeGreaterThan(0.99);
        }
    });
});
