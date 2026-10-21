// Clip planes (wasm/patches/0006) against the real wasm through the shim's raw exports. A body with a clip plane has
// every contact point on the plane's positive side dropped, point by point, against convex shapes, meshes and height
// fields alike, and its continuous collision ignores hits there too: what a portal needs for the part of a body that
// has gone through it.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Box3DThreads from "../lib/node-threads/box3d.mjs";
import { LoadBox3D } from "./wasmScene";

const STATIC = 0;
const DYNAMIC = 2;

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

function createWorld(workers = 1): number {
    const world = b3._bx_CreateWorld(0, -10, 0, workers);
    worlds.push(world);
    return world;
}

function createBox(world: number, type: number, center: Vec3, half: Vec3, category = 1): number {
    const body = b3._bx_CreateBody(world, type, center[0], center[1], center[2], 0, 0, 0, 1, 1);
    const desc = b3._bx_ShapeDesc_CreateBox(half[0], half[1], half[2], 0, 0, 0, 0, 0, 0, 1);
    b3._bx_ShapeDesc_SetDensity(desc, 1000);
    b3._bx_ShapeDesc_SetFilter(desc, category, 0xffffffff);
    b3._bx_Body_SetShape(body, desc);
    if (type === DYNAMIC) {
        b3._bx_Body_ApplyMassFromShapes(body);
    }
    return body;
}

/** A static triangle mesh floor at y = 0, 20 metres square. */
function createMeshFloor(world: number): number {
    const n = 11;
    const positions: number[] = [];
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            positions.push(2 * i - 10, 0, 2 * j - 10);
        }
    }
    const indices: number[] = [];
    for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < n - 1; j++) {
            const a = i * n + j;
            indices.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
        }
    }
    const vp = b3._malloc(positions.length * 4);
    b3.HEAPF32.set(positions, vp >> 2);
    const ip = b3._malloc(indices.length * 4);
    b3.HEAP32.set(indices, ip >> 2);
    const desc = b3._bx_ShapeDesc_CreateMesh(vp, n * n, ip, indices.length / 3, 1, 1, 1, 0, 0);
    b3._free(vp);
    b3._free(ip);
    const body = b3._bx_CreateBody(world, STATIC, 0, 0, 0, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, desc);
    return body;
}

function transform(body: number): { p: Vec3; q: [number, number, number, number] } {
    b3._bx_Body_GetTransform(body);
    const at = b3._bx_Scratch() >> 2;
    const f = b3.HEAPF32;
    return { p: [f[at], f[at + 1], f[at + 2]], q: [f[at + 3], f[at + 4], f[at + 5], f[at + 6]] };
}

function run(world: number, steps: number): void {
    for (let i = 0; i < steps; i++) {
        b3._bx_World_Step(world, 1 / 60, 4);
    }
}

/** Clips everything below y = 0.25, the ground's surface and all under it. */
function clipBelowGround(body: number, mask = 0xffffffff): void {
    b3._bx_Body_SetClipPlane(body, 1, 0, -1, 0, 0.25, mask);
}

/**
 * Sixteen boxes tilted every which way dropped from 7 m onto a box floor and a mesh floor, both clipped: about 11 m/s
 * at the floor, landing on faces, edges and corners. A speculative point sits in front of the plane while the box is
 * still above the floor (midway between the surfaces on the box floor, on the box on the mesh, made up to the
 * distance the box covers in a step away), so tested where it is it would stop the box dead on the surface.
 * @returns the most speed any box lost in a step, and where they all ended
 */
function FastDrop(workers = 1): { worstLoss: number; positions: number[] } {
    const world = createWorld(workers);
    createBox(world, STATIC, [0, -0.5, 0], [10, 0.5, 10]);
    createMeshFloor(world);
    const bodies: number[] = [];
    for (let i = 0; i < 16; i++) {
        const body = b3._bx_CreateBody(world, DYNAMIC, (i % 4) * 2 - 3, 7, Math.floor(i / 4) * 2 - 3, 0, 0, 0, 1, 1);
        const angle = i * 0.37;
        const axis = [Math.sin(i * 1.3), Math.cos(i * 0.7), Math.sin(i * 2.1)];
        const length = Math.hypot(...axis);
        const s = Math.sin(angle / 2) / length;
        b3._bx_Body_SetTransform(body, (i % 4) * 2 - 3, 7, Math.floor(i / 4) * 2 - 3, axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2));
        const desc = b3._bx_ShapeDesc_CreateBox(0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 1);
        b3._bx_ShapeDesc_SetDensity(desc, 20);
        b3._bx_Body_SetShape(body, desc);
        b3._bx_Body_ApplyMassFromShapes(body);
        b3._bx_Body_SetClipPlane(body, 1, 0, -1, 0, 0, 0xffffffff);
        bodies.push(body);
    }
    const speed = (body: number): number => {
        b3._bx_Body_GetLinearVelocity(body);
        return -b3.HEAPF32[(b3._bx_Scratch() >> 2) + 1];
    };
    let worstLoss = 0;
    for (let i = 0; i < 90; i++) {
        const before = bodies.map(speed);
        run(world, 1);
        bodies.forEach((body, k) => (worstLoss = Math.max(worstLoss, before[k] - speed(body))));
    }
    return { worstLoss, positions: bodies.flatMap((body) => transform(body).p) };
}

