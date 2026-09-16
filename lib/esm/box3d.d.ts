/**
 * Type definitions for the Box3D WebAssembly module used by the Babylon.js Box3DPlugin.
 *
 * The module exposes a flat, handle based C API (see src/box3d_shim.c). Bodies, shape descriptions and joints
 * are integer slots. Vectors and quaternions are passed as individual floats. Functions that return more than one
 * value write into the scratch buffer returned by `_bx_Scratch()` (64 floats), read it through `HEAPF32`.
 */

export interface Box3DModuleOptions {
    /** Resolves the location of box3d.wasm (and other runtime files). */
    locateFile?: (file: string, prefix: string) => string;
    /** Called with progress and error messages by the emscripten runtime. */
    print?: (text: string) => void;
    printErr?: (text: string) => void;
    /** Supplies a pre-fetched wasm binary instead of fetching it. */
    wasmBinary?: ArrayBuffer;
}

/** Emscripten heap views. Do not cache them: they are replaced when the memory grows. */
export interface Box3DHeap {
    HEAPF32: Float32Array;
    HEAP32: Int32Array;
    HEAPU32: Uint32Array;
    HEAPU8: Uint8Array;
}

/** All exported shim functions. Slots are integers, 0 is the null slot. */
export interface Box3DExports {
    _malloc(bytes: number): number;
    _free(ptr: number): void;
    _bx_Scratch(): number;
    _bx_Alloc(bytes: number): number;
    _bx_Free(ptr: number): void;
    /** major * 10000 + minor * 100 + revision */
    _bx_GetVersion(): number;

    // world
    _bx_CreateWorld(gx: number, gy: number, gz: number): number;
    _bx_DestroyWorld(world: number): void;
    _bx_World_Step(world: number, dt: number, subSteps: number): void;
    _bx_World_SetGravity(world: number, gx: number, gy: number, gz: number): void;
    _bx_World_SetMaximumLinearSpeed(world: number, speed: number): void;
    _bx_World_GetMaximumLinearSpeed(world: number): number;
    _bx_World_EnableSleeping(world: number, flag: number): void;
    _bx_World_EnableContinuous(world: number, flag: number): void;
    _bx_World_SetContactTuning(world: number, hertz: number, dampingRatio: number, contactSpeed: number): void;
    _bx_World_Explode(world: number, px: number, py: number, pz: number, radius: number, falloff: number, impulsePerArea: number): void;
    _bx_World_GetAwakeBodyCount(world: number): number;
    /** Joint force/torque threshold events from the last step (0 with the default thresholds). */
    _bx_World_GetJointEventCount(world: number): number;
    /** scratch: [bodyCount, shapeCount, contactCount, jointCount, islandCount, stepMs, collideMs, solveMs] */
    _bx_World_GetStats(world: number): void;

    // events (records are copied into flat float buffers, see the shim for the strides)
    _bx_MoveEventsPtr(): number;
    _bx_ContactEventsPtr(): number;
    _bx_SensorEventsPtr(): number;
    _bx_World_GetMoveEvents(world: number): number;
    _bx_World_GetContactEvents(world: number): number;
    _bx_World_GetSensorEvents(world: number): number;

