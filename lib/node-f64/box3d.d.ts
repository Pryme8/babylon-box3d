/**
 * Type definitions for the Box3D WebAssembly module used by the Babylon.js Box3DPlugin.
 *
 * The module exposes a flat, handle based C API (see src/box3d_shim.c). Bodies, shape descriptions and joints
 * are integer slots. Vectors and quaternions are passed as individual floats. Functions that return more than one
 * value write into the scratch buffer returned by `_bx_Scratch()` (64 floats), read it through `HEAPF32`.
 *
 * World positions cross in doubles: the entry points that take one take doubles, and those that give one back also
 * write it as doubles, to `_bx_ScratchF64()` or to a double buffer beside their float records (read through
 * `HEAPF64`). The `-f64` builds (BOX3D_DOUBLE_PRECISION) hold positions in doubles, so a body far from the origin moves
 * as it does near it; the default builds hold floats, and their doubles are those floats widened.
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
    HEAPF64: Float64Array;
    HEAP32: Int32Array;
    HEAPU32: Uint32Array;
    HEAPU8: Uint8Array;
}

/** All exported shim functions. Slots are integers, 0 is the null slot. */
export interface Box3DExports {
    _malloc(bytes: number): number;
    _free(ptr: number): void;
    _bx_Scratch(): number;
    /** 16 doubles: world positions given back, see `_bx_Body_GetTransform`. */
    _bx_ScratchF64(): number;
    /** 1 in an `-f64` build, which holds world positions in doubles. */
    _bx_IsDoublePrecision(): number;
    _bx_Alloc(bytes: number): number;
    _bx_Free(ptr: number): void;
    /** major * 10000 + minor * 100 + revision */
    _bx_GetVersion(): number;

