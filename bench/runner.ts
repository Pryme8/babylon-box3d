// Runs one benchmark case: builds the scene through Babylon's regular physics API for the chosen engine, steps it
// with a fixed 1/60 s time step and measures every step. Shared by the node CLI and the browser page.
//
// Two timings are recorded per step:
//   stepMs    the whole Babylon physics step (plugin pre step, engine step, transform sync, events)
//   engineMs  only the engine's own world step call (HP_World_Step, bx_World_Step, OIMO World.step)

import { type AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { type Mesh } from "@babylonjs/core/Meshes/mesh";
import { type InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox, PhysicsShapeSphere, type PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsActivationControl, PhysicsMotionType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsImpostor } from "@babylonjs/core/Physics/v1/physicsImpostor";
import { OimoJSPlugin } from "@babylonjs/core/Physics/v1/Plugins/oimoJSPlugin";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import "@babylonjs/core/Physics/v1/physicsEngineComponent";
import "@babylonjs/core/Physics/v2/physicsEngineComponent";
import { Box3DPlugin } from "../src/box3dPlugin";
import { type ISceneSpec } from "./scenes";

export type EngineName = "box3d" | "havok" | "oimo";

export const EngineLabels: Record<EngineName, string> = {
    box3d: "Box3D",
    havok: "Havok",
    oimo: "Oimo",
};

/** The loaded engine modules: the Box3D wasm module, the Havok wasm module and the OIMO namespace. */
export interface IEngineModules {
    box3d: any;
    havok: any;
    oimo: any;
}

export interface ICaseOptions {
    engine: EngineName;
    /** false turns sleeping off for every body, measuring raw solver throughput */
    sleep: boolean;
    /** stop measuring once this much wall time has been spent stepping */
    budgetMs: number;
    /** Box3D only: workers on a step, counting the calling thread. Above 1 needs the threaded module. */
    workerCount?: number;
}

export interface ICaseResult {
    scene: string;
    sceneLabel: string;
    bodies: number;
    engine: EngineName;
    sleep: boolean;
    workerCount: number;
    buildMs: number;
    stepsRequested: number;
    stepsRun: number;
    stoppedEarly: boolean;
    stepMean: number;
    stepP50: number;
    stepP95: number;
    stepMax: number;
    engineMean: number;
    quality: Record<string, number>;
}

const Now = () => performance.now();

function Percentile(sorted: Float64Array, p: number): number {
    if (sorted.length === 0) {
        return 0;
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[index];
}

// Wraps a function property so every call adds its duration to the accumulator. Returns a restore callback.
function TimeCalls(target: any, key: string, accumulator: { ms: number }): () => void {
    const original = target[key];
    target[key] = function (...args: any[]) {
        const t0 = Now();
        const result = original.apply(this, args);
        accumulator.ms += Now() - t0;
        return result;
    };
    return () => {
        target[key] = original;
    };
}

/**
 * Builds and runs one case.
 * @param engine a Babylon engine, a NullEngine is enough
 * @param modules the loaded physics modules
 * @param spec the scene to build
 * @param options engine, sleep mode and time budget
 * @returns timings and the scene's quality metrics
 */
export function RunCase(engine: AbstractEngine, modules: IEngineModules, spec: ISceneSpec, options: ICaseOptions): ICaseResult {
    const scene = new Scene(engine);
    const gravity = new Vector3(0, -9.81, 0);
    const engineStep = { ms: 0 };
    let restore: () => void = () => {};

    const buildStart = Now();
    let plugin: any;
    if (options.engine === "box3d") {
        plugin = new Box3DPlugin(true, modules.box3d, { workerCount: options.workerCount });
        restore = TimeCalls(modules.box3d, "_bx_World_Step", engineStep);
    } else if (options.engine === "havok") {
        plugin = new HavokPlugin(true, modules.havok);
        restore = TimeCalls(modules.havok, "HP_World_Step", engineStep);
    } else {
        plugin = new OimoJSPlugin(true, undefined, modules.oimo);
        restore = TimeCalls(plugin.world, "step", engineStep);
    }
    scene.enablePhysics(gravity, plugin);

    const friction = 0.6;
    const density = 1000;
    const isV2 = options.engine !== "oimo";

    for (const s of spec.statics) {
        const wall = MeshBuilder.CreateBox("static", { width: s.width, height: s.height, depth: s.depth }, scene);
        wall.position.set(s.x, s.y, s.z);
        if (isV2) {
            new PhysicsAggregate(wall, PhysicsShapeType.BOX, { mass: 0, friction, restitution: 0 }, scene);
        } else {
            wall.physicsImpostor = new PhysicsImpostor(wall, PhysicsImpostor.BoxImpostor, { mass: 0, friction, restitution: 0 }, scene);
        }
    }

    const size = spec.bodySize;
    const boxMesh = MeshBuilder.CreateBox("boxSource", { size }, scene);
    const sphereMesh = MeshBuilder.CreateSphere("sphereSource", { diameter: size, segments: 8 }, scene);
    boxMesh.isVisible = false;
    sphereMesh.isVisible = false;

    // v2 engines share one shape per body type, which is how Babylon recommends building large scenes
    let boxShape: PhysicsShape | undefined;
    let sphereShape: PhysicsShape | undefined;
    if (isV2) {
        boxShape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(size, size, size), scene);
        sphereShape = new PhysicsShapeSphere(Vector3.Zero(), size / 2, scene);
        for (const shape of [boxShape, sphereShape]) {
            shape.material = { friction, restitution: 0 };
            shape.density = density;
        }
    }
    const boxMass = density * size * size * size;
    const sphereMass = density * (4 / 3) * Math.PI * Math.pow(size / 2, 3);

    const nodes: InstancedMesh[] = [];
    const bodies: PhysicsBody[] = [];
    const oimoBodies: any[] = [];
    for (let i = 0; i < spec.bodies.length; i++) {
        const b = spec.bodies[i];
        const source: Mesh = b.shape === "box" ? boxMesh : sphereMesh;
        const node = source.createInstance("body" + i);
        node.position.set(b.x, b.y, b.z);
        node.rotationQuaternion = Quaternion.FromEulerAngles(b.rx, b.ry, b.rz);
        nodes.push(node);
        if (isV2) {
            const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, scene);
            body.shape = b.shape === "box" ? boxShape! : sphereShape!;
            bodies.push(body);
        } else {
            const type = b.shape === "box" ? PhysicsImpostor.BoxImpostor : PhysicsImpostor.SphereImpostor;
            const mass = b.shape === "box" ? boxMass : sphereMass;
            node.physicsImpostor = new PhysicsImpostor(node, type, { mass, friction, restitution: 0 }, scene);
            oimoBodies.push(node.physicsImpostor.physicsBody);
        }
    }

    if (!options.sleep) {
        if (options.engine === "box3d") {
            (plugin as Box3DPlugin).setSleepingEnabled(false);
        } else if (options.engine === "havok") {
            for (const body of bodies) {
                (plugin as HavokPlugin).setActivationControl(body, PhysicsActivationControl.ALWAYS_ACTIVE);
            }
        } else {
            for (const body of oimoBodies) {
                body.allowSleep = false;
            }
        }
    }
    const buildMs = Now() - buildStart;

    const physicsEngine = scene.getPhysicsEngine()!;
    const times = new Float64Array(spec.steps);
    engineStep.ms = 0;
    let stepsRun = 0;
    const loopStart = Now();
    for (let i = 0; i < spec.steps; i++) {
        const t0 = Now();
        physicsEngine._step(1 / 60);
        times[i] = Now() - t0;
        stepsRun++;
        if (Now() - loopStart > options.budgetMs) {
            break;
        }
    }
    const engineMean = engineStep.ms / Math.max(1, stepsRun);
    restore();

    const final = new Float64Array(spec.bodies.length * 3);
    for (let i = 0; i < nodes.length; i++) {
        final[i * 3] = nodes[i].position.x;
        final[i * 3 + 1] = nodes[i].position.y;
        final[i * 3 + 2] = nodes[i].position.z;
    }
    const quality = spec.quality(final);

    scene.dispose();

    const measured = times.slice(0, stepsRun);
    let sum = 0;
    for (const t of measured) {
        sum += t;
    }
    const sorted = measured.slice().sort();
    return {
        scene: spec.id,
        sceneLabel: spec.label,
        bodies: spec.bodies.length,
        engine: options.engine,
        sleep: options.sleep,
        workerCount: plugin instanceof Box3DPlugin ? plugin.workerCount : 1,
        buildMs,
        stepsRequested: spec.steps,
        stepsRun,
        stoppedEarly: stepsRun < spec.steps,
        stepMean: sum / Math.max(1, stepsRun),
        stepP50: Percentile(sorted, 0.5),
        stepP95: Percentile(sorted, 0.95),
        stepMax: sorted.length ? sorted[sorted.length - 1] : 0,
        engineMean,
        quality,
    };
}

