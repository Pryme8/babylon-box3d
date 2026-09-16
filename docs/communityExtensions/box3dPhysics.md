---
title: Box3D Physics
image:
description: Box3D, Erin Catto's open source 3D rigid body engine, as a physics v2 plugin for Babylon.js.
keywords: extensions, physics, box3d, box2d, wasm, ragdoll, vehicle
further-reading:
    - title: Physics V2 documentation
      url: /features/featuresDeepDive/physics
    - title: Box3D repository
      url: https://github.com/erincatto/box3d
video-overview:
video-content:
---

# Box3D Physics

[babylon-box3d](https://github.com/Pryme8/babylon-box3d) brings [Box3D](https://github.com/erincatto/box3d) to Babylon.js. Box3D is Erin Catto's 3D successor to Box2D v3: an MIT licensed rigid body engine with a soft step solver, continuous collision, cross platform determinism and SIMD. The package ships the engine compiled to WebAssembly together with `Box3DPlugin`, an implementation of the physics v2 plugin interface, so everything written for the Havok plugin (`PhysicsAggregate`, `PhysicsBody`, `PhysicsShape`, constraints, events, ray casts) works unchanged.

## Features

- Static, animated and dynamic bodies, thin instances, pre step teleport and action modes
- Sphere, capsule, cylinder, box, convex hull, mesh, height field and container shapes
- Ball and socket, hinge, prismatic, slider, lock and distance constraints with limits, velocity and position motors
- `Physics6DoFConstraint` and `SpringConstraint`: the limits are mapped onto the closest Box3D joint with Havok's axis
  rules, so ragdolls with twist, cone and one sided hinge limits behave the same
- Mass properties with Havok's semantics, including inertia per unit mass and locked rotation axes
- Collision started, continued and finished events, trigger events, per body observables, Havok's event mask bits
- Ray casts with membership and collide masks
- Box3D extras: explosions, wheel joints with suspension and steering, parallel joints, collision groups, rolling resistance

Not supported yet: `PhysicsCharacterController`, which currently depends on Havok internals.

## Usage

### Installation

```
npm add @babylonjs/core babylon-box3d
```

```typescript
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Box3D, Box3DPlugin } from "babylon-box3d";

const box3d = await Box3D();
scene.enablePhysics(new Vector3(0, -9.81, 0), new Box3DPlugin(true, box3d));
```

The wasm file is fetched from the same folder as the loader script. With a bundler pass its URL explicitly:

```typescript
import wasmUrl from "babylon-box3d/lib/esm/box3d.wasm?url"; // vite

const box3d = await Box3D({ locateFile: () => wasmUrl });
```

The loader and the wasm are one build and have to stay together. An app that copies `box3d.wasm` into a folder of its
own has to refresh that copy whenever it updates the package, and clear its bundler's dependency cache with it; a
loader and a wasm from two builds cannot bind to each other, so the module fails to instantiate or `new Box3DPlugin`
throws naming the entry points that are missing.

### Script tags

```html
<script src="https://cdn.babylonjs.com/babylon.js"></script>
<script src="https://unpkg.com/babylon-box3d/lib/umd/box3d.umd.js"></script>
<script src="https://unpkg.com/babylon-box3d/umd/babylon.box3d.min.js"></script>
<script>
    const box3d = await Box3D();
    scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), new BABYLONBOX3D.Box3DPlugin(true, box3d));
</script>
```

### Playground

```javascript
const load = (src) =>
    new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = resolve;
        document.head.appendChild(script);
    });
await load("https://unpkg.com/babylon-box3d/lib/umd/box3d.umd.js");
await load("https://unpkg.com/babylon-box3d/umd/babylon.box3d.min.js");

const box3d = await Box3D();
scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), new BABYLONBOX3D.Box3DPlugin(true, box3d));

const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 20, height: 20 }, scene);
new BABYLON.PhysicsAggregate(ground, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene);
const sphere = BABYLON.MeshBuilder.CreateSphere("sphere", { diameter: 1 }, scene);
sphere.position.y = 5;
new BABYLON.PhysicsAggregate(sphere, BABYLON.PhysicsShapeType.SPHERE, { mass: 1, restitution: 0.5 }, scene);
```

### Box3D specific features

```typescript
// radial impulse on everything within 6 units
plugin.explode(position, 6, 2500);

// a car: wheel joints with suspension, steering on the front wheels and a drive motor on the rear ones
const wheel = plugin.createWheelJoint(chassisBody, wheelBody, {
    pivotA: new Vector3(1.5, -0.5, 0.8), // chassis local anchor
    axisA: Vector3.Up(), // suspension axis
    axleA: Vector3.Forward(), // axle direction in chassis space
    enableSteering: true,
    enableSpinMotor: false,
});
wheel.setSteeringAngle(0.3);
rearWheel.setSpinSpeed(-40);

// keep a body upright with a soft spring instead of locking its rotation
plugin.createParallelJoint(groundBody, chassisBody, Vector3.Up(), Vector3.Up(), 0.5, 1);

// ragdoll bones that never collide with each other
plugin.setShapeFilterGroup(boneShape, -ragdollIndex);
```

## Examples

The repository contains a showcase with a 5000 box pyramid, Box3D's human ragdoll, a drivable car and a wrecking ball demolition: `npm run demo` in a checkout, then open `http://localhost:5178/?demo=pyramid|ragdolls|car|destruction`.

## Documentation

Full documentation, the C shim source and build instructions are in the [GitHub repository](https://github.com/Pryme8/babylon-box3d).
