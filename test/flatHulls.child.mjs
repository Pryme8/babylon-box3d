// Builds hulls from the flat point sets in fixtures/flat-hull-points.json through the shim's raw exports, in a
// process of its own: before wasm/patches/0004 every one of them sent Box3D's hull builder round a loop that never
// ended, and a test that calls into wasm cannot interrupt it. wasm.hulls.test.ts runs this under a watchdog, so a
// regression fails the suite instead of hanging it.
//
//   node test/flatHulls.child.mjs [node | node-threads]
//
// Prints one JSON line before each build, naming it, so a hang says where it hung, and one JSON line with every
// result at the end.

import { readFileSync } from "fs";

const DYNAMIC = 2;
const build = process.argv[2] ?? "node";
const { default: Box3D } = await import(`../lib/${build}/box3d.mjs`);
const b3 = await Box3D();
const sets = JSON.parse(readFileSync(new URL("./fixtures/flat-hull-points.json", import.meta.url), "utf8"));

const say = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const world = b3._bx_CreateWorld(0, -9.81, 0, 1);
const results = [];
for (const set of sets) {
    const count = set.points.length / 3;
    const pointer = b3._malloc(set.points.length * 4);
    b3.HEAPF32.set(set.points, pointer >> 2);

    say({ building: set.name, via: "bx_ShapeDesc_CreateHull" });
    let start = performance.now();
    const desc = b3._bx_ShapeDesc_CreateHull(pointer, count);
    const descMs = performance.now() - start;

    // The way R3's crush reshapes a chunk: a body's shape replaced by the hull of the points, in the body's frame.
    const body = b3._bx_CreateBody(world, DYNAMIC, 0, 0, 0, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, b3._bx_ShapeDesc_CreateBox(0.2, 0.2, 0.2, 0, 0, 0, 0, 0, 0, 1));
    say({ building: set.name, via: "bx_Body_SetShapeHull" });
    start = performance.now();
    const replaced = b3._bx_Body_SetShapeHull(body, 0, pointer, count);
    const bodyMs = performance.now() - start;
    // a refused hull leaves the shape as it was
    const kept = b3._bx_Body_GetShapeGeometry(body, 0) / 3;

    // and the world still steps with it
    b3._bx_World_Step(world, 1 / 60, 4);
    b3._free(pointer);
    results.push({ name: set.name, points: count, desc, descMs, replaced, bodyMs, keptVertices: kept });
}
b3._bx_DestroyWorld(world);
say({ results });
// the threaded build keeps its worker pool alive, which would keep this process up
process.exit(0);
