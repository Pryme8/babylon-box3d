// The files that actually ship: the three loaders in lib, the wasm next to each of them, and the build in dist.
//
// Everything else in this suite imports src and lib/node, so nothing covered the pairing a browser uses, and a
// box3d.js left over from an older install next to a freshly copied box3d.wasm ran a whole game with no physics and no
// error: at -O3 emscripten renamed the wasm exports to a, b, c... and the loader bound every bx_ entry point to a
// letter, so two builds bound the same letter to different functions. The wasm keeps its export names now (exports.js
// in wasm/build.mjs), which is what the "binds its exports by name" test below is there to hold in place.

import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
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
import { describe, expect, it, vi } from "vitest";

const Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const Read = (relative: string) => readFileSync(path.join(Root, relative), "utf8");

if (!existsSync(path.join(Root, "dist", "index.js"))) {
    throw new Error("dist is not built, so the packaged build cannot be tested: run `npm run build` (npm test does it first).");
}
// the build a consumer gets, not the TypeScript the other tests import
const { Box3DPlugin } = (await import("../dist/index.js")) as any;

/** Every loader in the package and the wasm that sits next to it. */
const Loaders = [
    { name: "lib/esm/box3d.js", loader: "lib/esm/box3d.js", wasm: "lib/esm/box3d.wasm" },
    { name: "lib/umd/box3d.umd.js", loader: "lib/umd/box3d.umd.js", wasm: "lib/umd/box3d.umd.wasm" },
    { name: "lib/node/box3d.mjs", loader: "lib/node/box3d.mjs", wasm: "lib/node/box3d.wasm" },
];

/**
 * Loads one loader with one wasm file, whatever environment the loader was built for. The web loaders fetch their wasm,
 * which node cannot do for a file URL, so the binary is handed over through instantiateWasm instead. That is also what
 * makes it possible to pair a loader with a wasm on purpose.
 */
async function LoadPair(loaderPath: string, wasmPath: string): Promise<any> {
    const compiled = new WebAssembly.Module(readFileSync(path.join(Root, wasmPath)));
    const url = pathToFileURL(path.join(Root, loaderPath)).href;
    let factory: any = (await import(/* @vite-ignore */ url)).default;
    if (typeof factory !== "function") {
        // the umd build assigns module.exports; run it the way a CommonJS consumer would
        const scope = { exports: {} as any };
        new Function("module", "exports", Read(loaderPath))(scope, scope.exports);
        factory = scope.exports.default ?? scope.exports;
    }
    return factory({
        instantiateWasm: (imports: WebAssembly.Imports, success: (instance: WebAssembly.Instance) => void) => {
            const instance = new WebAssembly.Instance(compiled, imports);
            success(instance);
            return instance.exports;
        },
    });
}

/** A ground box, a box dropped above it and a ray pointing at the ground, through the packaged plugin. */
function DropAndCast(b3: any) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const plugin = new Box3DPlugin(true, b3);
    scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);

    const groundNode = new TransformNode("ground", scene);
    groundNode.position = new Vector3(0, -0.5, 0);
    groundNode.computeWorldMatrix(true);
    const ground = new PhysicsBody(groundNode, PhysicsMotionType.STATIC, false, scene);
    ground.shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(20, 1, 20), scene);

    const node = new TransformNode("probe", scene);
    node.position = new Vector3(0, 5, 0);
    node.computeWorldMatrix(true);
    const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, scene);
    body.shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(1, 1, 1), scene);
    body.setLinearVelocity(new Vector3(0, -3, 0));
    const velocity = body.getLinearVelocity().clone();

    const physicsEngine = scene.getPhysicsEngine()!;
    for (let i = 0; i < 30; i++) {
        (physicsEngine as any)._step(1 / 60);
    }
    const halfSecond = node.position.y;
    for (let i = 0; i < 120; i++) {
        (physicsEngine as any)._step(1 / 60);
    }
    // clear of the falling box, so the ray has to find the static ground body itself
    const hit = (physicsEngine as any).raycast(new Vector3(8, 4, 0), new Vector3(8, -2, 0));
    return { scene, engine, plugin, body, node, ground, velocity, halfSecond, hit };
}

