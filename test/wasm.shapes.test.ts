// Shape property changes and filtering against the real Box3D wasm.

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox, PhysicsShapeContainer, PhysicsShapeSphere } from "@babylonjs/core/Physics/v2/physicsShape";
import { BallAndSocketConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult";
import { afterEach, describe, expect, it } from "vitest";
import { CreateBoxBody, CreateWasmScene, type IWasmScene } from "./wasmScene";

let world: IWasmScene | undefined;
afterEach(() => {
    world?.dispose();
    world = undefined;
});

describe("Box3D shape properties (real wasm)", () => {
    it("changes filters, materials and density on live shapes instead of rebuilding them", async () => {
        world = await CreateWasmScene();
        const w = world;
        CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        // a jointed pair of boxes, like two bones of a ragdoll, resting on the ground
        const a = CreateBoxBody(w.scene, "a", new Vector3(0, 0.5, 0), new Vector3(1, 1, 1), PhysicsMotionType.DYNAMIC, 5);
        const b = CreateBoxBody(w.scene, "b", new Vector3(1.2, 0.5, 0), new Vector3(1, 1, 1), PhysicsMotionType.DYNAMIC, 3);
        a.body.addConstraint(b.body, new BallAndSocketConstraint(new Vector3(0.6, 0, 0), new Vector3(-0.6, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 1, 0), w.scene));
        w.step(60);

        const builds = w.b3._bx_GetShapeBuildCount();
        a.shape.filterMembershipMask = 0xffffffff & ~256;
        a.shape.filterCollideMask = 0xffffffff & ~1024;
        a.shape.material = { friction: 0.9, restitution: 0.2 };
        b.shape.density = 500;
        expect(w.b3._bx_GetShapeBuildCount()).toBe(builds);
        // the user mass survives a density change, the shapes keep their materials
        expect(a.body.getMassProperties().mass).toBeCloseTo(5);
        expect(b.body.getMassProperties().mass).toBeCloseTo(3);
        expect(a.shape.material.friction).toBeCloseTo(0.9);
        expect(a.shape.getFilterMembershipMask?.() ?? a.shape.filterMembershipMask).toBe(0xffffffff & ~256);

        // the joint still holds the pair together and nothing was teleported
        const separation = Vector3.Distance(a.node.position, b.node.position);
        w.step(30);
        expect(Vector3.Distance(a.node.position, b.node.position)).toBeCloseTo(separation, 2);
        expect(a.body.getLinearVelocity().length()).toBeLessThan(0.2);

        // geometry changes still rebuild
        const container = new PhysicsShapeContainer(w.scene);
        container.addChild(new PhysicsShapeSphere(Vector3.Zero(), 0.4, w.scene), new Vector3(0, 0, 0));
        const c = CreateBoxBody(w.scene, "c", new Vector3(6, 3, 0), new Vector3(1, 1, 1), PhysicsMotionType.DYNAMIC, 1);
        c.body.shape = container;
        const beforeChild = w.b3._bx_GetShapeBuildCount();
        container.addChild(new PhysicsShapeSphere(Vector3.Zero(), 0.4, w.scene), new Vector3(0, 1, 0));
        expect(w.b3._bx_GetShapeBuildCount()).toBeGreaterThan(beforeChild);
    });

    it("stops colliding as soon as the collide mask excludes the other shape", async () => {
        world = await CreateWasmScene();
        const w = world;
        const ground = CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        ground.shape.filterMembershipMask = 1 << 3;
        const box = CreateBoxBody(w.scene, "box", new Vector3(0, 0.5, 0), new Vector3(1, 1, 1), PhysicsMotionType.DYNAMIC, 1);
        w.step(60);
        expect(box.node.position.y).toBeCloseTo(0.5, 1);
        // stop colliding with the ground's group only
        box.shape.filterCollideMask = 0xffffffff & ~(1 << 3);
        w.step(60);
        expect(box.node.position.y).toBeLessThan(0);
    });

    it("treats masks as uint32 and keeps Havok's signed bit pattern in the getters", async () => {
        world = await CreateWasmScene();
        const w = world;
        const box = CreateBoxBody(w.scene, "box", new Vector3(0, 5, 0), new Vector3(1, 1, 1), PhysicsMotionType.DYNAMIC, 1);
        box.shape.filterMembershipMask = 0x80000000;
        box.shape.filterCollideMask = 0xffffffff & ~(1 << 8);
        // Havok's HP_Shape_GetFilterInfo returns int32 too, so the bit patterns match
        expect(box.shape.filterMembershipMask | 0).toBe(0x80000000 | 0);
        expect(box.shape.filterCollideMask | 0).toBe((0xffffffff & ~(1 << 8)) | 0);
        expect((box.shape.filterCollideMask >>> 0) & (1 << 8)).toBe(0);
        expect((box.shape.filterCollideMask >>> 0) & 1).toBe(1);
        // a shape whose membership is only the top bit still collides with the default mask
        const ground = CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        expect(ground.shape.filterCollideMask >>> 0).toBe(0xffffffff);
        w.step(120);
        expect(box.node.position.y).toBeCloseTo(0.5, 1);
    });

    it("skips shapes whose collide mask excludes the ray, with and without a query filter", async () => {
        world = await CreateWasmScene();
        const w = world;
        const ground = CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        const from = new Vector3(0, 5, 0);
        const to = new Vector3(0, -5, 0);
        const result = new PhysicsRaycastResult();

        w.plugin.raycast(from, to, result);
        expect(result.hasHit).toBe(true);
        expect(result.body).toBe(ground.body);

        // collide mask 0: rays pass through, matching Havok's two way test against the query filter
        ground.shape.filterCollideMask = 0;
        w.plugin.raycast(from, to, result);
        expect(result.hasHit).toBe(false);

        // membership that the query does not collide with is skipped as well
        ground.shape.filterCollideMask = 0xffffffff;
        ground.shape.filterMembershipMask = 1 << 5;
        w.plugin.raycast(from, to, result);
        expect(result.hasHit).toBe(true);
        w.plugin.raycast(from, to, result, { collideWith: 0xffffffff & ~(1 << 5) });
        expect(result.hasHit).toBe(false);
        w.plugin.raycast(from, to, result, { collideWith: 1 << 5 });
        expect(result.hasHit).toBe(true);
        // and the other direction: the shape does not collide with the query's membership
        ground.shape.filterCollideMask = 1 << 6;
        w.plugin.raycast(from, to, result, { membership: 1 << 7, collideWith: 1 << 5 });
        expect(result.hasHit).toBe(false);
        w.plugin.raycast(from, to, result, { membership: 1 << 6, collideWith: 1 << 5 });
        expect(result.hasHit).toBe(true);
    });

    it("keeps the user mass properties when a body's shape is replaced", async () => {
        world = await CreateWasmScene();
        const w = world;
        const node = new TransformNode("body", w.scene);
        node.rotationQuaternion = Quaternion.Identity();
        const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, w.scene);
        // Babylon code often sets the mass before the shape exists
        body.setMassProperties({ mass: 70 });
        body.shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(1, 2, 1), w.scene);
        expect(body.getMassProperties().mass).toBeCloseTo(70);
        body.shape = new PhysicsShapeSphere(Vector3.Zero(), 0.5, w.scene);
        expect(body.getMassProperties().mass).toBeCloseTo(70);
    });
});
