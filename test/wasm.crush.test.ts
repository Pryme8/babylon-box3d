// Crushable contacts (wasm/patches/0003) against the real wasm through the shim's raw exports. A crushable shape's
// contacts push with at most a set force, so a body meeting something rigid decelerates over a crumple distance
// instead of stopping within a step, and a plastic contact keeps the overlap it reaches.
//
// The first four cases are the crush spike's numeric tests; the fifth, that rigid contacts are untouched, is the
// pyramid case at the end. Every case steps the way a rally sim does: 480 Hz with two substeps.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Box3DThreads from "../lib/node-threads/box3d.mjs";
import { LoadBox3D } from "./wasmScene";

const STATIC = 0;
const DYNAMIC = 2;
const HZ = 480;
const DT = 1 / HZ;
const SUB_STEPS = 2;
const H = DT / SUB_STEPS;

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

function createWorld(gravityY = 0): number {
    const world = b3._bx_CreateWorld(0, gravityY, 0, 1);
    worlds.push(world);
    return world;
}

function attach(body: number, desc: number, type: number, friction: number): void {
    b3._bx_ShapeDesc_SetMaterial(desc, friction, 0);
    b3._bx_Body_SetShape(body, desc);
    if (type === DYNAMIC) {
        b3._bx_Body_ApplyMassFromShapes(body);
    }
}

/** A box body; its density gives it `mass` kilograms. */
function createBox(world: number, type: number, center: Vec3, half: Vec3, mass = 1000, friction = 0.5): number {
    const body = b3._bx_CreateBody(world, type, center[0], center[1], center[2], 0, 0, 0, 1, 1);
    const desc = b3._bx_ShapeDesc_CreateBox(half[0], half[1], half[2], 0, 0, 0, 0, 0, 0, 1);
    b3._bx_ShapeDesc_SetDensity(desc, mass / (8 * half[0] * half[1] * half[2]));
    attach(body, desc, type, friction);
    return body;
}

/** A static upright capsule, a tree trunk, whose axis stands at (x, z). */
function createTree(world: number, x: number, z: number, radius: number, friction: number): number {
    const body = b3._bx_CreateBody(world, STATIC, x, 0, z, 0, 0, 0, 1, 1);
    attach(body, b3._bx_ShapeDesc_CreateCapsule(0, -3, 0, 0, 3, 0, radius), STATIC, friction);
    return body;
}

/** A flat static height field, `size` metres square with a sample every metre, its surface at y = 0. */
function createGround(world: number, size: number): number {
    const samples = size + 1;
    const heights = b3._malloc(samples * samples * 4);
    b3.HEAPF32.fill(0, heights >> 2, (heights >> 2) + samples * samples);
    const desc = b3._bx_ShapeDesc_CreateHeightField(heights, 0, samples, samples, 1, 1, 1, 0, -size / 2, 0, -size / 2);
    b3._free(heights);
    const body = b3._bx_CreateBody(world, STATIC, 0, 0, 0, 0, 0, 0, 1, 1);
    attach(body, desc, STATIC, 0.8);
    return body;
}

function read3(): Vec3 {
    const at = b3._bx_Scratch() >> 2;
    return [b3.HEAPF32[at], b3.HEAPF32[at + 1], b3.HEAPF32[at + 2]];
}

function position(body: number): Vec3 {
    b3._bx_Body_GetTransform(body);
    return read3();
}

function velocity(body: number): Vec3 {
    b3._bx_Body_GetLinearVelocity(body);
    return read3();
}

function step(world: number): void {
    b3._bx_World_Step(world, DT, SUB_STEPS);
}

function crush(body: number, maxForce: number, plastic = true): void {
    b3._bx_Body_SetShapeCrush(body, 0, maxForce, plastic ? 1 : 0);
}

interface IWallRun {
    /** x of the body's center, and its x velocity, after each tick */
    x: number[];
    vx: number[];
    /** the fractional tick at which the front face first reaches the wall */
    touchTick: number;
    /** the x of the body's center when its front face reaches the wall */
    touchX: number;
}

