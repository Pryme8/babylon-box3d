// The double precision builds (lib/*-f64, BOX3D_DOUBLE_PRECISION). A car settling and coasting on a road 30 km from
// the origin moves as it does at the origin, within a micrometre, where the float build's 2 mm position spacing out
// there does not. Box3D's broad phase still keeps its bounds in float world space, rounded outward, so where the car
// meets a new shape out there the pair can be made on another step than at the origin, and from there the two runs
// part. Positions cross the shim in doubles in both builds, and a mesh or height field block built by the float build
// is the f64 build's to the byte.

import { beforeAll, describe, expect, it } from "vitest";
import FloatBox3D from "../lib/node/box3d.mjs";
import F64Box3D from "../lib/node-f64/box3d.mjs";

const STATIC = 0;
const DYNAMIC = 2;
const DT = 1 / 480;
const TICKS = 2400;
const FAR = 30000;

/** A road of 1 m quads from x = -10 m, 16 m wide, with a low swell, as R3's pieces are meshes: vertices and indices. */
function road(nx: number) {
    const nz = 17;
    const positions = new Float32Array(nx * nz * 3);
    for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
            const o = (i * nz + j) * 3;
            positions[o] = i - 10;
            positions[o + 1] = 0.04 * Math.sin(0.21 * i) * Math.cos(0.5 * j);
            positions[o + 2] = j - 8;
        }
    }
    const indices: number[] = [];
    for (let i = 0; i < nx - 1; i++) {
        for (let j = 0; j < nz - 1; j++) {
            const a = i * nz + j;
            indices.push(a, a + 1, a + nz, a + 1, a + nz + 1, a + nz);
        }
    }
    return { positions, indices: Int32Array.from(indices), vertexCount: nx * nz, triangleCount: indices.length / 3 };
}
// 40 m, ending where the terrain starts, and 60 m, which the car never leaves
const ROAD = road(41);
const LONG_ROAD = road(61);

/** A 48 m by 16 m height field at 1 m past the road's end, as R3's terrain tiles are, with a hole every 40th cell. */
function terrain() {
    const countX = 49;
    const countZ = 17;
    const heights = new Float32Array(countX * countZ);
    for (let z = 0; z < countZ; z++) {
        for (let x = 0; x < countX; x++) {
            heights[z * countX + x] = -0.03 + 0.03 * Math.sin(0.3 * x + 0.2 * z);
        }
    }
    const materials = new Uint8Array((countX - 1) * (countZ - 1));
    for (let i = 0; i < materials.length; i++) {
        materials[i] = i % 40 === 39 ? 255 : 0;
    }
    return { heights, materials, countX, countZ };
}
const TERRAIN = terrain();

function put(m: any, values: Float32Array | Int32Array | Uint8Array): number {
    const p = m._malloc(values.byteLength);
    m.HEAPU8.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), p);
    return p;
}

function roadDesc(m: any, geometry = ROAD): number {
    const vp = put(m, geometry.positions);
    const ip = put(m, geometry.indices);
    const desc = m._bx_ShapeDesc_CreateMesh(vp, geometry.vertexCount, ip, geometry.triangleCount, 1, 1, 1, 0, 0);
    m._free(vp);
    m._free(ip);
    return desc;
}

function terrainDesc(m: any): number {
    const hp = put(m, TERRAIN.heights);
    const mp = put(m, TERRAIN.materials);
    const desc = m._bx_ShapeDesc_CreateHeightField(hp, mp, TERRAIN.countX, TERRAIN.countZ, 1, 1, 1, 0, 0, 0, 0);
    m._free(hp);
    m._free(mp);
    return desc;
}

function bytesOf(m: any, desc: number): Uint8Array {
    const p = m._bx_ShapeDesc_GetGeometryBytes(desc);
    return m.HEAPU8.slice(p, p + m._bx_ShapeDesc_GetGeometryByteCount(desc));
}

