import path from "node:path";
import { defineConfig } from "vitest/config";

// `BOX3D_FLAVOUR=f64 npx vitest run` runs the suite on the double precision builds: every import of a node loader is
// sent to its -f64 twin, except in wasm.largeWorld.test.ts, which compares the two flavours and names both.
const F64 = process.env.BOX3D_FLAVOUR === "f64";
const TWINS: Record<string, string> = {
    "lib/node/box3d.mjs": "lib/node-f64/box3d.mjs",
    "lib/node-threads/box3d.mjs": "lib/node-f64-threads/box3d.mjs",
};

export default defineConfig({
    plugins: [
        {
            name: "box3d-flavour",
            enforce: "pre",
            resolveId(source, importer) {
                if (!F64 || importer === undefined || importer.includes("wasm.largeWorld")) {
                    return null;
                }
                for (const [from, to] of Object.entries(TWINS)) {
                    if (source.endsWith(from)) {
                        return path.resolve(path.dirname(importer), source.slice(0, source.length - from.length) + to);
                    }
                }
                return null;
            },
        },
    ],
});
