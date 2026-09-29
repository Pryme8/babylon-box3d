// Box3D's hull builder on degenerate points (wasm/patches/0004), against the real wasm through the shim's raw exports.
// Flat point sets far from the origin sent b3CreateHull round a loop that never ended, which locked whatever called
// it. Now they make no hull, and quickly. Every hull that was built before comes out the same, bit for bit.

import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Box3DThreads from "../lib/node-threads/box3d.mjs";
import { LoadBox3D } from "./wasmScene";

const Here = path.dirname(fileURLToPath(import.meta.url));
const Child = path.join(Here, "flatHulls.child.mjs");
const FlatSets: { name: string; points: number[] }[] = JSON.parse(readFileSync(path.join(Here, "fixtures", "flat-hull-points.json"), "utf8"));

const STATIC = 0;
/** how long the child may take, loading the module included, before it counts as hung */
const WATCHDOG_MS = 20000;
/** how long refusing one set may take, all six of the shim's vertex budgets included (it takes about a millisecond) */
const QUICK_MS = 100;

let plain: any;
let threaded: any;

beforeAll(async () => {
    plain = await LoadBox3D();
    threaded = await Box3DThreads();
});

afterAll(() => {
    // emscripten keeps the worker pool alive, and vitest will not let the process go while it is up
    threaded?.PThread?.terminateAllThreads?.();
});

interface IChildResult {
    name: string;
    desc: number;
    descMs: number;
    replaced: number;
    bodyMs: number;
    keptVertices: number;
}

/** Runs the flat sets in a child process that is killed if it outlives the watchdog, so a hang fails instead of hanging. */
function RunFlatSets(build: string): IChildResult[] {
    const run = spawnSync(process.execPath, [Child, build], { encoding: "utf8", timeout: WATCHDOG_MS });
    const lines = run.stdout
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    const last = lines[lines.length - 1];
    if (run.error || run.status !== 0 || !last?.results) {
        const where = last?.building ? `building ${last.building} with ${last.via}` : "before the first build";
        throw new Error(`the ${build} child ${run.error ? "hung" : `exited with ${run.status}`} ${where}\n${run.stderr}`);
    }
    return last.results;
}

describe("flat point sets far from the origin", () => {
    for (const build of ["node", "node-threads"]) {
        it(
            `make no hull, and quickly, in the ${build} build`,
            () => {
                const results = RunFlatSets(build);
                expect(results.map((r) => r.name)).toEqual(FlatSets.map((set) => set.name));
                for (const result of results) {
                    expect(result.desc, result.name).toBe(0);
                    expect(result.replaced, result.name).toBe(0);
                    // the body keeps the 0.4 m box it had
                    expect(result.keptVertices, result.name).toBe(8);
                    expect(result.descMs, result.name).toBeLessThan(QUICK_MS);
                    expect(result.bodyMs, result.name).toBeLessThan(QUICK_MS);
                }
            },
            WATCHDOG_MS + 10000
        );
    }
});

/** A small deterministic generator (no Math.random, no transcendentals), so the points are the same everywhere. */
function Lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function BoxPoints(center: number[], half: number[]): number[] {
    const points: number[] = [];
    for (let corner = 0; corner < 8; corner++) {
        points.push(
            center[0] + (corner & 1 ? half[0] : -half[0]),
            center[1] + (corner & 2 ? half[1] : -half[1]),
            center[2] + (corner & 4 ? half[2] : -half[2])
        );
    }
    return points;
}