    // bodies (type: 0 static, 1 kinematic, 2 dynamic)
    _bx_CreateBody(world: number, type: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number, isAwake: number): number;
    _bx_DestroyBody(body: number): void;
    _bx_Body_SetType(body: number, type: number): void;
    _bx_Body_GetType(body: number): number;
    _bx_Body_SetTransform(body: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): void;
    /** scratch: [px, py, pz, qx, qy, qz, qw] */
    _bx_Body_GetTransform(body: number): void;
    _bx_Body_SetTargetTransform(body: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number, dt: number): void;
    _bx_Body_SetLinearVelocity(body: number, x: number, y: number, z: number): void;
    /** scratch: [x, y, z] */
    _bx_Body_GetLinearVelocity(body: number): void;
    _bx_Body_SetAngularVelocity(body: number, x: number, y: number, z: number): void;
    /** scratch: [x, y, z] */
    _bx_Body_GetAngularVelocity(body: number): void;
    _bx_Body_SetLinearDamping(body: number, damping: number): void;
    _bx_Body_GetLinearDamping(body: number): number;
    _bx_Body_SetAngularDamping(body: number, damping: number): void;
    _bx_Body_GetAngularDamping(body: number): number;
    _bx_Body_SetGravityScale(body: number, scale: number): void;
    _bx_Body_GetGravityScale(body: number): number;
    _bx_Body_ApplyForce(body: number, fx: number, fy: number, fz: number, px: number, py: number, pz: number): void;
    _bx_Body_ApplyForceToCenter(body: number, fx: number, fy: number, fz: number): void;
    _bx_Body_ApplyTorque(body: number, x: number, y: number, z: number): void;
    _bx_Body_ApplyLinearImpulse(body: number, ix: number, iy: number, iz: number, px: number, py: number, pz: number): void;
    _bx_Body_ApplyLinearImpulseToCenter(body: number, ix: number, iy: number, iz: number): void;
    _bx_Body_ApplyAngularImpulse(body: number, x: number, y: number, z: number): void;
    _bx_Body_SetAwake(body: number, awake: number): void;
    _bx_Body_IsAwake(body: number): number;
    _bx_Body_EnableSleep(body: number, flag: number): void;
    _bx_Body_SetBullet(body: number, flag: number): void;
    _bx_Body_AllowFastRotation(body: number, flag: number): void;
    _bx_Body_SetMotionLocks(body: number, lx: number, ly: number, lz: number, ax: number, ay: number, az: number): void;
    /** scratch: [minx, miny, minz, maxx, maxy, maxz] */
    _bx_Body_GetAABB(body: number): void;
    /** scratch: [mass, cx, cy, cz, ixx, iyy, izz, ixy, ixz, iyz] */
    _bx_Body_GetMassData(body: number): void;
    _bx_Body_SetMassData(body: number, mass: number, cx: number, cy: number, cz: number, ixx: number, iyy: number, izz: number): void;
    /** Full symmetric inertia tensor about the center of mass. */
    _bx_Body_SetMassDataFull(
        body: number,
        mass: number,
        cx: number,
        cy: number,
        cz: number,
        ixx: number,
        iyy: number,
        izz: number,
        ixy: number,
        ixz: number,
        iyz: number
    ): void;
    /** scratch: [lx, ly, lz, ax, ay, az], 1 where the motion is locked */
    _bx_Body_GetMotionLocks(body: number): void;
    /** Mass data the body's shapes would give it whatever its type (Box3D keeps mass 0 on static and kinematic bodies). */
    _bx_Body_ComputeShapeMassData(body: number): void;
    _bx_Body_ApplyMassFromShapes(body: number): void;
    _bx_Body_GetShapeCount(body: number): number;
    /** Begin/end touch events and hit events on the body's shapes, enabled separately. */
    _bx_Body_SetEventFlags(body: number, contactEvents: number, hitEvents: number): void;
    /** Bit 1: begin/end touch events, bit 2: hit events. */
    _bx_Body_GetEventFlags(body: number): number;
    /** Enables both begin/end touch and hit events. */
    _bx_Body_EnableContactEvents(body: number, flag: number): void;
    /** Replaces every shape on the body with an instance of the description (0 removes all shapes). */
    _bx_Body_SetShape(body: number, desc: number): void;
    /** Applies changed description properties (1 filter, 2 material, 4 density) to live shapes without rebuilding them. */
    _bx_Body_SyncShapeDesc(body: number, desc: number, what: number): void;
    /** Total number of box3d shapes the shim has created, to tell a rebuild from an in place update. */
    _bx_GetShapeBuildCount(): number;
    /** Live shape descriptions, including meshes baked for container children. */
    _bx_GetShapeDescCount(): number;
    /** Slot lookups the shim rejected (a handle used after it was destroyed, or a loader and a wasm from different builds). */
    _bx_GetRejectedSlotCount(): number;
    _bx_Body_GetShapeDesc(body: number): number;

