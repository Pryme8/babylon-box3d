// The Box3D patches in wasm/patches, against the real wasm through the shim's raw exports: continuous collision
// switched per body (0002), and the broad phase querying with a shape's own mask bits (0001), which must find every
// pair it found before and only skip what the filters already rule out.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LoadBox3D } from "./wasmScene";

const STATIC = 0;
const DYNAMIC = 2;

interface IFilter {
    category: number;
    mask: number;
    group?: number;
}

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

function createWorld(gravityY: number): number {
    const world = b3._bx_CreateWorld(0, gravityY, 0, 1);
    worlds.push(world);
    return world;
}

function createBox(world: number, type: number, center: [number, number, number], half: [number, number, number], filter?: IFilter): number {
    const body = b3._bx_CreateBody(world, type, center[0], center[1], center[2], 0, 0, 0, 1, 1);
    const desc = b3._bx_ShapeDesc_CreateBox(half[0], half[1], half[2], 0, 0, 0, 0, 0, 0, 1);
    b3._bx_ShapeDesc_SetDensity(desc, 1000);
    if (filter) {
        b3._bx_ShapeDesc_SetFilter(desc, filter.category, filter.mask);
        b3._bx_ShapeDesc_SetGroup(desc, filter.group ?? 0);
    }
    b3._bx_Body_SetShape(body, desc);
    if (type === DYNAMIC) {
        b3._bx_Body_ApplyMassFromShapes(body);
    }
    return body;
}

function position(body: number): [number, number, number] {
    b3._bx_Body_GetTransform(body);
    const at = b3._bx_Scratch() >> 2;
    return [b3.HEAPF32[at], b3.HEAPF32[at + 1], b3.HEAPF32[at + 2]];
}

function run(world: number, steps: number): void {
    for (let i = 0; i < steps; i++) {
        b3._bx_World_Step(world, 1 / 60, 4);
    }
}

describe("continuous collision per body", () => {
    /** Fires a 20 cm box at 120 m/s (2 m a step) at a 10 cm wall 5 m away, and says where it is ten steps later. */
    function fire(options: { body?: boolean; world?: boolean }): number {
        const world = createWorld(0);
        if (options.world === false) {
            b3._bx_World_EnableContinuous(world, 0);
        }
        createBox(world, STATIC, [5, 0, 0], [0.05, 2, 2]);
        const shot = createBox(world, DYNAMIC, [0, 0, 0], [0.1, 0.1, 0.1]);
        if (options.body === false) {
            b3._bx_Body_EnableContinuous(shot, 0);
        }
        b3._bx_Body_SetLinearVelocity(shot, 120, 0, 0);
        run(world, 10);
        return position(shot)[0];
    }

    it("is on by default, so a fast body stops at a thin wall", () => {
        expect(fire({})).toBeLessThan(5);
    });

    it("lets that body through the wall when it is switched off for it alone", () => {
        expect(fire({ body: false })).toBeGreaterThan(5);
    });

    it("still answers to the world's switch", () => {
        expect(fire({ world: false })).toBeGreaterThan(5);
    });

    it("reads back as set", () => {
        const world = createWorld(0);
        const body = createBox(world, DYNAMIC, [0, 0, 0], [0.1, 0.1, 0.1]);
        expect(b3._bx_Body_IsContinuousEnabled(body)).toBe(1);
        b3._bx_Body_EnableContinuous(body, 0);
        expect(b3._bx_Body_IsContinuousEnabled(body)).toBe(0);
        b3._bx_Body_EnableContinuous(body, 1);
        expect(b3._bx_Body_IsContinuousEnabled(body)).toBe(1);
    });
});

describe("the broad phase queries with a shape's own mask", () => {
    const OWN = 0x2;
    const OTHERS = ~OWN >>> 0;

    /**
     * Drops a 1 m box from 3 m onto a 1 m thick platform whose top is at y = 0.5, over a floor whose top is at
     * y = -9.5, and says where the box's center ends up: 1 on the platform, -9 on the floor.
     */
    function drop(platform?: IFilter, box?: IFilter): number {
        const world = createWorld(-9.81);
        createBox(world, STATIC, [0, 0, 0], [2, 0.5, 2], platform);
        createBox(world, STATIC, [0, -10, 0], [10, 0.5, 10]);
        const body = createBox(world, DYNAMIC, [0, 3, 0], [0.5, 0.5, 0.5], box);
        run(world, 180);
        return position(body)[1];
    }

    it("still finds a shape the mask lets through", () => {
        expect(drop(undefined, { category: OWN, mask: OTHERS })).toBeCloseTo(1, 1);
    });

    it("skips a shape the mask leaves out, as the filter always did", () => {
        expect(drop({ category: OWN, mask: OTHERS }, { category: OWN, mask: OTHERS })).toBeCloseTo(-9, 1);
    });

    it("still finds a shape in the same positive group, whatever the masks say", () => {
        const group = { category: OWN, mask: OTHERS, group: 1 };
        expect(drop(group, group)).toBeCloseTo(1, 1);
    });
});
