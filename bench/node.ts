// Headless benchmark: Box3D vs Havok vs Oimo through Babylon's physics APIs.
//
//   npm run bench                                   default matrix, 3 repeats
//   npm run bench -- --scenes pyramid-50,pile-1000 --engines box3d,havok --repeats 5 --sleep off
//   npm run bench -- --workers 4                    Box3D on the threaded build, 4 workers counting this thread
//
// Results are written to bench/results/node-<date>.json and .md.

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Logger } from "@babylonjs/core/Misc/logger";
import HavokPhysics from "@babylonjs/havok";
import Box3D from "../lib/node/box3d.mjs";
import Box3DThreads from "../lib/node-threads/box3d.mjs";
import { DefaultScenes, SceneById, type ISceneSpec } from "./scenes";
import { EngineLabels, MedianRun, ResultsTable, RunCase, type EngineName, type ICaseResult, type IEngineModules } from "./runner";

const Here = path.dirname(fileURLToPath(import.meta.url));
const RepoRoot = path.resolve(Here, "..");
const require = createRequire(import.meta.url);

function Arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const scenes: ISceneSpec[] = Arg("scenes") ? Arg("scenes")!.split(",").map(SceneById) : DefaultScenes();
const engines = (Arg("engines") ?? "box3d,havok,oimo").split(",") as EngineName[];
const repeats = parseInt(Arg("repeats") ?? "3", 10);
const sleepModes = (Arg("sleep") ?? "on,off").split(",").map((s) => s === "on");
const budgetMs = parseFloat(Arg("budget") ?? "60000");
// Box3D only. Above 1 this loads the threaded build, where box3d runs a step on its own worker threads.
const workerCount = parseInt(Arg("workers") ?? "1", 10);

Logger.LogLevels = Logger.ErrorLogLevel;

const modules: IEngineModules = {
    box3d: workerCount > 1 ? await Box3DThreads() : await Box3D(),
    havok: await HavokPhysics({ wasmBinary: readFileSync(path.join(RepoRoot, "node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm")) }),
    oimo: require("oimo"),
};

const engine = new NullEngine();
const packageVersion = (name: string) => JSON.parse(readFileSync(path.join(RepoRoot, "node_modules", name, "package.json"), "utf8")).version;
const environment = {
    date: new Date().toISOString(),
    cpu: os.cpus()[0]?.model.trim(),
    cores: os.cpus().length,
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    babylon: packageVersion("@babylonjs/core"),
    havok: packageVersion("@babylonjs/havok"),
    oimo: packageVersion("oimo"),
    box3d: readFileSync(path.join(RepoRoot, "UPSTREAM_COMMIT"), "utf8").trim().slice(0, 12),
    timestep: "1/60 s fixed, one step per call",
    box3dWorkers: workerCount,
    settings: "engine defaults (Box3D 4 sub steps, Havok defaults, Oimo 8 iterations), friction 0.6, restitution 0, density 1000",
};
console.log(environment);

const gc: (() => void) | undefined = (globalThis as any).gc;
if (!gc) {
    console.warn("run with node --expose-gc for a garbage collection between cases");
}

// Warm up every engine first so wasm tier-up and JIT compilation do not penalize whichever engine runs first.
for (const name of engines) {
    const warm = SceneById("pile-400");
    warm.steps = 120;
    RunCase(engine, modules, warm, { engine: name, sleep: true, budgetMs: 10000, workerCount });
}

const results: ICaseResult[] = [];
for (const spec of scenes) {
    for (const sleep of sleepModes) {
        // engines are interleaved within each repeat so drift (thermals, background load) hits all of them alike
        const runs = new Map<EngineName, ICaseResult[]>(engines.map((e) => [e, []]));
        for (let r = 0; r < repeats; r++) {
            for (const name of engines) {
                const previous = runs.get(name)!;
                if (previous.length && previous[previous.length - 1].stoppedEarly) {
                    continue; // too slow to repeat within the budget
                }
                gc?.();
                previous.push(RunCase(engine, modules, spec, { engine: name, sleep, budgetMs, workerCount }));
            }
        }
        for (const name of engines) {
            const median = MedianRun(runs.get(name)!);
            results.push(median);
            const q = JSON.stringify(median.quality, (_k, v) => (typeof v === "number" ? Number(v.toFixed(3)) : v));
            const workers = median.workerCount > 1 ? ` x${median.workerCount}` : "";
            console.log(
                `${spec.id.padEnd(12)} ${(EngineLabels[name] + workers).padEnd(9)} sleep ${sleep ? "on " : "off"}  step ${median.stepMean.toFixed(3)} ms  p95 ${median.stepP95.toFixed(3)}  engine ${median.engineMean.toFixed(3)}  build ${median.buildMs.toFixed(0)} ms  ${q}${median.stoppedEarly ? `  (stopped after ${median.stepsRun} steps)` : ""}`
            );
        }
    }
}

const outDir = path.join(Here, "results");
mkdirSync(outDir, { recursive: true });
const stamp = environment.date.slice(0, 10);
const suffix = workerCount > 1 ? `-${workerCount}workers` : "";
writeFileSync(path.join(outDir, `node-${stamp}${suffix}.json`), JSON.stringify({ environment, repeats, results }, null, 2));
const md = [
    `# Physics benchmark (node, ${stamp})`,
    "",
    `CPU: ${environment.cpu} (${environment.cores} logical cores), ${environment.platform}, node ${environment.node}`,
    `Babylon.js ${environment.babylon}, @babylonjs/havok ${environment.havok}, oimo ${environment.oimo}, box3d ${environment.box3d}`,
    `Time step ${environment.timestep}. ${environment.settings}. Median of ${repeats} runs.`,
    workerCount > 1
        ? `Box3D on the threaded build with ${workerCount} workers (the calling thread and ${workerCount - 1} others). Havok and Oimo are single threaded.`
        : "Every engine on one thread.",
    "",
    ResultsTable(results),
    "",
].join("\n");
writeFileSync(path.join(outDir, `node-${stamp}${suffix}.md`), md);
console.log(`\nwrote bench/results/node-${stamp}${suffix}.md`);
engine.dispose();
