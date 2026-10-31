// Snapshots of a whole module (shim: bx_Memory_End, bx_Memory_Base, bx_Memory_Reserve; src/box3dSnapshot.ts), against
// the real wasm through the shim's raw exports. A module's state lies in its memory below the break, so a copy of it
// taken between steps and written back puts every world back as it was: the steps after a restore are the steps after
// the snapshot, bit for bit, whatever was made, destroyed or grown in between, and in a fresh instance of the same build
// as in the module it came from. With the worlds' clocks off, the memory after them is the same to the byte.

import { describe, expect, it } from "vitest";
import Box3D from "../lib/node/box3d.mjs";
import Box3DThreads from "../lib/node-threads/box3d.mjs";
import { BOX3D_SNAPSHOT_CHUNK, RestoreBox3D, SnapshotBox3D, type IBox3DSnapshot } from "../src/box3dSnapshot";

const STATIC = 0;
const DYNAMIC = 2;
const DT = 1 / 480;
const SUB_STEPS = 2;

interface IPile {
    world: number;
    bodies: number[];
}

/**
 * A floor and a pile falling onto it, tumbling into each other: bodies of several boxes each, as a car's chunks are,
 * thrown with spin, so a step has many contacts, warm starts and islands to get wrong.
 */
function pile(b3: any): IPile {
    const world = b3._bx_CreateWorld(0, -9.81, 0, 1);
    // the clock off, so the module's memory after a step is the step's alone (src/box3dSnapshot.ts)
    b3._bx_World_EnableTimer(world, 0);
    const floor = b3._bx_CreateBody(world, STATIC, 0, -0.5, 0, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(floor, b3._bx_ShapeDesc_CreateBox(20, 0.5, 20, 0, 0, 0, 0, 0, 0, 1));
    const bodies: number[] = [];
    for (let n = 0; n < 12; n++) {
        const container = b3._bx_ShapeDesc_CreateContainer();
        for (let i = 0; i < 3; i++) {
            const box = b3._bx_ShapeDesc_CreateBox(0.15, 0.1, 0.2, 0, 0, 0, 0, 0, 0, 1);
            b3._bx_ShapeDesc_SetDensity(box, 400 + 50 * i);
            b3._bx_ShapeDesc_AddChild(container, box, (i - 1) * 0.3, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        }
        const angle = 0.4 * n;
        const body = b3._bx_CreateBody(world, DYNAMIC, 0.3 * (n % 3), 0.6 + 0.5 * n, 0.2 * (n % 2), 0, Math.sin(angle), 0, Math.cos(angle), 1);
        b3._bx_Body_SetShape(body, container);
        b3._bx_Body_ApplyMassFromShapes(body);
        b3._bx_Body_EnableSleep(body, 0);
        b3._bx_Body_SetAngularVelocity(body, 3 - n * 0.5, 1 + 0.25 * n, -2);
        b3._bx_Body_SetLinearVelocity(body, n % 2 === 0 ? 1.5 : -1, 0, 0.5);
        bodies.push(body);
    }
    return { world, bodies };
}

/** Every body's position, rotation and velocities, as the bits the module gives them back in. */
function state(b3: any, bodies: readonly number[]): number[] {
    const bits: number[] = [];
    const f32 = b3._bx_Scratch() >> 2;
    const f64 = b3._bx_ScratchF64() >> 3;
    for (const body of bodies) {
        b3._bx_Body_GetTransform(body);
        bits.push(...new Uint32Array(b3.HEAPF32.slice(f32, f32 + 7).buffer), ...new Uint32Array(b3.HEAPF64.slice(f64, f64 + 3).buffer));
        b3._bx_Body_GetLinearVelocity(body);
        bits.push(...new Uint32Array(b3.HEAPF32.slice(f32, f32 + 3).buffer));
        b3._bx_Body_GetAngularVelocity(body);
        bits.push(...new Uint32Array(b3.HEAPF32.slice(f32, f32 + 3).buffer));
    }
    return bits;
}

/** Whether two snapshots hold the same memory, to the byte, however their pieces are shared. */
function sameMemory(a: IBox3DSnapshot, b: IBox3DSnapshot): boolean {
    return a.end === b.end && a.chunks.every((chunk, i) => Buffer.from(chunk).equals(Buffer.from(b.chunks[i])));
}

/** `steps` steps of the world, its bodies' state after each. */
function run(b3: any, { world, bodies }: IPile, steps: number): number[][] {
    const states: number[][] = [];
    for (let i = 0; i < steps; i++) {
        b3._bx_World_Step(world, DT, SUB_STEPS);
        states.push(state(b3, bodies));
    }
    return states;
}

/** Things made, stepped, destroyed and left in the module, and its memory grown: what a restore has to undo. */
function clutter(b3: any, { world }: IPile): void {
    const made: number[] = [];
    for (let n = 0; n < 3000; n++) {
        const body = b3._bx_CreateBody(world, DYNAMIC, 30 + (n % 50), 1 + Math.floor(n / 50), 0, 0, 0, 0, 1, 1);
        b3._bx_Body_SetShape(body, b3._bx_ShapeDesc_CreateBox(0.2, 0.2, 0.2, 0, 0, 0, 0, 0, 0, 1));
        b3._bx_Body_ApplyMassFromShapes(body);
        made.push(body);
    }
    run(b3, { world, bodies: [] }, 5);
    for (let n = 0; n < made.length; n += 2) {
        b3._bx_DestroyBody(made[n]);
    }
    b3._bx_World_EnableTimer(b3._bx_CreateWorld(0, -1, 0, 1), 0);
    // and a block kept, past the memory the module started with
    expect(b3._malloc(48 * 1024 * 1024)).not.toBe(0);
}

describe("a module's snapshot", () => {
    it("reads the break, past everything the module holds, and further as it holds more", async () => {
        const b3 = await Box3D();
        const before = b3._bx_Memory_End();
        expect(before).toBeGreaterThan(0);
        expect(before).toBeLessThanOrEqual(b3.HEAPU8.length);
        clutter(b3, pile(b3));
        expect(b3._bx_Memory_End()).toBeGreaterThan(before);
        expect(b3._bx_Memory_End()).toBeLessThanOrEqual(b3.HEAPU8.length);
    });

    it("puts every world back, to step as it stepped after the snapshot, bit for bit", async () => {
        const b3 = await Box3D();
        const scene = pile(b3);
        run(b3, scene, 120);
        const snapshot = SnapshotBox3D(b3);
        expect(snapshot.end).toBe(b3._bx_Memory_End());
        const first = run(b3, scene, 480);
        const after = SnapshotBox3D(b3);
        // the pile has moved on: the restore is not a run that happens to land in the same place
        expect(first[479]).not.toEqual(first[0]);
        RestoreBox3D(b3, snapshot);
        expect(run(b3, scene, 480)).toEqual(first);
        // and the module after them is the module after the first, to the byte: every world, not only the bodies read
        expect(sameMemory(SnapshotBox3D(b3), after)).toBe(true);
    });

    it("puts it back whatever was made, destroyed and grown since, the bodies made since gone", async () => {
        const b3 = await Box3D();
        const scene = pile(b3);
        run(b3, scene, 60);
        const snapshot = SnapshotBox3D(b3);
        const first = run(b3, scene, 240);
        const after = SnapshotBox3D(b3);
        RestoreBox3D(b3, snapshot);
        const memory = b3.HEAPU8.length;
        clutter(b3, scene);
        expect(b3.HEAPU8.length).toBeGreaterThan(memory);
        const grown = b3._bx_Memory_End();
        RestoreBox3D(b3, snapshot);
        expect(b3._bx_Memory_End()).toBe(snapshot.end);
        // the memory taken since, given back zeroed
        expect(b3.HEAPU8.subarray(snapshot.end, grown).every((byte: number) => byte === 0)).toBe(true);
        expect(run(b3, scene, 240)).toEqual(first);
        // the clutter's bodies and world are gone with the rest of what was made since
        expect(sameMemory(SnapshotBox3D(b3), after)).toBe(true);
    });

    it("goes back and forth between snapshots, each restored as often as asked", async () => {
        const b3 = await Box3D();
        const scene = pile(b3);
        const early = SnapshotBox3D(b3);
        const fromEarly = run(b3, scene, 200);
        const late = SnapshotBox3D(b3, early);
        const fromLate = run(b3, scene, 200);
        for (let n = 0; n < 2; n++) {
            RestoreBox3D(b3, early);
            expect(run(b3, scene, 200)).toEqual(fromEarly);
            RestoreBox3D(b3, late);
            expect(run(b3, scene, 200)).toEqual(fromLate);
        }
    });

    it("shares with the snapshot before it the pieces that did not change, and copies those that did", async () => {
        const b3 = await Box3D();
        const scene = pile(b3);
        run(b3, scene, 60);
        const before = SnapshotBox3D(b3);
        expect(before.chunks.length).toBe(Math.ceil(before.end / BOX3D_SNAPSHOT_CHUNK));
        const same = SnapshotBox3D(b3, before);
        expect(same.chunks.every((chunk, i) => chunk === before.chunks[i])).toBe(true);
        run(b3, scene, 60);
        const after = SnapshotBox3D(b3, before);
        const shared = after.chunks.filter((chunk, i) => chunk === before.chunks[i]).length;
        expect(shared).toBeGreaterThan(0);
        expect(shared).toBeLessThan(after.chunks.length);
        // a shared piece is the memory to the byte, and so is a copied one
        const heap = b3.HEAPU8;
        expect(after.chunks.every((chunk, i) => chunk.every((byte, j) => byte === heap[i * BOX3D_SNAPSHOT_CHUNK + j]))).toBe(true);
    });

    it("writes into a fresh instance of the same build, grown to hold it, which steps on as the module did", async () => {
        const b3 = await Box3D();
        const scene = pile(b3);
        run(b3, scene, 90);
        // a block kept, so the snapshot holds more than a fresh instance starts with
        expect(b3._malloc(40 * 1024 * 1024)).not.toBe(0);
        const snapshot = SnapshotBox3D(b3);
        const first = run(b3, scene, 240);
        const fresh = await Box3D();
        expect(fresh.HEAPU8.length).toBeLessThan(snapshot.end);
        RestoreBox3D(fresh, snapshot);
        expect(fresh.HEAPU8.length).toBeGreaterThanOrEqual(snapshot.end);
        // the same slots, in the instance it was never made in
        expect(run(fresh, scene, 240)).toEqual(first);
        expect(sameMemory(SnapshotBox3D(fresh), SnapshotBox3D(b3))).toBe(true);
    });

    it("refuses a snapshot of a build laid out otherwise, or of the other precision", async () => {
        const b3 = await Box3D();
        pile(b3);
        const snapshot = SnapshotBox3D(b3);
        expect(snapshot.base).toBe(b3._bx_Memory_Base() >>> 0);
        expect(snapshot.base).toBeGreaterThan(0);
        expect(() => RestoreBox3D(b3, { ...snapshot, base: snapshot.base + 16 })).toThrow(/build it was taken on/);
        expect(() => RestoreBox3D(b3, { ...snapshot, doublePrecision: !snapshot.doublePrecision })).toThrow(/build it was taken on/);
        RestoreBox3D(b3, snapshot);
    });

    it("refuses a threaded module, whose workers' stacks lie in the memory a restore writes", async () => {
        const threaded = await Box3DThreads();
        expect(() => SnapshotBox3D(threaded)).toThrow(/threaded/);
        const b3 = await Box3D();
        const snapshot = SnapshotBox3D(b3);
        expect(() => RestoreBox3D(threaded, snapshot)).toThrow(/threaded/);
    });
});
