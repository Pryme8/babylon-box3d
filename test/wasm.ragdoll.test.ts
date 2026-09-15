// A zombie ragdoll mirroring ZombieBlaster's: 18 boxes, 75.5 kg, 17 Physics6DoFConstraints with anatomical limits,
// dropped on a floor with an impulse at the chest and stepped for 10 s against the real Box3D wasm.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import HavokPhysics from "@babylonjs/havok";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PhysicsConstraintAxis, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Physics6DoFConstraint, type Physics6DoFLimit } from "@babylonjs/core/Physics/v2/physicsConstraint";
import { describe, expect, it } from "vitest";
import { ConstraintFrame, CreateBoxBody, CreateWasmScene, DegToRad, type ITestBody, HingeAngle, RadToDeg, RelativeFrameRotation, SwingTwist } from "./wasmScene";

interface IBone {
    name: string;
    parent: string | null;
    /** world position of the joint with the parent, which is also the body origin */
    origin: Vector3;
    /** box size and where its centre sits relative to the body origin */
    extents: Vector3;
    center: Vector3;
    mass: number;
    /** twist (ANGULAR_X), swing 1 (ANGULAR_Y) and swing 2 (ANGULAR_Z) ranges in degrees */
    limits: [number, number, number, number, number, number];
}

const cone = (swing: number, twist: number): [number, number, number, number, number, number] => [-twist, twist, -swing, swing, -swing, swing];
const hinge = (min: number, max: number): [number, number, number, number, number, number] => [0, 0, min, max, 0, 0];

/** Roughly human, 1.80 m from the floor to the top of the head, arms hanging at the sides. */
function BuildSkeleton(): IBone[] {
    const bones: IBone[] = [];
    const add = (name: string, parent: string | null, origin: number[], extents: number[], center: number[], mass: number, limits: IBone["limits"]) =>
        bones.push({ name, parent, origin: new Vector3(...(origin as [number, number, number])), extents: new Vector3(...(extents as [number, number, number])), center: new Vector3(...(center as [number, number, number])), mass, limits });
    add("Hips", null, [0, 1.0, 0], [0.335, 0.22, 0.18], [0, 0, 0], 12, cone(0, 0));
    add("Spine02", "Hips", [0, 1.11, 0], [0.27, 0.185, 0.17], [0, 0.0925, 0], 8, cone(22, 15));
    add("Spine01", "Spine02", [0, 1.295, 0], [0.3, 0.125, 0.19], [0, 0.0625, 0], 8, cone(20, 15));
    add("Spine", "Spine01", [0, 1.42, 0], [0.415, 0.12, 0.2], [0, 0.06, 0], 6, cone(18, 12));
    add("neck", "Spine", [0, 1.54, 0], [0.165, 0.089, 0.12], [0, 0.0445, 0], 1.5, cone(35, 30));
    add("Head", "neck", [0, 1.629, 0], [0.17, 0.171, 0.21], [0, 0.0855, 0], 5, cone(40, 35));
    for (const [side, sign] of [
        ["Left", 1],
        ["Right", -1],
    ] as Array<[string, number]>) {
        add(`${side}Arm`, "Spine", [sign * 0.26, 1.5, 0], [0.095, 0.28, 0.095], [0, -0.14, 0], 2.5, cone(85, 55));
        add(`${side}ForeArm`, `${side}Arm`, [sign * 0.26, 1.22, 0], [0.075, 0.26, 0.075], [0, -0.13, 0], 1.5, hinge(-145, 0));
        add(`${side}Hand`, `${side}ForeArm`, [sign * 0.26, 0.96, 0], [0.075, 0.17, 0.045], [0, -0.085, 0], 0.5, cone(45, 25));
        add(`${side}UpLeg`, "Hips", [sign * 0.1, 0.92, 0], [0.135, 0.42, 0.135], [0, -0.21, 0], 8, cone(60, 30));
        add(`${side}Leg`, `${side}UpLeg`, [sign * 0.1, 0.5, 0], [0.11, 0.42, 0.11], [0, -0.21, 0], 4, hinge(0, 140));
        add(`${side}Foot`, `${side}Leg`, [sign * 0.1, 0.08, 0], [0.09, 0.08, 0.24], [0, -0.04, 0.06], 1, cone(30, 15));
    }
    return bones;
}

const JointAxis = new Vector3(0, 1, 0);
const JointPerp = new Vector3(1, 0, 0);
const Frame = ConstraintFrame(JointAxis, JointPerp);

interface IRagdollJoint {
    bone: IBone;
    parent: ITestBody;
    child: ITestBody;
    /** true when two angular axes are locked, so the joint is a hinge about ANGULAR_Y */
    isHinge: boolean;
}

/** The chest impulse is violent enough to overshoot a limit for a few steps; both checks start after it. */
const SettleSteps = 6;