    // world
    /** Workers this build can put on a step, counting the calling thread: 1 unless this is the threaded module. */
    _bx_GetMaxWorkers(): number;
    /** workerCount counts the calling thread and is clamped to _bx_GetMaxWorkers(); box3d builds its threads here. */
    _bx_CreateWorld(gx: number, gy: number, gz: number, workerCount: number): number;
    _bx_World_GetWorkerCount(world: number): number;
    _bx_DestroyWorld(world: number): void;
    _bx_World_Step(world: number, dt: number, subSteps: number): void;
    _bx_World_SetGravity(world: number, gx: number, gy: number, gz: number): void;
    _bx_World_SetMaximumLinearSpeed(world: number, speed: number): void;
    _bx_World_GetMaximumLinearSpeed(world: number): number;
    _bx_World_EnableSleeping(world: number, flag: number): void;
    _bx_World_EnableContinuous(world: number, flag: number): void;
    /** Box3D's clock while this world steps (wasm/patches/0007), on by default: off, a step reads no clock and the stats' timings are 0. */
    _bx_World_EnableTimer(world: number, flag: number): void;
    _bx_World_IsTimerEnabled(world: number): number;
    _bx_World_SetContactTuning(world: number, hertz: number, dampingRatio: number, contactSpeed: number): void;
    /** Restitution passes after the solver, [0, 63]. Box3D's default is 2. */
    _bx_World_SetRestitutionIterations(world: number, iterations: number): void;
    _bx_World_GetRestitutionIterations(world: number): number;
    /** The restitution passes also solve contacts without restitution, so a bounce carries through what it reaches. */
    _bx_World_EnableRestitutionPropagation(world: number, flag: number): void;
    _bx_World_IsRestitutionPropagationEnabled(world: number): number;
    /** How far from isotropic, [0, 1], a body's inertia may be before its gyroscopic torque is integrated. New mass only. */
    _bx_World_SetIsotropicInertiaTolerance(world: number, tolerance: number): void;
    _bx_World_GetIsotropicInertiaTolerance(world: number): number;
    _bx_World_Explode(world: number, px: number, py: number, pz: number, radius: number, falloff: number, impulsePerArea: number): void;
    _bx_World_GetAwakeBodyCount(world: number): number;
    /** Joint force/torque threshold events from the last step (0 with the default thresholds). */
    _bx_World_GetJointEventCount(world: number): number;
    /** The most the world's step stack has held at once, in bytes. */
    _bx_World_GetStackUsed(world: number): number;
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
    /** scratch: [px, py, pz, qx, qy, qz, qw] as floats; scratchF64: [px, py, pz] as the build holds them */
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
    /** Continuous collision for this body alone, on by default; the world's switch still applies. */
    _bx_Body_EnableContinuous(body: number, flag: number): void;
    _bx_Body_IsContinuousEnabled(body: number): number;
    /** The fat AABB margin of the body's shapes, m (wasm/patches/0008): 0, the default, leaves each shape its own. */
    _bx_Body_SetAabbMargin(body: number, margin: number): void;
    _bx_Body_GetAabbMargin(body: number): number;
    /** Continuous collision sweeps a shape that moves further in a step than this fraction of its smallest extent (0.5). */
    _bx_Body_SetSafetyFactor(body: number, safetyFactor: number): void;
    _bx_Body_GetSafetyFactor(body: number): number;
    /** The velocity of a world point moving with the body, to scratch[0..2]. */
    _bx_Body_GetPointVelocity(body: number, px: number, py: number, pz: number): void;
    /** A world point in the body's frame, to scratch[0..2]. */
    _bx_Body_GetLocalPoint(body: number, px: number, py: number, pz: number): void;
    /**
     * Crushable contacts for the body's shape `index`: each of its contacts pushes with at most `maxForce` newtons,
     * and a plastic one (1) keeps its overlap instead of pushing out. A `maxForce` of zero or less makes it rigid.
     */
    _bx_Body_SetShapeCrush(body: number, index: number, maxForce: number, plastic: number): void;
    /**
     * Clips the body's contacts with the plane (nx, ny, nz, d) (wasm/patches/0006), normalized: contact points where
     * n.p + d > -2 * linearSlop, there or one separation toward the other shape, are dropped from its contacts with shapes whose category bits meet `mask`. `enabled` 0
     * removes it. Wakes the body.
     */
    _bx_Body_SetClipPlane(body: number, enabled: number, nx: number, ny: number, nz: number, d: number, mask: number): void;
    /** scratchF64: [enabled, nx, ny, nz, d, mask] */
    _bx_Body_GetClipPlane(body: number): void;
    /** scratch: [maxForce, plastic] for the body's shape `index`, zeros when it is rigid or there is no such shape. */
    _bx_Body_GetShapeCrush(body: number, index: number): void;
    /**
     * Every touching contact manifold on the body, as the body feels it, written from `_bx_BodyContactsPtr`: 48 floats
     * each, [shapeIndex, otherBody, otherShapeIndex, otherShapeDesc, normal xyz (the push on this body), friction impulse
     * xyz on this body, twist impulse, pointCount], then 4 points of 9: [x, y, z, separation, normalImpulse (last
     * substep), totalNormalImpulse (Box3D's, summed over every solver pass: nonzero means it carried load),
     * normalVelocity, triangleIndex, material]. Returns the record count.
     */
    _bx_Body_GetContacts(body: number): number;
    _bx_BodyContactsPtr(): number;
    /** The points of the records `_bx_Body_GetContacts` wrote, as doubles: 12 a record, [x, y, z] for each of its 4. */
    _bx_BodyContactPointsF64Ptr(): number;
    /** Per-shape handles: each changes one shape, resets only its contacts, and keeps every shape's index. */
    /** Replaces shape `index` with the hull of `pointCount` points (xyz floats at `points`) in the body's frame; 1 if done. */
    _bx_Body_SetShapeHull(body: number, index: number, points: number, pointCount: number): number;
    /** Moves shape `index` (a hull, sphere or capsule) by (dx, dy, dz) in the body's frame; 1 if done. */
    _bx_Body_TranslateShape(body: number, index: number, dx: number, dy: number, dz: number): number;
    _bx_Body_SetShapeFilter(body: number, index: number, categoryBits: number, maskBits: number, groupIndex: number): void;
    /** Removes shape `index`; the other shapes keep their indices. */
    _bx_Body_RemoveShape(body: number, index: number): void;
    _bx_Body_HasShape(body: number, index: number): number;
    /** scratch: [kind (0 sphere, 1 capsule, 2 hull, -1 none), vertexCount, aabb min xyz, aabb max xyz] in the body's frame */
    _bx_Body_GetShapeInfo(body: number, index: number): void;
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
    /**
     * Gives the body a feature key (an integer from 1 to 2^44 - 1; 0 takes it off) and each of its shapes, now and when
     * it is next shaped, (key << 20) | its index. New contacts are made, continuous collision sweeps and a closest
     * cast's ties are broken in the order of these keys, so keyed statics pair the same whatever order they were made in.
     */
    _bx_Body_SetFeatureKey(body: number, key: number): void;
    _bx_Body_GetFeatureKey(body: number): number;
    /** Shape `index`'s own feature key, as Box3D orders by it (exact up to 2^53). */
    _bx_Body_GetShapeFeatureKey(body: number, index: number): number;
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
    /** heights: countX * countZ floats indexed [z * countX + x]; materials: one byte a cell, (countX - 1) * (countZ - 1),
     * or 0 for none; local offset (ox, oy, oz) */
    _bx_ShapeDesc_CreateHeightField(heights: number, materials: number, countX: number, countZ: number, sx: number, sy: number, sz: number, clockwise: number, ox: number, oy: number, oz: number): number;
    /**
     * Where a mesh or height field description's data starts, and how many bytes it has (0 for any other description).
     * Box3D keeps either as one block addressed by offsets, with no pointers in it, so the bytes can be copied to another
     * instance of the same build (one with no world, on a worker) and made into a shape there with
     * `_bx_ShapeDesc_CreateMeshFromBytes` or `_bx_ShapeDesc_CreateHeightFieldFromBytes`.
     */
    _bx_ShapeDesc_GetGeometryBytes(desc: number): number;
    _bx_ShapeDesc_GetGeometryByteCount(desc: number): number;
    /** A mesh description from a copy of a mesh block put at `bytes`, with the description's scale. 0 if it is not one. */
    _bx_ShapeDesc_CreateMeshFromBytes(bytes: number, byteCount: number, sx: number, sy: number, sz: number): number;
    /** A height field description from a copy of a height field block put at `bytes`, with a local offset. 0 if it is not one. */
    _bx_ShapeDesc_CreateHeightFieldFromBytes(bytes: number, byteCount: number, ox: number, oy: number, oz: number): number;
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
    /**
     * 1 (the default): a static shape made from this description looks for its own pairs on the next step. 0: it is not
     * marked as moved in the broad phase and waits for a moving shape to find it, which spares that step's walk of the
     * static tree and pairs a static made late on the same step as one made at the start. Off on a container, it is off
     * for every shape made from its children.
     */
    _bx_ShapeDesc_SetInvokeContactCreation(desc: number, flag: number): void;
    _bx_ShapeDesc_GetInvokeContactCreation(desc: number): number;
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
    /** Moves the joint's frames to scratch[0..13], as `_bx_CreateJoint` reads them. */
    _bx_Joint_SetLocalFrames(joint: number): void;
    /** A mover joint (type 8) drives body B to this velocity relative to body A. */
    _bx_MoverJoint_SetLinearVelocity(joint: number, vx: number, vy: number, vz: number): void;
    _bx_MoverJoint_SetMaxForce(joint: number, maxForce: number): void;
    /** A pogo joint's (type 9) unit ground normal, spring, rest length and force limits. */
    _bx_PogoJoint_Set(
        joint: number,
        nx: number,
        ny: number,
        nz: number,
        hertz: number,
        dampingRatio: number,
        restLength: number,
        maxTensionForce: number,
        maxCompressionForce: number
    ): void;
    /** A pogo joint's [currentLength, currentSpeed, impulse] to scratch[0..2]. */
    _bx_PogoJoint_GetState(joint: number): void;