/**
 * A 1,000 kg, 2 m box driven at `speed` into a static wall `gap` ahead, with gravity off. `limit(depth)` sets the
 * crush limit before every tick from the depth crushed so far.
 */
function wallRun(speed: number, limit: (depth: number) => number, ticks: number, gap = 0.05): IWallRun {
    const world = createWorld(0);
    createBox(world, STATIC, [1 + gap + 1, 0, 0], [1, 3, 3]);
    const car = createBox(world, DYNAMIC, [0, 0, 0], [1, 1, 1]);
    b3._bx_Body_SetLinearVelocity(car, speed, 0, 0);
    const touchX = gap;
    const run: IWallRun = { x: [], vx: [], touchTick: (gap / speed) * HZ, touchX };
    for (let i = 0; i < ticks; i++) {
        const depth = Math.max(0, position(car)[0] - touchX);
        crush(car, limit(depth));
        step(world);
        run.x.push(position(car)[0]);
        run.vx.push(velocity(car)[0]);
    }
    return run;
}

/** The first tick after which the body no longer moves toward the wall. */
function stopTick(run: IWallRun): number {
    return run.vx.findIndex((v) => v <= 1e-3) + 1;
}

describe("crushable contacts: a box into a wall at a constant limit", () => {
    // 1,000 kg at 15 m/s against 200 kN: 200 m/s², so v²/2a = 0.5625 m and v/a = 75 ms.
    //
    // Two things in Box3D itself, not in the crush, move the depth by about a centimetre either way, depending on
    // where in a tick the faces meet. It integrates semi-implicitly (the new velocity moves the body), which under
    // any constant force, gravity included, travels v·h/2 less than the continuous answer: 7.8 mm at a 1/960 s
    // substep. And it only makes contact points within its 2 cm speculative distance of touching, while 15 m/s
    // covers 3.1 cm a tick, so a touch that falls in the last 1.1 cm of a tick starts that far in. Across the phases
    // the depth runs from 1.4% short to 0.4% long, so it is held to 1.5% of the continuous answer rather than 1%.
    const SPEED = 15;
    const FORCE = 200e3;
    const TICKS = Math.round(0.4 * HZ);
    const EXACT = 0.5625;
    const GAPS = [0.05, 0.051, 0.0525, 0.054, 0.0555, 0.0445, 0.047];

    it("stops at 0.5625 m ± 1.5% in 75 ms ± 1 tick, at any phase of the touch", () => {
        for (const gap of GAPS) {
            const run = wallRun(SPEED, () => FORCE, TICKS, gap);
            const stop = stopTick(run);
            const depth = run.x[stop - 1] - run.touchX;
            expect(Math.abs(depth / EXACT - 1)).toBeLessThan(0.015);
            const crushTicks = stop - run.touchTick;
            expect(Math.abs(crushTicks - 0.075 * HZ)).toBeLessThanOrEqual(1);
        }
    });

    it("is exact when the touch comes early in a tick: the continuous answer less the integrator's half substep", () => {
        const run = wallRun(SPEED, () => FORCE, TICKS, 0.047);
        const depth = run.x[stopTick(run) - 1] - run.touchX;
        expect(Math.abs(depth / (EXACT - (SPEED * H) / 2) - 1)).toBeLessThan(0.001);
    });

    it("decelerates at F/m throughout the crush", () => {
        const run = wallRun(SPEED, () => FORCE, TICKS);
        const first = Math.ceil(run.touchTick) + 1;
        const stop = stopTick(run);
        for (let i = first; i < stop - 1; i++) {
            const decel = (run.vx[i - 1] - run.vx[i]) * HZ;
            expect(decel).toBeGreaterThan(200 * 0.99);
            expect(decel).toBeLessThan(200 * 1.01);
        }
    });

    it("rebounds at under 0.05 m/s", () => {
        const run = wallRun(SPEED, () => FORCE, TICKS);
        const stop = stopTick(run);
        for (let i = stop; i < TICKS; i++) {
            expect(run.vx[i]).toBeGreaterThan(-0.05);
        }
    });

    it("is deterministic", () => {
        const a = wallRun(SPEED, () => FORCE, TICKS);
        const b = wallRun(SPEED, () => FORCE, TICKS);
        expect(new Float32Array(b.x)).toEqual(new Float32Array(a.x));
        expect(new Float32Array(b.vx)).toEqual(new Float32Array(a.vx));
    });

    it("stops within a step when the shape is rigid, as before the patch", () => {
        const run = wallRun(SPEED, () => 0, TICKS);
        expect(stopTick(run) - run.touchTick).toBeLessThanOrEqual(2);
    });
});

