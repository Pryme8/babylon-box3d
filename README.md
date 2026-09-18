# babylon-box3d

[Box3D](https://github.com/erincatto/box3d) physics for Babylon.js. Box3D is Erin Catto's 3D successor to Box2D v3:
an MIT licensed rigid body engine with a soft step solver, continuous collision, cross platform determinism and
SIMD. This extension ships the engine compiled to WebAssembly plus `Box3DPlugin`, an implementation of Babylon's
physics v2 plugin interface. It supports most of the Physics V2 API, so scenes written for the Havok plugin generally
run on it unchanged; [What is covered](#what-is-covered) lists where it differs.

```ts
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent"; // adds scene.enablePhysics
import { Box3D, Box3DPlugin } from "babylon-box3d";

const box3d = await Box3D();
scene.enablePhysics(new Vector3(0, -9.81, 0), new Box3DPlugin(true, box3d));
```

Script tags (Playground, plain HTML). A complete Playground scene is in
[the documentation page](docs/communityExtensions/box3dPhysics.md#playground):

```html
<script src="https://cdn.babylonjs.com/babylon.js"></script>
<script src="https://unpkg.com/babylon-box3d/lib/umd/box3d.umd.js"></script>
<script src="https://unpkg.com/babylon-box3d/umd/babylon.box3d.min.js"></script>
<script>
    // a classic script cannot use await at the top level, so the setup runs in an async function
    (async () => {
        const box3d = await Box3D();
        scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), new BABYLONBOX3D.Box3DPlugin(true, box3d));
        // create physics bodies from here on
    })();
</script>
```

### Without npm or a build step

Like Havok's UMD build, this runs from plain files in a folder. Download these three and put them next to your page:

- [box3d.umd.js](https://unpkg.com/babylon-box3d@0.4.0/lib/umd/box3d.umd.js), the WebAssembly loader (global `Box3D`)
- [box3d.umd.wasm](https://unpkg.com/babylon-box3d@0.4.0/lib/umd/box3d.umd.wasm), the engine, found next to the loader
- [babylon.box3d.min.js](https://unpkg.com/babylon-box3d@0.4.0/umd/babylon.box3d.min.js), the plugin (global `BABYLONBOX3D`)

Then load them after `babylon.js` with the same three script tags as above, pointing at the local files. The folder
has to be opened through a web server rather than by double clicking the page: browsers refuse to load a `.wasm` from
`file://`, and Havok's wasm has the same limit. Any static server works, VS Code's Live Server or
`python -m http.server` in that folder among them; nothing runs on Node.

The wasm is fetched next to the loader script. With a bundler pass `locateFile`, for example with vite:

```ts
import { Box3D, Box3DPlugin } from "babylon-box3d";
import wasmUrl from "babylon-box3d/lib/esm/box3d.wasm?url";

const box3d = await Box3D({ locateFile: () => wasmUrl });
```

```ts
// vite.config.ts: emscripten loaders find their wasm through import.meta.url, keep them out of the pre-bundle
export default defineConfig({ optimizeDeps: { exclude: ["babylon-box3d"] } });
```

`box3d.js` and `box3d.wasm` have to come from the same install. If an app copies the wasm somewhere of its own (a
`public` folder, a CDN) and points `locateFile` at the copy, that copy has to be refreshed whenever the package is,
and a bundler's dependency cache (`node_modules/.vite`) has to be cleared with it. A loader and a wasm from different
builds cannot bind to each other: the loader fails to instantiate, or `new Box3DPlugin` throws naming the entry points
it could not find. Keeping the wasm out of any copy step, as above, avoids the question entirely.

Peer dependency: `@babylonjs/core` 8 or 9 (built and tested against 8.56.2 and 9.26.1). Babylon 9 registers
`Scene.enablePhysics` in `@babylonjs/core/Physics/joinedPhysicsEngineComponent`, so import that (or the `@babylonjs/core`
index) somewhere in the app.

### Installing a local build

```
npm run build   # dist and umd; lib (the wasm) is committed, rebuild it only after changing the shim
npm pack        # babylon-box3d-<version>.tgz
npm install ../babylon-box3d/babylon-box3d-<version>.tgz   # in the game
```

A tarball is the safest route because it carries no `node_modules`. `npm install ../babylon-box3d` works too, but npm
links the checkout, so the bundler finds the extension's own copy of `@babylonjs/core` and ships Babylon twice (the
`instanceof` checks in the plugin then fail). With a link, dedupe it:

```ts
// vite.config.ts
export default defineConfig({
    resolve: { dedupe: ["@babylonjs/core"] },
    optimizeDeps: { exclude: ["babylon-box3d"] },
});
```

## Threads

Box3D can run one world step on several threads. The package ships a second build of the wasm for that, because
threads need `SharedArrayBuffer`, and a browser only hands that out to a [cross origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
page - one served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`LoadBox3D` picks the build and the plugin asks for the workers:

```ts
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import { LoadBox3D, Box3DPlugin } from "babylon-box3d";

// "auto" uses the threaded build where the page allows it and the single threaded one everywhere else
const box3d = await LoadBox3D({ threads: "auto" });
scene.enablePhysics(new Vector3(0, -9.81, 0), new Box3DPlugin(true, box3d, { workerCount: "auto" }));
```

`workerCount` counts the thread the step is called on, so 4 means this thread and 3 others. `"auto"` asks for half
of `navigator.hardwareConcurrency`: box3d gains little from the second thread of a core, and the renderer still needs
somewhere to run. The threaded module is imported dynamically, so a page that never asks for threads never downloads
it. `CanUseBox3DThreads()` reports whether this page can run them.

Everything degrades rather than breaking. On a page that is not isolated, `threads: "auto"` loads the single threaded
build, `workerCount` is clamped to 1 and the plugin says so once in the console. `threads: true` throws instead, for
an app that would rather find out than quietly run on one thread. Isolation is a hosting decision: a static host that
cannot add response headers (GitHub Pages, for one) needs a service worker to add them, the way the hosted demo does
(`demo/public/coi-serviceworker.js`), and the headers also block cross origin
resources that do not opt in with CORS or `Cross-Origin-Resource-Policy`, which is worth checking before turning them
on for a whole site. `npm run demo` sets both headers, so the showcase runs threads with `?workers=4`.

What the threads do and do not change:

- **Results do not change.** The same scene stepped the same number of times lands on bit identical positions at any
  worker count, which is what `test/threads.test.ts` checks against the single threaded build.
- **The step still returns when it returns.** The calling thread does its share of the work and the step is over when
  the last worker is done; nothing is deferred to the next frame, so there is no extra latency and no API change.
- **Other engines run on one thread.** Havok's Babylon plugin is single threaded, so this is cores nothing else in
  Babylon is using.
- **Small scenes gain nothing.** Splitting a step costs something; under a few hundred awake bodies it is not worth
  it. Ask for workers on the scenes that need them.
- **There is no threaded script tag build.** A Playground or CDN page is not isolated, so it could not start one.

The threads themselves belong to the module, not to a world: they are created once, shared by every world, and never
joined. That is deliberate. Box3D's own scheduler creates threads with a world and joins them when it is destroyed,
and joining is what deadlocks a browser - a worker that has not finished starting cannot finish while the main thread
waits for it in `pthread_join`, and disposing a scene and building the next one in the same function is enough to
reach that. The shim hands box3d its own task system instead (`wasm/box3d_shim.c`), so worlds come and go freely.

### Tuning

- `subStepCount` (default 4, box3d's own) is the solver's sub steps per step: `new Box3DPlugin(true, box3d, {
  subStepCount: 2 })`, or `plugin.subStepCount` at any time. Tall stacks need the 4; 2 roughly halves solver time for
  scenes that are mostly loose bodies, 8 buys stiffness in exchange for time.
- `plugin.setSleepingEnabled(false)` measures raw throughput but costs a lot in a settled scene: sleeping is why a
  standing pyramid is nearly free.
- Contact events cross into JavaScript one record per contact per step. A body nothing listens to should not be
  asking for them: `body.setCollisionCallbackEnabled(false)`, which is the default.

## What is covered

| Babylon v2 | Box3D |
| --- | --- |
| `PhysicsShapeType.SPHERE`, `CAPSULE` | sphere, capsule |
| `BOX`, `CYLINDER`, `CONVEX_HULL` | convex hulls (hulls above box3d's 128 edge limit are simplified) |
| `MESH` | triangle mesh, static and animated bodies only |
| `HEIGHTFIELD` | height field, static bodies only, with holes (see below) |
| `CONTAINER` | multiple Box3D shapes on one body (a mesh child's transform is baked into a copy of its mesh data) |
| `BALL_AND_SOCKET` | spherical joint (cone and twist limits) |
| `HINGE` | revolute joint (rotation about `axisA`) |
| `PRISMATIC`, `SLIDER` | prismatic joint |
| `LOCK` | weld joint |
| `DISTANCE` | distance joint with a fixed length of `maxDistance` |
| `SIX_DOF` (`Physics6DoFConstraint`) | one Box3D joint chosen from the limits with Havok's axis rules, see below |
| `SpringConstraint` | distance joint spring (`stiffness` in N/m like Havok) |
| `COLLISION_STARTED` / `FINISHED` | contact begin / end touch events (started carries the manifold point, normal and normal impulse) |
| `COLLISION_CONTINUED` | contact hit events (point, normal, approach speed as `impulse`) |
| `TRIGGER_ENTERED` / `EXITED` | sensor events |
| thin instances | one Box3D body per instance |

**Height field holes.** Box3D height fields take a material index per cell, and 255 cuts the cell out: nothing
collides with it and rays pass through. Pass them as `heightFieldMaterials`, one per cell in the same row order as
`heightFieldData`:

```ts
import { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { BOX3D_HEIGHT_FIELD_HOLE } from "babylon-box3d";

const materials = new Uint8Array((samplesX - 1) * (samplesZ - 1));
materials[row * (samplesX - 1) + column] = BOX3D_HEIGHT_FIELD_HOLE;
const terrain = new PhysicsShape(
    {
        type: PhysicsShapeType.HEIGHTFIELD,
        parameters: {
            heightFieldSizeX: sizeX,
            heightFieldSizeZ: sizeZ,
            numHeightFieldSamplesX: samplesX,
            numHeightFieldSamplesZ: samplesZ,
            heightFieldData: heights,
            heightFieldMaterials: materials,
        },
    },
    scene,
);
```

A ray's `triangleIndex` is the height field triangle it hit, as it is for a mesh.

**Shapes from points.** `CONVEX_HULL` and `MESH` take their points straight from `positions`, as x, y, z triplets in the
body's space, when no `mesh` is given, so code with no meshes to read them from, like a headless simulation, can still
build them. A mesh also takes `positionIndices`, three per triangle, wound so the plain cross product of (b - a) and
(c - a) points out of the surface. That is Box3D's own winding, so nothing is flipped for a left handed scene:

```ts
const hull = new PhysicsShape({ type: PhysicsShapeType.CONVEX_HULL, parameters: { positions } }, scene);
const road = new PhysicsShape({ type: PhysicsShapeType.MESH, parameters: { positions, positionIndices } }, scene);
```

A `CYLINDER` runs from `pointA` to `pointB`. Before 0.3.0 it was built half its height further along its axis.

`PhysicsMassProperties` follows Havok: `inertia` is the principal moments **per unit mass** (so setting only `mass`
scales the shape's inertia with it), `inertiaOrientation` rotates those principal axes into body space, and a zero
component means infinite inertia about that axis. Box3D needs an invertible tensor, so a locked axis gets a moment
100000 times the largest free one, and when the remaining free axis is world aligned (the usual `inertia (0, 1, 0)`
upright character) Box3D's own motion locks are added on top, which makes it exact.

Event masks use Havok's bits (1 started, 2 continued, 4 finished) and only enable what they ask for: started and
finished map to Box3D's begin/end touch events, continued to its hit events, so bodies that only want one kind (every
body of a Babylon `Ragdoll`, for instance) do not pay for the others.

`SIX_DOF` limits follow Havok: an axis that is not listed is free, `minLimit === maxLimit === 0` locks it, anything
else limits it (one sided ranges such as 0..140 degrees work). The frame is `[axis, perpAxis, axis x perpAxis]` on each
body; `ANGULAR_X` is the rotation of the child frame about `axis`, `ANGULAR_Y` about `perpAxis` and `ANGULAR_Z` about
`axis x perpAxis`, right handed, in the same directions as Havok (the tests check this against Havok). Box3D has a fixed
set of joints, so the limits pick one:

| linear axes | angular axes | Box3D joint |
| --- | --- | --- |
| all locked | all locked | weld |
| all locked | one limited or free | revolute about that axis with its limits |
| all locked | two or three open | spherical: twist limits from `ANGULAR_X`, one symmetric cone from `ANGULAR_Y`/`ANGULAR_Z` |
| two locked | all locked | prismatic along the open axis |
| only `LINEAR_DISTANCE` | free | distance joint (a spring when min == max and a stiffness is set, a rope otherwise) |
| free | free | filter joint (only disables collision between the pair) |

Box3D's cone is symmetric: when the `ANGULAR_Y` and `ANGULAR_Z` ranges differ or are asymmetric the larger one is used
and a warning is logged once; cones are capped at 90 degrees. Limit `stiffness`/`damping` become Box3D's per joint
constraint softness, an approximation that applies to the whole joint. Other combinations warn once and use the closest
joint above.

`setActivationControl` follows Havok: `ALWAYS_ACTIVE` turns Box3D sleeping off for the body, `ALWAYS_INACTIVE` parks it
(it ignores impulses and velocity changes, is not woken by anything touching it and still blocks other bodies) and
`SIMULATION_CONTROLLED` hands it back to the solver, asleep until something wakes it.

Box3D extras on the plugin: `explode`, `createWheelJoint` (suspension, steering, spin motor), `createParallelJoint`,
`setShapeFilterGroup`, `setShapeRollingResistance`, `setAllowFastRotation`, `getStats`. `PhysicsCharacterController`
is not supported yet, it depends on Havok internals.

Box3D creates shapes on bodies while Babylon creates shapes standalone, so a `PhysicsShape` is a description that
is instantiated on every body it is set on. Changing its filter masks, material or density is applied to the live
Box3D shapes in place; only geometry, children and the trigger flag rebuild them. Hull data is copied into Box3D's world database, mesh and height field
data are shared and reference counted. Only bodies reported by Box3D's move events are synced each step. Box3D is
right handed and Babylon left handed by default; no conversion is done, the simulation runs in the mirrored frame
and mesh winding is flipped, exactly like the Havok plugin.

## Layout

| path | what |
| --- | --- |
| `src/box3dPlugin.ts` | the plugin (`IPhysicsEnginePluginV2`) |
| `src/index.ts` | package entry: `Box3DPlugin`, `Box3DWheelJoint`, `Box3D` (wasm factory), `LoadBox3D` |
| `src/loadBox3D.ts` | picks the single threaded or threaded wasm build for the page |
| `wasm/box3d_shim.c` | C shim: flat, handle based API over box3d (`bx_*` functions) |
| `wasm/build.mjs` | emcc build for `lib/esm`, `lib/umd` (global `Box3D`), `lib/node` and the threaded pair |
| `lib/` | committed wasm builds and typings, `UPSTREAM_COMMIT` is the box3d commit |
| `lib/esm-threads`, `lib/node-threads` | the same module built with pthreads, see [Threads](#threads) |
| `umd/` | plugin bundle for script tags (global `BABYLONBOX3D`), built by `npm run build:umd` |
| `demo/` | vite showcase: `npm run demo`, then `http://localhost:5178/?demo=pyramid` |
| `docs/` | the community extension page for the Babylon.js documentation |
| `test/` | vitest unit tests with a mocked wasm module, tests against the real wasm, node smoke test, and `packaged.test.ts` over the built `dist` and every loader in `lib` |
| `bench/` | Box3D vs Havok vs Oimo benchmark: `npm run bench` (node) or `demo/bench.html` (browser), results in `bench/results` |

The demo is published to GitHub Pages at https://pryme8.github.io/babylon-box3d/ by `.github/workflows/pages.yml`.
Pages cannot send the isolation headers threads need, so `demo/public/coi-serviceworker.js` adds them from a service
worker; that is only needed because of the host, and an app that controls its own headers does not want it.

Demos: `pyramid` (Box3D's Large Pyramid benchmark, thin instances, `&rows=100` for 5050 boxes, click to explode),
`ragdolls` (Erin's human ragdoll sliding down a chute), `car` (wheel joints, WASD), `destruction` (brick tower and
wrecking ball), plus `stack`, `joints`, `terrain`, `compound` feature tests. Add `&ui=0` to hide the overlay.

## Benchmarks

Box3D, Havok and Oimo build the same scenes through Babylon's regular physics API (v2 for Box3D and Havok, v1 for
Oimo), with engine defaults, a fixed 1/60 s step and nothing rendered. "Step" is Babylon's whole physics step,
"engine" is only the engine's own world step. Median of 3 interleaved runs after a warm up, AMD Ryzen 9 5900X,
Babylon.js 9.26.1, @babylonjs/havok 1.3.14, oimo 1.0.9, node 24. Mean milliseconds per step, sleep on, every engine
on one thread (2026-09-17):

| Scene | Box3D | Havok | Oimo |
| --- | ---: | ---: | ---: |
| Pyramid, 20 rows (210 boxes) | 0.09 | 0.51 | 6.3 |
| Pyramid, 50 rows (1275 boxes) | 0.98 | 7.45, collapses | 68.2, collapses |
| Pyramid, 100 rows (5050 boxes) | 28.2 | 27.5, collapses | 174, collapses |
| Pile, 1000 boxes and spheres | 3.44 | 4.48 | 31.3 |
| Pile, 4000 boxes and spheres | 20.9 | 22.0 | 183 |

The same Box3D scenes on the threaded build. Havok and Oimo have no equivalent, so this is time the other two cannot
take back:

| Scene | 1 thread | 4 workers | 8 workers |
| --- | ---: | ---: | ---: |
| Pyramid, 20 rows (210 boxes) | 0.09 | 0.05 | 0.11 |
| Pyramid, 50 rows (1275 boxes) | 0.98 | 0.42 | 0.34 |
| Pyramid, 100 rows (5050 boxes) | 28.2 | 7.55 | 5.72 |
| Pile, 1000 boxes and spheres | 3.44 | 1.38 | 1.65 |
| Pile, 4000 boxes and spheres | 20.9 | 7.21 | 6.31 |

- Box3D keeps every pyramid standing for 30 s of simulated time, up to 100 rows. With Babylon's default Havok setup
  a 30 row pyramid is flat within 30 s and a 50 row one within 10 s (`bench/results/pyramid-stability-*.md`).
- In the piles Havok's own world step is faster on one thread (15.7 ms vs 19.5 ms at 4000 bodies). Box3D's full
  Babylon step is faster because the plugin only syncs bodies that Box3D reports as moved.
- The 210 box pyramid is slower with 8 workers than with none, and the 1000 body pile is better at 4 than at 8:
  splitting a step is not free, and the scenes that pay for it are the big ones.
- Every threaded run ends in the same state as the single threaded one. The result column in all three tables is
  identical, drift and pile height included, which is the determinism claim holding at 5050 bodies.
- Chrome tells the same story, threads included: 23.6 ms to 7.5 ms on the 100 row pyramid, 23.6 ms to 6.8 ms on the
  4000 body pile at 8 workers. The one place it differs is that pile on one thread, where Chrome puts Havok's full
  step ahead of Box3D's (20.6 ms against 23.6 ms) while node has them the other way round (`bench/results/chrome-*.md`).
- Full tables, including sleep off, p95 and max step times, are in `bench/results`. Run `npm run bench`,
  `npm run bench -- --workers 4`, or open `bench.html` from `npm run demo` and set the worker count there.

## Building

```
npm install
npm run build        # dist (ESM + d.ts) and umd bundles
npm test             # wasm smoke test + unit and real wasm tests
npm run build:wasm   # rebuild the wasm, needs the Emscripten SDK (EMSDK or ../emsdk) and a box3d checkout (BOX3D_DIR or ../box3d)
```

`npm test` runs the node smoke test against the shim, unit tests with a mocked wasm module, and tests that drive the
plugin through Babylon's own classes against the real wasm: constraints, events, shapes, filtering, mass properties,
activation and a zombie ragdoll (18 jointed boxes dropped and stepped for 10 s). Several of them build the same scene
with Havok and compare, which is what pins the Havok compatible behaviour down.

`npm run build:wasm` produces both builds: the single threaded one in `lib/esm`, `lib/umd` and `lib/node`, and the
threaded one in `lib/esm-threads` and `lib/node-threads`. Add `--no-threads` to skip the second while iterating on the
shim. Both are wasm SIMD128; the threaded one adds `-pthread` and a pool of 8 workers, which is the cap the shim
clamps `workerCount` to. `npm run bench -- --workers 4` runs the benchmark on it.

## License

MIT. Box3D is MIT licensed by Erin Catto, see `LICENSE-box3d.txt`. The ragdoll data in the demo is ported from
box3d's `shared/human.c`.
