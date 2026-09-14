// Builds the Box3D WebAssembly module and its JavaScript loaders.
//
//   node build.mjs            release build
//   node build.mjs --debug    assertions and symbols, slower
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

import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { cpus } from "os";
import path from "path";
import { fileURLToPath } from "url";

const RepoRoot = path.dirname(fileURLToPath(import.meta.url));
const Debug = process.argv.includes("--debug");
const IsWindows = process.platform === "win32";

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

const ObjDir = path.join(RepoRoot, "build", Debug ? "debug" : "release");
mkdirSync(ObjDir, { recursive: true });

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
    path.join(RepoRoot, "src", "box3d_shim.c"),
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

async function CompileAll() {
    const jobs = Sources.map((source) => {
        const object = path.join(ObjDir, path.basename(source, ".c") + ".o");
        return async () => {
            const stale = !existsSync(object) || statSync(object).mtimeMs < statSync(source).mtimeMs;
            if (!stale) {
                return;
            }
            console.log(`  cc ${path.basename(source)}`);
            const output = await Run(["-c", source, "-o", object, ...CommonFlags]);
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
    return Sources.map((source) => path.join(ObjDir, path.basename(source, ".c") + ".o"));
}

async function Link(objects, { output, environment, es6 }) {
    mkdirSync(path.dirname(output), { recursive: true });
    console.log(`  link ${path.relative(RepoRoot, output)} (${environment}${es6 ? ", es6" : ", umd"})`);
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
    ];
    if (environment.includes("web")) {
        args.push("-sMIN_SAFARI_VERSION=160400");
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

console.log(`Box3D: ${Box3dDir}`);
console.log(`Emscripten: ${EmscriptenDir}`);
const objects = await CompileAll();
await Link(objects, { output: path.join(RepoRoot, "lib", "esm", "box3d.js"), environment: "web,worker", es6: true });
await Link(objects, { output: path.join(RepoRoot, "lib", "umd", "box3d.umd.js"), environment: "web,worker", es6: false });
await Link(objects, { output: path.join(RepoRoot, "lib", "node", "box3d.mjs"), environment: "node", es6: true });
RecordUpstream();
const wasmSize = statSync(path.join(RepoRoot, "lib", "esm", "box3d.wasm")).size;
console.log(`done: lib/esm/box3d.wasm ${(wasmSize / 1024).toFixed(0)} KB`);
