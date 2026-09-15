/* eslint-disable no-console */
// In browser version of bench/node.ts: same scenes, same runner, results as a table and copyable markdown.

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Logger } from "@babylonjs/core/Misc/logger";
import HavokPhysics from "@babylonjs/havok";
import havokWasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";
import * as OIMO from "oimo";
import Box3D from "../../lib/esm/box3d.js";
import box3dWasmUrl from "../../lib/esm/box3d.wasm?url";
import { DefaultScenes } from "../../bench/scenes";
import { EngineLabels, IsStanding, MedianRun, ResultsTable, RunCase, type EngineName, type ICaseResult, type IEngineModules } from "../../bench/runner";

Logger.LogLevels = Logger.ErrorLogLevel;

const Engines: EngineName[] = ["box3d", "havok", "oimo"];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const params = new URLSearchParams(location.search);

const scenes = DefaultScenes();
for (const spec of scenes) {
    const checked = spec.bodies.length <= 1300 ? "checked" : "";
    $("scenes").insertAdjacentHTML("beforeend", `<label><input type="checkbox" name="scene" value="${spec.id}" ${checked}/> ${spec.label}</label>`);
}
for (const name of Engines) {
    $("engines").insertAdjacentHTML("beforeend", `<label><input type="checkbox" name="engine" value="${name}" checked/> ${EngineLabels[name]}</label>`);
}

const Frame = () => new Promise((resolve) => setTimeout(resolve, 0));

function Checked(name: string): string[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>(`input[name=${name}]:checked`)).map((i) => i.value);
}

function RenderTable(results: ICaseResult[]): void {
    const table = $<HTMLTableElement>("results");
    const best = new Map<string, number>();
    for (const r of results) {
        const key = `${r.scene}-${r.sleep}`;
        best.set(key, Math.min(best.get(key) ?? Infinity, r.stepMean));
    }
    const rows = results.map((r) => {
        const q = r.quality;
        const outcome = "escaped" in q ? `${q.escaped} escaped` : `${IsStanding(q) ? "standing" : "collapsed"}, top at ${(q.topHeightRetained * 100).toFixed(0)}% height`;
        const isBest = best.get(`${r.scene}-${r.sleep}`) === r.stepMean;
        return `<tr class="${isBest ? "best" : ""}"><td>${r.sceneLabel}</td><td>${EngineLabels[r.engine]}</td><td>${r.sleep ? "on" : "off"}</td><td>${r.bodies}</td>
            <td>${r.stepMean.toFixed(2)}</td><td>${r.stepP95.toFixed(2)}</td><td>${r.stepMax.toFixed(2)}</td><td>${r.engineMean.toFixed(2)}</td><td>${r.buildMs.toFixed(0)}</td>
            <td>${outcome}${r.stoppedEarly ? ` (stopped after ${r.stepsRun} steps)` : ""}</td></tr>`;
    });
    table.innerHTML = `<tr><th>Scene</th><th>Engine</th><th>Sleep</th><th>Bodies</th><th>Step mean (ms)</th><th>p95</th><th>max</th><th>Engine only</th><th>Build (ms)</th><th>Result</th></tr>${rows.join("")}`;
}

async function Run(): Promise<void> {
    const run = $<HTMLButtonElement>("run");
    run.disabled = true;
    $<HTMLButtonElement>("copy").disabled = true;
    try {
        status.textContent = "Loading engines...";
        const modules: IEngineModules = {
            box3d: await Box3D({ locateFile: () => box3dWasmUrl }),
            havok: await HavokPhysics({ locateFile: () => havokWasmUrl }),
            oimo: OIMO,
        };
        const engine = new NullEngine();
        const engines = Checked("engine") as EngineName[];
        const selected = scenes.filter((s) => Checked("scene").includes(s.id));
        const modes: boolean[] = [];
        if ($<HTMLInputElement>("sleepOn").checked) {
            modes.push(true);
        }
        if ($<HTMLInputElement>("sleepOff").checked) {
            modes.push(false);
        }
        const repeats = Math.max(1, parseInt($<HTMLInputElement>("repeats").value, 10) || 1);
        const budgetMs = parseFloat(params.get("budget") ?? "30000");

        status.textContent = "Warming up...";
        await Frame();
        for (const name of engines) {
            const warm = scenes.find((s) => s.id === "pile-1000")!;
            RunCase(engine, modules, { ...warm, steps: 120 }, { engine: name, sleep: true, budgetMs: 10000 });
            await Frame();
        }

        const results: ICaseResult[] = [];
        for (const spec of selected) {
            for (const sleep of modes) {
                const runs = new Map<EngineName, ICaseResult[]>(engines.map((e) => [e, []]));
                for (let r = 0; r < repeats; r++) {
                    for (const name of engines) {
                        const previous = runs.get(name)!;
                        if (previous.length && previous[previous.length - 1].stoppedEarly) {
                            continue;
                        }
                        status.textContent = `${spec.label}: ${EngineLabels[name]}, sleep ${sleep ? "on" : "off"}, run ${r + 1}/${repeats}`;
                        await Frame();
                        previous.push(RunCase(engine, modules, spec, { engine: name, sleep, budgetMs }));
                    }
                }
                for (const name of engines) {
                    results.push(MedianRun(runs.get(name)!));
                }
                RenderTable(results);
            }
        }
        engine.dispose();

        const header = [
            `Browser: ${navigator.userAgent}`,
            `Logical cores: ${navigator.hardwareConcurrency}. Fixed 1/60 s step, engine defaults, median of ${repeats} run(s).`,
            "",
            "",
        ].join("\n");
        const markdown = $<HTMLTextAreaElement>("markdown");
        markdown.value = header + ResultsTable(results);
        markdown.hidden = false;
        $<HTMLButtonElement>("copy").disabled = false;
        status.textContent = "Done.";
        (window as any).benchResults = results;
    } catch (e) {
        console.error(e);
        status.textContent = `Failed: ${(e as Error).message}`;
    } finally {
        run.disabled = false;
    }
}

$("run").addEventListener("click", () => void Run());
$("copy").addEventListener("click", () => void navigator.clipboard.writeText($<HTMLTextAreaElement>("markdown").value));
if (params.get("autorun") === "1") {
    void Run();
}
