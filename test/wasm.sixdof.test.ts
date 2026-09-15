// SIX_DOF constraints against the real Box3D wasm, with Havok (also real) as the reference for the angle conventions.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PhysicsConstraintAxis, PhysicsConstraintAxisLimitMode, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Physics6DoFConstraint, type Physics6DoFLimit, SpringConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import HavokPhysics from "@babylonjs/havok";
import { afterEach, describe, expect, it } from "vitest";
import { ConstraintFrame, CreateBoxBody, CreateWasmScene, DegToRad, HingeAngle, type ITestBody, RadToDeg, RelativeFrameRotation, SwingTwist } from "./wasmScene";

type Engine = "box3d" | "havok";
interface IJointRig {
    scene: Scene;
    parent: ITestBody;
    child: ITestBody;
    constraint: Physics6DoFConstraint;
    frameA: Quaternion;
    frameB: Quaternion;
    step: (count: number, each?: () => void) => void;
    dispose: () => void;
}

let havokModule: any;
async function CreateHavokScene(gravity: Vector3) {
    havokModule ??= await HavokPhysics({
        wasmBinary: readFileSync(fileURLToPath(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url))),
    });
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.enablePhysics(gravity, new HavokPlugin(false, havokModule));
    return {
        scene,
        step: (count: number, each?: () => void) => {
            for (let i = 0; i < count; i++) {
                (scene.getPhysicsEngine() as any)._step(1 / 60);
                each?.();
            }
        },
        dispose: () => {
            scene.dispose();
            engine.dispose();
        },
    };
}

const rigs: IJointRig[] = [];
afterEach(() => {
    rigs.splice(0).forEach((rig) => rig.dispose());
});

const Locked = (axis: PhysicsConstraintAxis): Physics6DoFLimit => ({ axis, minLimit: 0, maxLimit: 0 });
const Limited = (axis: PhysicsConstraintAxis, minDeg: number, maxDeg: number): Physics6DoFLimit => ({ axis, minLimit: minDeg * DegToRad, maxLimit: maxDeg * DegToRad });
const LockedLinear = [Locked(PhysicsConstraintAxis.LINEAR_X), Locked(PhysicsConstraintAxis.LINEAR_Y), Locked(PhysicsConstraintAxis.LINEAR_Z)];

/**
 * A static parent and a dynamic 1 m bar jointed at the parent's origin. The bar runs along `axis` from the pivot, the
 * joint frames are identical on both bodies (like a ragdoll built in its bind pose).
 */
async function CreateJointRig(engine: Engine, axis: Vector3, perp: Vector3, limits: Physics6DoFLimit[], gravity = Vector3.Zero(), mass = 2): Promise<IJointRig> {
    const world = engine === "box3d" ? await CreateWasmScene(gravity) : await CreateHavokScene(gravity);
    const scene = world.scene;
    const pivot = new Vector3(0, 5, 0);
    const parent = CreateBoxBody(scene, "parent", pivot, new Vector3(0.2, 0.2, 0.2), PhysicsMotionType.STATIC);
    const direction = axis.normalizeToNew();
    const extents = new Vector3(Math.abs(direction.x) * 0.9 + 0.1, Math.abs(direction.y) * 0.9 + 0.1, Math.abs(direction.z) * 0.9 + 0.1);
    const child = CreateBoxBody(scene, "child", pivot, extents, PhysicsMotionType.DYNAMIC, mass, { shapeCenter: direction.scale(0.55) });
    const constraint = new Physics6DoFConstraint(
        { pivotA: Vector3.Zero(), pivotB: Vector3.Zero(), axisA: axis, axisB: axis, perpAxisA: perp, perpAxisB: perp, collision: false },
        limits,
        scene
    );
    parent.body.addConstraint(child.body, constraint);
    const rig: IJointRig = {
        scene,
        parent,
        child,
        constraint,
        frameA: ConstraintFrame(axis, perp),
        frameB: ConstraintFrame(axis, perp),
        step: world.step,
        dispose: world.dispose,
    };
    rigs.push(rig);
    return rig;
}

function Relative(rig: IJointRig): Quaternion {
    return RelativeFrameRotation(rig.parent.node, rig.child.node, rig.frameA, rig.frameB);
}

