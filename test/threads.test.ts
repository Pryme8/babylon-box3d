// The threaded build: box3d running a world step on its own worker threads.
//
// The package ships two builds of the same shim. The threaded one is only worth having if it gives the same answer as
// the single threaded one, since determinism is half the reason to use Box3D at all, so that is what most of this file
// checks: the same scene, stepped the same number of times, has to land on bit identical positions whatever the worker
// count. The rest guards the two ways this goes wrong quietly - a module built without threads accepting a request for
// workers and running on one anyway, and the two builds drifting apart in what they export.

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Logger } from "@babylonjs/core/Misc/logger";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import "@babylonjs/core/Physics/v2/physicsEngineComponent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Box3D from "../lib/node/box3d.mjs";
import Box3DThreads from "../lib/node-threads/box3d.mjs";
import { Box3DPlugin } from "../src/box3dPlugin";

const Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let plain: any;
let threaded: any;

beforeAll(async () => {
    Logger.LogLevels = Logger.ErrorLogLevel;
    plain = await Box3D();
    threaded = await Box3DThreads();
});

afterAll(() => {
    // emscripten keeps the worker pool alive, and vitest will not let the process go while it is up
    threaded?.PThread?.terminateAllThreads?.();
});

/**
 * Drops a grid of boxes into a pile and returns every body's resting position, which is what has to match across
 * worker counts. A grid gives the solver several islands to split across workers; a single stack would not.
 * @param b3 the Box3D module to run on
 * @param workerCount workers for the world, counting the calling thread
 * @returns the final positions, three floats per body, and the plugin that produced them
 */
function Pile(b3: any, workerCount: number): { positions: Float64Array; workers: number } {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const plugin = new Box3DPlugin(false, b3, { workerCount });
    scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);

    const groundNode = new TransformNode("ground", scene);
    groundNode.position = new Vector3(0, -0.5, 0);
    groundNode.computeWorldMatrix(true);
    const ground = new PhysicsBody(groundNode, PhysicsMotionType.STATIC, false, scene);
    ground.shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(40, 1, 40), scene);

    const nodes: TransformNode[] = [];
    const box = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(1, 1, 1), scene);
    for (let x = 0; x < 6; x++) {
        for (let y = 0; y < 5; y++) {
            for (let z = 0; z < 6; z++) {
                const node = new TransformNode(`b${x}_${y}_${z}`, scene);
                // an offset per row so the boxes settle into each other instead of dropping into tidy columns
                node.position = new Vector3(x * 1.4 - 4 + y * 0.05, 1 + y * 1.6, z * 1.4 - 4 - y * 0.05);
                node.computeWorldMatrix(true);
                const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, scene);
                body.shape = box;
                nodes.push(node);
            }
        }
    }

    const physicsEngine = scene.getPhysicsEngine()!;
    for (let i = 0; i < 180; i++) {
        (physicsEngine as any)._step(1 / 60);
    }

    const positions = new Float64Array(nodes.length * 3);
    for (let i = 0; i < nodes.length; i++) {
        positions[i * 3] = nodes[i].position.x;
        positions[i * 3 + 1] = nodes[i].position.y;
        positions[i * 3 + 2] = nodes[i].position.z;
    }
    const workers = plugin.workerCount;
    scene.dispose();
    engine.dispose();
    return { positions, workers };
}

describe("threaded build", () => {
    it("puts several workers on a step", () => {
        expect(threaded._bx_GetMaxWorkers()).toBeGreaterThan(1);
        const { workers } = Pile(threaded, 4);
        expect(workers).toBe(4);
    });

    it("gives bit identical results whatever the worker count", () => {
        const reference = Pile(plain, 1).positions;
        expect(reference.length).toBe(6 * 5 * 6 * 3);
        // the pile settled rather than exploding, so the comparison is about a real scene
        expect(reference.every((value) => Number.isFinite(value))).toBe(true);

        for (const workers of [1, 2, 4]) {
            const run = Pile(threaded, workers);
            expect(run.workers).toBe(workers);
            const differences = [...run.positions].filter((value, index) => value !== reference[index]).length;
            expect(differences, `${workers} worker(s) against the single threaded build`).toBe(0);
        }
    });

    it("creates and destroys worlds back to back without stalling on its threads", () => {
        // box3d's own scheduler would create threads with each world and join them on the way out. A browser cannot
        // do that: the main thread waiting in a join is the same thread a new worker needs in order to start, and
        // disposing a scene and building the next one in one go is enough to deadlock a page. The shim's pool is
        // created once and never joined, so this loop is only as expensive as the worlds themselves.
        for (let i = 0; i < 6; i++) {
            const world = threaded._bx_CreateWorld(0, -9.81, 0, 4);
            expect(threaded._bx_World_GetWorkerCount(world)).toBe(4);
            for (let step = 0; step < 10; step++) {
                threaded._bx_World_Step(world, 1 / 60, 4);
            }
            threaded._bx_DestroyWorld(world);
        }
        // and the worlds were really released rather than leaking a slot per cycle
        const world = threaded._bx_CreateWorld(0, -9.81, 0, 1);
        expect(world).toBeLessThanOrEqual(2);
        threaded._bx_DestroyWorld(world);
    });

    it("clamps a request for workers on the single threaded build, and says why once", () => {
        const warn = vi.spyOn(Logger, "Warn").mockImplementation(() => {});
        try {
            expect(plain._bx_GetMaxWorkers()).toBe(1);
            const engine = new NullEngine();
            const scene = new Scene(engine);
            const plugin = new Box3DPlugin(false, plain, { workerCount: 8 });
            expect(plugin.workerCount).toBe(1);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain("built without threads");
            scene.dispose();
            engine.dispose();
        } finally {
            warn.mockRestore();
        }
    });

    it("clamps a request beyond the thread pool instead of starting a worker mid step", () => {
        const max = threaded._bx_GetMaxWorkers();
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const plugin = new Box3DPlugin(false, threaded, { workerCount: max + 16 });
        expect(plugin.workerCount).toBe(max);
        scene.dispose();
        engine.dispose();
    });

    it("exports the same entry points as the single threaded build", () => {
        const names = (module_: any) =>
            Object.keys(module_)
                .filter((key) => key.startsWith("_bx_"))
                .sort();
        expect(names(threaded)).toEqual(names(plain));
        expect(names(plain).length).toBeGreaterThan(100);
    });

    it("ships one threaded build behind both of its loaders", () => {
        const esm = readFileSync(path.join(Root, "lib/esm-threads/box3d.wasm")).toString("base64");
        const node = readFileSync(path.join(Root, "lib/node-threads/box3d.wasm")).toString("base64");
        expect(node).toBe(esm);
        // and it is a different build from the single threaded one, which is the whole point of shipping both
        expect(esm).not.toBe(readFileSync(path.join(Root, "lib/esm/box3d.wasm")).toString("base64"));
    });
});
