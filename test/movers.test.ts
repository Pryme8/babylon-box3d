// Box3D's character movers against the real wasm: the mover and pogo joints and the mover queries through the shim's
// raw exports, then Box3DDynamicMover and Box3DGeometricMover (src/box3dMovers.ts, ports of Box3D's two samples) on a
// Babylon scene. Both stand y up on a pogo, a spring along a ray to the ground, at its rest length of 0.9 below the
// capsule's lower sphere center, so the capsule (half height 0.5, radius 0.3) stands with its center 1.4 above the
// ground and its bottom 0.6 above it.

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Box3DDynamicMover, Box3DGeometricMover } from "../src/box3dMovers";
import { CreateBoxBody, CreateWasmScene, type IWasmScene, LoadBox3D } from "./wasmScene";

const STATIC = 0;
const DYNAMIC = 2;
const MOVER_JOINT = 8;
const POGO_JOINT = 9;
const IDENTITY_FRAMES = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
const STAND_HEIGHT = 1.4;

describe("the mover and pogo joints (raw)", () => {
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

    function createBox(world: number, type: number, y: number, half: number): number {
        const body = b3._bx_CreateBody(world, type, 0, y, 0, 0, 0, 0, 1, 1);
        const desc = b3._bx_ShapeDesc_CreateBox(half, half, half, 0, 0, 0, 0, 0, 0, 1);
        b3._bx_ShapeDesc_SetDensity(desc, 1000);
        b3._bx_Body_SetShape(body, desc);
        if (type === DYNAMIC) {
            b3._bx_Body_ApplyMassFromShapes(body);
        }
        return body;
    }

    function scratch(): Float32Array {
        return new Float32Array(b3.HEAPF32.buffer, b3._bx_Scratch(), 64);
    }

    function step(world: number, count: number): void {
        for (let i = 0; i < count; i++) {
            b3._bx_World_Step(world, 1 / 60, 4);
        }
    }

    function velocity(body: number): number[] {
        b3._bx_Body_GetLinearVelocity(body);
        return Array.from(scratch().subarray(0, 3));
    }

    it("drives a body to the mover joint's velocity in the joint's xz plane only, within its force", () => {
        const world = createWorld(0);
        const base = b3._bx_CreateBody(world, STATIC, 0, 0, 0, 0, 0, 0, 1, 1);
        const box = createBox(world, DYNAMIC, 0, 0.5);
        const s = scratch();
        s.set(IDENTITY_FRAMES, 0);
        s.set([2, 1, -1], 14);
        const joint = b3._bx_CreateJoint(world, MOVER_JOINT, base, box, 0, 1e6);
        expect(joint).toBeGreaterThan(0);
        step(world, 30);
        const [vx, vy, vz] = velocity(box);
        expect(vx).toBeCloseTo(2, 3);
        expect(vz).toBeCloseTo(-1, 3);
        // the mover joint leaves the vertical to the pogo
        expect(vy).toBeCloseTo(0, 6);

        // 1 N on a 1000 kg box changes its speed by 1 mm/s in a second
        b3._bx_MoverJoint_SetMaxForce(joint, 1);
        b3._bx_MoverJoint_SetLinearVelocity(joint, 0, 0, 0);
        step(world, 60);
        const [slowedX] = velocity(box);
        expect(slowedX).toBeGreaterThan(2 - 0.0015);
        expect(slowedX).toBeLessThan(2 - 0.0005);
    });

    it("holds a body at the pogo joint's rest length above the ground point, and follows a new rest length", () => {
        const world = createWorld(-10);
        const ground = b3._bx_CreateBody(world, STATIC, 0, 0, 0, 0, 0, 0, 1, 1);
        const box = createBox(world, DYNAMIC, 2, 0.25);
        b3._bx_Body_GetMassData(box);
        const mass = scratch()[0];
        const s = scratch();
        s.set(IDENTITY_FRAMES, 0);
        // normal, hertz, damping ratio, rest length, max tension, max compression, impulse, velocity
        s.set([0, 1, 0, 5, 1, 1, 1e9, 1e9, 0, 0], 14);
        const pogo = b3._bx_CreateJoint(world, POGO_JOINT, ground, box, 1, 0);
        expect(pogo).toBeGreaterThan(0);
        step(world, 180);
        // the spring only sets the velocity the joint drives to, and the joint is rigid within its force limits, so it
        // carries the weight at the rest length itself rather than sagging below it as a soft constraint would
        b3._bx_PogoJoint_GetState(pogo);
        const [length, speed, impulse] = Array.from(scratch().subarray(0, 3));
        expect(length).toBeCloseTo(1, 3);
        expect(Math.abs(speed)).toBeLessThan(1e-3);
        // its impulse per substep is the weight's, m g h, with 4 substeps of the 1/60 s step
        expect(impulse).toBeCloseTo((mass * 10) / 240, 2);

        b3._bx_PogoJoint_Set(pogo, 0, 1, 0, 5, 1, 1.5, 1e9, 1e9);
        step(world, 180);
        b3._bx_PogoJoint_GetState(pogo);
        expect(scratch()[0]).toBeCloseTo(1.5, 3);

        // a pogo that may not pull lets the body go up freely, as a jump needs
        b3._bx_PogoJoint_Set(pogo, 0, 1, 0, 5, 1, 1.5, 0, 1e9);
        b3._bx_Body_ApplyLinearImpulseToCenter(box, 0, mass * 5, 0);
        step(world, 10);
        b3._bx_PogoJoint_GetState(pogo);
        expect(scratch()[0]).toBeGreaterThan(1.5 + 0.4);
    });

    it("finds the planes around a capsule, solves a move against them, casts it, and clips a velocity", () => {
        const world = createWorld(-10);
        // a wall whose face is at x = 1.5
        const wall = b3._bx_CreateBody(world, STATIC, 2, 1, 0, 0, 0, 0, 1, 1);
        const desc = b3._bx_ShapeDesc_CreateBox(0.5, 2, 2, 0, 0, 0, 0, 0, 0, 1);
        b3._bx_Body_SetShape(wall, desc);
        const all = 0xffffffff;
        const radius = 0.3;

        // the capsule's surface reaches x = 1.6, 10 cm into the wall
        const count = b3._bx_World_CollideMover(world, 1.3, 1, 0, 0, -0.5, 0, 0, 0.5, 0, radius, all, all, 0, b3._bx_GetMoverPlaneCapacity());
        expect(count).toBeGreaterThan(0);
        const planes = b3._bx_MoverPlanesPtr() >> 2;
        const f32 = b3.HEAPF32;
        // [nx, ny, nz, offset, pushLimit, push, clipVelocity, px, py, pz, bodySlot, shapeIndex]
        expect(f32[planes]).toBeCloseTo(-1, 4);
        expect(f32[planes + 10]).toBe(wall);
        // the closest point is on the wall's face, relative to the origin queried from
        expect(1.3 + f32[planes + 7]).toBeCloseTo(1.5, 3);

        // asked to move on into the wall and along it, the solver pushes the capsule out and keeps the slide
        b3._bx_SolveMoverPlanes(1, 0, 0.5, count);
        const s = new Float32Array(b3.HEAPF32.buffer, b3._bx_Scratch(), 3);
        expect(1.3 + s[0] + radius).toBeLessThan(1.5 + 0.01);
        expect(s[2]).toBeCloseTo(0.5, 3);
        expect(f32[planes + 5]).toBeGreaterThan(0);

        // a velocity into the wall loses that part against the plane that pushed
        b3._bx_ClipMoverVector(2, 0, 1, count);
        expect(s[0]).toBeCloseTo(0, 4);
        expect(s[2]).toBeCloseTo(1, 4);

        // from x = 0 the capsule touches the face after 1.2 of a 3 m move
        const fraction = b3._bx_World_CastMover(world, 0, 1, 0, 0, -0.5, 0, 0, 0.5, 0, radius, 3, 0, 0, all, all, 0);
        expect(fraction * 3).toBeGreaterThan(1.15);
        expect(fraction * 3).toBeLessThan(1.21);
        // the body to ignore, such as the mover's own, is passed through
        expect(b3._bx_World_CastMover(world, 0, 1, 0, 0, -0.5, 0, 0, 0.5, 0, radius, 3, 0, 0, all, all, wall)).toBe(1);
    });
});