describe("crushable contacts: a limit that follows a crush curve", () => {
    // F(d) = 100 kN + 400 kN/m · d, the stiffening a real front end shows. m·x'' = -F(x) stops the box where
    // ½mv² = F0·d + ½k·d², at d = 0.5406 m.
    const SPEED = 15;
    const MASS = 1000;
    const F0 = 100e3;
    const K = 400e3;
    const force = (depth: number) => F0 + K * depth;

    /** RK4 on m·x'' = -F(x) from the touch, fine enough to be exact here: time and depth at the stop, and v(t). */
    function analytic(): { stopTime: number; stopDepth: number; speedAt: (t: number) => number } {
        const h = 1e-6;
        const samples: number[] = [];
        let x = 0;
        let v = SPEED;
        let t = 0;
        const accel = (d: number) => -force(d) / MASS;
        while (v > 0) {
            samples.push(v);
            const k1x = v;
            const k1v = accel(x);
            const k2x = v + (h / 2) * k1v;
            const k2v = accel(x + (h / 2) * k1x);
            const k3x = v + (h / 2) * k2v;
            const k3v = accel(x + (h / 2) * k2x);
            const k4x = v + h * k3v;
            const k4v = accel(x + h * k3x);
            x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
            v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
            t += h;
        }
        return { stopTime: t, stopDepth: x, speedAt: (time) => (time < 0 ? SPEED : (samples[Math.round(time / h)] ?? 0)) };
    }

    it("matches the ODE within 2% in stopping depth, stopping time and speed along the way", () => {
        const exact = analytic();
        expect(exact.stopDepth).toBeCloseTo(0.5406, 3);
        const run = wallRun(SPEED, force, Math.round(0.3 * HZ));
        const stop = stopTick(run);
        const depth = run.x[stop - 1] - run.touchX;
        expect(Math.abs(depth / exact.stopDepth - 1)).toBeLessThan(0.02);
        const time = (stop - run.touchTick) / HZ;
        expect(Math.abs(time / exact.stopTime - 1)).toBeLessThan(0.02);
        for (let i = 0; i < stop; i++) {
            const t = (i + 1 - run.touchTick) / HZ;
            expect(Math.abs(run.vx[i] - exact.speedAt(t))).toBeLessThan(0.02 * SPEED);
        }
    });
});

