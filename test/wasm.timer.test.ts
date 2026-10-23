// Box3D's clock switched off per world (wasm/patches/0007, shim: bx_World_EnableTimer), against the real wasm through
// the shim's raw exports. A step read the clock dozens of times only to time itself, and in JavaScript every read is a
// call out of the module that allocates. With the timer off a step reads no clock at all, its timings read zero, and
// the world steps the same as with it on, bit for bit, on either build.

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Box3D from "../lib/node/box3d.mjs";
import Box3DThreads from "../lib/node-threads/box3d.mjs";

const Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STATIC = 0;
const DYNAMIC = 2;
/** where bx_World_GetStats writes the last step's timings, ms */
const STATS_STEP = 5;
const STATS_COLLIDE = 6;
const STATS_SOLVE = 7;

let b3: any;
let threaded: any;
/** calls the module has made out to the host for the time, whichever way it asked */
let clockReads = 0;
const worlds: { module: any; world: number }[] = [];

beforeAll(async () => {
    // the node build, instantiated here so that its imports for the time can be counted
    const binary = readFileSync(path.join(Root, "lib", "node", "box3d.wasm"));
    b3 = await Box3D({
        instantiateWasm(imports: any, receive: (instance: WebAssembly.Instance) => void) {
            for (const name of ["clock_time_get", "emscripten_get_now"]) {
                for (const table of [imports.env, imports.wasi_snapshot_preview1]) {
                    const read = table?.[name];
                    if (typeof read === "function" && !read.counted) {
                        const counted = (...args: unknown[]) => {
                            clockReads++;
                            return read(...args);
                        };
                        counted.counted = true;
                        table[name] = counted;
                    }
                }
            }
            void WebAssembly.instantiate(binary, imports).then(({ instance }) => receive(instance));
            return {};
        },
    });
    threaded = await Box3DThreads();
});

afterEach(() => {
    for (const { module, world } of worlds.splice(0)) {
        module._bx_DestroyWorld(world);
    }
});

afterAll(() => {
    // emscripten keeps the worker pool alive, and vitest will not let the process go while it is up
    threaded?.PThread?.terminateAllThreads?.();
});

function createWorld(module: any, workers = 1): number {
    const world = module._bx_CreateWorld(0, -9.81, 0, workers);
    worlds.push({ module, world });
    return world;
}

function createBox(module: any, world: number, type: number, center: [number, number, number], half: [number, number, number]): number {
    const body = module._bx_CreateBody(world, type, center[0], center[1], center[2], 0, 0, 0, 1, 1);
    const desc = module._bx_ShapeDesc_CreateBox(half[0], half[1], half[2], 0, 0, 0, 0, 0, 0, 1);
    module._bx_ShapeDesc_SetDensity(desc, 1000);
    module._bx_Body_SetShape(body, desc);
    if (type === DYNAMIC) {
        module._bx_Body_ApplyMassFromShapes(body);
    }
    return body;
}

/**
 * A pile of boxes dropped on a floor, knocked over by a box shot through it, and a small box fired at 150 m/s at a thin
 * wall, so a step has islands to solve and split, bodies to put to sleep, and continuous collision to run: every path
 * that timed itself. Returns the dynamic bodies.
 */
function buildScene(module: any, world: number): number[] {
    createBox(module, world, STATIC, [0, -0.5, 0], [20, 0.5, 20]);
    createBox(module, world, STATIC, [12, 1, 0], [0.05, 1, 1]);
    const bodies: number[] = [];
    for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 4; x++) {
            for (let z = 0; z < 3; z++) {
                bodies.push(createBox(module, world, DYNAMIC, [x * 0.6 - 0.9, 0.3 + y * 0.62, z * 0.6 - 0.6], [0.25, 0.25, 0.25]));
            }
        }
    }
    const ram = createBox(module, world, DYNAMIC, [-6, 0.8, 0], [0.3, 0.3, 0.3]);
    module._bx_Body_SetLinearVelocity(ram, 12, 0, 0);
    bodies.push(ram);
    const shot = createBox(module, world, DYNAMIC, [6, 1, 0], [0.05, 0.05, 0.05]);
    module._bx_Body_SetLinearVelocity(shot, 150, 0, 0);
    bodies.push(shot);
    return bodies;
}

/** Every body's position and rotation, as the float bits the module holds. */
function poses(module: any, bodies: number[]): Uint32Array {
    const out = new Float32Array(bodies.length * 7);
    bodies.forEach((body, i) => {
        module._bx_Body_GetTransform(body);
        const at = module._bx_Scratch() >> 2;
        out.set(module.HEAPF32.subarray(at, at + 7), i * 7);
    });
    return new Uint32Array(out.buffer);
}

