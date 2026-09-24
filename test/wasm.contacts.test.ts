// Contact readback (bx_Body_GetContacts) against the real wasm through the shim's raw exports: every touching manifold
// on a body as that body feels it, with the shapes on both sides, the triangle and material met, and the impulses.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LoadBox3D } from "./wasmScene";

const STATIC = 0;
const DYNAMIC = 2;
const HZ = 480;
const DT = 1 / HZ;
const SUB_STEPS = 2;
const H = DT / SUB_STEPS;
const G = 9.81;
const STRIDE = 48;
const POINT = 9;

type Vec3 = [number, number, number];

interface IContactPoint {
    point: Vec3;
    separation: number;
    normalImpulse: number;
    totalNormalImpulse: number;
    normalVelocity: number;
    triangle: number;
    material: number;
}

interface IContact {
    shape: number;
    otherBody: number;
    otherShape: number;
    otherDesc: number;
    normal: Vec3;
    friction: Vec3;
    twist: number;
    points: IContactPoint[];
}

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

function createWorld(gravityY: number): number {
    const world = b3._bx_CreateWorld(0, gravityY, 0, 1);
    worlds.push(world);
    return world;
}

function createBox(world: number, type: number, center: Vec3, half: Vec3, mass: number, friction = 0.8): number {
    const body = b3._bx_CreateBody(world, type, center[0], center[1], center[2], 0, 0, 0, 1, 1);
    const desc = b3._bx_ShapeDesc_CreateBox(half[0], half[1], half[2], 0, 0, 0, 0, 0, 0, 1);
    b3._bx_ShapeDesc_SetDensity(desc, mass / (8 * half[0] * half[1] * half[2]));
    b3._bx_ShapeDesc_SetMaterial(desc, friction, 0);
    b3._bx_Body_SetShape(body, desc);
    if (type === DYNAMIC) {
        b3._bx_Body_ApplyMassFromShapes(body);
    }
    b3._bx_Body_EnableSleep(body, 0);
    return body;
}

/**
 * A static height field `cells` metres square, a sample a metre, centred on the origin, with height(x, z) and the
 * material index material(column, row) for each cell. Returns the body and its description slot.
 */
function createGround(
    world: number,
    cells: number,
    height: (x: number, z: number) => number,
    material: (column: number, row: number) => number,
): { body: number; desc: number } {
    const samples = cells + 1;
    const heights = b3._malloc(samples * samples * 4);
    const materials = b3._malloc(cells * cells);
    for (let z = 0; z < samples; z++) {
        for (let x = 0; x < samples; x++) {
            b3.HEAPF32[(heights >> 2) + z * samples + x] = height(x - cells / 2, z - cells / 2);
        }
    }
    for (let row = 0; row < cells; row++) {
        for (let column = 0; column < cells; column++) {
            b3.HEAPU8[materials + row * cells + column] = material(column, row);
        }
    }
    const desc = b3._bx_ShapeDesc_CreateHeightField(heights, materials, samples, samples, 1, 1, 1, 0, -cells / 2, 0, -cells / 2);
    b3._free(heights);
    b3._free(materials);
    b3._bx_ShapeDesc_SetMaterial(desc, 0.8, 0);
    const body = b3._bx_CreateBody(world, STATIC, 0, 0, 0, 0, 0, 0, 1, 1);
    b3._bx_Body_SetShape(body, desc);
    return { body, desc };
}

function step(world: number, count: number): void {
    for (let i = 0; i < count; i++) {
        b3._bx_World_Step(world, DT, SUB_STEPS);
    }
}

function contacts(body: number): IContact[] {
    const count = b3._bx_Body_GetContacts(body);
    const base = b3._bx_BodyContactsPtr() >> 2;
    const f = b3.HEAPF32;
    const out: IContact[] = [];
    for (let i = 0; i < count; i++) {
        const r = base + i * STRIDE;
        const points: IContactPoint[] = [];
        for (let p = 0; p < f[r + 11]; p++) {
            const q = r + 12 + p * POINT;
            points.push({
                point: [f[q], f[q + 1], f[q + 2]],
                separation: f[q + 3],
                normalImpulse: f[q + 4],
                totalNormalImpulse: f[q + 5],
                normalVelocity: f[q + 6],
                triangle: f[q + 7],
                material: f[q + 8],
            });
        }
        out.push({
            shape: f[r],
            otherBody: f[r + 1],
            otherShape: f[r + 2],
            otherDesc: f[r + 3],
            normal: [f[r + 4], f[r + 5], f[r + 6]],
            friction: [f[r + 7], f[r + 8], f[r + 9]],
            twist: f[r + 10],
            points,
        });
    }
    return out;
}

/** The force the contacts put on the body in the last substep: normal impulses along their normals, plus friction. */
function contactForce(list: IContact[]): Vec3 {
    const sum: Vec3 = [0, 0, 0];
    for (const c of list) {
        const normal = c.points.reduce((s, p) => s + p.normalImpulse, 0);
        for (let k = 0; k < 3; k++) {
            sum[k] += (normal * c.normal[k] + c.friction[k]) / H;
        }
    }
    return sum;
}

