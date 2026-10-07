// Mesh and height field bytes (bx_ShapeDesc_GetGeometryBytes, bx_ShapeDesc_CreateMeshFromBytes and
// bx_ShapeDesc_CreateHeightFieldFromBytes): Box3D keeps either as one block addressed by offsets, so a module instance
// with no world can build it, and another instance copies the bytes in and makes the shape from them, unchanged.

import { beforeAll, describe, expect, it } from "vitest";
import Box3D from "../lib/node/box3d.mjs";

const STATIC = 0;
const DYNAMIC = 2;
const TICKS = 1920;

/** A 60 m road piece of 120 rings and 47 columns, about the size of one of R3's: vertices and indices. */
function pieceGeometry() {
    const rings = 120;
    const across = 47;
    const positions = new Float32Array(rings * across * 3);
    for (let i = 0; i < rings; i++) {
        for (let j = 0; j < across; j++) {
            const o = (i * across + j) * 3;
            positions[o] = i * 0.5;
            positions[o + 1] = 0.02 * Math.sin(i * 0.3 + j);
            positions[o + 2] = j * 0.35 - 8;
        }
    }
    const indices: number[] = [];
    for (let i = 0; i < rings - 1; i++) {
        for (let j = 0; j < across - 1; j++) {
            const a = i * across + j;
            indices.push(a, a + 1, a + across, a + 1, a + across + 1, a + across);
        }
    }
    return { positions, indices: Int32Array.from(indices), vertexCount: rings * across, triangleCount: indices.length / 3 };
}

/** A 64 m by 32 m height field at 1 m, a little below the piece's end, with every 50th cell a hole. */
function tileGeometry() {
    const countX = 65;
    const countZ = 33;
    const heights = new Float32Array(countX * countZ);
    for (let z = 0; z < countZ; z++) {
        for (let x = 0; x < countX; x++) {
            heights[z * countX + x] = -0.04 + 0.03 * Math.sin(0.4 * x) * Math.cos(0.3 * z);
        }
    }
    const materials = new Uint8Array((countX - 1) * (countZ - 1));
    for (let i = 0; i < materials.length; i++) {
        materials[i] = i % 50 === 49 ? 255 : i % 3;
    }
    return { heights, materials, countX, countZ };
}

const PIECE = pieceGeometry();
const TILE = tileGeometry();

function put(m: any, values: Float32Array | Int32Array | Uint8Array): number {
    const p = m._malloc(values.byteLength);
    m.HEAPU8.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), p);
    return p;
}

function buildMesh(m: any): number {
    const vp = put(m, PIECE.positions);
    const ip = put(m, PIECE.indices);
    const desc = m._bx_ShapeDesc_CreateMesh(vp, PIECE.vertexCount, ip, PIECE.triangleCount, 1, 1, 1, 0, 0);
    m._free(vp);
    m._free(ip);
    return desc;
}

function buildTile(m: any): number {
    const hp = put(m, TILE.heights);
    const mp = put(m, TILE.materials);
    const desc = m._bx_ShapeDesc_CreateHeightField(hp, mp, TILE.countX, TILE.countZ, 1, 1, 1, 0, 0, 0, 0);
    m._free(hp);
    m._free(mp);
    return desc;
}

/** A copy of a description's geometry block, out of the module's memory. */
function bytesOf(m: any, desc: number): Uint8Array {
    const p = m._bx_ShapeDesc_GetGeometryBytes(desc);
    const n = m._bx_ShapeDesc_GetGeometryByteCount(desc);
    return m.HEAPU8.slice(p, p + n);
}

function importMesh(m: any, bytes: Uint8Array): number {
    const p = put(m, bytes);
    const desc = m._bx_ShapeDesc_CreateMeshFromBytes(p, bytes.length, 1, 1, 1);
    m._free(p);
    return desc;
}

function importTile(m: any, bytes: Uint8Array): number {
    const p = put(m, bytes);
    const desc = m._bx_ShapeDesc_CreateHeightFieldFromBytes(p, bytes.length, 0, 0, 0);
    m._free(p);
    return desc;
}

/**
 * A car-like body of eight box hulls, 1,200 kg, dropped on the piece and pushed along it onto the tile. Returns its
 * state and every touching manifold it reports, each tick, as Box3D's floats.
 */