describe("crushable contacts: a glancing hit on a tree", () => {
    // A 4 × 1.8 m, 1,000 kg body, rotation locked so the contact normal stays its front face's, hits a 30 cm
    // capsule trunk at 15 m/s, 30° off square, with μ 0.5 and a 200 kN plastic limit.
    const MASS = 1000;
    const FORCE = 200e3;
    const MU = 0.5;
    const SPEED = 15;
    const ANGLE = (30 * Math.PI) / 180;

    function glance(): { normal: number[]; lateral: number[]; vn: number[]; first: number } {
        const world = createWorld(0);
        createTree(world, 2 + 0.15 + 0.02, 0, 0.15, MU);
        const car = createBox(world, DYNAMIC, [0, 0, -0.3], [2, 0.7, 0.9], MASS, MU);
        b3._bx_Body_SetMotionLocks(car, 0, 0, 0, 1, 1, 1);
        crush(car, FORCE);
        b3._bx_Body_SetLinearVelocity(car, SPEED * Math.cos(ANGLE), 0, SPEED * Math.sin(ANGLE));
        const normal: number[] = [];
        const lateral: number[] = [];
        const vn: number[] = [];
        let before = velocity(car);
        let first = -1;
        for (let i = 0; i < Math.round(0.2 * HZ); i++) {
            step(world);
            const after = velocity(car);
            // The trunk pushes along -x on the front face; friction acts along z.
            normal.push((MASS * (before[0] - after[0])) / DT);
            lateral.push((MASS * Math.abs(before[2] - after[2])) / DT);
            vn.push(after[0]);
            if (first < 0 && normal[i] > 0) {
                first = i;
            }
            before = after;
        }
        return { normal, lateral, vn, first };
    }

    it("pushes on every tick while it crushes, never dropping out for more than one", () => {
        const { normal, vn, first } = glance();
        expect(first).toBeGreaterThanOrEqual(0);
        let gap = 0;
        let longest = 0;
        for (let i = first; i < normal.length && vn[i - 1] > 1e-3; i++) {
            gap = normal[i] < 0.1 * FORCE ? gap + 1 : 0;
            longest = Math.max(longest, gap);
        }
        expect(longest).toBeLessThanOrEqual(1);
    });

    it("holds the push to its limit, and friction within 20% of μ times it", () => {
        const { normal, lateral } = glance();
        for (let i = 0; i < normal.length; i++) {
            expect(normal[i]).toBeLessThan(FORCE * 1.01);
            expect(lateral[i]).toBeLessThanOrEqual(1.2 * MU * Math.max(normal[i], 0) + 1);
        }
    });
});

describe("crushable contacts: a roof on the ground", () => {
    // A 1,000 kg, 1.2 m cube, a car's roof and pillars as one chunk, dropped 2 m onto a flat height field with a
    // 60 kN plastic limit (6 g). It lands at √(2g·2) = 6.26 m/s and decelerates at F/m − g = 50.2 m/s², so it
    // crushes v²/2(F/m − g) = 0.391 m into the ground and stays there, since its weight is well below the limit.
    // (The sim translates a chunk's hull back as it crushes; a hull pushed wholly through a surface finds nothing.)
    // Box3D gives a height field a 5 mm skin, where a rigid box comes to rest, so depth counts from there. As at
    // the wall, where in a tick the touch falls moves the depth by up to about 2%.
    const MASS = 1000;
    const FORCE = 60e3;
    const G = 9.81;
    const HALF = 0.6;

    /** Drops the chunk from `height` and gives its lowest center height and where it has settled 1.5 s later. */
    function drop(height: number, limit: number): { lowest: number; settled: number } {
        const world = createWorld(-G);
        createGround(world, 20);
        const roof = createBox(world, DYNAMIC, [0, height + HALF, 0], [0.6, HALF, 0.6], MASS, 0.8);
        b3._bx_Body_EnableSleep(roof, 0);
        crush(roof, limit);
        let lowest = Infinity;
        for (let i = 0; i < Math.round(1.5 * HZ); i++) {
            step(world);
            lowest = Math.min(lowest, position(roof)[1]);
        }
        return { lowest, settled: position(roof)[1] };
    }

    it("crushes plastically to the depth its energy allows ± 2%, and stays there", () => {
        const surface = drop(0.05, 0).settled;
        expect(surface - HALF).toBeCloseTo(0.005, 3);
        for (const height of [2, 1.99, 1.985, 1.98, 1.97]) {
            const { lowest, settled } = drop(height, FORCE);
            const landing = Math.sqrt(2 * G * (height - (surface - HALF)));
            const expected = (landing * landing) / (2 * (FORCE / MASS - G));
            expect(Math.abs((surface - lowest) / expected - 1)).toBeLessThan(0.02);
            expect(Math.abs(settled - lowest)).toBeLessThan(1e-4);
        }
    });

    it("sinks through when its weight is more than the limit", () => {
        const world = createWorld(-G);
        createGround(world, 20);
        const roof = createBox(world, DYNAMIC, [0, HALF, 0], [0.6, HALF, 0.6], MASS, 0.8);
        crush(roof, 0.5 * MASS * G);
        for (let i = 0; i < 0.4 * HZ; i++) {
            step(world);
        }
        // It sinks at g/2: 0.392 m in 0.4 s.
        const sunk = HALF - position(roof)[1];
        expect(Math.abs(sunk / 0.392 - 1)).toBeLessThan(0.02);
    });
});