function timings(module: any, world: number): number[] {
    module._bx_World_GetStats(world);
    const at = module._bx_Scratch() >> 2;
    return [module.HEAPF32[at + STATS_STEP], module.HEAPF32[at + STATS_COLLIDE], module.HEAPF32[at + STATS_SOLVE]];
}

describe("Box3D's clock", () => {
    it("is read on every step by default, and the step's timings are its", () => {
        const world = createWorld(b3);
        buildScene(b3, world);
        expect(b3._bx_World_IsTimerEnabled(world)).toBe(1);
        let longest = 0;
        for (let i = 0; i < 30; i++) {
            const before = clockReads;
            b3._bx_World_Step(world, 1 / 60, 4);
            expect(clockReads - before).toBeGreaterThan(10);
            longest = Math.max(longest, timings(b3, world)[0]);
        }
        expect(longest).toBeGreaterThan(0);
    });

    it("is not read once while it is off, and the timings are zero", () => {
        const world = createWorld(b3);
        buildScene(b3, world);
        b3._bx_World_EnableTimer(world, 0);
        expect(b3._bx_World_IsTimerEnabled(world)).toBe(0);
        const before = clockReads;
        for (let i = 0; i < 120; i++) {
            b3._bx_World_Step(world, 1 / 60, 4);
            expect(timings(b3, world)).toEqual([0, 0, 0]);
        }
        expect(clockReads - before).toBe(0);
    });

    it("is switched for one world, and a world made in its slot later starts with it on", () => {
        const quiet = createWorld(b3);
        const timed = createWorld(b3);
        buildScene(b3, quiet);
        buildScene(b3, timed);
        b3._bx_World_EnableTimer(quiet, 0);
        for (let i = 0; i < 10; i++) {
            let before = clockReads;
            b3._bx_World_Step(quiet, 1 / 60, 4);
            expect(clockReads - before).toBe(0);
            before = clockReads;
            b3._bx_World_Step(timed, 1 / 60, 4);
            expect(clockReads - before).toBeGreaterThan(0);
        }
        expect(b3._bx_World_IsTimerEnabled(timed)).toBe(1);
        // back on, the world reads it again
        b3._bx_World_EnableTimer(quiet, 1);
        const before = clockReads;
        b3._bx_World_Step(quiet, 1 / 60, 4);
        expect(clockReads - before).toBeGreaterThan(0);
        b3._bx_World_EnableTimer(quiet, 0);
        const { world } = worlds.shift()!;
        b3._bx_DestroyWorld(world);
        expect(createWorld(b3)).toBe(world);
        expect(b3._bx_World_IsTimerEnabled(world)).toBe(1);
        // a slot that holds no world has no timer to switch
        expect(b3._bx_World_IsTimerEnabled(7)).toBe(0);
    });

    it("changes nothing the world does: on or off, every body lands on the same bits every step", () => {
        const on = createWorld(b3);
        const off = createWorld(b3);
        const a = buildScene(b3, on);
        const b = buildScene(b3, off);
        b3._bx_World_EnableTimer(off, 0);
        let moved = 0;
        for (let i = 0; i < 240; i++) {
            b3._bx_World_Step(on, 1 / 60, 4);
            b3._bx_World_Step(off, 1 / 60, 4);
            const poseA = poses(b3, a);
            expect(poses(b3, b)).toEqual(poseA);
            moved = i;
        }
        expect(moved).toBe(239);
        // the shot met the wall rather than passing it, so continuous collision ran
        b3._bx_Body_GetTransform(a[a.length - 1]);
        expect(b3.HEAPF32[b3._bx_Scratch() >> 2]).toBeLessThan(12);
    });

    it("is off for a step on the threaded build's workers too, which step the same as with it on", () => {
        const on = createWorld(threaded, 4);
        const off = createWorld(threaded, 4);
        expect(threaded._bx_World_GetWorkerCount(off)).toBe(4);
        const a = buildScene(threaded, on);
        const b = buildScene(threaded, off);
        threaded._bx_World_EnableTimer(off, 0);
        let timed = 0;
        for (let i = 0; i < 240; i++) {
            threaded._bx_World_Step(on, 1 / 60, 4);
            timed = Math.max(timed, timings(threaded, on)[0]);
            threaded._bx_World_Step(off, 1 / 60, 4);
            expect(timings(threaded, off)).toEqual([0, 0, 0]);
            expect(poses(threaded, b)).toEqual(poses(threaded, a));
        }
        expect(timed).toBeGreaterThan(0);
    });
});
