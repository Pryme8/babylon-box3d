// Per-shape handles against the real wasm through the shim's raw exports: changing one of a body's shapes (its hull,
// its place, its filter, or removing it) resets only that shape's contacts and keeps every shape's index, where
// bx_Body_SetShape rebuilds them all and drops every contact the body has.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LoadBox3D } from "./wasmScene";

const STATIC = 0;
const DYNAMIC = 2;
const HZ = 480;
const DT = 1 / HZ;
const SUB_STEPS = 2;
const G = 9.81;
const STRIDE = 48;
const EVENT_STRIDE = 14;

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

function createWorld(): number {
    const world = b3._bx_CreateWorld(0, -G, 0, 1);
    worlds.push(world);
    return world;
}

function step(world: number, count: number): void {
    for (let i = 0; i < count; i++) {
        b3._bx_World_Step(world, DT, SUB_STEPS);
    }
}

function read(count: number, offset = 0): number[] {
    const at = (b3._bx_Scratch() >> 2) + offset;
    return Array.from(b3.HEAPF32.subarray(at, at + count));
}

function velocity(body: number): Vec3 {
    b3._bx_Body_GetLinearVelocity(body);
    return read(3) as Vec3;
}

function angularVelocity(body: number): Vec3 {
    b3._bx_Body_GetAngularVelocity(body);
    return read(3) as Vec3;
}

/**
 * A 300 kg body of three 0.8 m boxes in a row along x (shapes 0, 1 and 2, at x = -1, 0 and 1), settled on a static
 * floor whose top is at y = 0.
 */
function createTrain(world: number): { body: number; floor: number } {
    const floor = b3._bx_CreateBody(world, STATIC, 0, -0.5, 0, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(floor, b3._bx_ShapeDesc_CreateBox(10, 0.5, 10, 0, 0, 0, 0, 0, 0, 1));
    const container = b3._bx_ShapeDesc_CreateContainer();
    for (const x of [-1, 0, 1]) {
        const box = b3._bx_ShapeDesc_CreateBox(0.4, 0.4, 0.4, 0, 0, 0, 0, 0, 0, 1);
        b3._bx_ShapeDesc_SetDensity(box, 100 / 0.512);
        b3._bx_ShapeDesc_SetMaterial(box, 0.8, 0);
        b3._bx_ShapeDesc_AddChild(container, box, x, 0, 0, 0, 0, 0, 1, 1, 1, 1);
    }
    const body = b3._bx_CreateBody(world, DYNAMIC, 0, 0.4, 0, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, container);
    b3._bx_Body_EnableSleep(body, 0);
    step(world, HZ / 2);
    return { body, floor };
}

/** The normal impulse each of the body's shapes carries in its contacts, by shape index. */
function loadByShape(body: number): Map<number, number> {
    const count = b3._bx_Body_GetContacts(body);
    const base = b3._bx_BodyContactsPtr() >> 2;
    const f = b3.HEAPF32;
    const load = new Map<number, number>();
    for (let i = 0; i < count; i++) {
        const r = base + i * STRIDE;
        let sum = 0;
        for (let p = 0; p < f[r + 11]; p++) {
            sum += f[r + 12 + p * 9 + 4];
        }
        load.set(f[r], (load.get(f[r]) ?? 0) + sum);
    }
    return load;
}

/** The body's largest speed, linear or at a shape's reach (1.4 m) from the center, over `ticks` steps. */
function blip(world: number, body: number, ticks: number): number {
    let worst = 0;
    for (let i = 0; i < ticks; i++) {
        step(world, 1);
        worst = Math.max(worst, Math.hypot(...velocity(body)), 1.4 * Math.hypot(...angularVelocity(body)));
    }
    return worst;
}

function hull(points: Vec3[]): number {
    const ptr = b3._malloc(points.length * 12);
    b3.HEAPF32.set(points.flat(), ptr >> 2);
    return ptr;
}

/** The eight corners of a box of half size `h` centred at c, in the body's frame. */
function corners(c: Vec3, h: Vec3): Vec3[] {
    const out: Vec3[] = [];
    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
                out.push([c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]]);
            }
        }
    }
    return out;
}