describe("clip planes", () => {
    it("drop every contact behind the plane, so a box resting on a box falls through it", () => {
        const world = createWorld();
        createBox(world, STATIC, [0, -0.5, 0], [10, 0.5, 10]);
        const kept = createBox(world, DYNAMIC, [-3, 0.5, 0], [0.5, 0.5, 0.5]);
        const clipped = createBox(world, DYNAMIC, [3, 0.5, 0], [0.5, 0.5, 0.5]);
        run(world, 30);
        clipBelowGround(clipped);
        run(world, 60);
        expect(transform(kept).p[1]).toBeCloseTo(0.5, 1);
        expect(transform(clipped).p[1]).toBeLessThan(-2);
    });

    it("clip mesh contacts too, which Box3D's own pre-solve callback never sees", () => {
        const world = createWorld();
        createMeshFloor(world);
        const kept = createBox(world, DYNAMIC, [-3, 0.5, 0], [0.5, 0.5, 0.5]);
        const clipped = createBox(world, DYNAMIC, [3, 0.5, 0], [0.5, 0.5, 0.5]);
        run(world, 30);
        clipBelowGround(clipped);
        run(world, 60);
        expect(transform(kept).p[1]).toBeCloseTo(0.5, 1);
        expect(transform(clipped).p[1]).toBeLessThan(-2);
    });

    it("let a body falling fast through a clipped surface keep its speed, speculative contacts included", () => {
        // free fall throughout: no step slows any of them
        expect(FastDrop().worstLoss).toBeLessThan(0.01);
    });

    it("clip the same on worker threads, bit for bit", async () => {
        const single = FastDrop();
        for (const world of worlds.splice(0)) {
            b3._bx_DestroyWorld(world);
        }
        const plain = b3;
        b3 = await Box3DThreads();
        try {
            const threaded = FastDrop(4);
            expect(b3._bx_World_GetWorkerCount(worlds[0])).toBe(4);
            expect(threaded.positions).toEqual(single.positions);
        } finally {
            for (const world of worlds.splice(0)) {
                b3._bx_DestroyWorld(world);
            }
            b3.PThread?.terminateAllThreads?.();
            b3 = plain;
        }
    });

    it("clip point by point: a plank half past the plane loses only that half's support", () => {
        const world = createWorld();
        createBox(world, STATIC, [0, -0.5, 0], [10, 0.5, 10]);
        const plank = createBox(world, DYNAMIC, [0, 0.1, 0], [2, 0.1, 0.5]);
        run(world, 30);
        // past x = 1 the plank is "through the portal"
        b3._bx_Body_SetClipPlane(plank, 1, 1, 0, 0, -1, 0xffffffff);
        run(world, 40);
        const { p, q } = transform(plank);
        // it tips about the edge at x = 1 and slides in: its centre drops below the floor's surface and the plank rolls
        // about z, the +x end going down
        expect(p[1]).toBeLessThan(0);
        const rollZ = 2 * Math.atan2(q[2], q[3]);
        expect(rollZ).toBeLessThan(-0.2);
    });

    it("only clip contacts with shapes whose category bits meet the mask", () => {
        const world = createWorld();
        createBox(world, STATIC, [0, -0.5, 0], [10, 0.5, 10], 2);
        const body = createBox(world, DYNAMIC, [0, 0.5, 0], [0.5, 0.5, 0.5]);
        run(world, 30);
        clipBelowGround(body, 4);
        run(world, 60);
        expect(transform(body).p[1]).toBeCloseTo(0.5, 1);
        clipBelowGround(body, 2 | 4);
        run(world, 60);
        expect(transform(body).p[1]).toBeLessThan(-2);
    });

    it("stop clipping when removed, and read back", () => {
        const world = createWorld();
        createBox(world, STATIC, [0, -0.5, 0], [10, 0.5, 10]);
        const body = createBox(world, DYNAMIC, [0, 0.5, 0], [0.5, 0.5, 0.5]);
        clipBelowGround(body, 6);
        b3._bx_Body_GetClipPlane(body);
        const at = b3._bx_ScratchF64() >> 3;
        expect(Array.from(b3.HEAPF64.subarray(at, at + 6))).toEqual([1, 0, -1, 0, 0.25, 6]);
        b3._bx_Body_SetClipPlane(body, 0, 0, 0, 0, 0, 0);
        b3._bx_Body_GetClipPlane(body);
        expect(b3.HEAPF64[at]).toBe(0);
        run(world, 60);
        expect(transform(body).p[1]).toBeCloseTo(0.5, 1);
    });

    it("let continuous collision pass through what the plane clips", () => {
        const world = createWorld();
        createBox(world, STATIC, [0, -0.05, 0], [10, 0.05, 10]);
        const kept = createBox(world, DYNAMIC, [-3, 5, 0], [0.1, 0.1, 0.1]);
        const clipped = createBox(world, DYNAMIC, [3, 5, 0], [0.1, 0.1, 0.1]);
        clipBelowGround(clipped);
        for (const body of [kept, clipped]) {
            b3._bx_Body_SetBullet(body, 1);
            // ~8 metres a step, far past the 10 cm floor, so only continuous collision can stop it
            b3._bx_Body_SetLinearVelocity(body, 0, -500, 0);
        }
        run(world, 3);
        expect(transform(kept).p[1]).toBeGreaterThan(0);
        expect(transform(clipped).p[1]).toBeLessThan(-10);
    });

    it("leave a body without a plane bit for bit as before", () => {
        const positions = (clip: boolean): number[] => {
            const world = createWorld();
            createBox(world, STATIC, [0, -0.5, 0], [10, 0.5, 10]);
            const bodies: number[] = [];
            for (let i = 0; i < 10; i++) {
                bodies.push(createBox(world, DYNAMIC, [0, 0.5 + i * 1.01, 0], [0.5, 0.5, 0.5]));
            }
            const far = createBox(world, DYNAMIC, [8, 0.5, 8], [0.5, 0.5, 0.5]);
            if (clip) {
                // a clip plane on another body changes nothing for the stack
                b3._bx_Body_SetClipPlane(far, 1, 0, 1, 0, -100, 0xffffffff);
            }
            run(world, 120);
            return bodies.flatMap((b) => transform(b).p);
        };
        expect(positions(true)).toEqual(positions(false));
    });
});