describe("Box3DDynamicMover", () => {
    let world: IWasmScene | undefined;
    let mover: Box3DDynamicMover | undefined;
    const input = { forward: 0, right: 0 };
    const forward = new Vector3(1, 0, 0);
    const right = new Vector3(0, 0, -1);

    afterEach(() => {
        mover?.dispose();
        mover = undefined;
        world?.dispose();
        world = undefined;
        input.forward = 0;
        input.right = 0;
    });

    async function standOnGround(): Promise<{ world: IWasmScene; mover: Box3DDynamicMover }> {
        world = await CreateWasmScene();
        CreateBoxBody(world.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(60, 1, 60), PhysicsMotionType.STATIC);
        mover = new Box3DDynamicMover(world.plugin, world.scene, { position: new Vector3(0, STAND_HEIGHT, 0) });
        const m = mover;
        world.plugin.onBeforeWorldStepObservable.add((dt) => m.update(dt, forward, right, input.forward, input.right));
        world.step(60);
        return { world, mover };
    }

    it("stands on its pogo above flat ground, upright and awake", async () => {
        const { world, mover } = await standOnGround();
        world.step(60);
        expect(mover.onGround).toBe(true);
        expect(mover.walkable).toBe(true);
        expect(mover.jumping).toBe(false);
        // the pogo joint holds its rest length under the mover's weight, see the raw pogo test
        const y = mover.transformNode.position.y;
        expect(y).toBeCloseTo(STAND_HEIGHT, 2);
        expect(mover.pogoLength).toBeCloseTo(y - 0.5, 3);
        expect(mover.body.getLinearVelocity().length()).toBeLessThan(0.01);
        expect(mover.transformNode.rotationQuaternion!.w).toBe(1);
        // the capsule's mass comes from its density, 200 kg/m^3
        const volume = Math.PI * 0.3 * 0.3 * 1 + (4 / 3) * Math.PI * 0.3 ** 3;
        expect(mover.body.getMassProperties().mass).toBeCloseTo(200 * volume, 1);
    });

    it("walks at its top speed, steers the way it is told, and stops when let go", async () => {
        const { world, mover } = await standOnGround();
        input.forward = 1;
        world.step(60);
        const v = mover.body.getLinearVelocity();
        expect(v.x).toBeGreaterThan(5.9);
        expect(v.x).toBeLessThan(6.01);
        expect(Math.abs(v.z)).toBeLessThan(1e-3);
        expect(mover.transformNode.position.x).toBeGreaterThan(5);
        expect(mover.onGround).toBe(true);

        input.forward = 0;
        input.right = 1;
        world.step(30);
        const turned = mover.body.getLinearVelocity();
        // right is -z here. Friction takes the old direction's speed at 8/s, 13% a step: 6 * 0.87^30 = 0.08 m/s is left
        expect(turned.z).toBeLessThan(-5.9);
        expect(Math.abs(turned.x)).toBeLessThan(0.15);

        input.right = 0;
        world.step(30);
        expect(mover.body.getLinearVelocity().length()).toBeLessThan(0.01);
    });

    it("jumps once from the ground, comes down and stands again", async () => {
        const { world, mover } = await standOnGround();
        const start = mover.transformNode.position.y;
        expect(mover.jump()).toBe(true);
        expect(mover.jump()).toBe(false);
        let top = start;
        world.step(90, () => (top = Math.max(top, mover.transformNode.position.y)));
        // 7 m/s against 1.5 g rises 7^2 / (2 * 14.7) = 1.67 m
        expect(top - start).toBeGreaterThan(1.5);
        expect(top - start).toBeLessThan(1.75);
        world.step(90);
        expect(mover.jumping).toBe(false);
        expect(mover.onGround).toBe(true);
        expect(mover.transformNode.position.y).toBeCloseTo(start, 1);
    });

    it("walks up a step lower than the capsule's bottom without touching it", async () => {
        const { world, mover } = await standOnGround();
        CreateBoxBody(world.scene, "step", new Vector3(6, 0.15, 0), new Vector3(8, 0.3, 8), PhysicsMotionType.STATIC);
        input.forward = 1;
        world.step(60);
        input.forward = 0;
        world.step(60);
        expect(mover.transformNode.position.x).toBeGreaterThan(3);
        expect(mover.transformNode.position.x).toBeLessThan(9);
        expect(mover.ground.body?.transformNode.name).toBe("step");
        expect(mover.transformNode.position.y).toBeCloseTo(0.3 + STAND_HEIGHT, 1);
    });

    it("rides an animated platform, which carries the mover joint with it", async () => {
        world = await CreateWasmScene();
        const platform = CreateBoxBody(world.scene, "platform", new Vector3(0, -0.25, 0), new Vector3(4, 0.5, 4), PhysicsMotionType.ANIMATED);
        mover = new Box3DDynamicMover(world.plugin, world.scene, { position: new Vector3(0, STAND_HEIGHT, 0) });
        const m = mover;
        world.plugin.onBeforeWorldStepObservable.add((dt) => m.update(dt, forward, right, 0, 0));
        world.step(30);
        platform.body.setLinearVelocity(new Vector3(0, 0, 1.5));
        world.step(120);
        expect(mover.ground.body).toBe(platform.body);
        // two seconds at 1.5 m/s, with the mover still standing at the platform's center
        expect(platform.node.position.z).toBeCloseTo(3, 1);
        expect(mover.transformNode.position.z).toBeCloseTo(platform.node.position.z, 1);
        expect(mover.onGround).toBe(true);
    });

    it("lets go of the ground for a launch, and frees everything it made when disposed", async () => {
        const { world, mover: m } = await standOnGround();
        m.launch();
        m.body.applyImpulse(new Vector3(0, m.body.getMassProperties().mass! * 8, 0), m.transformNode.position);
        world.step(20);
        expect(m.transformNode.position.y).toBeGreaterThan(STAND_HEIGHT + 1);
        expect(m.onGround).toBe(false);

        // [bodyCount, shapeCount, contactCount, jointCount, ...]
        const counts = (): number[] => {
            world.b3._bx_World_GetStats((world.plugin as any)._worldSlot);
            return Array.from(new Float32Array(world.b3.HEAPF32.buffer, world.b3._bx_Scratch(), 4));
        };
        world.step(60);
        const before = counts();
        // the capsule, and the shapeless static the mover joint holds to off a platform; the mover joint and the pogo
        expect(before[3]).toBe(2);

        const node = m.transformNode;
        m.dispose();
        mover = undefined;
        expect(node.isDisposed()).toBe(true);
        const after = counts();
        expect(after[0]).toBe(before[0] - 2);
        expect(after[1]).toBe(before[1] - 1);
        expect(after[3]).toBe(0);
        world.step(10);
    });
});

