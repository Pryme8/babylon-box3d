// Cylinders where pointA and pointB say, and hulls and meshes built from plain points, against the real Box3D wasm.

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PhysicsMotionType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShape, PhysicsShapeContainer, PhysicsShapeCylinder } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult";
import { afterEach, describe, expect, it } from "vitest";
import { CreateBoxBody, CreateWasmScene, type IWasmScene } from "./wasmScene";

let world: IWasmScene | undefined;
afterEach(() => {
    world?.dispose();
    world = undefined;
});

function staticBody(w: IWasmScene, shape: PhysicsShape, position = Vector3.Zero()): PhysicsBody {
    const node = new TransformNode("static", w.scene);
    node.position.copyFrom(position);
    node.rotationQuaternion = Quaternion.Identity();
    const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, w.scene);
    body.shape = shape;
    return body;
}

function hitY(w: IWasmScene, x: number, z: number, downward = true): number | null {
    const result = new PhysicsRaycastResult();
    const [from, to] = downward ? [new Vector3(x, 20, z), new Vector3(x, -20, z)] : [new Vector3(x, -20, z), new Vector3(x, 20, z)];
    w.plugin.raycast(from, to, result);
    return result.hasHit ? result.hitPointWorld.y : null;
}

/** The corners of a box as x, y, z triplets. */
function boxPoints(min: [number, number, number], max: [number, number, number]): number[] {
    const points: number[] = [];
    for (let corner = 0; corner < 8; corner++) {
        points.push(corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]);
    }
    return points;
}

describe("cylinders", () => {
    it("run from pointA to pointB, standing up and lying down", async () => {
        world = await CreateWasmScene();
        const w = world;
        staticBody(w, new PhysicsShapeCylinder(new Vector3(0, 0, 0), new Vector3(0, 2, 0), 1, w.scene));
        w.step();
        expect(hitY(w, 0, 0)).toBeCloseTo(2, 3);
        expect(hitY(w, 0, 0, false)).toBeCloseTo(0, 3);

        staticBody(w, new PhysicsShapeCylinder(new Vector3(-1, 5, 10), new Vector3(1, 5, 10), 0.5, w.scene));
        w.step();
        expect(hitY(w, 0.9, 10)).toBeCloseTo(5.5, 2);
        expect(hitY(w, -0.9, 10)).toBeCloseTo(5.5, 2);
        expect(hitY(w, 1.1, 10)).toBeNull();
    });

    it("sit where they were put inside a container", async () => {
        world = await CreateWasmScene();
        const w = world;
        const container = new PhysicsShapeContainer(w.scene);
        container.addChild(new PhysicsShapeCylinder(new Vector3(0, -0.5, 0), new Vector3(0, 0.5, 0), 0.5, w.scene), new Vector3(3, 1, 0));
        staticBody(w, container);
        w.step();
        expect(hitY(w, 3, 0)).toBeCloseTo(1.5, 3);
        expect(hitY(w, 3, 0, false)).toBeCloseTo(0.5, 3);
    });
});

describe("shapes from plain points", () => {
    it("builds a convex hull with no mesh, which a dynamic body can stand on", async () => {
        world = await CreateWasmScene();
        const w = world;
        CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        const hull = new PhysicsShape({ type: PhysicsShapeType.CONVEX_HULL, parameters: { positions: boxPoints([-1, 0, -1], [1, 1, 1]) } }, w.scene);
        staticBody(w, hull, new Vector3(10, 0, 0));
        w.step();
        expect(hitY(w, 10, 0)).toBeCloseTo(1, 3);

        // The same points as a body of its own: it falls and comes to rest on its underside.
        const node = new TransformNode("falling", w.scene);
        node.position.set(-10, 3, 0);
        node.rotationQuaternion = Quaternion.Identity();
        const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, w.scene);
        body.shape = new PhysicsShape({ type: PhysicsShapeType.CONVEX_HULL, parameters: { positions: boxPoints([-0.5, 0, -0.5], [0.5, 0.4, 0.5]) } }, w.scene);
        body.setMassProperties({ mass: 10 });
        w.step(180);
        expect(node.position.y).toBeCloseTo(0, 2);
    });

    it("builds a triangle mesh from points and indices, wound so the cross product points out", async () => {
        world = await CreateWasmScene();
        const w = world;
        // A 2 m quad facing up at y 0.25: (b - a) x (c - a) points up for both triangles.
        const positions = [-1, 0.25, -1, -1, 0.25, 1, 1, 0.25, 1, 1, 0.25, -1];
        const mesh = new PhysicsShape({ type: PhysicsShapeType.MESH, parameters: { positions, positionIndices: [0, 1, 2, 0, 2, 3] } }, w.scene);
        staticBody(w, mesh);
        w.step();
        expect(hitY(w, 0.5, 0.5)).toBeCloseTo(0.25, 3);
        expect(hitY(w, 1.5, 0)).toBeNull();
    });

    it("says what is wrong with the points it was given", async () => {
        world = await CreateWasmScene();
        const w = world;
        expect(() => new PhysicsShape({ type: PhysicsShapeType.CONVEX_HULL, parameters: { positions: [0, 0] } }, w.scene)).toThrow(/triplets/);
        expect(() => new PhysicsShape({ type: PhysicsShapeType.MESH, parameters: { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1] } }, w.scene)).toThrow(
            /positionIndices/
        );
        expect(
            () => new PhysicsShape({ type: PhysicsShapeType.MESH, parameters: { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], positionIndices: [0, 1, 3] } }, w.scene)
        ).toThrow(/3 points/);
    });
});