function drive(m: any, mesh: number, tile: number) {
    const world = m._bx_CreateWorld(0, -9.81, 0, 1);
    m._bx_World_EnableSleeping(world, 0);
    for (const desc of [mesh, tile]) {
        m._bx_ShapeDesc_SetMaterial(desc, 0.6, 0);
    }
    m._bx_Body_SetShape(m._bx_CreateBody(world, STATIC, 0, 0, 0, 0, 0, 0, 1, 1), mesh);
    m._bx_Body_SetShape(m._bx_CreateBody(world, STATIC, 59.5, 0, -16, 0, 0, 0, 1, 1), tile);
    const car = m._bx_ShapeDesc_CreateContainer();
    for (const x of [-1.2, -0.4, 0.4, 1.2]) {
        for (const z of [-0.5, 0.5]) {
            const box = m._bx_ShapeDesc_CreateBox(0.38, 0.25, 0.45, x, 0, z, 0, 0, 0, 1);
            m._bx_ShapeDesc_SetMaterial(box, 0.6, 0);
            m._bx_ShapeDesc_AddChild(car, box, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        }
    }
    const body = m._bx_CreateBody(world, DYNAMIC, 30, 0.6, 0.3, 0, 0.05, 0, Math.sqrt(1 - 0.0025), 1);
    m._bx_Body_SetShape(body, car);
    m._bx_Body_SetMassData(body, 1200, 0, 0, 0, 500, 1500, 1200);
    const scratch = m._bx_Scratch() >> 2;
    const states = new Float32Array(TICKS * 13);
    const contacts: Float32Array[] = [];
    let touches = 0;
    for (let tick = 0; tick < TICKS; tick++) {
        m._bx_Body_ApplyForceToCenter(body, 15000, 0, 1500 * Math.sin(tick / 200));
        m._bx_World_Step(world, 1 / 480, 2);
        m._bx_Body_GetTransform(body);
        states.set(m.HEAPF32.subarray(scratch, scratch + 7), tick * 13);
        m._bx_Body_GetLinearVelocity(body);
        states.set(m.HEAPF32.subarray(scratch, scratch + 3), tick * 13 + 7);
        m._bx_Body_GetAngularVelocity(body);
        states.set(m.HEAPF32.subarray(scratch, scratch + 3), tick * 13 + 10);
        const count = m._bx_Body_GetContacts(body);
        const at = m._bx_BodyContactsPtr() >> 2;
        // the other body's slot and its shape's description slot (record floats 1 and 3) are this instance's own
        // numbering; the rest is shape indices, geometry and impulses
        const records = m.HEAPF32.slice(at, at + count * 48);
        for (let i = 0; i < count; i++) {
            records[i * 48 + 1] = 0;
            records[i * 48 + 3] = 0;
        }
        contacts.push(records);
        touches += count;
    }
    m._bx_Body_GetTransform(body);
    const finalX = m.HEAPF32[scratch];
    m._bx_DestroyWorld(world);
    return { states, contacts, touches, finalX };
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
    const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
    return ua.every((v, i) => v === ub[i]);
}

describe("mesh and height field bytes", () => {
    let builder: any;
    let inPlace: any;
    let importer: any;

    beforeAll(async () => {
        // three instances: one that builds and has no world, one that builds in place, one that only copies bytes in
        [builder, inPlace, importer] = await Promise.all([Box3D(), Box3D(), Box3D()]);
    });

    it("are the same built in an instance with no world as in one with", () => {
        const meshA = buildMesh(builder);
        const tileA = buildTile(builder);
        const world = inPlace._bx_CreateWorld(0, -9.81, 0, 1);
        const meshB = buildMesh(inPlace);
        const tileB = buildTile(inPlace);
        expect(bytesOf(builder, meshA)).toEqual(bytesOf(inPlace, meshB));
        expect(bytesOf(builder, tileA)).toEqual(bytesOf(inPlace, tileB));
        expect(builder._bx_ShapeDesc_GetGeometryBytes(builder._bx_ShapeDesc_CreateSphere(0, 0, 0, 1))).toBe(0);
        inPlace._bx_DestroyWorld(world);
        for (const [m, d] of [[builder, meshA], [builder, tileA], [inPlace, meshB], [inPlace, tileB]]) {
            m._bx_ShapeDesc_Destroy(d);
        }
    });

    it("collide a car-like body to the bit as the geometry built in place does", () => {
        const meshA = buildMesh(builder);
        const tileA = buildTile(builder);
        const meshBytes = bytesOf(builder, meshA);
        const tileBytes = bytesOf(builder, tileA);
        const copied = drive(importer, importMesh(importer, meshBytes), importTile(importer, tileBytes));
        const built = drive(inPlace, buildMesh(inPlace), buildTile(inPlace));
        console.log(
            `piece ${(meshBytes.length / 1048576).toFixed(3)} MiB (${PIECE.triangleCount} triangles), tile ${(tileBytes.length / 1024).toFixed(1)} KiB; ` +
                `${built.touches} manifolds over ${TICKS} ticks, car at x = ${built.finalX.toFixed(2)} m`
        );
        // the car crossed the piece onto the tile, which starts at 59.5 m, touching all the way
        expect(built.finalX).toBeGreaterThan(62);
        expect(built.touches).toBeGreaterThan(TICKS);
        expect(sameBits(copied.states, built.states)).toBe(true);
        for (let tick = 0; tick < TICKS; tick++) {
            if (!sameBits(copied.contacts[tick], built.contacts[tick])) {
                throw new Error(`contacts differ at tick ${tick}`);
            }
        }
    });

    it("are refused when they are not a whole block of this build", () => {
        const mesh = buildMesh(builder);
        const bytes = bytesOf(builder, mesh);
        expect(importMesh(importer, bytes.subarray(0, bytes.length - 8))).toBe(0);
        const wrongVersion = bytes.slice();
        wrongVersion[0] ^= 1;
        expect(importMesh(importer, wrongVersion)).toBe(0);
        // a mesh's bytes are not a height field's
        expect(importTile(importer, bytes)).toBe(0);
        builder._bx_ShapeDesc_Destroy(mesh);
    });

    it("cost a copy to import", () => {
        const mesh = buildMesh(builder);
        const bytes = bytesOf(builder, mesh);
        const runs = 200;
        const p = importer._malloc(bytes.length);
        let copy = 0;
        let make = 0;
        for (let i = 0; i < runs + 20; i++) {
            const t0 = performance.now();
            importer.HEAPU8.set(bytes, p);
            const t1 = performance.now();
            const desc = importer._bx_ShapeDesc_CreateMeshFromBytes(p, bytes.length, 1, 1, 1);
            const t2 = performance.now();
            expect(desc).not.toBe(0);
            importer._bx_ShapeDesc_Destroy(desc);
            if (i >= 20) {
                copy += t1 - t0;
                make += t2 - t1;
            }
        }
        importer._free(p);
        console.log(
            `importing a ${(bytes.length / 1048576).toFixed(3)} MiB piece: ${(copy / runs).toFixed(3)} ms into the heap, ` +
                `${(make / runs).toFixed(3)} ms to make the description (Box3D's allocation and a copy)`
        );
        builder._bx_ShapeDesc_Destroy(mesh);
    });
});