describe("Box3DPlugin.setBodyClipPlane", () => {
    it("lets a plank pushed through a portal pass the wall behind it, and reads the plane back", async () => {
        const { CreateWasmScene, CreateBoxBody } = await import("./wasmScene");
        const { Vector3 } = await import("@babylonjs/core/Maths/math.vector");
        const { Plane } = await import("@babylonjs/core/Maths/math.plane");
        const { PhysicsMotionType } = await import("@babylonjs/core/Physics/v2/IPhysicsEnginePlugin");
        const run = async (clip: boolean): Promise<number> => {
            const s = await CreateWasmScene(new Vector3(0, 0, 0));
            // a slab at z = 0 to 1, what is behind a portal in a wall at z = 0
            CreateBoxBody(s.scene, "behind", new Vector3(0, 0, 0.5), new Vector3(10, 10, 1), PhysicsMotionType.STATIC);
            const plank = CreateBoxBody(s.scene, "plank", new Vector3(0, 0, -2), new Vector3(0.5, 0.5, 3), PhysicsMotionType.DYNAMIC, 10);
            if (clip) {
                // the portal's plane, its positive side the far side of the portal
                const plane = Plane.FromPositionAndNormal(Vector3.Zero(), new Vector3(0, 0, 1));
                s.plugin.setBodyClipPlane(plank.body, plane);
                const back = s.plugin.getBodyClipPlane(plank.body)!;
                expect(back.collideMask).toBe(0xffffffff);
                expect(back.plane.normal.asArray()).toEqual([0, 0, 1]);
                expect(back.plane.d).toBeCloseTo(0, 6);
            } else {
                expect(s.plugin.getBodyClipPlane(plank.body)).toBeNull();
            }
            plank.body.setLinearVelocity(new Vector3(0, 0, 2));
            s.step(60);
            const z = plank.node.position.z;
            s.dispose();
            return z;
        };
        // stopped at the slab: its front end at z = 0
        expect(await run(false)).toBeLessThan(-1.4);
        // 2 m/s for a second, through the slab
        expect(await run(true)).toBeGreaterThan(-0.2);
    });
});
