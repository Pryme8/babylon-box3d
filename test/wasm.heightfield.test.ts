// Height fields against the real Box3D wasm: row order, holes, and rays through holes.

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PhysicsMotionType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult";
import { afterEach, describe, expect, it } from "vitest";
import { BOX3D_HEIGHT_FIELD_HOLE } from "../src/box3dPlugin";
import { CreateBoxBody, CreateWasmScene, type IWasmScene } from "./wasmScene";

let world: IWasmScene | undefined;
afterEach(() => {
    world?.dispose();
    world = undefined;
});

// 10 × 10 m, a sample every meter, centered on the origin. Babylon's rows start at the +Z edge, so data row r is at
// z = 5 - r, and cell (column c, row r) spans x from c - 5 to c - 4 and z from 4 - r to 5 - r.
const SIZE = 10;
const SAMPLES = 11;
const CELLS = SAMPLES - 1;

function addTerrain(w: IWasmScene, height: (x: number, z: number) => number, holes: Array<[number, number]> = []): void {
    const heights = new Float32Array(SAMPLES * SAMPLES);
    for (let row = 0; row < SAMPLES; row++) {
        for (let column = 0; column < SAMPLES; column++) {
            heights[row * SAMPLES + column] = height(column - SIZE / 2, SIZE / 2 - row);
        }
    }
    const materials = new Uint8Array(CELLS * CELLS);
    for (const [column, row] of holes) {
        materials[row * CELLS + column] = BOX3D_HEIGHT_FIELD_HOLE;
    }
    const node = new TransformNode("terrain", w.scene);
    node.rotationQuaternion = Quaternion.Identity();
    const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, w.scene);
    body.shape = new PhysicsShape(
        {
            type: PhysicsShapeType.HEIGHTFIELD,
            parameters: {
                heightFieldSizeX: SIZE,
                heightFieldSizeZ: SIZE,
                numHeightFieldSamplesX: SAMPLES,
                numHeightFieldSamplesZ: SAMPLES,
                heightFieldData: heights,
                heightFieldMaterials: materials,
            },
        },
        w.scene,
    );
}

function groundAt(w: IWasmScene, x: number, z: number): number | null {
    const result = new PhysicsRaycastResult();
    w.plugin.raycast(new Vector3(x, 20, z), new Vector3(x, -20, z), result);
    return result.hasHit ? result.hitPointWorld.y : null;
}

describe("Box3D height fields (real wasm)", () => {
    it("reads heights with rows from the +Z edge", async () => {
        world = await CreateWasmScene();
        addTerrain(world, (x, z) => 2 + 0.1 * x + 0.3 * z);
        expect(groundAt(world, 0, 0)).toBeCloseTo(2, 3);
        expect(groundAt(world, -4, 4)).toBeCloseTo(2 - 0.4 + 1.2, 3);
        expect(groundAt(world, 3, -2)).toBeCloseTo(2 + 0.3 - 0.6, 3);
    });

    it("lets rays through a hole and nowhere else, cells in the same row order as the heights", async () => {
        world = await CreateWasmScene();
        // Cell (7, 1) spans x 2..3 and z 3..4.
        addTerrain(world, () => 0, [[7, 1]]);
        expect(groundAt(world, 2.5, 3.5)).toBeNull();
        expect(groundAt(world, 2.5, -3.5)).toBeCloseTo(0, 3);
        expect(groundAt(world, 3.5, 3.5)).toBeCloseTo(0, 3);
        expect(groundAt(world, 2.5, 4.5)).toBeCloseTo(0, 3);
    });

    it("drops a box through a hole while holding one up beside it", async () => {
        world = await CreateWasmScene();
        // A 2 × 2 m hole: cells (2, 2), (3, 2), (2, 3), (3, 3), spanning x -3..-1 and z 1..3.
        addTerrain(world, () => 0, [
            [2, 2],
            [3, 2],
            [2, 3],
            [3, 3],
        ]);
        const over = CreateBoxBody(world.scene, "over", new Vector3(-2, 2, 2), new Vector3(0.5, 0.5, 0.5), PhysicsMotionType.DYNAMIC, 1);
        const beside = CreateBoxBody(world.scene, "beside", new Vector3(2, 2, 2), new Vector3(0.5, 0.5, 0.5), PhysicsMotionType.DYNAMIC, 1);
        world.step(120);
        expect(over.node.position.y).toBeLessThan(-2);
        expect(beside.node.position.y).toBeCloseTo(0.25, 1);
    });

    it("refuses a materials array of the wrong size", async () => {
        world = await CreateWasmScene();
        const w = world;
        expect(
            () =>
                new PhysicsBody(new TransformNode("bad", w.scene), PhysicsMotionType.STATIC, false, w.scene).shape = new PhysicsShape(
                    {
                        type: PhysicsShapeType.HEIGHTFIELD,
                        parameters: {
                            heightFieldSizeX: SIZE,
                            heightFieldSizeZ: SIZE,
                            numHeightFieldSamplesX: SAMPLES,
                            numHeightFieldSamplesZ: SAMPLES,
                            heightFieldData: new Float32Array(SAMPLES * SAMPLES),
                            heightFieldMaterials: new Uint8Array(3),
                        },
                    },
                    w.scene,
                ),
        ).toThrow(/heightFieldMaterials needs 100 cells/);
    });
});