interface IRagdollStats {
    engine: string;
    subStepCount: number;
    maxSpeed: number;
    maxSpeedAfterSettling: number;
    /** worst limit excess during the first 0.1 s, when the impulse is being absorbed */
    firstStepsLimitExcessDeg: number;
    finalMaxSpeed: number;
    asleep: boolean;
    worstLimitExcessDeg: number;
    worstLimitJoint: string;
    nan: boolean;
    stepMs: number;
    lowestBodyY: number;
    perJoint: Map<string, number>;
}

let havokModule: any;
/** The same ragdoll on Havok, as a reference for the numbers (Havok has no sub step setting). */
async function CreateHavokWorld(gravity: Vector3) {
    havokModule ??= await HavokPhysics({
        wasmBinary: readFileSync(fileURLToPath(new URL("../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm", import.meta.url))),
    });
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.enablePhysics(gravity, new HavokPlugin(false, havokModule));
    return {
        scene,
        b3: undefined as any,
        step: (count: number, each?: (index: number) => void) => {
            for (let i = 0; i < count; i++) {
                (scene.getPhysicsEngine() as any)._step(1 / 60);
                each?.(i);
            }
        },
        dispose: () => {
            scene.dispose();
            engine.dispose();
        },
    };
}

async function RunRagdoll(engineName: "box3d" | "havok", subStepCount: number, measure = true): Promise<IRagdollStats> {
    const world = engineName === "box3d" ? await CreateWasmScene(new Vector3(0, -9.81, 0), subStepCount) : await CreateHavokWorld(new Vector3(0, -9.81, 0));
    const { scene, b3, step } = world;
    try {
        CreateBoxBody(scene, "floor", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        const bones = BuildSkeleton();
        const bodies = new Map<string, ITestBody>();
        for (const bone of bones) {
            const body = CreateBoxBody(scene, bone.name, bone.origin, bone.extents, PhysicsMotionType.DYNAMIC, bone.mass, { shapeCenter: bone.center });
            body.body.setLinearDamping(0.04);
            body.body.setAngularDamping(0.35 + Math.min(1, 2 / bone.mass) * 0.55);
            bodies.set(bone.name, body);
        }
        const joints: IRagdollJoint[] = [];
        for (const bone of bones) {
            if (!bone.parent) {
                continue;
            }
            const parent = bodies.get(bone.parent)!;
            const child = bodies.get(bone.name)!;
            const [twistMin, twistMax, swing1Min, swing1Max, swing2Min, swing2Max] = bone.limits.map((value) => value * DegToRad);
            const limits: Physics6DoFLimit[] = [
                { axis: PhysicsConstraintAxis.LINEAR_X, minLimit: 0, maxLimit: 0 },
                { axis: PhysicsConstraintAxis.LINEAR_Y, minLimit: 0, maxLimit: 0 },
                { axis: PhysicsConstraintAxis.LINEAR_Z, minLimit: 0, maxLimit: 0 },
                { axis: PhysicsConstraintAxis.ANGULAR_X, minLimit: twistMin, maxLimit: twistMax },
                { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: swing1Min, maxLimit: swing1Max },
                { axis: PhysicsConstraintAxis.ANGULAR_Z, minLimit: swing2Min, maxLimit: swing2Max },
            ];
            const constraint = new Physics6DoFConstraint(
                {
                    pivotA: bone.origin.subtract(bodies.get(bone.parent)!.node.position),
                    pivotB: Vector3.Zero(),
                    axisA: JointAxis,
                    axisB: JointAxis,
                    perpAxisA: JointPerp,
                    perpAxisB: JointPerp,
                    collision: false,
                },
                limits,
                scene
            );
            parent.body.addConstraint(child.body, constraint);
            joints.push({ bone, parent, child, isHinge: twistMin === twistMax && swing2Min === swing2Max });
        }

        // shoved in the chest, like a round landing on a standing zombie
        const chest = bodies.get("Spine01")!;
        chest.body.applyImpulse(new Vector3(0, 0, -40), chest.node.getAbsolutePosition());

        const stats: IRagdollStats = {
            engine: engineName,
            subStepCount,
            firstStepsLimitExcessDeg: 0,
            maxSpeed: 0,
            maxSpeedAfterSettling: 0,
            finalMaxSpeed: 0,
            asleep: false,
            worstLimitExcessDeg: 0,
            worstLimitJoint: "",
            nan: false,
            stepMs: 0,
            lowestBodyY: Infinity,
            perJoint: new Map(),
        };
        const steps = 600;
        if (!measure) {
            // a bare run, so the reported cost per step is the physics and not the checks below
            const bare = performance.now();
            step(steps);
            stats.stepMs = (performance.now() - bare) / steps;
            return stats;
        }
        const started = performance.now();
        step(steps, (index) => {
            let stepMax = 0;
            for (const body of bodies.values()) {
                const velocity = body.body.getLinearVelocity();
                const position = body.node.position;
                if (!isFinite(velocity.x + velocity.y + velocity.z + position.x + position.y + position.z)) {
                    stats.nan = true;
                }
                stepMax = Math.max(stepMax, velocity.length());
                stats.lowestBodyY = Math.min(stats.lowestBodyY, position.y);
            }
            stats.maxSpeed = Math.max(stats.maxSpeed, stepMax);
            if (index >= SettleSteps) {
                stats.maxSpeedAfterSettling = Math.max(stats.maxSpeedAfterSettling, stepMax);
            }
            if (index === steps - 1) {
                stats.finalMaxSpeed = stepMax;
            }
            // joint limits, in the same frames the constraint was built with
            for (const joint of joints) {
                const rel = RelativeFrameRotation(joint.parent.node, joint.child.node, Frame, Frame);
                const [twistMin, twistMax, swing1Min, swing1Max, swing2Min, swing2Max] = joint.bone.limits;
                let excess = 0;
                if (joint.isHinge) {
                    const { angle, offAxis } = HingeAngle(rel, 1);
                    const degrees = angle * RadToDeg;
                    excess = Math.max(degrees - swing1Max, swing1Min - degrees, offAxis * RadToDeg);
                } else {
                    const { twist, swing } = SwingTwist(rel);
                    const twistDeg = twist * RadToDeg;
                    const coneDeg = Math.max(Math.abs(swing1Min), Math.abs(swing1Max), Math.abs(swing2Min), Math.abs(swing2Max));
                    excess = Math.max(twistDeg - twistMax, twistMin - twistDeg, swing * RadToDeg - coneDeg);
                }
                stats.firstStepsLimitExcessDeg = Math.max(stats.firstStepsLimitExcessDeg, excess);
                if (index >= SettleSteps) {
                    stats.perJoint.set(joint.bone.name, Math.max(stats.perJoint.get(joint.bone.name) ?? 0, excess));
                    if (excess > stats.worstLimitExcessDeg) {
                        stats.worstLimitExcessDeg = excess;
                        stats.worstLimitJoint = `${joint.bone.name} at step ${index}`;
                    }
                }
            }
        });
        stats.stepMs = (performance.now() - started) / steps;
        stats.asleep = b3 ? [...bodies.values()].every((body) => b3._bx_Body_IsAwake((body.body as any)._pluginData.slot) === 0) : false;
        return stats;
    } finally {
        world.dispose();
    }
}

describe("Zombie ragdoll (real wasm)", () => {
    it("falls, stays inside its joint limits and comes to rest", async () => {
        const report: string[] = [];
        const matrix: Array<["box3d" | "havok", number]> = [
            ["box3d", 4],
            ["box3d", 8],
            ["havok", 0],
        ];
        // warm up first (the first run pays the JIT), then measure, then time a bare run without the per step checks
        for (const [engineName, subStepCount] of matrix) {
            await RunRagdoll(engineName, subStepCount, false);
        }
        const runs: IRagdollStats[] = [];
        for (const [engineName, subStepCount] of matrix) {
            const stats = await RunRagdoll(engineName, subStepCount);
            stats.stepMs = (await RunRagdoll(engineName, subStepCount, false)).stepMs;
            runs.push(stats);
        }
        for (const stats of runs) {
            report.push(
                `${stats.engine}${stats.engine === "box3d" ? ` subSteps ${stats.subStepCount}` : ""}: peak ${stats.maxSpeed.toFixed(2)} m/s, ` +
                    `peak after 0.1 s ${stats.maxSpeedAfterSettling.toFixed(2)} m/s, final ${stats.finalMaxSpeed.toFixed(4)} m/s, ` +
                    `asleep ${stats.engine === "box3d" ? stats.asleep : "n/a"}, ` +
                    `limit excess ${stats.worstLimitExcessDeg.toFixed(2)} deg after 0.1 s (${stats.worstLimitJoint || "none"}), ` +
                    `${stats.firstStepsLimitExcessDeg.toFixed(1)} deg while absorbing the impulse, lowest body y ${stats.lowestBodyY.toFixed(3)}, ` +
                    `${stats.stepMs.toFixed(3)} ms/step\n  worst per joint: ` +
                    [...stats.perJoint.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 4)
                        .map(([name, value]) => `${name} ${value.toFixed(2)}`)
                        .join(", ")
            );
        }
        console.log(report.join("\n"));
        for (const stats of runs.filter((run) => run.engine === "box3d")) {
            expect(stats.nan, "no NaNs").toBe(false);
            expect(stats.maxSpeedAfterSettling, "no body faster than 30 m/s after the first 0.1 s").toBeLessThan(30);
            // Havok overshoots these limits by 25 degrees in the same scene, so this is a tight bound
            expect(stats.worstLimitExcessDeg, "joint limits hold").toBeLessThan(6);
            expect(stats.asleep || stats.finalMaxSpeed < 0.05, "at rest after 10 s").toBe(true);
            // the ragdoll lies on the floor instead of sinking through it
            expect(stats.lowestBodyY).toBeGreaterThan(-0.1);
        }
    });
});
