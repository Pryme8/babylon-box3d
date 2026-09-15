// Diagnostic: how tall a pyramid each engine keeps standing, and whether it stays standing over a long run.
// Checked at 10 s and 30 s of simulated time (600 and 1800 fixed 1/60 s steps).
//
//   node --import tsx bench/diagnose-pyramid.ts [rows,rows,...] [engines]
//
// Earlier finding (kept for reference): adding gaps between the boxes only makes edge boxes drop and bounce for every
// engine, exact contact (as in box3d's own benchmark) is the fair setup and nothing starts overlapping.

import { readFileSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Logger } from "@babylonjs/core/Misc/logger";
import HavokPhysics from "@babylonjs/havok";
import Box3D from "../lib/node/box3d.mjs";
import { Pyramid } from "./scenes";
import { RunCase, type EngineName, type IEngineModules } from "./runner";

const Here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
Logger.LogLevels = Logger.ErrorLogLevel;

const rowsList = (process.argv[2] ?? "20,30,40,50,100").split(",").map((r) => parseInt(r, 10));
const engines = (process.argv[3] ?? "box3d,havok").split(",") as EngineName[];
const modules: IEngineModules = {
    box3d: await Box3D(),
    havok: await HavokPhysics({ wasmBinary: readFileSync(path.join(Here, "../node_modules/@babylonjs/havok/lib/esm/HavokPhysics.wasm")) }),
    oimo: require("oimo"),
};
const engine = new NullEngine();

for (const rows of rowsList) {
    for (const name of engines) {
        const line: string[] = [];
        for (const steps of [600, 1800]) {
            const result = RunCase(engine, modules, Pyramid(rows, steps), { engine: name, sleep: true, budgetMs: 240000 });
            const q = result.quality;
            line.push(`${steps / 60}s: top ${q.topHeightRetained.toFixed(2)} mean drift ${q.meanDrift.toFixed(2)} max ${q.maxDrift.toFixed(2)}`);
        }
        console.log(`rows ${String(rows).padStart(3)} ${name.padEnd(5)} ${line.join(" | ")}`);
    }
}
engine.dispose();
