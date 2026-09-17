// Builds the Box3D WebAssembly module and its JavaScript loaders.
//
//   node wasm/build.mjs               release build, single threaded and threaded
//   node wasm/build.mjs --debug       assertions and symbols, slower
//   node wasm/build.mjs --no-threads  skip the threaded build (faster to iterate on)
//
// Requirements:
//   * Emscripten SDK: set EMSDK, or keep a checkout at ../emsdk next to this repository.
//   * Box3D sources: set BOX3D_DIR, or keep a checkout at ../box3d next to this repository.
//     The commit that gets built is recorded in UPSTREAM_COMMIT.
//
// Outputs (all committed so consumers never need the toolchain):
//   lib/esm/box3d.js + box3d.wasm       ES module for browsers and bundlers (default export = factory)
//   lib/umd/box3d.umd.js + box3d.wasm   script tag / CommonJS build, defines a global `Box3D` factory
//   lib/node/box3d.mjs + box3d.wasm     ES module for node (tests)
//   lib/esm-threads, lib/node-threads   the same two modules built with pthreads, so box3d can put its own worker
//                                       threads on a world step. They need SharedArrayBuffer, which browsers only
//                                       hand out on a cross origin isolated page, so they are a second build rather
//                                       than the default. There is no threaded UMD build: the script tag case is the
//                                       Playground and plain pages, and those are not isolated.

import { spawn } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { cpus } from "os";
import path from "path";
import { fileURLToPath } from "url";

const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const Debug = process.argv.includes("--debug");
const SkipThreads = process.argv.includes("--no-threads");
const IsWindows = process.platform === "win32";

// Emscripten spawns this many workers when the threaded module loads, and box3d gets one more worker than that
// because it also works on the calling thread. The shim clamps its worker count to the same number, so asking for
// more never ends up creating a worker in the middle of a step. Passed to the shim as BX_WORKER_POOL.
const WorkerPoolSize = 8;

function Resolve(envName, fallback, probe) {
    const candidates = [process.env[envName], path.resolve(RepoRoot, "..", fallback)].filter(Boolean);
    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, probe))) {
            return candidate;
        }
    }
    throw new Error(`Could not find ${fallback}. Set ${envName} or clone it next to this repository.`);
}

const EmsdkDir = Resolve("EMSDK", "emsdk", "upstream/emscripten");
const Box3dDir = Resolve("BOX3D_DIR", "box3d", "include/box3d/box3d.h");
const EmscriptenDir = path.join(EmsdkDir, "upstream", "emscripten");
const Emcc = path.join(EmscriptenDir, IsWindows ? "emcc.exe" : "emcc");

// emcc needs python and node on the PATH. Prefer the ones shipped with the SDK.
function SdkToolDirs(sub) {
    const root = path.join(EmsdkDir, sub);
    if (!existsSync(root)) {
        return [];
    }
    return readdirSync(root)
        .map((name) => path.join(root, name))
        .filter((p) => statSync(p).isDirectory())
        .flatMap((p) => [p, path.join(p, "bin")])
        .filter((p) => existsSync(p));
}

const Env = {
    ...process.env,
    EMSDK: EmsdkDir,
    PATH: [EmscriptenDir, ...SdkToolDirs("python"), ...SdkToolDirs("node"), process.env.PATH ?? ""].join(path.delimiter),
};

const CommonFlags = [
    "-std=gnu17",
    "-msimd128",
    "-msse2",
    "-ffp-contract=off",
    "-fno-exceptions",
    `-I${path.join(Box3dDir, "include")}`,
    `-I${path.join(Box3dDir, "src")}`,
    ...(Debug ? ["-O1", "-g", "-DB3_ENABLE_ASSERT"] : ["-O3", "-DNDEBUG"]),
];

const Sources = [
    ...readdirSync(path.join(Box3dDir, "src"))
        .filter((name) => name.endsWith(".c"))
        .map((name) => path.join(Box3dDir, "src", name)),
    path.join(RepoRoot, "wasm", "box3d_shim.c"),
];

function Run(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(Emcc, args, { env: Env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (d) => (output += d));
        child.stderr.on("data", (d) => (output += d));
        child.on("close", (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`emcc failed (${code})\n${output}`));
            }
        });
    });
}

// Threads change the generated code (atomics, thread local storage), so the two builds cannot share object files.
async function CompileAll(objDir, extraFlags) {
    mkdirSync(objDir, { recursive: true });
    const jobs = Sources.map((source) => {
        const object = path.join(objDir, path.basename(source, ".c") + ".o");
        return async () => {
            const stale = !existsSync(object) || statSync(object).mtimeMs < statSync(source).mtimeMs;
            if (!stale) {
                return;
            }
            console.log(`  cc ${path.basename(source)}`);
            const output = await Run(["-c", source, "-o", object, ...CommonFlags, ...extraFlags]);
            if (output.trim()) {
                console.log(output.trim());
            }
        };
    });
    const workers = Math.max(1, Math.min(cpus().length, 8));
    let next = 0;
    await Promise.all(
        Array.from({ length: workers }, async () => {
            while (next < jobs.length) {
                await jobs[next++]();
            }
        })
    );
    return Sources.map((source) => path.join(objDir, path.basename(source, ".c") + ".o"));
}