describe("crushable contacts: switching a touching shape", () => {
    const MASS = 1000;
    const G = 9.81;

    it("keeps its contacts through becoming crushable and rigid again", () => {
        const world = createWorld(-G);
        createBox(world, STATIC, [0, -0.5, 0], [5, 0.5, 5]);
        const box = createBox(world, DYNAMIC, [0, 0.5, 0], [0.5, 0.5, 0.5], MASS);
        b3._bx_Body_EnableSleep(box, 0);
        for (let i = 0; i < HZ / 2; i++) {
            step(world);
        }
        const resting = position(box)[1];
        expect(resting).toBeCloseTo(0.5, 2);

        // Crushable with room to spare: it still rests, now solved on the scalar path.
        crush(box, 10 * MASS * G);
        for (let i = 0; i < HZ / 2; i++) {
            step(world);
        }
        expect(position(box)[1]).toBeCloseTo(resting, 3);

        // Below its weight: it sinks, at g/2.
        crush(box, 0.5 * MASS * G);
        for (let i = 0; i < HZ / 4; i++) {
            step(world);
        }
        const sunk = position(box)[1];
        expect(sunk).toBeLessThan(resting - 0.1);

        // Rigid again: the contact goes back to the wide path and pushes the box back out.
        crush(box, 0);
        for (let i = 0; i < HZ; i++) {
            step(world);
        }
        expect(position(box)[1]).toBeCloseTo(resting, 2);
    });

    it("reads back as set", () => {
        const world = createWorld(0);
        const box = createBox(world, DYNAMIC, [0, 0, 0], [0.5, 0.5, 0.5]);
        const read = () => {
            b3._bx_Body_GetShapeCrush(box, 0);
            const at = b3._bx_Scratch() >> 2;
            return [b3.HEAPF32[at], b3.HEAPF32[at + 1]];
        };
        expect(read()).toEqual([0, 0]);
        crush(box, 150e3, true);
        expect(read()).toEqual([150e3, 1]);
        crush(box, 80e3, false);
        expect(read()).toEqual([80e3, 0]);
        crush(box, 0);
        expect(read()).toEqual([0, 0]);
        b3._bx_Body_SetShapeCrush(box, 5, 1e3, 1);
        b3._bx_Body_GetShapeCrush(box, 5);
        expect(b3.HEAPF32[b3._bx_Scratch() >> 2]).toBe(0);
    });
});

