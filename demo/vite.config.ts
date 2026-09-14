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
        // the emscripten loader uses import.meta.url to find the wasm, keep it out of the pre-bundle
        exclude: ["babylon-box3d"],
    },
    build: {
        outDir: path.join(repoRoot, "demo-dist"),
        emptyOutDir: true,
    },
});