/** Hulls of every everyday kind: a box, one far out, a tetrahedron, clouds, a dense sphere the shim simplifies, a thin plate and a dented chunk. */
function OrdinarySets(): { name: string; points: number[] }[] {
    const cloud = Lcg(7);
    const cloudPoints: number[] = [];
    for (let i = 0; i < 60; i++) {
        cloudPoints.push(cloud() - 0.5, 0.6 * (cloud() - 0.5), 0.3 * (cloud() - 0.5));
    }
    const sphere = Lcg(11);
    const spherePoints: number[] = [];
    while (spherePoints.length < 300 * 3) {
        const x = 2 * sphere() - 1;
        const y = 2 * sphere() - 1;
        const z = 2 * sphere() - 1;
        const length = Math.sqrt(x * x + y * y + z * z);
        if (length > 0.1 && length < 1) {
            spherePoints.push((0.8 * x) / length, 2 + (0.8 * y) / length, (0.8 * z) / length);
        }
    }
    const h = Math.sqrt(3) / 2;
    const hexagon = [
        [1, 0],
        [0.5, h],
        [-0.5, h],
        [-1, 0],
        [-0.5, -h],
        [0.5, -h],
    ];
    const prism: number[] = [];
    for (const [a, b] of hexagon) {
        // a hexagonal prism lying along x + z, 0.6 m across and 1.5 m long
        prism.push(0.3 * a + 0.75, 0.3 * b, 0.3 * a - 0.75, 0.3 * a - 0.75, 0.3 * b, 0.3 * a + 0.75);
    }
    const plate = BoxPoints([0, 0.5, 0], [0.5, 0.0025, 0.5]);
    for (const [x, z] of [
        [0, 0.5],
        [0.5, 0],
        [0, -0.5],
        [-0.5, 0],
    ]) {
        plate.push(x, 0.5025, z, x, 0.4975, z);
    }
    // a chunk of a car's body 6.9 m from the origin, one corner pushed in 5 cm the way a crush first dents it
    const dented = BoxPoints([2.2, 0.13, -6.5], [0.2, 0.15, 0.1]);
    dented[21] -= 0.05;
    dented[22] -= 0.05;
    dented[23] -= 0.05;
    return [
        { name: "cube", points: BoxPoints([0, 0, 0], [0.5, 0.5, 0.5]) },
        { name: "far box", points: BoxPoints([40, 3, -12], [1, 0.2, 0.6]) },
        { name: "tetrahedron", points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
        { name: "cloud", points: cloudPoints },
        { name: "dense sphere", points: spherePoints },
        { name: "hexagonal prism", points: prism },
        { name: "thin plate", points: plate },
        { name: "dented chunk", points: dented },
    ];
}

/** FNV-1a over the bits of the floats: the hull's points and its mass data. */
function Fingerprint(values: Float32Array): string {
    const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
    let hash = 0x811c9dc5;
    for (const word of bits) {
        for (let shift = 0; shift < 32; shift += 8) {
            hash = Math.imul(hash ^ ((word >>> shift) & 0xff), 0x01000193) >>> 0;
        }
    }
    return hash.toString(16).padStart(8, "0");
}

/**
 * The hull of the points as the shim builds it, read back as its points and its mass data at density 1000.
 * @param viaBody build it with bx_Body_SetShapeHull on a body that had a box, the way R3 reshapes a crushed chunk
 */
function HullOf(b3: any, points: number[], viaBody: boolean): { vertices: number; fingerprint: string } {
    const world = b3._bx_CreateWorld(0, -9.81, 0, 1);
    const pointer = b3._malloc(points.length * 4);
    b3.HEAPF32.set(points, pointer >> 2);
    const body = b3._bx_CreateBody(world, STATIC, 0, 0, 0, 0, 0, 0, 1, 1);
    let made: number;
    if (viaBody) {
        const box = b3._bx_ShapeDesc_CreateBox(0.2, 0.2, 0.2, 0, 0, 0, 0, 0, 0, 1);
        b3._bx_ShapeDesc_SetDensity(box, 1000);
        b3._bx_Body_SetShape(body, box);
        made = b3._bx_Body_SetShapeHull(body, 0, pointer, points.length / 3);
    } else {
        made = b3._bx_ShapeDesc_CreateHull(pointer, points.length / 3);
        if (made) {
            b3._bx_ShapeDesc_SetDensity(made, 1000);
            b3._bx_Body_SetShape(body, made);
        }
    }
    b3._free(pointer);
    expect(made).not.toBe(0);
    const floats = b3._bx_Body_GetShapeGeometry(body, 0);
    const geometry = b3.HEAPF32.slice(b3._bx_GeometryPtr() >> 2, (b3._bx_GeometryPtr() >> 2) + floats);
    b3._bx_Body_ComputeShapeMassData(body);
    const mass = b3.HEAPF32.slice(b3._bx_Scratch() >> 2, (b3._bx_Scratch() >> 2) + 10);
    b3._bx_DestroyWorld(world);
    const all = new Float32Array(floats + 10);
    all.set(geometry);
    all.set(mass, floats);
    return { vertices: floats / 3, fingerprint: Fingerprint(all) };
}

// Recorded from the 0.6.0 build, before the patch: vertex count and fingerprint of each ordinary hull.
const Before: Record<string, [number, string]> = {
    cube: [8, "49da656a"],
    "far box": [8, "c8b182b1"],
    tetrahedron: [4, "4e0bf744"],
    cloud: [23, "f21954e9"],
    "dense sphere": [40, "0081d04f"],
    "hexagonal prism": [12, "6beb33c2"],
    "thin plate": [8, "59d533f4"],
    "dented chunk": [8, "4998e55f"],
};

describe("ordinary hulls", () => {
    it("come out as they did before the patch, bit for bit", () => {
        const now: Record<string, [number, string]> = {};
        for (const set of OrdinarySets()) {
            const hull = HullOf(plain, set.points, false);
            now[set.name] = [hull.vertices, hull.fingerprint];
        }
        expect(now).toEqual(Before);
    });

    it("come out the same when a body's shape is replaced with them, as when they are made on their own", () => {
        for (const set of OrdinarySets()) {
            expect(HullOf(plain, set.points, true), set.name).toEqual(HullOf(plain, set.points, false));
        }
    });

    it("come out the same in the threaded build", () => {
        for (const set of OrdinarySets()) {
            expect(HullOf(threaded, set.points, false), set.name).toEqual(HullOf(plain, set.points, false));
        }
    });
});
