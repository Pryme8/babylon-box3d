// Shape queries against the real wasm through the shim's raw exports: a convex point cloud cast through the world
// (bx_World_CastShape), the shapes one overlaps (bx_World_OverlapShape), and a shape's geometry read back
// (bx_Body_GetShapeGeometry). A wheel's ring of points cast down onto the ground is what a tire model asks.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LoadBox3D } from "./wasmScene";

const STATIC = 0;
const DYNAMIC = 2;
const ALL = 0xffffffff;

type Vec3 = [number, number, number];

let b3: any;
const worlds: number[] = [];
const allocations: number[] = [];

beforeAll(async () => {
    b3 = await LoadBox3D();
});

afterEach(() => {
    for (const world of worlds.splice(0)) {
        b3._bx_DestroyWorld(world);
    }
    for (const ptr of allocations.splice(0)) {
        b3._free(ptr);
    }
});

function createWorld(): number {
    const world = b3._bx_CreateWorld(0, -9.81, 0, 1);
    worlds.push(world);
    return world;
}

/** A static height field `cells` metres square, a sample a metre, centred on (cx, 0, cz), heights from height(x, z). */
function createGround(world: number, cells: number, height: (x: number, z: number) => number, cx = 0, cz = 0): number {
    const samples = cells + 1;
    const heights = b3._malloc(samples * samples * 4);
    for (let z = 0; z < samples; z++) {
        for (let x = 0; x < samples; x++) {
            b3.HEAPF32[(heights >> 2) + z * samples + x] = height(cx + x - cells / 2, cz + z - cells / 2);
        }
    }
    const desc = b3._bx_ShapeDesc_CreateHeightField(heights, 0, samples, samples, 1, 1, 1, 0, -cells / 2, 0, -cells / 2);
    b3._free(heights);
    const body = b3._bx_CreateBody(world, STATIC, cx, 0, cz, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, desc);
    return body;
}

function createBox(world: number, type: number, center: Vec3, half: Vec3): number {
    const body = b3._bx_CreateBody(world, type, center[0], center[1], center[2], 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, b3._bx_ShapeDesc_CreateBox(half[0], half[1], half[2], 0, 0, 0, 0, 0, 0, 1));
    return body;
}

/** A wheel's ring: `count` points round a circle of `radius` in the xy plane, doubled at z = ±width/2. */
function ring(radius: number, width: number, count: number): Vec3[] {
    const points: Vec3[] = [];
    for (let i = 0; i < count; i++) {
        const a = (2 * Math.PI * i) / count;
        for (const z of [-width / 2, width / 2]) {
            points.push([radius * Math.sin(a), -radius * Math.cos(a), z]);
        }
    }
    return points;
}

function upload(points: Vec3[]): number {
    const ptr = b3._malloc(points.length * 12);
    allocations.push(ptr);
    b3.HEAPF32.set(points.flat(), ptr >> 2);
    return ptr;
}

interface IHit {
    point: Vec3;
    normal: Vec3;
    fraction: number;
    body: number;
    shape: number;
}

function cast(world: number, origin: Vec3, points: Vec3[], radius: number, translation: Vec3, ignoreBody = 0): IHit | null {
    const count = b3._bx_World_CastShape(
        world,
        origin[0],
        origin[1],
        origin[2],
        upload(points),
        points.length,
        radius,
        translation[0],
        translation[1],
        translation[2],
        ALL,
        ALL,
        ignoreBody,
        1,
    );
    if (count === 0) {
        return null;
    }
    const r = b3._bx_RayHitsPtr() >> 2;
    const f = b3.HEAPF32;
    return {
        point: [f[r], f[r + 1], f[r + 2]],
        normal: [f[r + 3], f[r + 4], f[r + 5]],
        fraction: f[r + 6],
        body: f[r + 7],
        shape: f[r + 10],
    };
}

