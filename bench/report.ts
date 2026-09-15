// Regenerates the markdown report from a results json without rerunning the benchmark.
//   node --import tsx bench/report.ts bench/results/node-2026-09-15.json

import { readFileSync, writeFileSync } from "fs";
import { ResultsTable } from "./runner";

const file = process.argv[2];
const { environment, repeats, results } = JSON.parse(readFileSync(file, "utf8"));
const stamp = environment.date.slice(0, 10);
const md = [
    `# Physics benchmark (node, ${stamp})`,
    "",
    `CPU: ${environment.cpu} (${environment.cores} logical cores), ${environment.platform}, node ${environment.node}`,
    `Babylon.js ${environment.babylon}, @babylonjs/havok ${environment.havok}, oimo ${environment.oimo}, box3d ${environment.box3d}`,
    `Time step ${environment.timestep}. ${environment.settings}. Median of ${repeats} runs.`,
    "",
    ResultsTable(results),
    "",
].join("\n");
writeFileSync(file.replace(/\.json$/, ".md"), md);
console.log(md);
