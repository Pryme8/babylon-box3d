// A body's fat AABB margin (wasm/patches/0008, shim: bx_Body_SetAabbMargin), against the real wasm through the shim's
// raw exports. Box3D gives each shape a margin of an eighth of its extent, at most 5 cm, so a fast body of many small
// shapes leaves every shape's bounds every step and moves every proxy; a wider margin finds pairs sooner and moves the
// proxies seldom. A body that touches nothing steps the same either way, bit for bit; one that lands can touch a step
// sooner, a pair found sooner, and comes to rest within a centimetre of where it would have.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LoadBox3D } from "./wasmScene";

const STATIC = 0;
const DYNAMIC = 2;
const HZ = 480;
const DT = 1 / HZ;
const SUB_STEPS = 2;
const EVENT_STRIDE = 14;
/** where bx_World_GetStats writes the world's pairs: shape pairs whose fat AABBs overlap, touching or not */
const STATS_PAIRS = 2;

type Vec3 = [number, number, number];

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

function createWorld(gravity: number): number {
    const world = b3._bx_CreateWorld(0, -gravity, 0, 1);
    worlds.push(world);
    return world;
}

/** A static floor whose top is at y = 0. */
function floor(world: number): number {
    const body = b3._bx_CreateBody(world, STATIC, 0, -0.5, 0, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, b3._bx_ShapeDesc_CreateBox(200, 0.5, 20, 0, 0, 0, 0, 0, 0, 1));
    return body;
}

/**
 * A body of a 3 by 3 grid of 0.2 m boxes, each its own shape as a car's chunks are, its lowest face `clearance` above
 * the floor, turned by `roll` about its length so its boxes reach the floor one after another when it falls.
 */
function chunks(world: number, clearance: number, roll = 0): number {
    const container = b3._bx_ShapeDesc_CreateContainer();
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            const box = b3._bx_ShapeDesc_CreateBox(0.1, 0.1, 0.1, 0, 0, 0, 0, 0, 0, 1);
            b3._bx_ShapeDesc_SetDensity(box, 500);
            b3._bx_ShapeDesc_AddChild(container, box, (i - 1) * 0.25, 0, (j - 1) * 0.25, 0, 0, 0, 1, 1, 1, 1);
        }
    }
    const s = Math.sin(roll / 2);
    const body = b3._bx_CreateBody(world, DYNAMIC, 0, clearance + 0.1 + 0.3 * Math.abs(Math.sin(roll)), 0, s, 0, 0, Math.cos(roll / 2), 1);
    b3._bx_Body_SetShape(body, container);
    b3._bx_Body_ApplyMassFromShapes(body);
    b3._bx_Body_EnableSleep(body, 0);
    b3._bx_Body_SetEventFlags(body, 1, 0);
    return body;
}

function pairs(world: number): number {
    b3._bx_World_GetStats(world);
    return b3.HEAPF32[(b3._bx_Scratch() >> 2) + STATS_PAIRS];
}

/** Begin-touch events the last step made. */
function touches(world: number): number {
    const count = b3._bx_World_GetContactEvents(world);
    const base = b3._bx_ContactEventsPtr() >> 2;
    let begun = 0;
    for (let e = 0; e < count; e++) {
        begun += b3.HEAPF32[base + e * EVENT_STRIDE] === 0 ? 1 : 0;
    }
    return begun;
}

/** The body's position and rotation, as the bits the module holds (doubles on the f64 build, floats otherwise). */
function pose(body: number): number[] {
    b3._bx_Body_GetTransform(body);
    const at = b3._bx_Scratch() >> 2;
    return Array.from(new Uint32Array(b3.HEAPF32.slice(at, at + 7).buffer));
}