    // queries
    _bx_RayHitsPtr(): number;
    /** The hit points of the last ray or shape cast, as doubles: [x, y, z] a hit, beside `_bx_RayHitsPtr`'s records. */
    _bx_RayHitPointsF64Ptr(): number;
    /** Returns the hit count; hits are 11 floats each: [px, py, pz, nx, ny, nz, fraction, bodySlot, shapeDesc, triangleIndex, shapeIndex] */
    _bx_World_CastRay(world: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, categoryBits: number, maskBits: number, ignoreBody: number, hitSensors: number, closestOnly: number): number;
    /**
     * Casts the hull of `count` points (xyz floats at `points`, relative to the origin) grown by `radius` along
     * (dx, dy, dz). Hits are written as `_bx_World_CastRay` writes them, the fraction being where the surfaces touch.
     */
    _bx_World_CastShape(world: number, ox: number, oy: number, oz: number, points: number, count: number, radius: number, dx: number, dy: number, dz: number, categoryBits: number, maskBits: number, ignoreBody: number, closestOnly: number): number;
    /** Every shape the hull of the points grown by `radius` overlaps, written from `_bx_OverlapsPtr` as [bodySlot, shapeIndex, shapeDesc]. */
    _bx_World_OverlapShape(world: number, ox: number, oy: number, oz: number, points: number, count: number, radius: number, categoryBits: number, maskBits: number, ignoreBody: number): number;
    _bx_OverlapsPtr(): number;
    /** Shape `index`'s geometry in the body's frame, from `_bx_GeometryPtr`: sphere [c, r], capsule [c1, c2, r], or hull points. Returns the float count. */
    _bx_Body_GetShapeGeometry(body: number, index: number): number;
    _bx_GeometryPtr(): number;