    // shape descriptions
    _bx_ShapeDesc_CreateSphere(cx: number, cy: number, cz: number, radius: number): number;
    _bx_ShapeDesc_CreateCapsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): number;
    _bx_ShapeDesc_CreateBox(hx: number, hy: number, hz: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): number;
    _bx_ShapeDesc_CreateCylinder(height: number, radius: number, sides: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): number;
    /** points: pointer to pointCount * 3 floats */
    _bx_ShapeDesc_CreateHull(points: number, pointCount: number): number;
    /** vertices: vertexCount * 3 floats, indices: triangleCount * 3 int32 */
    _bx_ShapeDesc_CreateMesh(vertices: number, vertexCount: number, indices: number, triangleCount: number, sx: number, sy: number, sz: number, clockwise: number, weld: number): number;
    /** heights: countX * countZ floats indexed [z * countX + x], local offset (ox, oy, oz) */
    _bx_ShapeDesc_CreateHeightField(heights: number, countX: number, countZ: number, sx: number, sy: number, sz: number, clockwise: number, ox: number, oy: number, oz: number): number;
    _bx_ShapeDesc_CreateContainer(): number;
    _bx_ShapeDesc_AddChild(parent: number, child: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number): void;
    _bx_ShapeDesc_RemoveChild(parent: number, index: number): void;
    _bx_ShapeDesc_GetChildCount(desc: number): number;
    _bx_ShapeDesc_GetKind(desc: number): number;
    _bx_ShapeDesc_SetMaterial(desc: number, friction: number, restitution: number): void;
    _bx_ShapeDesc_GetFriction(desc: number): number;
    _bx_ShapeDesc_GetRestitution(desc: number): number;
    _bx_ShapeDesc_SetDensity(desc: number, density: number): void;
    _bx_ShapeDesc_GetDensity(desc: number): number;
    _bx_ShapeDesc_SetFilter(desc: number, categoryBits: number, maskBits: number): void;
    _bx_ShapeDesc_GetCategoryBits(desc: number): number;
    _bx_ShapeDesc_GetMaskBits(desc: number): number;
    _bx_ShapeDesc_SetGroup(desc: number, groupIndex: number): void;
    _bx_ShapeDesc_SetRollingResistance(desc: number, value: number): void;
    _bx_ShapeDesc_SetSensor(desc: number, flag: number): void;
    _bx_ShapeDesc_IsSensor(desc: number): number;
    /** scratch: [minx, miny, minz, maxx, maxy, maxz] */
    _bx_ShapeDesc_GetAABB(desc: number): void;
    _bx_ShapeDesc_Destroy(desc: number): void;
    _bx_ShapeDesc_BuildDebugGeometry(desc: number): number;
    _bx_DebugPositionsPtr(): number;
    _bx_DebugIndicesPtr(): number;
    _bx_DebugIndexCount(): number;

    // joints (type: 0 weld, 1 spherical, 2 revolute, 3 prismatic, 4 distance, 5 filter, 6 wheel, 7 parallel)
    /** Frames are read from scratch[0..13], type specific parameters from scratch[14..]. */
    _bx_CreateJoint(world: number, type: number, bodyA: number, bodyB: number, collideConnected: number, param: number): number;
    _bx_DestroyJoint(joint: number): void;
    _bx_Joint_IsValid(joint: number): number;
    _bx_Joint_SetCollideConnected(joint: number, flag: number): void;
    _bx_Joint_SetConstraintTuning(joint: number, hertz: number, dampingRatio: number): void;
    _bx_Joint_WakeBodies(joint: number): void;
    _bx_Joint_EnableLimit(joint: number, flag: number): void;
    _bx_Joint_SetLimits(joint: number, lower: number, upper: number): void;
    _bx_Joint_SetTwistLimits(joint: number, enable: number, lower: number, upper: number): void;
    _bx_Joint_EnableMotor(joint: number, flag: number): void;
    _bx_Joint_SetMotorSpeed(joint: number, speed: number): void;
    /** Spherical joints: target relative angular velocity in joint frame A, with a torque limit. */
    _bx_Joint_SetSphericalMotor(joint: number, enable: number, x: number, y: number, z: number, maxTorque: number): void;
    /** Re-converts a spherical motor target to world space, call once per step while the target is non-zero. */
    _bx_Joint_UpdateMotorFrame(joint: number): void;
    /** Spherical joints: target rotation of the spring, frame B relative to frame A. */
    _bx_Joint_SetSphericalTarget(joint: number, qx: number, qy: number, qz: number, qw: number): void;
    _bx_Joint_SetMaxMotorForce(joint: number, force: number): void;
    _bx_Joint_EnableSpring(joint: number, flag: number): void;
    _bx_Joint_SetSpring(joint: number, hertz: number, dampingRatio: number): void;
    _bx_Joint_SetTarget(joint: number, target: number): void;
    _bx_Joint_GetPosition(joint: number): number;
    /** Reads frame A from scratch[0..6] and pivot B from scratch[7..9], writes the frame B rotation to scratch[10..13]. */
    _bx_ComputeAlignedFrameB(bodyA: number, bodyB: number): void;
    _bx_WheelJoint_SetSpinMotorSpeed(joint: number, speed: number): void;
    _bx_WheelJoint_SetMaxSpinTorque(joint: number, torque: number): void;
    _bx_WheelJoint_EnableSpinMotor(joint: number, flag: number): void;
    _bx_WheelJoint_SetTargetSteeringAngle(joint: number, radians: number): void;
    _bx_WheelJoint_SetSuspension(joint: number, hertz: number, dampingRatio: number): void;

    // queries
    _bx_RayHitsPtr(): number;
    /** Returns the hit count; hits are 11 floats each: [px, py, pz, nx, ny, nz, fraction, bodySlot, shapeDesc, triangleIndex, reserved] */
    _bx_World_CastRay(world: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, categoryBits: number, maskBits: number, ignoreBody: number, hitSensors: number, closestOnly: number): number;
}

export type Box3DModule = Box3DExports & Box3DHeap;

/**
 * Instantiates the Box3D WebAssembly module.
 * @param options emscripten module options, `locateFile` is needed when the wasm is not next to the script
 * @returns the resolved module, pass it to `new Box3DPlugin(true, module)`
 */
declare function Box3D(options?: Box3DModuleOptions): Promise<Box3DModule>;

export default Box3D;