describe("a body's AABB margin", () => {
    it("is zero, each shape's own, until set, and is never negative", () => {
        const world = createWorld(9.81);
        const body = chunks(world, 0.3);
        expect(b3._bx_Body_GetAabbMargin(body)).toBe(0);
        b3._bx_Body_SetAabbMargin(body, 0.5);
        expect(b3._bx_Body_GetAabbMargin(body)).toBe(0.5);
        b3._bx_Body_SetAabbMargin(body, -1);
        expect(b3._bx_Body_GetAabbMargin(body)).toBe(0);
    });

    it("finds a fast body's pairs with the floor sooner, and touches nothing sooner, on the same bits every step", () => {
        // at 25 m/s a step moves the body 5.2 cm, past every box's own margin of 1.7 cm
        const own = createWorld(0);
        const wide = createWorld(0);
        floor(own);
        floor(wide);
        const a = chunks(own, 0.3);
        const b = chunks(wide, 0.3);
        b3._bx_Body_SetAabbMargin(b, 0.5);
        for (const body of [a, b]) {
            b3._bx_Body_SetLinearVelocity(body, 25, 0, 0);
        }
        let ownPairs = 0;
        let widePairs = 0;
        for (let i = 0; i < 240; i++) {
            b3._bx_World_Step(own, DT, SUB_STEPS);
            b3._bx_World_Step(wide, DT, SUB_STEPS);
            ownPairs = Math.max(ownPairs, pairs(own));
            widePairs = Math.max(widePairs, pairs(wide));
            expect(touches(own)).toBe(0);
            expect(touches(wide)).toBe(0);
            expect(pose(b)).toEqual(pose(a));
        }
        // 30 cm up, out of reach of the floor at its own margins; within it at half a metre, every box paired
        expect(ownPairs).toBe(0);
        expect(widePairs).toBe(9);
    });

    it("keeps the body's margin for a shape whose hull is changed", () => {
        const world = createWorld(0);
        floor(world);
        const body = chunks(world, 0.3);
        b3._bx_Body_SetAabbMargin(body, 0.5);
        const points: Vec3[] = [];
        for (const x of [-0.08, 0.08]) {
            for (const y of [-0.08, 0.08]) {
                for (const z of [-0.08, 0.08]) {
                    points.push([x - 0.25, y, z - 0.25]);
                }
            }
        }
        const ptr = b3._malloc(points.length * 12);
        b3.HEAPF32.set(points.flat(), ptr >> 2);
        expect(b3._bx_Body_SetShapeHull(body, 0, ptr, points.length)).toBe(1);
        b3._free(ptr);
        b3._bx_Body_SetLinearVelocity(body, 25, 0, 0);
        let most = 0;
        for (let i = 0; i < 60; i++) {
            b3._bx_World_Step(world, DT, SUB_STEPS);
            most = Math.max(most, pairs(world));
        }
        expect(most).toBe(9);
    });

    it("lands a body of many shapes where its shapes' own margins land it, touching first no later, the same every run", () => {
        // A pair found a step sooner can begin touching a step sooner: a box within its speculative reach of the floor
        // touches as soon as its pair is there, and at its own 1.7 cm margin the pair is found only the step after its
        // bounds reach the floor's. So with a wide margin the first box touches no later, the body comes to rest within a
        // centimetre of the same place, and a run gives the same bits every time.
        const landing = (margin: number) => {
            const world = createWorld(9.81);
            floor(world);
            const body = chunks(world, 0.4, 0.3);
            b3._bx_Body_SetAabbMargin(body, margin);
            const began = new Map<number, number>();
            const poses: number[][] = [];
            for (let i = 0; i < HZ; i++) {
                b3._bx_World_Step(world, DT, SUB_STEPS);
                const count = b3._bx_World_GetContactEvents(world);
                const base = b3._bx_ContactEventsPtr() >> 2;
                for (let e = 0; e < count; e++) {
                    const r = base + e * EVENT_STRIDE;
                    if (b3.HEAPF32[r] === 0) {
                        const shape = b3.HEAPF32[r + (b3.HEAPF32[r + 3] === body ? 12 : 13)];
                        if (!began.has(shape)) {
                            began.set(shape, i);
                        }
                    }
                }
                poses.push(pose(body));
            }
            b3._bx_Body_GetTransform(body);
            const at = b3._bx_Scratch() >> 2;
            return { began, poses, rest: Array.from(b3.HEAPF32.subarray(at, at + 7)) };
        };
        const own = landing(0);
        const wide = landing(0.5);
        // it fell and tipped, its boxes meeting the floor one after another
        expect(own.began.size).toBeGreaterThan(2);
        expect([...wide.began.keys()].sort()).toEqual([...own.began.keys()].sort());
        // the first to touch touches no later; after that the two land apart, each its own way, and settle alike
        expect(Math.min(...wide.began.values())).toBeLessThanOrEqual(Math.min(...own.began.values()));
        // within a centimetre and about half a degree of each other
        for (let k = 0; k < 3; k++) {
            expect(Math.abs(wide.rest[k] - own.rest[k])).toBeLessThan(0.01);
        }
        for (let k = 3; k < 7; k++) {
            expect(Math.abs(Math.abs(wide.rest[k]) - Math.abs(own.rest[k]))).toBeLessThan(0.005);
        }
        expect(landing(0.5).poses).toEqual(wide.poses);
    });
});