describe("Box3DGeometricMover", () => {
    let world: IWasmScene | undefined;
    afterEach(() => {
        world?.dispose();
        world = undefined;
    });

    const forward = new Vector3(1, 0, 0);
    const right = new Vector3(0, 0, -1);

    async function createWorld(): Promise<{ world: IWasmScene; mover: Box3DGeometricMover }> {
        world = await CreateWasmScene();
        CreateBoxBody(world.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(60, 1, 60), PhysicsMotionType.STATIC);
        const mover = new Box3DGeometricMover(world.plugin, { position: new Vector3(0, STAND_HEIGHT + 0.2, 0) });
        return { world, mover };
    }

    function run(w: IWasmScene, mover: Box3DGeometricMover, steps: number, throttleForward = 0): void {
        w.step(steps, () => mover.update(1 / 60, forward, right, throttleForward, 0));
    }

    it("settles on its pogo at the rest length above the ground", async () => {
        const { world, mover } = await createWorld();
        run(world, mover, 90);
        expect(mover.onGround).toBe(true);
        expect(mover.pogoProbe.hit).toBe(true);
        // the spring is solved geometrically against the mover's own gravity of 15 m/s^2, so it sags slightly
        expect(mover.position.y).toBeGreaterThan(STAND_HEIGHT - 0.06);
        expect(mover.position.y).toBeLessThan(STAND_HEIGHT + 0.01);
        expect(mover.planeCount).toBe(0);
    });

    it("walks into a wall and stops against it, with no speed left into it", async () => {
        const { world, mover } = await createWorld();
        CreateBoxBody(world.scene, "wall", new Vector3(4, 2, 0), new Vector3(1, 4, 8), PhysicsMotionType.STATIC);
        run(world, mover, 30);
        run(world, mover, 120, 1);
        // the wall's face is at x = 3.5
        expect(mover.position.x).toBeGreaterThan(3.5 - 0.3 - 0.02);
        expect(mover.position.x).toBeLessThan(3.5 - 0.3 + 0.005);
        expect(mover.velocity.x).toBeLessThan(0.01);
        expect(mover.planeCount).toBeGreaterThan(0);
        expect(mover.planes[0].body?.transformNode.name).toBe("wall");
    });

    it("pushes a dynamic box it walks into, unless told not to", async () => {
        for (const push of [true, false]) {
            world?.dispose();
            const created = await createWorld();
            const { mover } = created;
            mover.canPush = () => push;
            const box = CreateBoxBody(created.world.scene, "crate", new Vector3(2, 0.5, 0), new Vector3(1, 1, 1), PhysicsMotionType.DYNAMIC, 20);
            run(created.world, mover, 30);
            run(created.world, mover, 90, 1);
            if (push) {
                expect(box.node.position.x).toBeGreaterThan(3);
            } else {
                // the crate stops the mover instead
                expect(box.node.position.x).toBeCloseTo(2, 2);
                expect(mover.position.x).toBeLessThan(1.5 - 0.3 + 0.005);
            }
        }
    });

    it("jumps only from the ground and moves its node", async () => {
        world = await CreateWasmScene();
        CreateBoxBody(world.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(60, 1, 60), PhysicsMotionType.STATIC);
        const node = CreateBoxBody(world.scene, "visual", Vector3.Zero(), new Vector3(1, 1, 1), PhysicsMotionType.ANIMATED).node;
        const mover = new Box3DGeometricMover(world.plugin, { position: new Vector3(0, STAND_HEIGHT, 0), transformNode: node });
        run(world, mover, 60);
        const start = mover.position.y;
        expect(node.position.y).toBe(mover.position.y);
        expect(mover.jump()).toBe(true);
        expect(mover.jump()).toBe(false);
        let top = start;
        world.step(60, () => {
            mover.update(1 / 60, forward, right, 0, 0);
            top = Math.max(top, mover.position.y);
        });
        // 5 m/s against 15 m/s^2 rises 5^2 / 30 = 0.83 m
        expect(top - start).toBeGreaterThan(0.75);
        expect(top - start).toBeLessThan(0.85);
        expect(mover.onGround).toBe(true);
    });
});

