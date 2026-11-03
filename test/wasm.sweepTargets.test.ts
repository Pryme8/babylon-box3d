// Sweeps against sweep targets alone (wasm/patches/0009, shim: bx_Body_SetSweepTargetsOnly and bx_Body_SetSweepTarget),
// against the real wasm through the shim's raw exports. A body that moves further in a step than its speculative reach
// passes through a thin body that is not static: continuous collision sweeps a body against static shapes alone, and
// a bullet against everything. A body swept against targets alone is swept once the broad phase is refit against the
// kinematic and dynamic bodies marked as targets, and nothing else. It stops at a target it meets, and with no target
// near, or one beside its path, it steps as it would unswept, bit for bit.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LoadBox3D } from "./wasmScene";

const STATIC = 0;
const DYNAMIC = 2;
const HZ = 480;
const DT = 1 / HZ;
const SUB_STEPS = 2;
const EVENT_STRIDE = 14;
/** 10.4 cm a step, against a 2 cm post and plates 2 cm thick */
const SPEED = 50;

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

function box(hx: number, hy: number, hz: number, density: number): number {
    const shape = b3._bx_ShapeDesc_CreateBox(hx, hy, hz, 0, 0, 0, 0, 0, 0, 1);
    b3._bx_ShapeDesc_SetDensity(shape, density);
    return shape;
}

/**
 * Three plates 2 cm thick side by side, each its own shape as a car's chunks are, with continuous collision off as R3's
 * car has it, moving along x at SPEED. The middle plate's front face starts 4 cm short of x = -0.01 five steps out, so
 * the sixth step carries it past a 2 cm post at x = 0 with never a step's start within 2 cm of it.
 */
function plates(world: number): number {
    const container = b3._bx_ShapeDesc_CreateContainer();
    for (const z of [-0.25, 0, 0.25]) {
        b3._bx_ShapeDesc_AddChild(container, box(0.01, 0.1, 0.1, 2000), 0, 0, z, 0, 0, 0, 1, 1, 1, 1);
    }
    const front = -0.01 - (0.04 + (5 * SPEED) / HZ);
    const body = b3._bx_CreateBody(world, DYNAMIC, front - 0.01, 0, 0, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, container);
    b3._bx_Body_ApplyMassFromShapes(body);
    b3._bx_Body_EnableSleep(body, 0);
    b3._bx_Body_EnableContinuous(body, 0);
    b3._bx_Body_SetEventFlags(body, 1, 0);
    b3._bx_Body_SetLinearVelocity(body, SPEED, 0, 0);
    return body;
}

/** A steel post 2 cm square and a metre tall, free, its middle at (x, 0, z). */
function post(world: number, x: number, y: number, z: number): number {
    const body = b3._bx_CreateBody(world, DYNAMIC, x, y, z, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, box(0.01, 0.5, 0.01, 7850));
    b3._bx_Body_ApplyMassFromShapes(body);
    b3._bx_Body_EnableSleep(body, 0);
    b3._bx_Body_SetEventFlags(body, 1, 0);
    return body;
}

function x(body: number): number {
    b3._bx_Body_GetTransform(body);
    return b3.HEAPF64[b3._bx_ScratchF64() >> 3];
}

function vx(body: number): number {
    b3._bx_Body_GetLinearVelocity(body);
    return b3.HEAPF32[b3._bx_Scratch() >> 2];
}

/** The body's position as the module holds it and its rotation, to compare bit for bit. */
function pose(body: number): number[] {
    b3._bx_Body_GetTransform(body);
    const at = b3._bx_ScratchF64() >> 3;
    const q = (b3._bx_Scratch() >> 2) + 3;
    return [...b3.HEAPF64.slice(at, at + 3), ...b3.HEAPF32.slice(q, q + 4)];
}

/** Whether the last step began a touch between the two bodies. */
function began(world: number, a: number, b: number): boolean {
    const count = b3._bx_World_GetContactEvents(world);
    const base = b3._bx_ContactEventsPtr() >> 2;
    for (let e = 0; e < count; e++) {
        const r = base + e * EVENT_STRIDE;
        const pair = [b3.HEAPF32[r + 3], b3.HEAPF32[r + 4]];
        if (b3.HEAPF32[r] === 0 && pair.includes(a) && pair.includes(b)) {
            return true;
        }
    }
    return false;
}

interface Strike {
    swept: boolean;
    target: boolean;
    bullet?: boolean;
    sweptItself?: boolean;
}

/** The plates driven at the post for 24 steps: whether they touched, where they ended and how fast each was going. */
function strike({ swept, target, bullet = false, sweptItself = false }: Strike) {
    const world = createWorld(0);
    const body = plates(world);
    const pole = post(world, 0, 0, 0);
    b3._bx_Body_SetSweepTargetsOnly(body, swept ? 1 : 0);
    b3._bx_Body_SetSweepTarget(pole, target ? 1 : 0);
    b3._bx_Body_SetBullet(pole, bullet ? 1 : 0);
    b3._bx_Body_SetSweepTargetsOnly(pole, sweptItself ? 1 : 0);
    let touched = false;
    for (let i = 0; i < 24; i++) {
        b3._bx_World_Step(world, DT, SUB_STEPS);
        touched ||= began(world, body, pole);
    }
    return { touched, behind: x(body) < x(pole), speed: vx(body), postSpeed: vx(pole) };
}