/** Pushes the bar with a torque (world space) for `steps` and records the hinge angle range about one frame axis. */
function PushHinge(rig: IJointRig, torque: Vector3, steps: number, frameAxis: 0 | 1 | 2) {
    let min = Infinity;
    let max = -Infinity;
    let offAxis = 0;
    rig.step(steps, () => {
        rig.child.body.applyTorque(torque);
        const hinge = HingeAngle(Relative(rig), frameAxis);
        min = Math.min(min, hinge.angle);
        max = Math.max(max, hinge.angle);
        offAxis = Math.max(offAxis, hinge.offAxis);
    });
    return { min: min * RadToDeg, max: max * RadToDeg, offAxis: offAxis * RadToDeg };
}

const Up = new Vector3(0, 1, 0);
const Right = new Vector3(1, 0, 0);
const KneeLimits = [...LockedLinear, Locked(PhysicsConstraintAxis.ANGULAR_X), Limited(PhysicsConstraintAxis.ANGULAR_Y, 0, 140), Locked(PhysicsConstraintAxis.ANGULAR_Z)];
const TorqueScale = 40;
/** the bar is thin, its twist inertia is about 200 times smaller than its swing inertia */
const TwistTorque = 1.5;

describe("SIX_DOF constraints (real Box3D wasm)", () => {
    it("allows the same rotation directions as Havok for one sided hinges and an asymmetric twist", async () => {
        const results: Record<Engine, number[]> = { box3d: [], havok: [] };
        for (const engine of ["box3d", "havok"] as Engine[]) {
            // knee: ANGULAR_Y (about perpAxis = world x) limited to [0, 140]
            let rig = await CreateJointRig(engine, Up, Right, KneeLimits);
            const negative = PushHinge(rig, new Vector3(-TorqueScale, 0, 0), 60, 1);
            const positive = PushHinge(rig, new Vector3(TorqueScale, 0, 0), 120, 1);
            // elbow style: ANGULAR_Z (about axis x perp = world -z) limited to [-90, 0]
            rig = await CreateJointRig(engine, Up, Right, [...LockedLinear, Locked(PhysicsConstraintAxis.ANGULAR_X), Locked(PhysicsConstraintAxis.ANGULAR_Y), Limited(PhysicsConstraintAxis.ANGULAR_Z, -90, 0)]);
            const zNegative = PushHinge(rig, new Vector3(0, 0, TorqueScale), 120, 2);
            const zPositive = PushHinge(rig, new Vector3(0, 0, -TorqueScale), 60, 2);
            // twist: ANGULAR_X (about axis = world y) limited to [-10, 60]
            rig = await CreateJointRig(engine, Up, Right, [...LockedLinear, Limited(PhysicsConstraintAxis.ANGULAR_X, -10, 60), Locked(PhysicsConstraintAxis.ANGULAR_Y), Locked(PhysicsConstraintAxis.ANGULAR_Z)]);
            const twistPositive = PushHinge(rig, new Vector3(0, TwistTorque, 0), 120, 0);
            const twistNegative = PushHinge(rig, new Vector3(0, -TwistTorque, 0), 120, 0);
            results[engine] = [negative.min, positive.max, zNegative.min, zPositive.max, twistPositive.max, twistNegative.min];
        }
        const [kneeMin, kneeMax, zMin, zMax, twistMax, twistMin] = results.box3d;
        expect(kneeMin).toBeGreaterThan(-2);
        expect(kneeMax).toBeGreaterThan(130);
        expect(kneeMax).toBeLessThan(143);
        expect(zMin).toBeLessThan(-80);
        expect(zMin).toBeGreaterThan(-93);
        expect(zMax).toBeLessThan(2);
        expect(twistMax).toBeGreaterThan(55);
        expect(twistMax).toBeLessThan(63);
        expect(twistMin).toBeLessThan(-7);
        expect(twistMin).toBeGreaterThan(-13);
        // same limits reached in the same directions as Havok, within a few degrees
        results.havok.forEach((havok, i) => expect(Math.abs(results.box3d[i] - havok)).toBeLessThan(5));
    });

    it("slides along a single open linear axis in the same direction as Havok", async () => {
        const results: Record<Engine, number[]> = { box3d: [], havok: [] };
        for (const engine of ["box3d", "havok"] as Engine[]) {
            // LINEAR_Y runs along perpAxis (world x here), limited to [0, 0.5]; everything else locked
            const limits = [
                Locked(PhysicsConstraintAxis.LINEAR_X),
                { axis: PhysicsConstraintAxis.LINEAR_Y, minLimit: 0, maxLimit: 0.5 },
                Locked(PhysicsConstraintAxis.LINEAR_Z),
                Locked(PhysicsConstraintAxis.ANGULAR_X),
                Locked(PhysicsConstraintAxis.ANGULAR_Y),
                Locked(PhysicsConstraintAxis.ANGULAR_Z),
            ];
            const rig = await CreateJointRig(engine, Up, Right, limits);
            let min = Infinity;
            let max = -Infinity;
            const push = (force: Vector3, steps: number) =>
                rig.step(steps, () => {
                    rig.child.body.applyForce(force, rig.child.node.position);
                    const offset = rig.child.node.position.x;
                    min = Math.min(min, offset);
                    max = Math.max(max, offset);
                });
            push(new Vector3(-40, 0, 0), 60);
            push(new Vector3(40, 0, 0), 90);
            results[engine] = [min, max, Math.abs(rig.child.node.position.z) + Math.abs(rig.child.node.position.y - 5)];
        }
        const [min, max, offAxis] = results.box3d;
        expect(min).toBeGreaterThan(-0.01);
        expect(max).toBeGreaterThan(0.45);
        expect(max).toBeLessThan(0.52);
        expect(offAxis).toBeLessThan(0.01);
        results.havok.forEach((havok, i) => expect(Math.abs(results.box3d[i] - havok)).toBeLessThan(0.03));
    });

    it("keeps a cone joint inside its cone and asymmetric twist range under gravity and an impulse", async () => {
        const limits = [
            ...LockedLinear,
            Limited(PhysicsConstraintAxis.ANGULAR_X, -15, 45),
            Limited(PhysicsConstraintAxis.ANGULAR_Y, -30, 30),
            Limited(PhysicsConstraintAxis.ANGULAR_Z, -30, 30),
        ];
        // horizontal bar: gravity drags it into the cone
        const rig = await CreateJointRig("box3d", Right, Up, limits, new Vector3(0, -9.81, 0));
        let maxSwing = 0;
        let minTwist = Infinity;
        let maxTwist = -Infinity;
        const record = () => {
            const { swing, twist } = SwingTwist(Relative(rig));
            maxSwing = Math.max(maxSwing, swing);
            minTwist = Math.min(minTwist, twist);
            maxTwist = Math.max(maxTwist, twist);
        };
        rig.step(60, record);
        const sagged = maxSwing;
        rig.child.body.applyImpulse(new Vector3(0, 0, 8), new Vector3(1, 5, 0));
        rig.child.body.applyAngularImpulse(new Vector3(3, 0, 0));
        rig.step(60, record);
        rig.child.body.applyAngularImpulse(new Vector3(-3, 0, 0));
        rig.step(90, record);
        expect(sagged * RadToDeg).toBeGreaterThan(27);
        expect(maxSwing * RadToDeg).toBeLessThan(33);
        expect(maxTwist * RadToDeg).toBeGreaterThan(40);
        expect(maxTwist * RadToDeg).toBeLessThan(48);
        expect(minTwist * RadToDeg).toBeLessThan(-10);
        expect(minTwist * RadToDeg).toBeGreaterThan(-18);
    });

    it("maps a one sided hinge (0..140 deg) to a revolute joint that never bends backwards", async () => {
        const rig = await CreateJointRig("box3d", Up, Right, KneeLimits, new Vector3(0, -9.81, 0));
        rig.child.node.position.y = 5;
        const back = PushHinge(rig, new Vector3(-TorqueScale, 0, 0), 90, 1);
        const forward = PushHinge(rig, new Vector3(TorqueScale, 0, 0), 150, 1);
        const released = PushHinge(rig, Vector3.Zero(), 120, 1);
        expect(back.min).toBeGreaterThan(-2);
        expect(forward.max).toBeGreaterThan(130);
        expect(forward.max).toBeLessThan(142);
        expect(released.min).toBeGreaterThan(-2);
        expect(Math.max(back.offAxis, forward.offAxis, released.offAxis)).toBeLessThan(2);
    });

    it("welds when every axis is locked", async () => {
        const all = [...LockedLinear, Locked(PhysicsConstraintAxis.ANGULAR_X), Locked(PhysicsConstraintAxis.ANGULAR_Y), Locked(PhysicsConstraintAxis.ANGULAR_Z)];
        const rig = await CreateJointRig("box3d", Right, Up, all, new Vector3(0, -9.81, 0), 5);
        const start = rig.child.node.position.clone();
        let maxAngle = 0;
        let maxDrift = 0;
        rig.step(30);
        rig.child.body.applyImpulse(new Vector3(0, 10, 10), new Vector3(1, 5, 0));
        rig.step(120, () => {
            const rel = Relative(rig);
            maxAngle = Math.max(maxAngle, 2 * Math.acos(Math.min(1, rel.w)));
            maxDrift = Math.max(maxDrift, Vector3.Distance(rig.child.node.position, start));
        });
        expect(maxAngle * RadToDeg).toBeLessThan(1.5);
        expect(maxDrift).toBeLessThan(0.02);
    });

    it("keeps the mapped limits when the constraint is disabled and enabled again", async () => {
        const rig = await CreateJointRig("box3d", Up, Right, KneeLimits);
        // disabled right after creation, like Babylon's Ragdoll does
        rig.constraint.isEnabled = false;
        expect(rig.constraint.isEnabled).toBe(false);
        const free = PushHinge(rig, new Vector3(-TorqueScale, 0, 0), 30, 1);
        expect(free.min).toBeLessThan(-10);
        rig.constraint.isEnabled = true;
        expect(rig.constraint.isEnabled).toBe(true);
        PushHinge(rig, Vector3.Zero(), 60, 1);
        const back = PushHinge(rig, new Vector3(-TorqueScale, 0, 0), 60, 1);
        const forward = PushHinge(rig, new Vector3(TorqueScale, 0, 0), 150, 1);
        expect(back.min).toBeGreaterThan(-2);
        expect(forward.max).toBeGreaterThan(130);
        expect(forward.max).toBeLessThan(142);
        expect(rig.constraint.getAxisMode(PhysicsConstraintAxis.ANGULAR_Y)).toBe(PhysicsConstraintAxisLimitMode.LIMITED);
        expect(rig.constraint.getAxisMaxLimit(PhysicsConstraintAxis.ANGULAR_Y)).toBeCloseTo(140 * DegToRad);
        expect(rig.constraint.getAxisMode(PhysicsConstraintAxis.ANGULAR_X)).toBe(PhysicsConstraintAxisLimitMode.LOCKED);
    });

    it("re-plans the joint when an axis changes at runtime", async () => {
        const rig = await CreateJointRig("box3d", Up, Right, KneeLimits);
        // unlock the twist: two open angular axes turn the revolute into a spherical joint with a twist range
        rig.constraint.setAxisMode(PhysicsConstraintAxis.ANGULAR_X, PhysicsConstraintAxisLimitMode.LIMITED);
        rig.constraint.setAxisMinLimit(PhysicsConstraintAxis.ANGULAR_X, -20 * DegToRad);
        rig.constraint.setAxisMaxLimit(PhysicsConstraintAxis.ANGULAR_X, 20 * DegToRad);
        const twist = PushHinge(rig, new Vector3(0, TwistTorque, 0), 90, 0);
        expect(twist.max).toBeGreaterThan(15);
        expect(twist.max).toBeLessThan(24);
    });

    it("maps a SpringConstraint to a Box3D distance spring with Havok's spring constant", async () => {
        const world = await CreateWasmScene(Vector3.Zero());
        rigs.push({ dispose: world.dispose } as IJointRig);
        const anchor = CreateBoxBody(world.scene, "anchor", Vector3.Zero(), new Vector3(0.1, 0.1, 0.1), PhysicsMotionType.STATIC);
        const bob = CreateBoxBody(world.scene, "bob", new Vector3(1.2, 0, 0), new Vector3(0.1, 0.1, 0.1), PhysicsMotionType.DYNAMIC, 1);
        // k = 100 N/m on 1 kg: period 2 pi sqrt(m / k) = 0.628 s, measured the same with Havok
        anchor.body.addConstraint(bob.body, new SpringConstraint(Vector3.Zero(), Vector3.Zero(), Right, Right, 1, 1, 100, 0, world.scene));
        const xs: number[] = [];
        world.step(240, () => xs.push(bob.node.position.x));
        const crossings: number[] = [];
        for (let i = 1; i < xs.length; i++) {
            if ((xs[i - 1] - 1) * (xs[i] - 1) < 0) {
                crossings.push(i / 60);
            }
        }
        const period = (crossings[crossings.length - 1] - crossings[0]) / ((crossings.length - 1) / 2);
        expect(period).toBeGreaterThan(0.55);
        expect(period).toBeLessThan(0.7);
    });
});
