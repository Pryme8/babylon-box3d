import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoRoot, "..");

// Runs the showcase against the plugin sources so edits hot reload.
export default defineConfig({
    root: demoRoot,
    server: { port: 5178 },
    resolve: {
        alias: [
            { find: "babylon-box3d/wasm", replacement: path.join(repoRoot, "lib/esm/box3d.js") },
            { find: "babylon-box3d", replacement: path.join(repoRoot, "src/index.ts") },
        ],
    },
    optimizeDeps: {
        // emscripten loaders use import.meta.url to find their wasm, keep them out of the pre-bundle
        exclude: ["babylon-box3d", "@babylonjs/havok"],
    },
    build: {
        outDir: path.join(repoRoot, "demo-dist"),
        emptyOutDir: true,
        rollupOptions: {
            input: {
                showcase: path.join(demoRoot, "index.html"),
                bench: path.join(demoRoot, "bench.html"),
            },
        },
    },
});
