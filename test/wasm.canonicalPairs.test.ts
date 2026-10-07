// Canonical pairs (patch 0005, shim bx_Body_SetFeatureKey): a moving shape's new contacts are made in the order of the
// other shapes' feature keys, not the order the static tree gives, so the same statics in reach give the same contacts
// in the same order however the world was built: kind by kind, in route order, in reverse, or streamed in ahead of the
// body and removed behind it. And a moved proxy's pairs are never dropped, however many it finds in one step.

import { describe, expect, it } from "vitest";
import Box3D from "../lib/node/box3d.mjs";

const STATIC = 0;
const DYNAMIC = 2;
const FRICTION = 0.6;

// A box-hull "car" pushed 10 s along a strip of 40 mesh pieces of 16 m, over 28 height-field tiles of 24 m whose seams
// interleave with the pieces', strewn with low box stones grouped in 32 m cells: R3's order probe.
const PIECE = 16;
const WIDTH = 8;
const PIECES = 40;
const CELL = 32;
const TILE = 24;
const TICKS = 4800;
const DT = 1 / 480;

const h = (x: number, z: number) => 0.05 * Math.sin(0.3 * x) + 0.03 * Math.cos(0.7 * z);

type Kind = "tile" | "piece" | "cell";
interface IItem {
    kind: Kind;
    key: number;
    from: number;
    to: number;
}

const STONES = (() => {
    const cells = new Map<number, { x: number; z: number }[]>();
    for (let s = 5; s < PIECE * PIECES; s += 3.5) {
        const z = ((s * 7.3) % 5) - 2.5;
        const cell = Math.floor(s / CELL);
        (cells.get(cell) ?? cells.set(cell, []).get(cell)!).push({ x: s, z });
    }
    return cells;
})();
const TILES = Math.ceil((PIECE * PIECES + 8) / TILE);
const KIND_ORDER: Record<Kind, number> = { tile: 0, piece: 1, cell: 2 };
const ITEMS: IItem[] = [
    ...Array.from({ length: TILES }, (_, k) => ({ kind: "tile" as const, key: k, from: k * TILE - 8, to: (k + 1) * TILE - 8 })),
    ...Array.from({ length: PIECES }, (_, k) => ({ kind: "piece" as const, key: k, from: k * PIECE, to: (k + 1) * PIECE })),
    ...[...STONES.keys()].map((c) => ({ kind: "cell" as const, key: c, from: c * CELL, to: (c + 1) * CELL })),
];
const ROUTE = [...ITEMS].sort((a, b) => a.from - b.from || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.key - b.key);

interface IConfig {
    order: IItem[];
    mode: "whole" | "stream";
    keys: boolean;
    ahead?: number;
    behind?: number;
    /** 30,000 capsules 5 km off, made after the strip */
    far?: boolean;
    /** each step's new items made in reverse */
    batchReverse?: boolean;
}

function floats(m: any, values: ArrayLike<number>): number {
    const p = m._malloc(values.length * 4);
    m.HEAPF32.set(values, p >> 2);
    return p;
}

function shaped(m: any, desc: number): number {
    m._bx_ShapeDesc_SetMaterial(desc, FRICTION, 0);
    return desc;
}