describe("Box3D's newer world and body settings", () => {
    let world: IWasmScene | undefined;
    afterEach(() => {
        world?.dispose();
        world = undefined;
    });

    it("gets and sets the restitution passes, restitution propagation and the isotropic inertia tolerance", async () => {
        world = await CreateWasmScene();
        const { plugin } = world;
        expect(plugin.getRestitutionIterations()).toBe(2);
        plugin.setRestitutionIterations(5);
        expect(plugin.getRestitutionIterations()).toBe(5);
        plugin.setRestitutionIterations(1000);
        expect(plugin.getRestitutionIterations()).toBe(63);
        expect(plugin.isRestitutionPropagationEnabled()).toBe(false);
        plugin.setRestitutionPropagationEnabled(true);
        expect(plugin.isRestitutionPropagationEnabled()).toBe(true);
        expect(plugin.getIsotropicInertiaTolerance()).toBeCloseTo(0.2, 6);
        plugin.setIsotropicInertiaTolerance(2);
        expect(plugin.getIsotropicInertiaTolerance()).toBe(1);
    });

    it("gets and sets a body's continuous collision safety factor", async () => {
        world = await CreateWasmScene();
        const ball = CreateBoxBody(world.scene, "ball", new Vector3(0, 5, 0), new Vector3(0.2, 0.2, 0.2), PhysicsMotionType.DYNAMIC, 1);
        expect(world.plugin.getBodySafetyFactor(ball.body)).toBeCloseTo(0.5, 6);
        world.plugin.setBodySafetyFactor(ball.body, 0.05);
        expect(world.plugin.getBodySafetyFactor(ball.body)).toBeCloseTo(0.05, 6);
    });

    it("notifies before each world step with the step's time", async () => {
        world = await CreateWasmScene();
        const times: number[] = [];
        world.plugin.onBeforeWorldStepObservable.add((dt) => times.push(dt));
        world.step(3);
        expect(times).toEqual([1 / 60, 1 / 60, 1 / 60]);
    });
});
