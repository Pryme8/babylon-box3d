# babylon-box3d

[Box3D](https://github.com/erincatto/box3d), Erin Catto's 3D rigid body engine, compiled to WebAssembly for the
Babylon.js `Box3DPlugin`. This package is the Box3D counterpart of `@babylonjs/havok`: it ships the engine and a
thin C shim, the Babylon.js plugin lives in Babylon.js core.

```ts
import Box3D from "babylon-box3d";
import { Box3DPlugin } from "@babylonjs/core/Physics/v2/Plugins/box3dPlugin";

const box3d = await Box3D();
scene.enablePhysics(new Vector3(0, -9.81, 0), new Box3DPlugin(true, box3d));
```

From a script tag (UMD build, defines a global `Box3D` factory):

```html
<script src="https://cdn.jsdelivr.net/npm/babylon-box3d/lib/umd/box3d.umd.js"></script>
<script>
    const box3d = await Box3D({ locateFile: (f) => "https://cdn.jsdelivr.net/npm/babylon-box3d/lib/umd/" + f });
</script>
```

The wasm is fetched next to the loader script by default. Pass `locateFile` when it is served from somewhere else.

## Contents

| path | what |
| --- | --- |
| `lib/esm/box3d.js`, `box3d.wasm` | ES module for bundlers and browsers (default export is the factory) |
| `lib/umd/box3d.umd.js`, `box3d.umd.wasm` | script tag / CommonJS build, global `Box3D` |
| `lib/node/box3d.mjs`, `box3d.wasm` | ES module for node (`import Box3D from "babylon-box3d/node"`) |
| `box3d.d.ts` | typings for the shim API |
| `src/box3d_shim.c` | the C shim: flat, handle based API over box3d (`bx_*` functions) |
| `UPSTREAM_COMMIT` | the box3d commit that was built |

The shim keeps integer slots for bodies, shape descriptions and joints, returns multi-value results through a
scratch float buffer, and copies box3d's per step events (body moves, contacts, sensors) into flat buffers so the
plugin reads them with one typed array view. Hull data is copied into box3d's world database, mesh and height
field data are shared and reference counted.

## Building

```
node build.mjs          # release, all three targets
node build.mjs --debug  # assertions and symbols
npm test                # node smoke test against lib/node
```

Needs the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) (`EMSDK` env var, or a
checkout at `../emsdk`) and a Box3D checkout (`BOX3D_DIR`, or `../box3d`). The build is single threaded with wasm
SIMD128. Box3D's task scheduler could run on wasm threads later, that needs `SharedArrayBuffer` and cross origin
isolation, so it is not the default. Outputs are committed so the package installs without a toolchain.

## License

MIT. Box3D is MIT licensed by Erin Catto, see `LICENSE-box3d.txt`.
