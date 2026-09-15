// Joint behaviour against the real Box3D wasm, through Babylon's constraint classes.

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { BallAndSocketConstraint, HingeConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import { afterEach, describe, expect, it } from "vitest";
import { CreateBoxBody, CreateWasmScene, type IWasmScene } from "./wasmScene";

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
});