function makeItem(m: any, world: number, it: IItem, keys: boolean, invoke: number): number {
    let body: number;
    let desc: number;
    if (it.kind === "tile") {
        const countX = TILE + 1;
        const countZ = 13;
        const heights = new Float32Array(countX * countZ);
        for (let zi = 0; zi < countZ; zi++) {
            for (let xi = 0; xi < countX; xi++) {
                heights[zi * countX + xi] = h(it.from + xi, zi - 6) - 0.12;
            }
        }
        const p = floats(m, heights);
        desc = shaped(m, m._bx_ShapeDesc_CreateHeightField(p, 0, countX, countZ, 1, 1, 1, 0, 0, 0, 0));
        m._free(p);
        body = m._bx_CreateBody(world, STATIC, it.from, 0, -6, 0, 0, 0, 1, 1);
    } else if (it.kind === "piece") {
        const nx = PIECE + 1;
        const nz = WIDTH + 1;
        const positions = new Float32Array(nx * nz * 3);
        for (let i = 0; i < nx; i++) {
            for (let j = 0; j < nz; j++) {
                const o = (i * nz + j) * 3;
                positions[o] = i;
                positions[o + 1] = h(it.key * PIECE + i, j - WIDTH / 2);
                positions[o + 2] = j - WIDTH / 2;
            }
        }
        const indices: number[] = [];
        for (let i = 0; i < PIECE; i++) {
            for (let j = 0; j < WIDTH; j++) {
                const a = i * nz + j;
                indices.push(a, a + 1, a + nz, a + 1, a + nz + 1, a + nz);
            }
        }
        const vp = floats(m, positions);
        const ip = m._malloc(indices.length * 4);
        m.HEAP32.set(indices, ip >> 2);
        desc = shaped(m, m._bx_ShapeDesc_CreateMesh(vp, nx * nz, ip, indices.length / 3, 1, 1, 1, 0, 0));
        m._free(vp);
        m._free(ip);
        body = m._bx_CreateBody(world, STATIC, it.key * PIECE, 0, 0, 0, 0, 0, 1, 1);
    } else {
        const cornerX = it.key * CELL;
        desc = shaped(m, m._bx_ShapeDesc_CreateContainer());
        for (const { x, z } of STONES.get(it.key)!) {
            const stone = shaped(m, m._bx_ShapeDesc_CreateBox(0.25, 0.05, 0.25, x - cornerX, h(x, z) + 0.02, z, 0, 0.2, 0, Math.sqrt(1 - 0.04)));
            m._bx_ShapeDesc_AddChild(desc, stone, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        }
        body = m._bx_CreateBody(world, STATIC, cornerX, 0, 0, 0, 0, 0, 1, 1);
    }
    m._bx_ShapeDesc_SetInvokeContactCreation(desc, invoke);
    if (keys) {
        m._bx_Body_SetFeatureKey(body, 1 + KIND_ORDER[it.kind] * 1000 + it.key);
    }
    m._bx_Body_SetShape(body, desc);
    return body;
}

function farCapsules(m: any, world: number): void {
    for (let c = 0; c < 1500; c++) {
        const cell = m._bx_ShapeDesc_CreateContainer();
        for (let t = 0; t < 20; t++) {
            const x = (t * 7.1) % 32;
            const z = (t * 13.7) % 32;
            m._bx_ShapeDesc_AddChild(cell, shaped(m, m._bx_ShapeDesc_CreateCapsule(x, -0.5, z, x, 3, z, 0.15 + 0.01 * (t % 5))), 0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        }
        const body = m._bx_CreateBody(world, STATIC, (c % 100) * 32, 0, 5000 + Math.floor(c / 100) * 32, 0, 0, 0, 1, 1);
        m._bx_Body_SetFeatureKey(body, 100000 + c);
        m._bx_Body_SetShape(body, cell);
    }
}

function makeCar(m: any, world: number): number {
    const car = m._bx_ShapeDesc_CreateContainer();
    for (const x of [-1.2, -0.4, 0.4, 1.2]) {
        for (const z of [-0.5, 0.5]) {
            const box = shaped(m, m._bx_ShapeDesc_CreateBox(0.38, 0.25, 0.45, x, 0, z, 0, 0, 0, 1));
            m._bx_ShapeDesc_SetFilter(box, 0x2, ~0x2 >>> 0);
            m._bx_ShapeDesc_AddChild(car, box, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        }
    }
    const body = m._bx_CreateBody(world, DYNAMIC, 2, 0.4, 0, 0, 0, 0, 1, 1);
    m._bx_Body_SetShape(body, car);
    m._bx_Body_EnableContinuous(body, 0);
    m._bx_Body_SetMassData(body, 1200, 0, 0, 0, 500, 1500, 1200);
    m._bx_Body_SetLinearDamping(body, 0);
    m._bx_Body_SetAngularDamping(body, 0);
    return body;
}

/** The car's state each tick: position, rotation, linear and angular velocity, as Box3D's floats. */
async function drive(c: IConfig): Promise<Float32Array> {
    const m = await Box3D();
    const world = m._bx_CreateWorld(0, -9.81, 0, 1);
    m._bx_World_EnableSleeping(world, 0);
    const live = new Map<IItem, number>();
    const ahead = c.ahead ?? 60;
    const behind = c.behind ?? 40;
    const stream = (x: number) => {
        for (const it of c.batchReverse ? [...c.order].reverse() : c.order) {
            const want = it.from < x + ahead && it.to > x - behind;
            if (want && !live.has(it)) {
                live.set(it, makeItem(m, world, it, c.keys, 0));
            } else if (!want && live.has(it)) {
                m._bx_DestroyBody(live.get(it));
                live.delete(it);
            }
        }
    };
    if (c.mode === "whole") {
        for (const it of c.order) {
            live.set(it, makeItem(m, world, it, c.keys, 1));
        }
    } else {
        stream(2);
    }
    if (c.far) {
        farCapsules(m, world);
    }
    const car = makeCar(m, world);
    const scratch = m._bx_Scratch() >> 2;
    const out = new Float32Array(TICKS * 13);
    for (let tick = 0; tick < TICKS; tick++) {
        if (c.mode === "stream") {
            m._bx_Body_GetTransform(car);
            stream(m.HEAPF32[scratch]);
        }
        m._bx_Body_ApplyForceToCenter(car, 15000, 0, 2500 * Math.sin(tick / 300));
        m._bx_Body_ApplyTorque(car, 0, 300 * Math.sin(tick / 170), 0);
        m._bx_World_Step(world, DT, 2);
        const o = tick * 13;
        m._bx_Body_GetTransform(car);
        out.set(m.HEAPF32.subarray(scratch, scratch + 7), o);
        m._bx_Body_GetLinearVelocity(car);
        out.set(m.HEAPF32.subarray(scratch, scratch + 3), o + 7);
        m._bx_Body_GetAngularVelocity(car);
        out.set(m.HEAPF32.subarray(scratch, scratch + 3), o + 10);
    }
    m._bx_DestroyWorld(world);
    return out;
}

/** The first tick at which the two runs' states differ in any bit, or -1. */
function firstDifference(a: Float32Array, b: Float32Array): number {
    const ua = new Uint32Array(a.buffer);
    const ub = new Uint32Array(b.buffer);
    for (let i = 0; i < ua.length; i++) {
        if (ua[i] !== ub[i]) {
            return Math.floor(i / 13);
        }
    }
    return -1;
}

describe("canonical pairs", () => {
    it("drive the car the same, bit for bit, however the keyed statics were made", async () => {
        const route = await drive({ order: ROUTE, mode: "whole", keys: true });
        const runs: Record<string, IConfig> = {
            "kind by kind": { order: ITEMS, mode: "whole", keys: true },
            "in reverse, far capsules after": { order: [...ITEMS].reverse(), mode: "whole", keys: true, far: true },
            "streamed 60 m ahead, removed 40 m behind": { order: ROUTE, mode: "stream", keys: true },
            "streamed 20 m ahead, removed 8 m behind": { order: ROUTE, mode: "stream", keys: true, ahead: 20, behind: 8 },
            "streamed, each step's batch in reverse": { order: ROUTE, mode: "stream", keys: true, batchReverse: true },
        };
        const first: Record<string, number> = {};
        for (const [name, config] of Object.entries(runs)) {
            first[name] = firstDifference(await drive(config), route);
        }
        console.log(`final x ${route[(TICKS - 1) * 13].toFixed(3)} m; first tick unlike the route-order whole run: ${JSON.stringify(first)}`);
        for (const name of Object.keys(runs)) {
            expect(first[name], name).toBe(-1);
        }
        // the car went somewhere: along the strip, over pieces, tiles and stones
        expect(route[(TICKS - 1) * 13]).toBeGreaterThan(100);
    }, 120000);

    it("still follows the build order where the statics have no keys, since ties fall back to shape ids", async () => {
        const route = await drive({ order: ROUTE, mode: "whole", keys: false });
        const reverse = await drive({ order: [...ROUTE].reverse(), mode: "whole", keys: false });
        const first = firstDifference(reverse, route);
        console.log(`without keys, the reverse build first differs from route order at tick ${first}`);
        expect(first).toBeGreaterThan(-1);
    }, 60000);
});

describe("a moved proxy's pairs", () => {
    /** A box teleported into a cluster of 40 small static spheres, each its own body, made in the given order. */
    async function cluster(order: number[]) {
        const m = await Box3D();
        const world = m._bx_CreateWorld(0, 0, 0, 1);
        m._bx_World_EnableSleeping(world, 0);
        for (const i of order) {
            const body = m._bx_CreateBody(world, STATIC, (i % 4) * 0.4 - 0.6, Math.floor(i / 16) * 0.4 - 0.4, (Math.floor(i / 4) % 4) * 0.4 - 0.6, 0, 0, 0, 1, 1);
            const sphere = m._bx_ShapeDesc_CreateSphere(0, 0, 0, 0.1);
            m._bx_ShapeDesc_SetInvokeContactCreation(sphere, 0);
            m._bx_Body_SetFeatureKey(body, 1 + i);
            m._bx_Body_SetShape(body, sphere);
        }
        const box = m._bx_CreateBody(world, DYNAMIC, 50, 0, 0, 0, 0, 0, 1, 1);
        m._bx_Body_SetShape(box, m._bx_ShapeDesc_CreateBox(1, 1, 1, 0, 0, 0, 0, 0, 0, 1));
        m._bx_Body_ApplyMassFromShapes(box);
        m._bx_World_Step(world, DT, 2);
        m._bx_Body_SetTransform(box, 0, 0, 0, 0, 0, 0, 1);
        m._bx_World_Step(world, DT, 2);
        m._bx_World_GetStats(world);
        const contacts = m.HEAPF32[(m._bx_Scratch() >> 2) + 2];
        const count = m._bx_Body_GetContacts(box);
        const records = m._bx_BodyContactsPtr() >> 2;
        const keys: number[] = [];
        for (let i = 0; i < count; i++) {
            keys.push(m._bx_Body_GetFeatureKey(m.HEAPF32[records + i * 48 + 1]));
        }
        m._bx_DestroyWorld(world);
        return { contacts, keys };
    }

    it("are all made in the step they are found, in key order whatever order the statics were made in", async () => {
        const forward = Array.from({ length: 40 }, (_, i) => i);
        const shuffled = [...forward].sort((a, b) => ((a * 7919) % 40) - ((b * 7919) % 40) || a - b);
        const a = await cluster(forward);
        const b = await cluster([...forward].reverse());
        const c = await cluster(shuffled);
        expect(a.contacts).toBe(40);
        expect(b.contacts).toBe(40);
        expect(c.contacts).toBe(40);
        expect(a.keys.length).toBe(40);
        expect(b.keys).toEqual(a.keys);
        expect(c.keys).toEqual(a.keys);
    });
});