function fromBytes(m: any, bytes: Uint8Array, kind: "mesh" | "heightField"): number {
    const p = put(m, bytes);
    const desc =
        kind === "mesh"
            ? m._bx_ShapeDesc_CreateMeshFromBytes(p, bytes.length, 1, 1, 1)
            : m._bx_ShapeDesc_CreateHeightFieldFromBytes(p, bytes.length, 0, 0, 0);
    m._free(p);
    return desc;
}

interface IRun {
    /** per tick: the car's position less the origin, from the doubles */
    positions: Float64Array;
    /** per tick: the car's rotation and velocities, as Box3D's floats */
    rest: Float32Array;
    /** every touching manifold each tick, points left out (they are world positions) */
    contacts: Float32Array[];
    touches: number;
}

/**
 * An eight-hull, 1,200 kg car dropped on the road at `originX`, left to settle for 1 s, pushed along the road for 1 s,
 * then left to coast for 3 s: off the road's end at 30 m onto the terrain, or along the long road alone. `ground` makes
 * the road's and the terrain's descriptions.
 */
function drive(m: any, originX: number, ground?: () => [number, number], longRoad = false): IRun {
    const world = m._bx_CreateWorld(0, -9.81, 0, 1);
    m._bx_World_EnableSleeping(world, 0);
    if (longRoad) {
        const roadShape = roadDesc(m, LONG_ROAD);
        m._bx_ShapeDesc_SetMaterial(roadShape, 0.6, 0);
        m._bx_Body_SetShape(m._bx_CreateBody(world, STATIC, originX, 0, 0, 0, 0, 0, 1, 1), roadShape);
    } else {
        const [roadShape, terrainShape] = ground ? ground() : [roadDesc(m), terrainDesc(m)];
        m._bx_ShapeDesc_SetMaterial(roadShape, 0.6, 0);
        m._bx_ShapeDesc_SetMaterial(terrainShape, 0.6, 0);
        m._bx_Body_SetShape(m._bx_CreateBody(world, STATIC, originX, 0, 0, 0, 0, 0, 1, 1), roadShape);
        m._bx_Body_SetShape(m._bx_CreateBody(world, STATIC, originX + 30, 0, -8, 0, 0, 0, 1, 1), terrainShape);
    }
    const car = m._bx_ShapeDesc_CreateContainer();
    for (const x of [-1.2, -0.4, 0.4, 1.2]) {
        for (const z of [-0.5, 0.5]) {
            const box = m._bx_ShapeDesc_CreateBox(0.38, 0.25, 0.45, x, 0, z, 0, 0, 0, 1);
            m._bx_ShapeDesc_SetMaterial(box, 0.05, 0);
            m._bx_ShapeDesc_AddChild(car, box, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
        }
    }
    const body = m._bx_CreateBody(world, DYNAMIC, originX + 2, 0.45, 0.4, 0, 0.0998, 0, 0.995, 1);
    m._bx_Body_SetShape(body, car);
    m._bx_Body_SetMassData(body, 1200, 0, 0, 0, 500, 1500, 1200);
    const scratch = m._bx_Scratch() >> 2;
    const scratchF64 = m._bx_ScratchF64() >> 3;
    const positions = new Float64Array(TICKS * 3);
    const rest = new Float32Array(TICKS * 10);
    const contacts: Float32Array[] = [];
    let touches = 0;
    for (let tick = 0; tick < TICKS; tick++) {
        if (tick >= 480 && tick < 960) {
            m._bx_Body_ApplyForceToCenter(body, 15000, 0, 600);
        }
        m._bx_World_Step(world, DT, 2);
        m._bx_Body_GetTransform(body);
        positions[tick * 3] = m.HEAPF64[scratchF64] - originX;
        positions[tick * 3 + 1] = m.HEAPF64[scratchF64 + 1];
        positions[tick * 3 + 2] = m.HEAPF64[scratchF64 + 2];
        rest.set(m.HEAPF32.subarray(scratch + 3, scratch + 7), tick * 10);
        m._bx_Body_GetLinearVelocity(body);
        rest.set(m.HEAPF32.subarray(scratch, scratch + 3), tick * 10 + 4);
        m._bx_Body_GetAngularVelocity(body);
        rest.set(m.HEAPF32.subarray(scratch, scratch + 3), tick * 10 + 7);
        const count = m._bx_Body_GetContacts(body);
        const at = m._bx_BodyContactsPtr() >> 2;
        const records = m.HEAPF32.slice(at, at + count * 48);
        for (let i = 0; i < count; i++) {
            // the other body's slot and description slot are the instance's own numbering, and the points world positions
            records[i * 48 + 1] = 0;
            records[i * 48 + 3] = 0;
            for (let p = 0; p < 4; p++) {
                records.fill(0, i * 48 + 12 + p * 9, i * 48 + 12 + p * 9 + 3);
            }
        }
        contacts.push(records);
        touches += count;
    }
    m._bx_DestroyWorld(world);
    return { positions, rest, contacts, touches };
}

function maxDifference(a: Float64Array, b: Float64Array): number {
    let most = 0;
    for (let i = 0; i < a.length; i++) {
        most = Math.max(most, Math.abs(a[i] - b[i]));
    }
    return most;
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
    const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
    const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
    return a.length === b.length && ua.every((v, i) => v === ub[i]);
}

describe("large worlds", () => {
    let float: any;
    let f64: any;

    beforeAll(async () => {
        [float, f64] = await Promise.all([FloatBox3D(), F64Box3D()]);
    });

    it("say which build they are", () => {
        expect(float._bx_IsDoublePrecision()).toBe(0);
        expect(f64._bx_IsDoublePrecision()).toBe(1);
    });

    it("drive a car settling and coasting on a road 30 km out as at the origin, within a micrometre, in the f64 build", () => {
        const near = drive(f64, 0, undefined, true);
        const far = drive(f64, FAR, undefined, true);
        const floatNear = drive(float, 0, undefined, true);
        const floatFar = drive(float, FAR, undefined, true);
        const gap = maxDifference(near.positions, far.positions);
        const floatGap = maxDifference(floatNear.positions, floatFar.positions);
        const last = (TICKS - 1) * 3;
        console.log(
            `on one road the car ran ${near.positions[last].toFixed(2)} m with ${near.touches} manifolds; 30 km out it is at ` +
                `most ${gap.toExponential(2)} m from its run at the origin in the f64 build, ${floatGap.toExponential(2)} m in the float build`
        );
        // it settled, was pushed and coasted along the road
        expect(near.positions[last]).toBeGreaterThan(30);
        expect(near.touches).toBeGreaterThan(TICKS);
        expect(gap).toBeLessThan(1e-6);
        // where the float build cannot: positions out there are 2 mm apart
        expect(floatGap).toBeGreaterThan(1e-3);
    });

    it("part from the origin's run only where the car meets a new shape, whose pair the float bounds can make on another step", () => {
        const near = drive(f64, 0);
        const far = drive(f64, FAR);
        // the step the car's state first differs in any bit, and where the car was then
        let first = -1;
        for (let tick = 0; tick < TICKS && first < 0; tick++) {
            for (let i = 0; i < 10; i++) {
                if (near.rest[tick * 10 + i] !== far.rest[tick * 10 + i]) {
                    first = tick;
                    break;
                }
            }
        }
        const gap = maxDifference(near.positions, far.positions);
        console.log(
            `onto the terrain at 30 m: the runs first differ at tick ${first}, with the car at x = ` +
                `${first < 0 ? "-" : near.positions[first * 3].toFixed(2)} m, and end at most ${gap.toExponential(2)} m apart`
        );
        // the same to the doubles' rounding until the car reaches the terrain, then apart by a few millimetres at most
        // (1.7 mm on Box3D 3362633, under 1 mm before it: how far depends on the step the pair is made in, not on the
        // doubles)
        expect(maxDifference(near.positions.subarray(0, 2000 * 3), far.positions.subarray(0, 2000 * 3))).toBeLessThan(1e-9);
        expect(gap).toBeLessThan(5e-3);
    });

    it("take and give positions in doubles", () => {
        const world = f64._bx_CreateWorld(0, 0, 0, 1);
        const body = f64._bx_CreateBody(world, DYNAMIC, 30000.123456789, 0.5, -29999.987654321, 0, 0, 0, 1, 1);
        f64._bx_Body_SetShape(body, f64._bx_ShapeDesc_CreateSphere(0, 0, 0, 0.5));
        f64._bx_Body_GetTransform(body);
        const at = f64._bx_ScratchF64() >> 3;
        expect(f64.HEAPF64[at]).toBe(30000.123456789);
        expect(f64.HEAPF64[at + 2]).toBe(-29999.987654321);
        f64._bx_Body_SetTransform(body, 30000.000001, 1, 0, 0, 0, 0, 1);
        f64._bx_Body_GetTransform(body);
        expect(f64.HEAPF64[f64._bx_ScratchF64() >> 3]).toBe(30000.000001);
        // a ray down from 1 µm past it hits it there, and gives the hit point in doubles too
        expect(f64._bx_World_CastRay(world, 30000.000002, 5, 0, 0, -10, 0, 0xffffffff, 0xffffffff, 0, 0, 1)).toBe(1);
        const hit = f64._bx_RayHitPointsF64Ptr() >> 3;
        expect(Math.abs(f64.HEAPF64[hit] - 30000.000002)).toBeLessThan(1e-9);
        f64._bx_DestroyWorld(world);

        // a ball resting on a slab there gives its contact point in doubles, where the float record's is 30,000 m: to the
        // rounding of the floats the contact is found in, relative to the shapes (half a micrometre on a 4 m slab)
        const fall = f64._bx_CreateWorld(0, -9.81, 0, 1);
        f64._bx_Body_SetShape(f64._bx_CreateBody(fall, STATIC, 30000, -0.5, 0, 0, 0, 0, 1, 1), f64._bx_ShapeDesc_CreateBox(4, 0.5, 4, 0, 0, 0, 0, 0, 0, 1));
        const ball = f64._bx_CreateBody(fall, DYNAMIC, 30000.000001, 0.5, 0, 0, 0, 0, 1, 1);
        f64._bx_Body_SetShape(ball, f64._bx_ShapeDesc_CreateSphere(0, 0, 0, 0.5));
        for (let i = 0; i < 60; i++) {
            f64._bx_World_Step(fall, DT, 2);
        }
        expect(f64._bx_Body_GetContacts(ball)).toBe(1);
        const point = f64._bx_BodyContactPointsF64Ptr() >> 3;
        expect(Math.abs(f64.HEAPF64[point] - 30000.000001)).toBeLessThan(1e-6);
        expect(f64.HEAPF32[(f64._bx_BodyContactsPtr() >> 2) + 12]).toBe(30000);
        f64._bx_DestroyWorld(fall);
    });

    it("build mesh and height field bytes the same in either build, so the float build's load in the f64 build", () => {
        const floatRoad = roadDesc(float);
        const floatTerrain = terrainDesc(float);
        const roadBytes = bytesOf(float, floatRoad);
        const terrainBytes = bytesOf(float, floatTerrain);
        const f64Road = roadDesc(f64);
        const f64Terrain = terrainDesc(f64);
        expect(bytesOf(f64, f64Road)).toEqual(roadBytes);
        expect(bytesOf(f64, f64Terrain)).toEqual(terrainBytes);
        f64._bx_ShapeDesc_Destroy(f64Road);
        f64._bx_ShapeDesc_Destroy(f64Terrain);
        // and a car meets the copies 30 km out as it meets the same geometry built there in place
        const copied = drive(f64, FAR, () => [fromBytes(f64, roadBytes, "mesh"), fromBytes(f64, terrainBytes, "heightField")]);
        const built = drive(f64, FAR);
        expect(maxDifference(copied.positions, built.positions)).toBe(0);
        expect(sameBits(copied.rest, built.rest)).toBe(true);
        for (let tick = 0; tick < TICKS; tick++) {
            if (!sameBits(copied.contacts[tick], built.contacts[tick])) {
                throw new Error(`contacts differ at tick ${tick}`);
            }
        }
        float._bx_ShapeDesc_Destroy(floatRoad);
        float._bx_ShapeDesc_Destroy(floatTerrain);
    });
});