    // character movers
    /** Collision planes, 12 floats each: [nx, ny, nz, offset, pushLimit, push, clipVelocity, px, py, pz, bodySlot, shapeIndex]. */
    _bx_MoverPlanesPtr(): number;
    _bx_GetMoverPlaneCapacity(): number;
    /** Gathers the planes between the capsule (relative to the origin) and the world into `_bx_MoverPlanesPtr`. Returns the count. */
    _bx_World_CollideMover(
        world: number,
        ox: number,
        oy: number,
        oz: number,
        c1x: number,
        c1y: number,
        c1z: number,
        c2x: number,
        c2y: number,
        c2z: number,
        radius: number,
        categoryBits: number,
        maskBits: number,
        ignoreBody: number,
        capacity: number
    ): number;
    /** The translation closest to (dx, dy, dz) the first `count` planes allow, to scratch[0..2]. Returns the iterations. */
    _bx_SolveMoverPlanes(dx: number, dy: number, dz: number, count: number): number;
    /** The vector clipped against the first `count` planes that pushed and clip velocity, to scratch[0..2]. */
    _bx_ClipMoverVector(vx: number, vy: number, vz: number, count: number): void;
    /** Casts the capsule (relative to the origin) along the translation, sliding. Returns the fraction it may move. */
    _bx_World_CastMover(
        world: number,
        ox: number,
        oy: number,
        oz: number,
        c1x: number,
        c1y: number,
        c1z: number,
        c2x: number,
        c2y: number,
        c2z: number,
        radius: number,
        dx: number,
        dy: number,
        dz: number,
        categoryBits: number,
        maskBits: number,
        ignoreBody: number
    ): number;
    /** A geometric mover moving at v pushes the dynamic body at the world point along the normal into it. Returns the impulse. */
    _bx_Body_PushFromMover(body: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, vx: number, vy: number, vz: number): number;
}

export type Box3DModule = Box3DExports & Box3DHeap;

/**
 * Instantiates the Box3D WebAssembly module.
 * @param options emscripten module options, `locateFile` is needed when the wasm is not next to the script
 * @returns the resolved module, pass it to `new Box3DPlugin(true, module)`
 */
declare function Box3D(options?: Box3DModuleOptions): Promise<Box3DModule>;

export default Box3D;
