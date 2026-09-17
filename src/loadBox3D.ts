// Picks a Box3D module: the plain one, or the threaded one when the page can run it.
//
// The package ships two builds of the same wasm. The default is single threaded and runs anywhere. The threaded build
// lets box3d spread a world step over its own worker threads, which is several times faster on a heavy scene, but it
// needs SharedArrayBuffer, and browsers only hand that out on a cross origin isolated page:
//
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// The threaded module is imported dynamically, so a page that never asks for threads never downloads it.

import type { Box3DModule, Box3DModuleOptions } from "babylon-box3d/wasm";

/** Options for LoadBox3D: the emscripten module options plus which build to load. */
export interface ILoadBox3DOptions extends Box3DModuleOptions {
    /**
     * Which build to load. false (the default) is the single threaded one. true is the threaded one, and fails
     * loudly if the page is not cross origin isolated. "auto" uses the threaded build where it can and falls back
     * to the single threaded one everywhere else.
     */
    threads?: boolean | "auto";
}

/**
 * Whether the threaded Box3D build can run here: the page has to be cross origin isolated, which is what gives it
 * SharedArrayBuffer. Node and bundler test environments have SharedArrayBuffer without the flag.
 * @returns true when LoadBox3D({ threads: true }) will work
 */
export function CanUseBox3DThreads(): boolean {
    if (typeof SharedArrayBuffer === "undefined") {
        return false;
    }
    const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    return isolated === undefined || isolated;
}

/**
 * Loads the Box3D WebAssembly module, optionally the threaded build.
 * The result goes to the plugin as it always does; ask the plugin for workers to put them to use:
 * ```ts
 * const box3d = await LoadBox3D({ threads: "auto" });
 * scene.enablePhysics(gravity, new Box3DPlugin(true, box3d, { workerCount: "auto" }));
 * ```
 * @param options which build to load, plus the emscripten options (locateFile and friends)
 * @returns the resolved module
 */
export async function LoadBox3D(options: ILoadBox3DOptions = {}): Promise<Box3DModule> {
    const { threads = false, ...moduleOptions } = options;
    const wantsThreads = threads === "auto" ? CanUseBox3DThreads() : threads;
    if (wantsThreads) {
        if (threads === true && !CanUseBox3DThreads()) {
            throw new Error(
                "babylon-box3d: the threaded build needs SharedArrayBuffer, which this page does not have. Serve it with the " +
                    "Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp headers, or use " +
                    'LoadBox3D({ threads: "auto" }) to fall back to the single threaded build.'
            );
        }
        const threaded = await import("babylon-box3d/wasm/threads");
        return threaded.default(moduleOptions);
    }
    const plain = await import("babylon-box3d/wasm");
    return plain.default(moduleOptions);
}