describe("per-shape handles", () => {
    it("re-hulls shape 2 while shapes 0 and 1 keep their contacts, with no blip over 1 mm/s", () => {
        const world = createWorld();
        const { body } = createTrain(world);
        const before = loadByShape(body);
        expect(before.get(0)).toBeGreaterThan(0);
        expect(before.get(1)).toBeGreaterThan(0);
        expect(before.get(2)).toBeGreaterThan(0);

        // as a crushed chunk comes back: its top pushed down 2 cm, its bottom still on the floor
        const points = hull(corners([1, -0.01, 0], [0.4, 0.39, 0.4]));
        expect(b3._bx_Body_SetShapeHull(body, 2, points, 8)).toBe(1);
        b3._free(points);
        b3._bx_Body_GetShapeInfo(body, 2);
        expect(read(1, 6)[0]).toBeCloseTo(0.38, 5);

        // shape 2's contacts are new; shapes 0 and 1 carry their load straight through the change, warm started
        expect([...loadByShape(body).keys()].sort()).toEqual([0, 1]);
        step(world, 1);
        const after = loadByShape(body);
        expect(after.get(0)! / before.get(0)!).toBeCloseTo(1, 1);
        expect(after.get(1)! / before.get(1)!).toBeCloseTo(1, 1);
        expect(blip(world, body, HZ / 4)).toBeLessThan(1e-3);
        expect(loadByShape(body).get(2)! / before.get(2)!).toBeCloseTo(1, 1);
    });

    it("drops every contact the body has when the whole shape is rebuilt, which is what the handles avoid", () => {
        const world = createWorld();
        const { body } = createTrain(world);
        // a rebuild through the description: every shape is new
        const container = b3._bx_ShapeDesc_CreateContainer();
        for (const x of [-1, 0, 1]) {
            const box = b3._bx_ShapeDesc_CreateBox(0.4, 0.4, 0.4, 0, 0, 0, 0, 0, 0, 1);
            b3._bx_ShapeDesc_SetDensity(box, 100 / 0.512);
            b3._bx_ShapeDesc_AddChild(container, box, x, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        }
        b3._bx_Body_SetShape(body, container);
        expect(b3._bx_Body_GetContacts(body)).toBe(0);
    });

    it("moves a shape in the body's frame, and reads back where it is", () => {
        const world = createWorld();
        const { body } = createTrain(world);
        b3._bx_Body_GetShapeInfo(body, 2);
        const [kind, vertices] = read(2);
        expect(kind).toBe(2);
        expect(vertices).toBe(8);
        expect(read(3, 2)).toEqual([expect.closeTo(0.6, 5), expect.closeTo(-0.4, 5), expect.closeTo(-0.4, 5)]);

        // lifted 3 cm, as a crushing chunk is translated back out of what it hits
        expect(b3._bx_Body_TranslateShape(body, 2, 0, 0.03, 0)).toBe(1);
        b3._bx_Body_GetShapeInfo(body, 2);
        expect(read(3, 2)).toEqual([expect.closeTo(0.6, 5), expect.closeTo(-0.37, 5), expect.closeTo(-0.4, 5)]);
        // shape 1 is where it was
        b3._bx_Body_GetShapeInfo(body, 1);
        expect(read(3, 2)).toEqual([expect.closeTo(-0.4, 5), expect.closeTo(-0.4, 5), expect.closeTo(-0.4, 5)]);
        // and the lifted shape no longer carries load once the body has settled on the other two
        step(world, HZ / 4);
        expect(loadByShape(body).get(2) ?? 0).toBe(0);
    });

    it("filters one shape out of the floor's reach, and the body settles on the rest", () => {
        const world = createWorld();
        const { body } = createTrain(world);
        // category 2, colliding with nothing
        b3._bx_Body_SetShapeFilter(body, 2, 2, 0, 0);
        step(world, HZ / 4);
        const load = loadByShape(body);
        expect(load.has(2)).toBe(false);
        expect((load.get(0) ?? 0) + (load.get(1) ?? 0)).toBeGreaterThan(0);
    });

    it("removes a shape and keeps the others' indices", () => {
        const world = createWorld();
        const { body } = createTrain(world);
        b3._bx_Body_RemoveShape(body, 1);
        expect(b3._bx_Body_HasShape(body, 1)).toBe(0);
        expect(b3._bx_Body_HasShape(body, 0)).toBe(1);
        expect(b3._bx_Body_HasShape(body, 2)).toBe(1);
        expect(b3._bx_Body_GetShapeCount(body)).toBe(3);
        step(world, 2);
        const load = loadByShape(body);
        expect([...load.keys()].sort()).toEqual([0, 2]);
        // a removed index stays empty: nothing changes it and nothing reads from it
        expect(b3._bx_Body_SetShapeHull(body, 1, 0, 0)).toBe(0);
        expect(b3._bx_Body_TranslateShape(body, 1, 0, 1, 0)).toBe(0);
        b3._bx_Body_GetShapeInfo(body, 1);
        expect(read(1)[0]).toBe(-1);
        // removing it again, or a shape that never was, does nothing
        b3._bx_Body_RemoveShape(body, 1);
        b3._bx_Body_RemoveShape(body, 7);
        expect(b3._bx_Body_HasShape(body, 2)).toBe(1);
    });

    it("names the shape by index in contact events and ray hits", () => {
        const world = createWorld();
        const floor = b3._bx_CreateBody(world, STATIC, 0, -0.5, 0, 0, 0, 0, 1, 1);
        b3._bx_Body_SetShape(floor, b3._bx_ShapeDesc_CreateBox(10, 0.5, 10, 0, 0, 0, 0, 0, 0, 1));
        const container = b3._bx_ShapeDesc_CreateContainer();
        // one box description used for all three children, so only the index tells them apart
        const box = b3._bx_ShapeDesc_CreateBox(0.4, 0.4, 0.4, 0, 0, 0, 0, 0, 0, 1);
        for (const [x, y] of [
            [-1, 0],
            [0, 0.5],
            [1, 1],
        ]) {
            b3._bx_ShapeDesc_AddChild(container, box, x, y, 0, 0, 0, 0, 1, 1, 1, 1);
        }
        const body = b3._bx_CreateBody(world, DYNAMIC, 0, 1.5, 0, 0, 0, 0, 1, 1);
        b3._bx_Body_SetShape(body, container);
        b3._bx_Body_SetMotionLocks(body, 0, 0, 0, 1, 1, 1);
        b3._bx_Body_SetEventFlags(body, 1, 0);
        // shape 0 hangs lowest, so it is the one that lands
        let landed = -1;
        for (let i = 0; i < HZ && landed < 0; i++) {
            step(world, 1);
            const count = b3._bx_World_GetContactEvents(world);
            const base = b3._bx_ContactEventsPtr() >> 2;
            for (let e = 0; e < count; e++) {
                const r = base + e * EVENT_STRIDE;
                if (b3.HEAPF32[r] === 0) {
                    const bodyIsA = b3.HEAPF32[r + 3] === body;
                    landed = b3.HEAPF32[r + (bodyIsA ? 12 : 13)];
                }
            }
        }
        expect(landed).toBe(0);

        // a ray down onto shape 2, at x = 1
        const hits = b3._bx_World_CastRay(world, 1, 10, 0, 0, -20, 0, 0xffffffff, 0xffffffff, 0, 0, 1);
        expect(hits).toBe(1);
        const r = b3._bx_RayHitsPtr() >> 2;
        expect(b3.HEAPF32[r + 7]).toBe(body);
        expect(b3.HEAPF32[r + 10]).toBe(2);
    });
});