describe("packaged build", () => {
    it.each(Loaders)("$name and the wasm beside it run a scene end to end", async ({ loader, wasm }) => {
        const b3 = await LoadPair(loader, wasm);
        const world = DropAndCast(b3);
        // the velocity reached the engine rather than being dropped on the floor of a no-op
        expect(world.velocity.y).toBeCloseTo(-3);
        // and the body actually fell: gravity plus the velocity it was given, then a landing on the ground box
        expect(world.halfSecond).toBeCloseTo(5 - 3 * 0.5 - 0.5 * 9.81 * 0.25, 1);
        expect(world.node.position.y).toBeCloseTo(0.5, 1);
        // a ray finds the static body, which is the other thing that silently stops working
        expect(world.hit.hasHit).toBe(true);
        expect(world.hit.body).toBe(world.ground);
        expect(b3._bx_GetRejectedSlotCount()).toBe(0);
        world.scene.dispose();
        world.engine.dispose();
    });

    it("ships one build: the same wasm and the same entry points behind every loader", () => {
        const binaries = Loaders.map(({ wasm }) => readFileSync(path.join(Root, wasm)).toString("base64"));
        expect(binaries[1]).toBe(binaries[0]);
        expect(binaries[2]).toBe(binaries[0]);

        const names = Loaders.map(({ loader }) => [...new Set(Read(loader).match(/_bx_[A-Za-z0-9_]+/g) ?? [])].sort());
        expect(names[0].length).toBeGreaterThan(100);
        expect(names[1]).toEqual(names[0]);
        expect(names[2]).toEqual(names[0]);
    });

    it("points every entry in the package export map at a file that exists", () => {
        const pkg = JSON.parse(Read("package.json"));
        const paths: string[] = [];
        const collect = (value: any) => {
            if (typeof value === "string") {
                paths.push(value);
            } else if (value && typeof value === "object") {
                Object.values(value).forEach(collect);
            }
        };
        collect(pkg.exports);
        // a wildcard entry stands for a folder, so check that instead of a file named *
        for (const relative of paths) {
            const target = relative.replace(/\/\*$/, "");
            expect(existsSync(path.join(Root, target)), `${relative} in package.json exports`).toBe(true);
        }
        // the two builds and their typings, which is what an import of babylon-box3d/wasm/threads resolves through
        expect(paths).toContain("./lib/esm-threads/box3d.js");
        expect(paths).toContain("./lib/node-threads/box3d.mjs");
    });

    it("binds its exports by name, so a loader and a wasm from two builds cannot bind the wrong functions", () => {
        for (const { loader } of Loaders) {
            const source = Read(loader);
            // wasmExports["bx_CreateWorld"], not wasmExports["G"]: without this a mismatch is silent instead of loud
            expect(source, loader).toContain('wasmExports["bx_CreateWorld"]');
            expect(source.match(/wasmExports\["[a-zA-Z$_]{1,2}"\]/g) ?? [], loader).toHaveLength(0);
        }
    });

    it("keeps dist in step with src, and the required export list in step with both", () => {
        const used = (source: string) => [...new Set(source.match(/\.(_bx_[A-Za-z0-9_]+)/g) ?? [])].map((name) => name.slice(1)).sort();
        const source = Read("src/box3dPlugin.ts");
        const usedInSource = used(source);
        expect(usedInSource.length).toBeGreaterThan(90);
        // a dist built from an older src calls a different set of entry points than the source does
        expect(used(Read("dist/box3dPlugin.js"))).toEqual(usedInSource);

        // RequiredNativeExports is what the constructor checks for, so it has to name everything the plugin calls
        const declared = source.split("const RequiredNativeExports = [")[1].split("];")[0];
        const listed = [...new Set(declared.match(/_bx_[A-Za-z0-9_]+/g) ?? [])].sort();
        expect(listed).toEqual(usedInSource);
    });

    it("refuses a loader that is missing an entry point instead of running half a world", async () => {
        const b3 = await LoadPair("lib/esm/box3d.js", "lib/esm/box3d.wasm");
        const older = Object.create(b3);
        // what an older box3d.js looks like to this build: the newest entry points simply are not there
        older._bx_Body_ComputeShapeMassData = undefined;
        older._bx_GetRejectedSlotCount = undefined;
        expect(() => new Box3DPlugin(true, older)).toThrowError(/missing 2 entry points.*_bx_Body_ComputeShapeMassData/s);
        expect(() => new Box3DPlugin(true, older)).toThrowError(/box3d.js and box3d.wasm have to come from the same build/s);
    });

    it("says once that the module did not recognize a handle instead of no-oping quietly", async () => {
        const b3 = await LoadPair("lib/esm/box3d.js", "lib/esm/box3d.wasm");
        const world = DropAndCast(b3);
        const warn = vi.spyOn(Logger, "Warn").mockImplementation(() => {});
        try {
            // a handle from another module, a destroyed body, a loader bound to the wrong functions: all arrive here
            b3._bx_Body_SetAwake(4242, 1);
            b3._bx_Body_GetTransform(4242);
            expect(b3._bx_GetRejectedSlotCount()).toBe(2);
            (world.scene.getPhysicsEngine() as any)._step(1 / 60);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain("did not recognize 2");
            // once, not once per step
            b3._bx_Body_SetAwake(4242, 1);
            (world.scene.getPhysicsEngine() as any)._step(1 / 60);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
            world.scene.dispose();
            world.engine.dispose();
        }
    });
});