describe("contact readback", () => {
    it("carries a 1 t box's weight on a height field, Σ impulse / h = m·g ± 0.5%, on the triangles under it", () => {
        const world = createWorld(-G);
        const ground = createGround(world, 8, () => 0, (column, row) => column + 10 * row);
        // Centred on cell (5, 5), which spans x 1..2 and z 1..2, and smaller than it.
        const box = createBox(world, DYNAMIC, [1.5, 0.3, 1.5], [0.3, 0.3, 0.3], 1000);
        step(world, HZ);
        const list = contacts(box);
        expect(list.length).toBeGreaterThan(0);
        const force = contactForce(list);
        expect(Math.abs(force[1] / (1000 * G) - 1)).toBeLessThan(0.005);
        expect(Math.abs(force[0])).toBeLessThan(0.005 * 1000 * G);
        expect(Math.abs(force[2])).toBeLessThan(0.005 * 1000 * G);
        for (const c of list) {
            expect(c.shape).toBe(0);
            expect(c.otherBody).toBe(ground.body);
            expect(c.otherShape).toBe(0);
            expect(c.otherDesc).toBe(ground.desc);
            expect(c.normal[1]).toBeCloseTo(1, 5);
            for (const p of c.points) {
                // cell (5, 5): triangles 2·cell and 2·cell + 1, and the material given to that cell
                expect(Math.floor(p.triangle / 2)).toBe(5 * 8 + 5);
                expect(p.material).toBe(55);
                expect(p.point[0]).toBeGreaterThan(1.1);
                expect(p.point[0]).toBeLessThan(1.9);
                expect(p.point[1]).toBeCloseTo(0.005, 2);
            }
        }
    });

    it("reports friction on the body's side: a box held on a slope feels a force equal and opposite to its weight", () => {
        const world = createWorld(-G);
        // rising 0.3 m a metre along x
        createGround(world, 8, (x) => 0.3 * x, () => 0);
        const angle = Math.atan(0.3);
        const q: [number, number, number, number] = [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
        const box = b3._bx_CreateBody(world, DYNAMIC, 1.5, 0.3 * 1.5 + 0.31, 1.5, q[0], q[1], q[2], q[3], 1);
        const desc = b3._bx_ShapeDesc_CreateBox(0.3, 0.3, 0.3, 0, 0, 0, 0, 0, 0, 1);
        b3._bx_ShapeDesc_SetDensity(desc, 1000 / 0.216);
        b3._bx_ShapeDesc_SetMaterial(desc, 0.8, 0);
        b3._bx_Body_SetShape(box, desc);
        b3._bx_Body_ApplyMassFromShapes(box);
        b3._bx_Body_EnableSleep(box, 0);
        step(world, HZ);
        const force = contactForce(contacts(box));
        expect(Math.abs(force[1] / (1000 * G) - 1)).toBeLessThan(0.005);
        expect(force[0] / (1000 * G)).toBeCloseTo(0, 2);
        // friction holds it up the slope, which rises toward +x: m·g·sin θ along the slope
        const list = contacts(box);
        const friction: Vec3 = [0, 0, 0];
        for (const c of list) {
            for (let k = 0; k < 3; k++) {
                friction[k] += c.friction[k] / H;
            }
        }
        expect(friction[0]).toBeGreaterThan(0);
        expect(Math.hypot(...friction) / (1000 * G * Math.sin(angle))).toBeCloseTo(1, 2);
    });

    it("names the shape on each side between two bodies, with the normal pushing each away from the other", () => {
        const world = createWorld(-G);
        const floor = createBox(world, STATIC, [0, -0.5, 0], [5, 0.5, 5], 1);
        const lower = createBox(world, DYNAMIC, [0, 0.5, 0], [0.5, 0.5, 0.5], 100);
        const upper = createBox(world, DYNAMIC, [0, 1.25, 0], [0.25, 0.25, 0.25], 50);
        step(world, HZ);
        const onLower = contacts(lower);
        const fromUpper = onLower.find((c) => c.otherBody === upper)!;
        const fromFloor = onLower.find((c) => c.otherBody === floor)!;
        expect(fromUpper.normal[1]).toBeCloseTo(-1, 5);
        expect(fromFloor.normal[1]).toBeCloseTo(1, 5);
        expect(fromUpper.points.every((p) => p.triangle === -1 && p.material === 0)).toBe(true);
        const onUpper = contacts(upper);
        expect(onUpper.length).toBe(1);
        expect(onUpper[0].otherBody).toBe(lower);
        expect(onUpper[0].normal[1]).toBeCloseTo(1, 5);
        expect(contactForce(onUpper)[1] / (50 * G)).toBeCloseTo(1, 2);
        expect(contactForce(onLower)[1] / (100 * G)).toBeCloseTo(1, 2);
    });

    it("reads nothing for a body touching nothing, or an invalid slot", () => {
        const world = createWorld(0);
        const box = createBox(world, DYNAMIC, [0, 10, 0], [0.5, 0.5, 0.5], 10);
        step(world, 2);
        expect(b3._bx_Body_GetContacts(box)).toBe(0);
        expect(b3._bx_Body_GetContacts(0)).toBe(0);
    });
});
