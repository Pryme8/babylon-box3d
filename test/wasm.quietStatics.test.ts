// Static shapes made without contact creation (bx_ShapeDesc_SetInvokeContactCreation, 0): they never enter the broad
// phase's move buffer, so the first step reserves no pair slots for them, and one made where a resting body's fat
// bounds already reach it is paired only when that body moves, as a static made at the start would have been.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Box3D from "../lib/node/box3d.mjs";
import { LoadBox3D } from "./wasmScene";

const STATIC = 0;
const DYNAMIC = 2;

let b3: any;
const worlds: number[] = [];

beforeAll(async () => {
    b3 = await LoadBox3D();
});

afterEach(() => {
    for (const world of worlds.splice(0)) {
        b3._bx_DestroyWorld(world);
    }
});

function createWorld(module: any = b3): number {
    const world = module._bx_CreateWorld(0, 0, 0, 1);
    if (module === b3) {
        worlds.push(world);
    }
    return world;
}

function contactCount(module: any, world: number): number {
    module._bx_World_GetStats(world);
    return module.HEAPF32[(module._bx_Scratch() >> 2) + 2];
}

/** A unit box resting on nothing, without gravity, so its proxy leaves the move buffer after one step and stays out. */
function restingBox(world: number): number {
    const body = b3._bx_CreateBody(world, DYNAMIC, 0, 0, 0, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, b3._bx_ShapeDesc_CreateBox(0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 1));
    b3._bx_Body_ApplyMassFromShapes(body);
    b3._bx_World_Step(world, 1 / 60, 4);
    return body;
}

/** A static box overlapping the resting one, made from `desc` after the first step. */
function staticAt(world: number, desc: number): number {
    const body = b3._bx_CreateBody(world, STATIC, 0.9, 0, 0, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, desc);
    return body;
}

describe("a static made without contact creation", () => {
    it("is on by default and reads back as set", () => {
        const desc = b3._bx_ShapeDesc_CreateBox(0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 1);
        expect(b3._bx_ShapeDesc_GetInvokeContactCreation(desc)).toBe(1);
        b3._bx_ShapeDesc_SetInvokeContactCreation(desc, 0);
        expect(b3._bx_ShapeDesc_GetInvokeContactCreation(desc)).toBe(0);
        b3._bx_ShapeDesc_Destroy(desc);
    });

    it("pairs on the next step with the default, from its own side", () => {
        const world = createWorld();
        restingBox(world);
        staticAt(world, b3._bx_ShapeDesc_CreateBox(0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 1));
        b3._bx_World_Step(world, 1 / 60, 4);
        expect(contactCount(b3, world)).toBe(1);
    });

    it("waits until the body that reaches it moves", () => {
        const world = createWorld();
        const box = restingBox(world);
        const desc = b3._bx_ShapeDesc_CreateBox(0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 1);
        b3._bx_ShapeDesc_SetInvokeContactCreation(desc, 0);
        staticAt(world, desc);
        for (let i = 0; i < 5; i++) {
            b3._bx_World_Step(world, 1 / 60, 4);
            expect(contactCount(b3, world)).toBe(0);
        }
        // past the fat margin, so the box's proxy moves
        b3._bx_Body_SetTransform(box, 0.2, 0, 0, 0, 0, 0, 1);
        b3._bx_World_Step(world, 1 / 60, 4);
        expect(contactCount(b3, world)).toBe(1);
    });

    it("takes the setting from a container for every child", () => {
        const world = createWorld();
        restingBox(world);
        const container = b3._bx_ShapeDesc_CreateContainer();
        b3._bx_ShapeDesc_AddChild(container, b3._bx_ShapeDesc_CreateBox(0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 1), 0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        b3._bx_ShapeDesc_AddChild(container, b3._bx_ShapeDesc_CreateCapsule(0, -0.5, 0, 0, 0.5, 0, 0.2), 0, 0, 0.3, 0, 0, 0, 1, 1, 1, 1);
        b3._bx_ShapeDesc_SetInvokeContactCreation(container, 0);
        staticAt(world, container);
        b3._bx_World_Step(world, 1 / 60, 4);
        expect(contactCount(b3, world)).toBe(0);
    });
});

describe("what a static without contact creation saves", () => {
    /** The top of the module's heap: where a block too big for any free gap lands. */
    function heapTop(module: any): number {
        const p = module._malloc(128 * 1048576);
        module._free(p);
        return p;
    }

    /**
     * Makes `count` capsules eight to a static body, as tree cells are, in a fresh module, and steps once with a box
     * among them. Returns the bytes each static took before the step and in it, and the step stack's peak.
     */
    async function measure(count: number, invoke: number) {
        const m = await Box3D();
        const world = createWorld(m);
        const body = m._bx_CreateBody(world, DYNAMIC, 0, 1, 0, 0, 0, 0, 1, 1);
        m._bx_Body_SetShape(body, m._bx_ShapeDesc_CreateBox(2, 0.7, 1, 0, 0, 0, 0, 0, 0, 1));
        m._bx_Body_ApplyMassFromShapes(body);
        const t0 = heapTop(m);
        for (let i = 0; i < count; i += 8) {
            const cell = m._bx_ShapeDesc_CreateContainer();
            for (let j = i; j < i + 8; j++) {
                const x = (j % 1000) * 3;
                const z = 10 + Math.floor(j / 1000) * 3;
                const capsule = m._bx_ShapeDesc_CreateCapsule(x, 0, z, x, 3, z, 0.15);
                m._bx_ShapeDesc_AddChild(cell, capsule, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
            }
            m._bx_ShapeDesc_SetInvokeContactCreation(cell, invoke);
            const cellBody = m._bx_CreateBody(world, STATIC, 0, 0, 0, 0, 0, 0, 1, 1);
            m._bx_Body_SetShape(cellBody, cell);
        }
        const t1 = heapTop(m);
        m._bx_World_Step(world, 1 / 480, 2);
        const t2 = heapTop(m);
        const stack = m._bx_World_GetStackUsed(world);
        m._bx_DestroyWorld(world);
        return { madeEach: (t1 - t0) / count, firstStepEach: (t2 - t1) / count, stackEach: stack / count };
    }

    it("keeps the statics out of the first step's move buffer, and its stack", async () => {
        const count = 20000;
        const on = await measure(count, 1);
        const off = await measure(count, 0);
        console.log(
            `a static capsule, eight to a body, with contact creation: made ${on.madeEach.toFixed(1)} B, first step ` +
                `${on.firstStepEach.toFixed(1)} B (stack ${on.stackEach.toFixed(1)} B); without: made ${off.madeEach.toFixed(1)} B, ` +
                `first step ${off.firstStepEach.toFixed(1)} B (stack ${off.stackEach.toFixed(2)} B)`
        );
        // with contact creation, every static reserves its move result and sixteen pair slots, and the stack keeps
        // half as much again
        expect(on.stackEach).toBeGreaterThan(300);
        expect(on.firstStepEach).toBeGreaterThan(400);
        // without, the stack holds the box's query alone, whatever the statics' count
        expect(off.stackEach).toBeLessThan(1);
        expect(off.firstStepEach).toBeLessThan(1);
        // and nothing is pushed on the move array as each is made
        expect(off.madeEach).toBeLessThan(on.madeEach);
    });
});