describe("crushable contacts: rigid contacts are untouched", () => {
    // Box3D's 210-box pyramid (20 rows), stepped for 2 s at 480 Hz: every body's final transform, bit for bit,
    // hashes to what the build before wasm/patches/0003 gave. Rigid contacts keep the wide and scalar paths exactly
    // as they were. The hash is Box3D's, so a new upstream commit or another patch that changes rigid contacts
    // records it again, and says why in its commit.
    const PYRAMID_HASH = 0x3e73047d;

    it("leaves the 210-box pyramid bit for bit where it was", () => {
        const world = createWorld(-9.81);
        const ground = b3._bx_CreateBody(world, STATIC, 0, -0.5, 0, 0, 0, 0, 1, 1);
        b3._bx_Body_SetShape(ground, b3._bx_ShapeDesc_CreateBox(40, 0.5, 40, 0, 0, 0, 0, 0, 0, 1));
        const bodies: number[] = [];
        const rows = 20;
        const h = 0.5;
        for (let i = 0; i < rows; i++) {
            for (let j = i; j < rows; j++) {
                const body = b3._bx_CreateBody(world, DYNAMIC, (i + 1) * h + 2 * (j - i) * h - h * rows, (2 * i + 1) * h, 0, 0, 0, 0, 1, 1);
                b3._bx_Body_SetShape(body, b3._bx_ShapeDesc_CreateBox(h, h, h, 0, 0, 0, 0, 0, 0, 1));
                b3._bx_Body_ApplyMassFromShapes(body);
                bodies.push(body);
            }
        }
        expect(bodies.length).toBe(210);
        for (let i = 0; i < 2 * HZ; i++) {
            step(world);
        }
        // FNV-1a over the bits of each body's position and rotation.
        let hash = 2166136261;
        const bits = new Uint32Array(1);
        const value = new Float32Array(bits.buffer);
        for (const body of bodies) {
            b3._bx_Body_GetTransform(body);
            const at = b3._bx_Scratch() >> 2;
            for (let k = 0; k < 7; k++) {
                value[0] = b3.HEAPF32[at + k];
                hash = Math.imul(hash ^ bits[0], 16777619) >>> 0;
            }
        }
        expect(hash).toBe(PYRAMID_HASH);
    });
});

describe("crushable contacts: the threaded build", () => {
    let threaded: any;

    beforeAll(async () => {
        threaded = await Box3DThreads();
    });

    afterAll(() => {
        // emscripten keeps the worker pool alive, and vitest will not let the process go while it is up
        threaded?.PThread?.terminateAllThreads?.();
    });

    /**
     * Sixty crushable boxes, in rows that each crush into a wall and then into each other, on `module` with
     * `workerCount` workers: enough crush contacts to spread over several graph colors and worker blocks.
     */
    function crashRows(module: any, workerCount: number): Float32Array {
        const world = module._bx_CreateWorld(0, -9.81, 0, workerCount);
        const box = (type: number, x: number, y: number, z: number, hx: number, hy: number, hz: number) => {
            const body = module._bx_CreateBody(world, type, x, y, z, 0, 0, 0, 1, 1);
            const desc = module._bx_ShapeDesc_CreateBox(hx, hy, hz, 0, 0, 0, 0, 0, 0, 1);
            module._bx_ShapeDesc_SetDensity(desc, 1000 / (8 * hx * hy * hz));
            module._bx_Body_SetShape(body, desc);
            if (type === DYNAMIC) {
                module._bx_Body_ApplyMassFromShapes(body);
            }
            return body;
        };
        box(STATIC, 0, -0.5, 0, 60, 0.5, 60);
        box(STATIC, 12, 1, 0, 0.5, 2, 30);
        const bodies: number[] = [];
        for (let row = 0; row < 12; row++) {
            for (let k = 0; k < 5; k++) {
                const body = box(DYNAMIC, 9 - k * 2.6, 0.5, -24 + row * 4, 1, 0.5, 1);
                module._bx_Body_SetShapeCrush(body, 0, 80e3 + 10e3 * k, 1);
                module._bx_Body_SetLinearVelocity(body, 8 + k, 0, 0);
                bodies.push(body);
            }
        }
        for (let i = 0; i < HZ / 2; i++) {
            module._bx_World_Step(world, DT, SUB_STEPS);
        }
        const out = new Float32Array(bodies.length * 3);
        bodies.forEach((body, i) => {
            module._bx_Body_GetTransform(body);
            const at = module._bx_Scratch() >> 2;
            out.set(module.HEAPF32.subarray(at, at + 3), i * 3);
        });
        module._bx_DestroyWorld(world);
        return out;
    }

    it("crushes bit for bit the same on one worker or four, and as the single threaded build", () => {
        const single = crashRows(b3, 1);
        // the front box of each row has crushed into the wall, whose face its center meets at x = 10.5
        expect(single[0]).toBeGreaterThan(10.6);
        expect(crashRows(threaded, 1)).toEqual(single);
        expect(crashRows(threaded, 4)).toEqual(single);
    });
});