/** Picks the median run (by mean step time) out of repeated runs of the same case. */
export function MedianRun(runs: ICaseResult[]): ICaseResult {
    const sorted = runs.slice().sort((a, b) => a.stepMean - b.stepMean);
    return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * A pyramid counts as standing when its top box kept at least 90% of its height and boxes moved less than half a
 * box on average. Outer boxes sliding a little at the base does not count as a collapse.
 * @param quality the pyramid quality metrics
 * @returns true when the pyramid is still standing
 */
export function IsStanding(quality: Record<string, number>): boolean {
    return quality.topHeightRetained >= 0.9 && quality.topHeightRetained <= 1.1 && quality.meanDrift < 0.5;
}

function Fmt(value: number, digits = 2): string {
    return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function QualityText(result: ICaseResult): string {
    const q = result.quality;
    if ("escaped" in q) {
        return `${q.escaped} escaped`;
    }
    if ("maxDrift" in q) {
        return `${IsStanding(q) ? "standing" : "collapsed"}, top at ${Fmt(q.topHeightRetained * 100, 0)}% height`;
    }
    return "";
}

/** Markdown table of results, one row per case. */
export function ResultsTable(results: ICaseResult[]): string {
    const lines = [
        "| Scene | Bodies | Engine | Sleep | Step mean (ms) | p95 | max | Engine only mean | Build (ms) | Result |",
        "| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ];
    for (const r of results) {
        const partial = r.stoppedEarly ? ` (stopped after ${r.stepsRun} steps)` : "";
        const label = r.workerCount > 1 ? `${EngineLabels[r.engine]} x${r.workerCount}` : EngineLabels[r.engine];
        lines.push(
            `| ${r.sceneLabel} | ${r.bodies} | ${label} | ${r.sleep ? "on" : "off"} | ${Fmt(r.stepMean)} | ${Fmt(r.stepP95)} | ${Fmt(r.stepMax)} | ${Fmt(r.engineMean)} | ${Fmt(r.buildMs, 0)} | ${QualityText(r)}${partial} |`
        );
    }
    return lines.join("\n");
}
