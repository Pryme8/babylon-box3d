# babylon-box3d

[Box3D](https://github.com/erincatto/box3d) physics for Babylon.js. Box3D is Erin Catto's 3D successor to Box2D v3:
an MIT licensed rigid body engine with a soft step solver, continuous collision, cross platform determinism and
SIMD. This extension ships the engine compiled to WebAssembly plus `Box3DPlugin`, an implementation of Babylon's
physics v2 plugin interface, so it drops in wherever the Havok plugin is used.

```ts
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Box3D, Box3DPlugin } from "babylon-box3d";

const box3d = await Box3D();
scene.enablePhysics(new Vector3(0, -9.81, 0), new Box3DPlugin(true, box3d));
```

Script tags (Playground, plain HTML):

```html
<script src="https://cdn.babylonjs.com/babylon.js"></script>
<script src="https://unpkg.com/babylon-box3d/lib/umd/box3d.umd.js"></script>
<script src="https://unpkg.com/babylon-box3d/umd/babylon.box3d.min.js"></script>
<script>
    const box3d = await Box3D();
    scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), new BABYLONBOX3D.Box3DPlugin(true, box3d));
</script>
```

The wasm is fetched next to the loader script. With a bundler pass `locateFile`, for example with vite:
`Box3D({ locateFile: () => wasmUrl })` where `wasmUrl` is `import wasmUrl from "babylon-box3d/lib/esm/box3d.wasm?url"`.

## What is covered

| Babylon v2 | Box3D |
| --- | --- |
| `PhysicsShapeType.SPHERE`, `CAPSULE` | sphere, capsule |
| `BOX`, `CYLINDER`, `CONVEX_HULL` | convex hulls (hulls above box3d's 128 edge limit are simplified) |
| `MESH` | triangle mesh, static and animated bodies only |
| `HEIGHTFIELD` | height field, static bodies only |
| `CONTAINER` | multiple Box3D shapes on one body |
| `BALL_AND_SOCKET` | spherical joint (cone and twist limits) |
| `HINGE` | revolute joint (rotation about `axisA`) |
| `PRISMATIC`, `SLIDER` | prismatic joint |
| `LOCK` | weld joint |
| `DISTANCE` | distance joint with a fixed length of `maxDistance` |
| `SIX_DOF`, `SpringConstraint` | not supported yet |
| `COLLISION_STARTED` / `FINISHED` | contact begin / end touch events |
| `COLLISION_CONTINUED` | contact hit events (point, normal, approach speed as `impulse`) |
| `TRIGGER_ENTERED` / `EXITED` | sensor events |
| thin instances | one Box3D body per instance |

Box3D extras on the plugin: `explode`, `createWheelJoint` (suspension, steering, spin motor), `createParallelJoint`,
`setShapeFilterGroup`, `setShapeRollingResistance`, `setAllowFastRotation`, `getStats`. `PhysicsCharacterController`
is not supported yet, it depends on Havok internals.

Box3D creates shapes on bodies while Babylon creates shapes standalone, so a `PhysicsShape` is a description that
is instantiated on every body it is set on. Hull data is copied into Box3D's world database, mesh and height field
data are shared and reference counted. Only bodies reported by Box3D's move events are synced each step. Box3D is
right handed and Babylon left handed by default; no conversion is done, the simulation runs in the mirrored frame
and mesh winding is flipped, exactly like the Havok plugin.

## Layout

| path | what |
| --- | --- |
| `src/box3dPlugin.ts` | the plugin (`IPhysicsEnginePluginV2`) |
| `src/index.ts` | package entry: `Box3DPlugin`, `Box3DWheelJoint`, `Box3D` (wasm factory) |
| `wasm/box3d_shim.c` | C shim: flat, handle based API over box3d (`bx_*` functions) |
| `wasm/build.mjs` | emcc build for `lib/esm`, `lib/umd` (global `Box3D`) and `lib/node` |
| `lib/` | committed wasm builds and typings, `UPSTREAM_COMMIT` is the box3d commit |
| `umd/` | plugin bundle for script tags (global `BABYLONBOX3D`), built by `npm run build:umd` |
| `demo/` | vite showcase: `npm run demo`, then `http://localhost:5178/?demo=pyramid` |
| `docs/` | the community extension page for the Babylon.js documentation |
| `test/` | vitest unit tests with a mocked wasm module, node smoke test against the real wasm |
| `bench/` | Box3D vs Havok vs Oimo benchmark: `npm run bench` (node) or `demo/bench.html` (browser), results in `bench/results` |

Demos: `pyramid` (Box3D's Large Pyramid benchmark, thin instances, `&rows=100` for 5050 boxes, click to explode),
`ragdolls` (Erin's human ragdoll sliding down a chute), `car` (wheel joints, WASD), `destruction` (brick tower and
wrecking ball), plus `stack`, `joints`, `terrain`, `compound` feature tests. Add `&ui=0` to hide the overlay.

## Benchmarks

Box3D, Havok and Oimo build the same scenes through Babylon's regular physics API (v2 for Box3D and Havok, v1 for
Oimo), with engine defaults, a fixed 1/60 s step and nothing rendered. "Step" is Babylon's whole physics step,
"engine" is only the engine's own world step. Median of 3 interleaved runs after a warm up, AMD Ryzen 9 5900X,
Babylon.js 8.56.2, @babylonjs/havok 1.3.14, oimo 1.0.9. Mean milliseconds per step, sleep on:

| Scene | Box3D | Havok | Oimo |
| --- | ---: | ---: | ---: |
| Pyramid, 20 rows (210 boxes) | 0.09 | 0.47 | 5.94 |
| Pyramid, 50 rows (1275 boxes) | 0.89 | 7.05, collapses | 69.4, collapses |
| Pyramid, 100 rows (5050 boxes) | 31.7 | 29.9, collapses | 219, collapses |
| Pile, 1000 boxes and spheres | 3.45 | 4.26 | 33.3 |
| Pile, 4000 boxes and spheres | 22.0 | 23.8 | 196 |

- Box3D keeps every pyramid standing for 30 s of simulated time, up to 100 rows. With Babylon's default Havok setup
  a 30 row pyramid is flat within 30 s and a 50 row one within 10 s (`bench/results/pyramid-stability-*.md`).
- In the piles Havok's own world step is faster (17.7 ms vs 20.8 ms at 4000 bodies). Box3D's full Babylon step is
  faster because the plugin only syncs bodies that Box3D reports as moved.
- Chrome gives the same picture as node (`bench/results/chrome-*.md`). Full tables, including sleep off, p95 and
  max step times, are in `bench/results`. Run `npm run bench` or open `bench.html` from `npm run demo` to reproduce.

## Building

```
npm install
npm run build        # dist (ESM + d.ts) and umd bundles
npm test             # wasm smoke test + unit tests
npm run build:wasm   # rebuild the wasm, needs the Emscripten SDK (EMSDK or ../emsdk) and a box3d checkout (BOX3D_DIR or ../box3d)
```

The wasm build is single threaded with wasm SIMD128. Box3D's task scheduler could run on wasm threads later, that
needs `SharedArrayBuffer` and cross origin isolation.

## License

MIT. Box3D is MIT licensed by Erin Catto, see `LICENSE-box3d.txt`. The ragdoll data in the demo is ported from
box3d's `shared/human.c`.