async function Link(objects, { output, environment, es6, threads }) {
    mkdirSync(path.dirname(output), { recursive: true });
    console.log(`  link ${path.relative(RepoRoot, output)} (${environment}${es6 ? ", es6" : ", umd"}${threads ? ", threads" : ""})`);
    const args = [
        ...objects,
        "-o",
        output,
        ...(Debug ? ["-O1", "-g", "-sASSERTIONS=1"] : ["-O3", "-sASSERTIONS=0"]),
        "-sMODULARIZE=1",
        `-sEXPORT_ES6=${es6 ? 1 : 0}`,
        "-sEXPORT_NAME=Box3D",
        `-sENVIRONMENT=${environment}`,
        "-sALLOW_MEMORY_GROWTH=1",
        "-sINITIAL_MEMORY=33554432",
        "-sSTACK_SIZE=1048576",
        "-sFILESYSTEM=0",
        "-sEXPORTED_FUNCTIONS=_malloc,_free",
        "-sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAP32,HEAPU32,HEAPU8",
        // Keep the wasm export names. At -O3 emscripten renames them to a, b, c... and the loader binds each bx_ entry
        // point to a letter, so a box3d.js and a box3d.wasm from two different builds bind every function to its
        // neighbour and fail silently: bodies get created and never reach the world, rays hit nothing, and nothing
        // throws. Linking exports.js turns that renaming off, so the two bind by name; a mismatch is then either
        // harmless or a missing function. It costs about 2 KB in the wasm.
        "-lexports.js",
    ];
    if (environment.includes("web")) {
        args.push("-sMIN_SAFARI_VERSION=160400");
    }
    if (threads) {
        args.push("-pthread", `-sPTHREAD_POOL_SIZE=${WorkerPoolSize}`);
    }
    const result = await Run(args);
    if (result.trim()) {
        console.log(result.trim());
    }
}

function RecordUpstream() {
    const headPath = path.join(Box3dDir, ".git", "HEAD");
    if (!existsSync(headPath)) {
        return;
    }
    let ref = readFileSync(headPath, "utf8").trim();
    if (ref.startsWith("ref: ")) {
        const refPath = path.join(Box3dDir, ".git", ref.slice(5));
        ref = existsSync(refPath) ? readFileSync(refPath, "utf8").trim() : ref;
    }
    writeFileSync(path.join(RepoRoot, "UPSTREAM_COMMIT"), `${ref}\n`);
}

// One hand written declaration file describes every build; keep the copies next to the loaders that import them.
function CopyTypes(dirs) {
    const source = path.join(RepoRoot, "lib", "esm", "box3d.d.ts");
    for (const dir of dirs) {
        copyFileSync(source, path.join(RepoRoot, "lib", dir, "box3d.d.ts"));
    }
}

const BuildDir = path.join(RepoRoot, "build", Debug ? "debug" : "release");

console.log(`Box3D: ${Box3dDir}`);
console.log(`Emscripten: ${EmscriptenDir}`);
const objects = await CompileAll(BuildDir, []);
await Link(objects, { output: path.join(RepoRoot, "lib", "esm", "box3d.js"), environment: "web,worker", es6: true });
await Link(objects, { output: path.join(RepoRoot, "lib", "umd", "box3d.umd.js"), environment: "web,worker", es6: false });
await Link(objects, { output: path.join(RepoRoot, "lib", "node", "box3d.mjs"), environment: "node", es6: true });
CopyTypes(["node"]);

if (!SkipThreads) {
    const threadFlags = ["-pthread", `-DBX_WORKER_POOL=${WorkerPoolSize}`];
    const threadObjects = await CompileAll(`${BuildDir}-threads`, threadFlags);
    const threaded = { threads: true, es6: true };
    await Link(threadObjects, { output: path.join(RepoRoot, "lib", "esm-threads", "box3d.js"), environment: "web,worker", ...threaded });
    await Link(threadObjects, { output: path.join(RepoRoot, "lib", "node-threads", "box3d.mjs"), environment: "node", ...threaded });
    CopyTypes(["esm-threads", "node-threads"]);
}

RecordUpstream();
const wasmSize = statSync(path.join(RepoRoot, "lib", "esm", "box3d.wasm")).size;
console.log(`done: lib/esm/box3d.wasm ${(wasmSize / 1024).toFixed(0)} KB`);