describe("shape cast", () => {
    const R = 0.3;
    const WHEEL = ring(R, 0.2, 16);
    const DROP: Vec3 = [0, -2, 0];

    it("drops a wheel's ring onto flat ground where its lowest point meets it, within 1 mm", () => {
        const world = createWorld();
        const ground = createGround(world, 16, () => 0);
        const hit = cast(world, [0.25, 1, 0.5], WHEEL, 0, DROP)!;
        expect(hit.body).toBe(ground);
        expect(hit.shape).toBe(0);
        // the ring's lowest point is a vertex at -R, so its centre stops at y = R
        const travelled = hit.fraction * 2;
        expect(Math.abs(1 - travelled - R)).toBeLessThan(1e-3);
        expect(hit.normal[1]).toBeCloseTo(1, 4);
        expect(Math.abs(hit.point[1])).toBeLessThan(1e-3);
    });

    it("lands on a slope where the analytic answer says, rounded by a radius or not", () => {
        const world = createWorld();
        const slope = 0.2;
        createGround(world, 16, (x) => slope * x);
        for (const radius of [0, 0.05]) {
            const c: Vec3 = [0.4, 2, -0.3];
            const hit = cast(world, c, WHEEL, radius, [0, -4, 0])!;
            // a point p of the ring touches the plane y = slope·x, offset by the radius along its normal, when the
            // centre's height is slope·(c.x + p.x) − p.y + radius·√(1 + slope²)
            const lift = radius * Math.sqrt(1 + slope * slope);
            const hitY = Math.max(...WHEEL.map((p) => slope * (c[0] + p[0]) - p[1] + lift));
            expect(Math.abs(c[1] - hit.fraction * 4 - hitY)).toBeLessThan(1e-3);
            expect(hit.normal[0]).toBeCloseTo(-slope / Math.sqrt(1 + slope * slope), 3);
        }
    });

    it("stops on a box's top face within 1 mm, and passes by what it ignores", () => {
        const world = createWorld();
        const floor = createBox(world, STATIC, [0, -0.5, 0], [10, 0.5, 10]);
        const block = createBox(world, STATIC, [0, 0.25, 0], [1, 0.25, 1]);
        const onBlock = cast(world, [0, 2, 0], WHEEL, 0, [0, -3, 0])!;
        expect(onBlock.body).toBe(block);
        expect(Math.abs(2 - onBlock.fraction * 3 - (0.5 + R))).toBeLessThan(1e-3);
        const pastBlock = cast(world, [0, 2, 0], WHEEL, 0, [0, -3, 0], block)!;
        expect(pastBlock.body).toBe(floor);
        expect(Math.abs(2 - pastBlock.fraction * 3 - R)).toBeLessThan(1e-3);
        expect(cast(world, [0, 2, 0], WHEEL, 0, [0, 0.5, 0])).toBeNull();
    });

    it("meets a rounded shape at the sum of the radii: a rounded ring onto a log", () => {
        const world = createWorld();
        // a log of radius 0.2 lying along z, its axis at y = 0.2
        const log = b3._bx_CreateBody(world, STATIC, 0, 0.2, 0, 0, 0, 0, 1, 1);
        b3._bx_Body_SetShape(log, b3._bx_ShapeDesc_CreateCapsule(0, 0, -2, 0, 0, 2, 0.2));
        const hit = cast(world, [0, 2, 0], WHEEL, 0.05, [0, -3, 0])!;
        expect(hit.body).toBe(log);
        // the ring's bottom vertex, at -R, stops 0.2 + 0.05 above the axis
        expect(Math.abs(2 - hit.fraction * 3 - (0.2 + 0.25 + R))).toBeLessThan(1e-3);
    });

    it("casts from an origin a kilometre out as it does at home", () => {
        const world = createWorld();
        createGround(world, 16, () => 0, 1000, 0);
        const hit = cast(world, [1000.25, 1, 0.5], WHEEL, 0, DROP)!;
        expect(Math.abs(1 - hit.fraction * 2 - R)).toBeLessThan(1e-3);
        expect(hit.point[0]).toBeGreaterThan(999);
    });

    it("refuses a point cloud larger than Box3D casts", () => {
        const world = createWorld();
        createGround(world, 16, () => 0);
        expect(cast(world, [0, 1, 0], ring(R, 0.2, 200), 0, DROP)).toBeNull();
    });
});

