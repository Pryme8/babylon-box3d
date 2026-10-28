// Two Box3D builds against each other, such as a release and an upstream update, through the shim's raw API: the
// bench scenes built in both and stepped in turns of 10 steps, so a machine busy with other work slows both alike.
// Prints a Markdown table of the median engine milliseconds per step. Only the engine's step is timed, no Babylon.
//
//   git worktree add --detach ../old v0.9.0
//   node --expose-gc bench/compareBuilds.mjs ../old/lib/node/box3d.mjs lib/node/box3d.mjs 3 pyramid-50,pile-1000
import { pathToFileURL } from "url";

const [oldPath, newPath, repeatArg, sceneArg] = process.argv.slice(2);
const repeats = parseInt(repeatArg ?? "3", 10);
const builds = {
    old: await (await import(pathToFileURL(oldPath).href)).default(),
    new: await (await import(pathToFileURL(newPath).href)).default(),
};

function Prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function Euler(rx, ry, rz) {
    const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx / 2), Math.sin(rx / 2), Math.cos(ry / 2), Math.sin(ry / 2), Math.cos(rz / 2), Math.sin(rz / 2)];
    return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}

function Pyramid(rows) {
    const h = 0.5;
    const bodies = [];
    for (let i = 0; i < rows; i++) {
        for (let j = i; j < rows; j++) {
            bodies.push({ shape: "box", x: (i + 1) * h + 2 * (j - i) * h - h * rows, y: (2 * i + 1) * h, z: 0, q: [0, 0, 0, 1] });
        }
    }
    const g = Math.max(40, rows * 2 + 20);
    return { id: `pyramid-${rows}`, size: 1, statics: [[0, -0.5, 0, g, 1, g]], bodies };
}

function Pile(count) {
    const perSide = 20;
    const spacing = 1.1;
    const inner = perSide * spacing + 1;
    const half = inner / 2;
    const layers = Math.ceil(count / (perSide * perSide));
    const wall = 4 + layers * spacing * 1.2;
    const random = Prng(1234);
    const bodies = [];
    for (let n = 0; n < count; n++) {
        const layer = Math.floor(n / (perSide * perSide));
        const cell = n % (perSide * perSide);
        const ix = cell % perSide;
        const iz = Math.floor(cell / perSide);
        const x = (ix - (perSide - 1) / 2) * spacing + (random() - 0.5) * 0.1;
        const y = 2 + layer * spacing;
        const z = (iz - (perSide - 1) / 2) * spacing + (random() - 0.5) * 0.1;
        bodies.push({ shape: (ix + iz + layer) % 2 === 0 ? "box" : "sphere", x, y, z, q: Euler(random() * Math.PI, random() * Math.PI, random() * Math.PI) });
    }
    return {
        id: `pile-${count}`,
        size: 0.9,
        statics: [
            [0, -0.5, 0, inner + 4, 1, inner + 4],
            [-half - 0.5, wall / 2, 0, 1, wall, inner + 2],
            [half + 0.5, wall / 2, 0, 1, wall, inner + 2],
            [0, wall / 2, -half - 0.5, inner, wall, 1],
            [0, wall / 2, half + 0.5, inner, wall, 1],
        ],
        bodies,
    };
}

function Build(b3, scene, sleep) {
    const world = b3._bx_CreateWorld(0, -9.81, 0, 1);
    b3._bx_World_EnableSleeping(world, sleep ? 1 : 0);
    for (const [x, y, z, w, h, d] of scene.statics) {
        const desc = b3._bx_ShapeDesc_CreateBox(w / 2, h / 2, d / 2, 0, 0, 0, 0, 0, 0, 1);
        b3._bx_ShapeDesc_SetMaterial(desc, 0.6, 0);
        const body = b3._bx_CreateBody(world, 0, x, y, z, 0, 0, 0, 1, 1);
        b3._bx_Body_SetShape(body, desc);
    }
    const s = scene.size;
    const box = b3._bx_ShapeDesc_CreateBox(s / 2, s / 2, s / 2, 0, 0, 0, 0, 0, 0, 1);
    const sphere = b3._bx_ShapeDesc_CreateSphere(0, 0, 0, s / 2);
    for (const desc of [box, sphere]) {
        b3._bx_ShapeDesc_SetDensity(desc, 1000);
        b3._bx_ShapeDesc_SetMaterial(desc, 0.6, 0);
    }
    const bodies = [];
    for (const b of scene.bodies) {
        const body = b3._bx_CreateBody(world, 2, b.x, b.y, b.z, b.q[0], b.q[1], b.q[2], b.q[3], 1);
        b3._bx_Body_SetShape(body, b.shape === "box" ? box : sphere);
        b3._bx_Body_ApplyMassFromShapes(body);
        bodies.push(body);
    }
    return { world, bodies };
}

function TopY(b3, built) {
    let top = -Infinity;
    for (const body of built.bodies) {
        b3._bx_Body_GetTransform(body);
        top = Math.max(top, b3.HEAPF32[(b3._bx_Scratch() >> 2) + 1]);
    }
    return top;
}

const only = sceneArg?.split(",");
const scenes = [Pyramid(20), Pyramid(50), Pyramid(100), Pile(1000), Pile(4000)].filter((s) => !only || only.includes(s.id));
const steps = 600;
const chunk = 10;
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
console.log(`| Scene | Sleep | A ms/step | B ms/step | change | top y A / B |`);
console.log(`| --- | --- | ---: | ---: | ---: | --- |`);
for (const scene of scenes) {
    for (const sleep of [true, false]) {
        const totals = { old: [], new: [] };
        let tops = "";
        for (let r = 0; r < repeats; r++) {
            const built = { old: Build(builds.old, scene, sleep), new: Build(builds.new, scene, sleep) };
            // warm up
            for (const k of ["old", "new"]) {
                builds[k]._bx_World_Step(built[k].world, 1 / 60, 4);
            }
            const time = { old: 0, new: 0 };
            for (let c = 0; c < steps / chunk; c++) {
                const order = (c + r) % 2 === 0 ? ["old", "new"] : ["new", "old"];
                for (const k of order) {
                    const b3 = builds[k];
                    const start = performance.now();
                    for (let i = 0; i < chunk; i++) {
                        b3._bx_World_Step(built[k].world, 1 / 60, 4);
                    }
                    time[k] += performance.now() - start;
                }
            }
            for (const k of ["old", "new"]) {
                totals[k].push(time[k] / steps);
            }
            if (r === 0) {
                tops = `${TopY(builds.old, built.old).toFixed(2)} / ${TopY(builds.new, built.new).toFixed(2)}`;
            }
            for (const k of ["old", "new"]) {
                builds[k]._bx_DestroyWorld(built[k].world);
            }
            globalThis.gc?.();
        }
        const o = median(totals.old);
        const n = median(totals.new);
        console.log(`| ${scene.id} | ${sleep ? "on" : "off"} | ${o.toFixed(2)} | ${n.toFixed(2)} | ${(((n - o) / o) * 100).toFixed(0)}% | ${tops} |`);
    }
}
