// Bundles the plugin into a single script for the Playground and plain HTML pages.
//
//   <script src="https://cdn.babylonjs.com/babylon.js"></script>
//   <script src="https://unpkg.com/babylon-box3d/lib/umd/box3d.umd.js"></script>   -> global Box3D (wasm factory)
//   <script src="https://unpkg.com/babylon-box3d/umd/babylon.box3d.js"></script>   -> global BABYLONBOX3D
//
// @babylonjs/core imports are resolved to the BABYLON global and the wasm loader to the Box3D global.

import { build } from "esbuild";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(RepoRoot, "package.json"), "utf8"));

const globalsPlugin = {
    name: "babylon-globals",
    setup(build) {
        build.onResolve({ filter: /^@babylonjs\/core(\/.*)?$/ }, (args) => ({ path: args.path, namespace: "babylon-global" }));
        build.onLoad({ filter: /.*/, namespace: "babylon-global" }, () => ({
            contents: 'if (typeof BABYLON === "undefined") { throw new Error("babylon.box3d.js needs babylon.js loaded first"); } module.exports = BABYLON;',
            loader: "js",
        }));
        build.onResolve({ filter: /^babylon-box3d\/wasm$/ }, (args) => ({ path: args.path, namespace: "box3d-global" }));
        build.onLoad({ filter: /.*/, namespace: "box3d-global" }, () => ({
            contents: 'if (typeof Box3D === "undefined") { throw new Error("babylon.box3d.js needs lib/umd/box3d.umd.js loaded first"); } export default Box3D;',
            loader: "js",
        }));
        // There is no threaded script tag build: a page that loads physics from a CDN is not cross origin isolated, so
        // the threaded module could not start anyway. LoadBox3D({ threads: "auto" }) never reaches this; asking for
        // threads outright says why instead of failing on a missing file.
        build.onResolve({ filter: /^babylon-box3d\/wasm\/threads$/ }, (args) => ({ path: args.path, namespace: "box3d-threads-stub" }));
        build.onLoad({ filter: /.*/, namespace: "box3d-threads-stub" }, () => ({
            contents:
                'export default function () { throw new Error("babylon.box3d.js is the script tag build and has no threaded module. Install the package and import it, or use LoadBox3D({ threads: \\"auto\\" })."); }',
            loader: "js",
        }));
    },
};

for (const minify of [false, true]) {
    await build({
        entryPoints: [path.join(RepoRoot, "src", "index.ts")],
        bundle: true,
        format: "iife",
        globalName: "BABYLONBOX3D",
        target: "es2020",
        minify,
        sourcemap: true,
        outfile: path.join(RepoRoot, "umd", minify ? "babylon.box3d.min.js" : "babylon.box3d.js"),
        banner: { js: `/* babylon-box3d ${pkg.version} | MIT | https://github.com/Pryme8/babylon-box3d */` },
        plugins: [globalsPlugin],
        logLevel: "info",
    });
}