describe("shape overlap", () => {
    it("lists every shape a point cloud overlaps, with its body and index", () => {
        const world = createWorld();
        const floor = createBox(world, STATIC, [0, -0.5, 0], [10, 0.5, 10]);
        const box = createBox(world, DYNAMIC, [3, 0.5, 0], [0.5, 0.5, 0.5]);
        // a 1 m cube at the floor's surface next to the box, and one reaching into it
        const cube = (c: Vec3) => ring(0.5, 1, 4).map((p): Vec3 => [c[0] + p[0], c[1] + p[1], c[2] + p[2]]);
        const run = (points: Vec3[], ignore = 0) => {
            const count = b3._bx_World_OverlapShape(world, 0, 0, 0, upload(points), points.length, 0, ALL, ALL, ignore);
            const base = b3._bx_OverlapsPtr() >> 2;
            return Array.from({ length: count }, (_, i) => [b3.HEAPF32[base + i * 3], b3.HEAPF32[base + i * 3 + 1]]);
        };
        expect(run(cube([0, 0.3, 0]))).toEqual([[floor, 0]]);
        const both = run(cube([2.5, 0.3, 0]));
        expect(both).toHaveLength(2);
        expect(both).toContainEqual([floor, 0]);
        expect(both).toContainEqual([box, 0]);
        expect(run(cube([2.5, 0.3, 0]), floor)).toEqual([[box, 0]]);
        expect(run(cube([0, 5, 0]))).toEqual([]);
    });
});

describe("shape geometry readback", () => {
    function geometry(body: number, index: number): number[] {
        const count = b3._bx_Body_GetShapeGeometry(body, index);
        const base = b3._bx_GeometryPtr() >> 2;
        return Array.from(b3.HEAPF32.subarray(base, base + count));
    }

    it("reads a hull's points, a capsule's ends and a sphere's centre, in the body's frame", () => {
        const world = createWorld();
        const container = b3._bx_ShapeDesc_CreateContainer();
        b3._bx_ShapeDesc_AddChild(container, b3._bx_ShapeDesc_CreateBox(0.5, 0.25, 0.1, 0, 0, 0, 0, 0, 0, 1), 1, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        b3._bx_ShapeDesc_AddChild(container, b3._bx_ShapeDesc_CreateCapsule(0, 0, 0, 0, 1, 0, 0.2), 0, 0, 2, 0, 0, 0, 1, 1, 1, 1);
        b3._bx_ShapeDesc_AddChild(container, b3._bx_ShapeDesc_CreateSphere(0, 0.5, 0, 0.3), -1, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        const body = b3._bx_CreateBody(world, DYNAMIC, 5, 5, 5, 0, 0, 0, 1, 1);
        b3._bx_Body_SetShape(body, container);

        const hull = geometry(body, 0);
        expect(hull).toHaveLength(24);
        const xs = hull.filter((_, i) => i % 3 === 0);
        expect(Math.min(...xs)).toBeCloseTo(0.5, 5);
        expect(Math.max(...xs)).toBeCloseTo(1.5, 5);
        expect(geometry(body, 1)).toEqual([0, 0, 2, 0, 1, 2, expect.closeTo(0.2, 6)].map((v) => (typeof v === "number" ? expect.closeTo(v, 6) : v)));
        expect(geometry(body, 2)).toEqual([expect.closeTo(-1, 6), expect.closeTo(0.5, 6), 0, expect.closeTo(0.3, 6)]);
        expect(geometry(body, 3)).toEqual([]);

        // a re-hulled shape reads back as its new points
        const points: Vec3[] = [
            [1, 0, 0],
            [2, 0, 0],
            [1, 1, 0],
            [1, 0, 1],
        ];
        expect(b3._bx_Body_SetShapeHull(body, 0, upload(points), 4)).toBe(1);
        const back = geometry(body, 0);
        expect(back).toHaveLength(12);
        for (const p of points) {
            expect(
                [0, 1, 2, 3].some((i) => Math.hypot(back[i * 3] - p[0], back[i * 3 + 1] - p[1], back[i * 3 + 2] - p[2]) < 1e-6),
            ).toBe(true);
        }
    });
});