describe("a sweep against sweep targets", () => {
    it("is off until set, and set on each body alone", () => {
        const world = createWorld(0);
        const body = plates(world);
        const pole = post(world, 0, 0, 0);
        expect(b3._bx_Body_IsSweepTargetsOnly(body)).toBe(0);
        expect(b3._bx_Body_IsSweepTarget(pole)).toBe(0);
        b3._bx_Body_SetSweepTargetsOnly(body, 1);
        b3._bx_Body_SetSweepTarget(pole, 1);
        expect(b3._bx_Body_IsSweepTargetsOnly(body)).toBe(1);
        expect(b3._bx_Body_IsSweepTarget(body)).toBe(0);
        expect(b3._bx_Body_IsSweepTarget(pole)).toBe(1);
        expect(b3._bx_Body_IsSweepTargetsOnly(pole)).toBe(0);
        b3._bx_Body_SetSweepTargetsOnly(body, 0);
        b3._bx_Body_SetSweepTarget(pole, 0);
        expect(b3._bx_Body_IsSweepTargetsOnly(body)).toBe(0);
        expect(b3._bx_Body_IsSweepTarget(pole)).toBe(0);
    });

    it("stops a body at a thin target it would pass through, the same every run", () => {
        // unswept the plates pass the post untouched, neither slowed nor moved
        const through = strike({ swept: false, target: true });
        expect(through).toEqual({ touched: false, behind: false, speed: SPEED, postSpeed: 0 });
        // swept, they stop at it and carry it on: 4.8 kg of plates into 3.1 kg of post, about 30 m/s together
        const stopped = strike({ swept: true, target: true });
        expect(stopped.touched).toBe(true);
        expect(stopped.behind).toBe(true);
        expect(stopped.speed).toBeLessThan(40);
        expect(stopped.postSpeed).toBeGreaterThan(20);
        expect(strike({ swept: true, target: true })).toEqual(stopped);
    });

    it("sees targets alone, and never a bullet or a target swept against targets itself", () => {
        const through = strike({ swept: false, target: true });
        expect(strike({ swept: true, target: false })).toEqual(through);
        expect(strike({ swept: true, target: true, bullet: true })).toEqual(through);
        expect(strike({ swept: true, target: true, sweptItself: true })).toEqual(through);
    });

    it("steps a body as it would unswept, bit for bit, past a target beside its path", () => {
        // A sled sliding on the floor at 30 m/s, its plates in front, past a post 1 cm beside it: near enough that each of
        // its shapes is swept against the post, and none hits it, while its contacts with the floor recycle as they would.
        const slide = (swept: boolean) => {
            const world = createWorld(9.81);
            const ground = b3._bx_CreateBody(world, STATIC, 0, -0.5, 0, 0, 0, 0, 1, 1);
            b3._bx_Body_SetShape(ground, box(200, 0.5, 20, 1));
            const container = b3._bx_ShapeDesc_CreateContainer();
            b3._bx_ShapeDesc_AddChild(container, box(0.2, 0.025, 0.35, 500), 0, 0.025, 0, 0, 0, 0, 1, 1, 1, 1);
            for (const z of [-0.25, 0, 0.25]) {
                b3._bx_ShapeDesc_AddChild(container, box(0.01, 0.1, 0.1, 2000), 0.21, 0.15, z, 0, 0, 0, 1, 1, 1, 1);
            }
            const body = b3._bx_CreateBody(world, DYNAMIC, 0, 0, 0, 0, 0, 0, 1, 1);
            b3._bx_Body_SetShape(body, container);
            b3._bx_Body_ApplyMassFromShapes(body);
            b3._bx_Body_EnableSleep(body, 0);
            b3._bx_Body_EnableContinuous(body, 0);
            b3._bx_Body_SetLinearVelocity(body, 30, 0, 0);
            b3._bx_Body_SetSweepTargetsOnly(body, swept ? 1 : 0);
            const pole = post(world, 3, 0.5, 0.37);
            b3._bx_Body_SetSweepTarget(pole, 1);
            const poses: number[][] = [];
            for (let i = 0; i < HZ / 4; i++) {
                b3._bx_World_Step(world, DT, SUB_STEPS);
                poses.push([...pose(body), ...pose(pole)]);
            }
            return { poses, past: x(body) > 3.5 };
        };
        const unswept = slide(false);
        const swept = slide(true);
        expect(unswept.past).toBe(true);
        for (let i = 0; i < swept.poses.length; i++) {
            expect(swept.poses[i]).toEqual(unswept.poses[i]);
        }
    });
});
