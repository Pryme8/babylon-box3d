import { Matrix, Quaternion, TmpVectors, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import {
    type IPhysicsEnginePluginV2,
    type PhysicsMassProperties,
    type PhysicsShapeParameters,
    type ConstrainedBodyPair,
    type IPhysicsCollisionEvent,
    type IBasePhysicsCollisionEvent,
    PhysicsShapeType,
    PhysicsConstraintType,
    PhysicsMotionType,
    PhysicsConstraintAxis,
    PhysicsConstraintAxisLimitMode,
    PhysicsConstraintMotorType,
    PhysicsEventType,
    PhysicsPrestepType,
    PhysicsActivationControl,
} from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult.js";
import { type IRaycastQuery } from "@babylonjs/core/Physics/physicsRaycastResult.js";
import { Logger } from "@babylonjs/core/Misc/logger.js";
import { type PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { type PhysicsConstraint, type Physics6DoFConstraint, type Physics6DoFLimit } from "@babylonjs/core/Physics/v2/physicsConstraint.js";
import { type PhysicsMaterial } from "@babylonjs/core/Physics/v2/physicsMaterial.js";
import { type PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { BoundingBox } from "@babylonjs/core/Culling/boundingBox.js";
import { type TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { Observable } from "@babylonjs/core/Misc/observable.js";
import { type Nullable, type FloatArray } from "@babylonjs/core/types.js";

/** The cell material that cuts a hole in a height field: nothing collides with the cell and rays pass through it. */
export const BOX3D_HEIGHT_FIELD_HOLE = 255;

declare module "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js" {
    interface PhysicsShapeParameters {
        /**
         * Box3D height fields only: a material index for every cell, `(numHeightFieldSamplesX - 1) *
         * (numHeightFieldSamplesZ - 1)` of them, rows in the same order as `heightFieldData`. A cell of
         * `BOX3D_HEIGHT_FIELD_HOLE` (255) is a hole. The index is also what `userMaterialId` would carry in Box3D, so
         * keep it below 255 for solid ground.
         */
        heightFieldMaterials?: ArrayLike<number>;
        /**
         * `CONVEX_HULL` and `MESH` without a `mesh`: the points as x, y, z triplets in the body's space, for code that
         * builds shapes with no meshes to read them from, like a headless simulation.
         */
        positions?: ArrayLike<number>;
        /**
         * `MESH` with `positions`: three indices into the points per triangle, wound so the plain cross product of
         * (b - a) and (c - a) points out of the surface. That is Box3D's own winding, and it is used as given: no
         * flip for a left handed scene, which only applies to winding read from a Babylon mesh.
         */
        positionIndices?: ArrayLike<number>;
    }
}

/**
 * Per body plugin data. One instance per Box3D body (thin instances get one each).
 */
class Box3DBodyData {
    public constructor(
        /** slot handle inside the WASM shim */
        public slot: number
    ) {}
    public userMassProps: PhysicsMassProperties = {};
    /** Box3D angular motion locks currently set on the body, bits x, y, z */
    public angularLocks = 0;
    /** Havok's EventType bits: 1 collision started, 2 collision continued, 4 collision finished */
    public eventMask = 0;
    public motionType = PhysicsMotionType.STATIC;
    /** Babylon activation control; ALWAYS_INACTIVE parks the body as a static Box3D body, see setActivationControl */
    public activation = PhysicsActivationControl.SIMULATION_CONTROLLED;
}

/**
 * Per shape plugin data. A Babylon shape is a description that gets instantiated on each body it is set on.
 */
class Box3DShapeData {
    public constructor(
        public slot: number,
        public type: PhysicsShapeType
    ) {}
    public material: PhysicsMaterial = {};
    /** bodies currently instantiating this shape, refreshed when the description changes */
    public users = new Set<Box3DBodyData>();
    /** for containers: child shapes, so changes propagate to users */
    public children: Box3DShapeData[] = [];
    public parents = new Set<Box3DShapeData>();
}

/** Axis state kept on the JS side because box3d has no generic axis API. */
interface IAxisState {
    mode: PhysicsConstraintAxisLimitMode;
    min: number;
    max: number;
    motor: PhysicsConstraintMotorType;
    target: number;
    maxForce: number;
    friction: number;
    /** Physics6DoFLimit.stiffness: spring constant of a soft limit (N/m, or N*m/rad for angular axes) */
    stiffness: number;
    /** Physics6DoFLimit.damping */
    damping: number;
}

/**
 * How a SIX_DOF constraint is realised with Box3D's fixed joint types. Recomputed from the axis table whenever an axis
 * changes, and reused as is when a disabled constraint is enabled again.
 */
interface ISixDofPlan {
    jointType: Box3DJointType;
    /** Box3D frame x, y, z as indices into the constraint basis [axis, perpAxis, axis x perpAxis], null for identity frames */
    basis: Nullable<[number, number, number]>;
    /** the Babylon axis that follows the single degree of freedom of a revolute, prismatic or distance joint */
    primaryAxis: Nullable<PhysicsConstraintAxis>;
    /** spherical cone angle, negative when the swing is free */
    coneAngle: number;
    /** spherical twist limits (about axis), null when free */
    twist: Nullable<[number, number]>;
    /** revolute angle, prismatic translation or distance length limits, null when free */
    limit: Nullable<[number, number]>;
    /** distance joints: a real spring at rest length limit[0] instead of a rope between the limits */
    spring: boolean;
    /** stiffest soft limit, mapped to Box3D spring or constraint softness per body pair */
    stiffness: number;
    damping: number;
    angularStiffness: boolean;
}

class Box3DConstraintData {
    public joints: number[] = [];
    public pairs: Array<{ parent: PhysicsBody; parentIndex: number; child: PhysicsBody; childIndex: number; parentData: Box3DBodyData; childData: Box3DBodyData }> = [];
    public type: PhysicsConstraintType = PhysicsConstraintType.LOCK;
    public jointType = 0;
    public enabled = true;
    public collisions = false;
    public frames = new Float32Array(14);
    public length = 0;
    public axes = new Map<PhysicsConstraintAxis, IAxisState>();
    /** SIX_DOF only */
    public plan: Nullable<ISixDofPlan> = null;
}

// shim joint types
const enum Box3DJointType {
    WELD = 0,
    SPHERICAL = 1,
    REVOLUTE = 2,
    PRISMATIC = 3,
    DISTANCE = 4,
    FILTER = 5,
    WHEEL = 6,
    PARALLEL = 7,
}

/**
 * Options for a Box3D wheel joint (Box3D specific, no Babylon equivalent).
 * The suspension travels along axisA (chassis space), the wheel spins about spinAxisB (wheel space)
 * and steers about the suspension axis.
 */
export interface IBox3DWheelJointOptions {
    /** anchor on the chassis, chassis local space */
    pivotA: Vector3;
    /** suspension axis in chassis local space (usually up) */
    axisA?: Vector3;
    /** axle direction in chassis local space, the wheel spins about it (default +z) */
    axleA?: Vector3;
    /** anchor on the wheel, wheel local space */
    pivotB?: Vector3;
    /** suspension spring stiffness in hertz */
    suspensionHertz?: number;
    /** suspension spring damping ratio */
    suspensionDampingRatio?: number;
    /** suspension travel limits along axisA */
    suspensionLimits?: [number, number];
    /** whether the wheel is driven */
    enableSpinMotor?: boolean;
    /** maximum drive torque */
    maxSpinTorque?: number;
    /** whether the wheel steers */
    enableSteering?: boolean;
    /** steering spring stiffness in hertz */
    steeringHertz?: number;
    /** steering spring damping ratio */
    steeringDampingRatio?: number;
    /** maximum steering torque */
    maxSteeringTorque?: number;
    /** steering angle limits in radians */
    steeringLimits?: [number, number];
}

/**
 * Handle to a Box3D wheel joint created with Box3DPlugin.createWheelJoint.
 */
export class Box3DWheelJoint {
    /**
     * @internal
     */
    public constructor(
        private _plugin: Box3DPlugin,
        /** @internal */
        public _slot: number
    ) {}

    /**
     * Sets the target angular speed of the spin motor.
     * @param speed radians per second
     */
    public setSpinSpeed(speed: number): void {
        this._plugin._wheelCall("_bx_WheelJoint_SetSpinMotorSpeed", this._slot, speed);
    }

    /**
     * Sets the maximum torque the spin motor can apply.
     * @param torque newton meters
     */
    public setMaxSpinTorque(torque: number): void {
        this._plugin._wheelCall("_bx_WheelJoint_SetMaxSpinTorque", this._slot, torque);
    }

    /**
     * Enables or disables the spin motor (disabled wheels roll freely).
     * @param enabled true to enable
     */
    public enableSpinMotor(enabled: boolean): void {
        this._plugin._wheelCall("_bx_WheelJoint_EnableSpinMotor", this._slot, enabled ? 1 : 0);
    }

    /**
     * Sets the target steering angle.
     * @param radians steering angle
     */
    public setSteeringAngle(radians: number): void {
        this._plugin._wheelCall("_bx_WheelJoint_SetTargetSteeringAngle", this._slot, radians);
    }

    /**
     * Tunes the suspension spring.
     * @param hertz stiffness
     * @param dampingRatio damping ratio
     */
    public setSuspension(hertz: number, dampingRatio: number): void {
        this._plugin._wheelCall("_bx_WheelJoint_SetSuspension", this._slot, hertz, dampingRatio);
    }

    /**
     * Removes the joint.
     */
    public dispose(): void {
        this._plugin._destroyExtraJoint(this._slot);
        this._slot = 0;
    }
}

/**
 * Body event mask bits, the same values Havok's plugin uses so masks can be copied over from Havok code.
 * Box3D reports begin and end touch events together (they are one shape flag) and hit events separately.
 */
const enum Box3DEventBits {
    COLLISION_STARTED = 1,
    COLLISION_CONTINUED = 2,
    COLLISION_FINISHED = 4,
    ALL = 7,
}

/**
 * How much heavier a locked rotation axis is made than the heaviest free one. Babylon locks an axis with a zero inertia
 * component, Box3D needs an invertible tensor; 1e5 leaves a body a hundred thousand times harder to turn about that axis
 * while the tensor stays well conditioned in float32.
 */
const LockedInertiaRatio = 1e5;

/**
 * Diagonalizes a symmetric inertia tensor [ixx, iyy, izz, ixy, ixz, iyz] into its principal moments and the rotation
 * that turns principal axes into body axes (Babylon's inertiaOrientation). Jacobi rotations, a few sweeps are plenty for
 * a 3x3, and the common diagonal case exits immediately.
 */
function DiagonalizeInertia(tensor: ArrayLike<number>, moments: Vector3, orientation: Quaternion): void {
    const a = [
        [tensor[0], tensor[3], tensor[4]],
        [tensor[3], tensor[1], tensor[5]],
        [tensor[4], tensor[5], tensor[2]],
    ];
    orientation.set(0, 0, 0, 1);
    moments.set(tensor[0], tensor[1], tensor[2]);
    const q = [0, 0, 0, 1];
    for (let sweep = 0; sweep < 24; sweep++) {
        // rotation matrix of q, columns are the current principal axes
        const [x, y, z, w] = q;
        const r = [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ];
        // d = transpose(r) * a * r
        const d = [0, 1, 2].map((i) => [0, 1, 2].map((j) => [0, 1, 2].reduce((sum, k) => sum + r[k][i] * [0, 1, 2].reduce((s2, l) => s2 + a[k][l] * r[l][j], 0), 0)));
        moments.set(d[0][0], d[1][1], d[2][2]);
        orientation.set(q[0], q[1], q[2], q[3]);
        const offDiagonal = [Math.abs(d[1][2]), Math.abs(d[0][2]), Math.abs(d[0][1])];
        const k = offDiagonal.indexOf(Math.max(...offDiagonal));
        const k1 = (k + 1) % 3;
        const k2 = (k + 2) % 3;
        const off = d[k1][k2];
        const scale = Math.abs(d[0][0]) + Math.abs(d[1][1]) + Math.abs(d[2][2]) + 1e-30;
        if (Math.abs(off) <= 1e-9 * scale) {
            return;
        }
        let theta = (d[k2][k2] - d[k1][k1]) / (2 * off);
        const sign = theta > 0 ? 1 : -1;
        theta *= sign;
        const t = sign / (theta + (theta < 1e6 ? Math.sqrt(theta * theta + 1) : theta));
        const c = 1 / Math.sqrt(t * t + 1);
        if (c === 1) {
            return;
        }
        const jacobi = [0, 0, 0, 0];
        // d is transpose(r) * a * r and the step right multiplies q, so d becomes transpose(jacobi) * d * jacobi: the
        // quaternion has to turn by -theta where the matrix form of the Jacobi rotation turns by +theta. With the other
        // sign every sweep puts the off diagonal term straight back and the loop never converges.
        jacobi[k] = -sign * Math.sqrt((1 - c) / 2);
        jacobi[3] = Math.sqrt(1 - jacobi[k] * jacobi[k]);
        // q = q * jacobi
        const [qx, qy, qz, qw] = q;
        const [jx, jy, jz, jw] = jacobi;
        q[0] = qw * jx + qx * jw + qy * jz - qz * jy;
        q[1] = qw * jy - qx * jz + qy * jw + qz * jx;
        q[2] = qw * jz + qx * jy - qy * jx + qz * jw;
        q[3] = qw * jw - qx * jx - qy * jy - qz * jz;
        const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
        for (let i = 0; i < 4; i++) {
            q[i] /= length;
        }
    }
}

/** Builds the symmetric tensor [ixx, iyy, izz, ixy, ixz, iyz] of principal moments rotated into body space. */
function ComposeInertia(moments: ArrayLike<number>, orientation: Quaternion): number[] {
    const { x, y, z, w } = orientation;
    const r = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
    const at = (i: number, j: number) => r[i][0] * moments[0] * r[j][0] + r[i][1] * moments[1] * r[j][1] + r[i][2] * moments[2] * r[j][2];
    return [at(0, 0), at(1, 1), at(2, 2), at(0, 1), at(0, 2), at(1, 2)];
}

/** Shape description properties that Box3D can change on live shapes, see bx_Body_SyncShapeDesc. */
const enum Box3DShapeSync {
    FILTER = 1,
    MATERIAL = 2,
    DENSITY = 4,
}

const MOVE_STRIDE = 9;
const CONTACT_STRIDE = 12;
const SENSOR_STRIDE = 5;
const RAY_STRIDE = 11;

/**
 * Collects mesh geometry in the physics body's local space (scaling baked in).
 */
class MeshGeometryAccumulator {
    private _vertices: number[] = [];
    private _indices: number[] = [];

    public constructor(
        private _collectIndices: boolean,
        private _flipWinding: boolean
    ) {}

    public addNodeMeshes(mesh: TransformNode, includeChildren: boolean): void {
        mesh.computeWorldMatrix(true);
        const rootScaled = TmpVectors.Matrix[0];
        Matrix.ScalingToRef(mesh.absoluteScaling.x, mesh.absoluteScaling.y, mesh.absoluteScaling.z, rootScaled);
        if (mesh instanceof Mesh) {
            this._addMesh(mesh, rootScaled);
        } else if (mesh instanceof InstancedMesh) {
            this._addMesh(mesh.sourceMesh, rootScaled);
        }
        if (includeChildren) {
            const worldToRoot = TmpVectors.Matrix[1];
            mesh.computeWorldMatrix().invertToRef(worldToRoot);
            const worldToRootScaled = TmpVectors.Matrix[2];
            worldToRoot.multiplyToRef(rootScaled, worldToRootScaled);
            const children = mesh.getChildMeshes(false).filter((m: any) => !m.physicsBody);
            for (const m of children) {
                const childToWorld = m.computeWorldMatrix();
                const childToRootScaled = TmpVectors.Matrix[3];
                childToWorld.multiplyToRef(worldToRootScaled, childToRootScaled);
                if (m instanceof Mesh) {
                    this._addMesh(m, childToRootScaled);
                } else if (m instanceof InstancedMesh) {
                    this._addMesh(m.sourceMesh, childToRootScaled);
                }
            }
        }
    }

    private _addMesh(mesh: Mesh, meshToRoot: Matrix): void {
        const vertexData = mesh.getVerticesData(VertexBuffer.PositionKind) || [];
        const numVerts = vertexData.length / 3;
        const indexOffset = this._vertices.length / 3;
        const p = TmpVectors.Vector3[0];
        for (let v = 0; v < numVerts; v++) {
            p.set(vertexData[v * 3 + 0], vertexData[v * 3 + 1], vertexData[v * 3 + 2]);
            Vector3.TransformCoordinatesToRef(p, meshToRoot, p);
            this._vertices.push(p.x, p.y, p.z);
        }
        if (this._collectIndices) {
            const meshIndices = mesh.getIndices();
            if (meshIndices) {
                for (let i = 0; i < meshIndices.length; i += 3) {
                    if (this._flipWinding) {
                        this._indices.push(meshIndices[i + 2] + indexOffset, meshIndices[i + 1] + indexOffset, meshIndices[i + 0] + indexOffset);
                    } else {
                        this._indices.push(meshIndices[i + 0] + indexOffset, meshIndices[i + 1] + indexOffset, meshIndices[i + 2] + indexOffset);
                    }
                }
            }
        }
    }

    public get vertexCount(): number {
        return this._vertices.length / 3;
    }

    public get triangleCount(): number {
        return this._indices.length / 3;
    }

    public get vertices(): number[] {
        return this._vertices;
    }

    public get indices(): number[] {
        return this._indices;
    }
}

/**
 * Every native entry point the plugin calls. The constructor checks that the module has all of them, because the two ways this goes wrong
 * in practice - a box3d.js loader left behind by an older install, or a box3d.wasm served from a stale copy - otherwise turn into a physics
 * world where nothing ever happens. A test keeps the list in step with the code.
 */
const RequiredNativeExports = [
    "_bx_Body_AllowFastRotation", "_bx_Body_ApplyAngularImpulse", "_bx_Body_ApplyForce", "_bx_Body_ApplyLinearImpulse",
    "_bx_Body_ApplyMassFromShapes", "_bx_Body_ApplyTorque", "_bx_Body_ComputeShapeMassData", "_bx_Body_EnableSleep", "_bx_Body_GetAABB",
    "_bx_Body_GetAngularDamping", "_bx_Body_GetAngularVelocity", "_bx_Body_GetGravityScale", "_bx_Body_GetLinearDamping",
    "_bx_Body_GetLinearVelocity", "_bx_Body_GetMassData", "_bx_Body_GetTransform", "_bx_Body_SetAngularDamping", "_bx_Body_SetAngularVelocity",
    "_bx_Body_SetAwake", "_bx_Body_SetEventFlags", "_bx_Body_SetGravityScale", "_bx_Body_SetLinearDamping", "_bx_Body_SetLinearVelocity",
    "_bx_Body_SetMassDataFull", "_bx_Body_SetMotionLocks", "_bx_Body_SetShape", "_bx_Body_SetTargetTransform", "_bx_Body_SetTransform",
    "_bx_Body_SetType", "_bx_Body_SyncShapeDesc", "_bx_ComputeAlignedFrameB", "_bx_ContactEventsPtr", "_bx_CreateBody", "_bx_CreateJoint",
    "_bx_CreateWorld", "_bx_DebugIndexCount", "_bx_DebugIndicesPtr", "_bx_DebugPositionsPtr", "_bx_DestroyBody", "_bx_DestroyJoint",
    "_bx_DestroyWorld", "_bx_GetMaxWorkers", "_bx_GetRejectedSlotCount", "_bx_Joint_EnableLimit", "_bx_Joint_EnableMotor",
    "_bx_Joint_EnableSpring", "_bx_Joint_IsValid",
    "_bx_Joint_SetCollideConnected", "_bx_Joint_SetConstraintTuning", "_bx_Joint_SetLimits", "_bx_Joint_SetMaxMotorForce",
    "_bx_Joint_SetMotorSpeed", "_bx_Joint_SetSphericalMotor", "_bx_Joint_SetSphericalTarget", "_bx_Joint_SetSpring", "_bx_Joint_SetTarget",
    "_bx_Joint_SetTwistLimits", "_bx_Joint_UpdateMotorFrame", "_bx_Joint_WakeBodies", "_bx_MoveEventsPtr", "_bx_RayHitsPtr", "_bx_Scratch",
    "_bx_SensorEventsPtr", "_bx_ShapeDesc_AddChild", "_bx_ShapeDesc_BuildDebugGeometry", "_bx_ShapeDesc_CreateBox", "_bx_ShapeDesc_CreateCapsule",
    "_bx_ShapeDesc_CreateContainer", "_bx_ShapeDesc_CreateCylinder", "_bx_ShapeDesc_CreateHeightField", "_bx_ShapeDesc_CreateHull",
    "_bx_ShapeDesc_CreateMesh", "_bx_ShapeDesc_CreateSphere", "_bx_ShapeDesc_Destroy", "_bx_ShapeDesc_GetAABB", "_bx_ShapeDesc_GetCategoryBits",
    "_bx_ShapeDesc_GetChildCount", "_bx_ShapeDesc_GetDensity", "_bx_ShapeDesc_GetFriction", "_bx_ShapeDesc_GetMaskBits",
    "_bx_ShapeDesc_GetRestitution", "_bx_ShapeDesc_RemoveChild", "_bx_ShapeDesc_SetDensity", "_bx_ShapeDesc_SetFilter", "_bx_ShapeDesc_SetGroup",
    "_bx_ShapeDesc_SetMaterial", "_bx_ShapeDesc_SetRollingResistance", "_bx_ShapeDesc_SetSensor", "_bx_World_CastRay", "_bx_World_EnableContinuous",
    "_bx_World_EnableSleeping", "_bx_World_Explode", "_bx_World_GetContactEvents", "_bx_World_GetMaximumLinearSpeed", "_bx_World_GetMoveEvents",
    "_bx_World_GetSensorEvents", "_bx_World_GetStats", "_bx_World_GetWorkerCount", "_bx_World_SetGravity", "_bx_World_SetMaximumLinearSpeed",
    "_bx_World_Step"
];

/**
 * Options for the Box3D plugin, passed to the constructor after the module.
 */
export interface IBox3DPluginOptions {
    /**
     * Workers box3d may put on a world step, counting the thread the step is called on. 1 (the default) keeps
     * everything on the calling thread. Anything above 1 needs the threaded build of the module
     * (`LoadBox3D({ threads: true })` or `babylon-box3d/wasm/threads`), which in turn needs a cross origin isolated
     * page; on the single threaded module the request is clamped to 1 and a warning explains why.
     * "auto" asks for half of `navigator.hardwareConcurrency`, capped at what the build supports: box3d gains little
     * from the second thread of a core, and leaving room for rendering matters more than the last worker.
     * The world is created in the constructor and box3d builds its threads with it, so this cannot change later.
     */
    workerCount?: number | "auto";
    /**
     * Solver sub steps per world step. Box3D's default of 4 is what keeps tall stacks standing; 2 roughly halves
     * solver time and is worth trying for scenes that are mostly loose bodies, 8 buys stiffness in exchange for time.
     */
    subStepCount?: number;
}

/**
 * Box3D physics plugin for Babylon.js physics v2.
 * Box3D is Erin Catto's 3D rigid body engine (https://github.com/erincatto/box3d). This plugin drives the
 * WebAssembly build that ships in this package (a flat, handle based C shim over box3d).
 * Usage mirrors the Havok plugin:
 * ```ts
 * import { Box3D, Box3DPlugin } from "babylon-box3d";
 * const box3d = await Box3D();
 * scene.enablePhysics(new Vector3(0, -9.81, 0), new Box3DPlugin(true, box3d));
 * ```
 * On a cross origin isolated page the threaded module can spread a step over several workers:
 * ```ts
 * import { LoadBox3D, Box3DPlugin } from "babylon-box3d";
 * const box3d = await LoadBox3D({ threads: "auto" });
 * scene.enablePhysics(new Vector3(0, -9.81, 0), new Box3DPlugin(true, box3d, { workerCount: "auto" }));
 * ```
 */
export class Box3DPlugin implements IPhysicsEnginePluginV2 {
    /** Reference to the WASM module (the value resolved by the module factory). */
    public world: any;
    /** Name of the plugin */
    public name = "Box3DPlugin";
    /** Number of solver sub steps per world step. Box3D recommends 4. */
    public subStepCount = 4;
    /** Workers box3d puts on a world step, counting the calling thread. 1 unless the threaded module asked for more. */
    public readonly workerCount: number = 1;
    /** Wall clock time of the last world step in milliseconds (JavaScript side, includes the event sync). */
    public lastStepTimeMs = 0;

    private _b3: any;
    private _worldSlot = 0;
    private _fixedTimeStep = 1 / 60;
    private _timeStep = 1 / 60;
    private _maxAngularVelocity = 4 * Math.PI * 10;
    private _bodies: Array<{ body: PhysicsBody; index: number; data: Box3DBodyData } | undefined> = [];
    private _shapes: Array<Box3DShapeData | undefined> = [];
    private _bodyCollisionObservable = new Map<number, Observable<IPhysicsCollisionEvent>>();
    private _bodyCollisionEndedObservable = new Map<number, Observable<IBasePhysicsCollisionEvent>>();
    private _touchedInstanceMeshes = new Set<Mesh>();
    /** spherical joints whose velocity motor target has to be re-expressed in world space every step */
    private _motorJoints = new Set<number>();
    private _tmpVec3 = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    private _tmpQuat = [new Quaternion(), new Quaternion(), new Quaternion()];
    private _warned = new Set<string>();
    /** the shim's rejected slot counter as of the last step, see executeStep */
    private _rejectedSlots = 0;

    /** Observable for collision started and continued events */
    public onCollisionObservable = new Observable<IPhysicsCollisionEvent>();
    /** Observable for collision ended events */
    public onCollisionEndedObservable = new Observable<IBasePhysicsCollisionEvent>();
    /** Observable for trigger entered and exited events */
    public onTriggerCollisionObservable = new Observable<IBasePhysicsCollisionEvent>();

    /**
     * Creates a Box3D plugin.
     * @param _useDeltaForWorldStep step the world with the frame delta (true) or a fixed time step (false)
     * @param box3dModule the resolved Box3D WASM module (await Box3DModule())
     * @param options worker count and sub steps, see IBox3DPluginOptions
     */
    public constructor(
        private _useDeltaForWorldStep = true,
        box3dModule: any,
        options?: IBox3DPluginOptions
    ) {
        if (!box3dModule) {
            throw new Error("Box3D module is required: pass the awaited result of the Box3D module factory.");
        }
        const missing = RequiredNativeExports.filter((name) => typeof box3dModule[name] !== "function");
        if (missing.length > 0) {
            throw new Error(
                `Box3DPlugin: the Box3D module is missing ${missing.length} entry point${missing.length === 1 ? "" : "s"} this build needs` +
                    ` (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""}). box3d.js and box3d.wasm have to come from the` +
                    " same build of this package: check what locateFile points at and clear any copied or cached box3d.wasm."
            );
        }
        this._b3 = box3dModule;
        this.world = box3dModule;
        if (options?.subStepCount !== undefined) {
            this.subStepCount = Math.max(1, Math.round(options.subStepCount));
        }
        this._worldSlot = this._b3._bx_CreateWorld(0, -9.81, 0, this._resolveWorkerCount(options?.workerCount));
        if (!this._worldSlot) {
            throw new Error("Box3D: could not create a world (max worlds reached?)");
        }
        // what box3d settled on, which is the request clamped to what this build of the module can run
        this.workerCount = Math.max(1, this._b3._bx_World_GetWorkerCount(this._worldSlot));
    }

    /**
     * Turns the requested worker count into one this module can honour. Only the threaded build reports more than one,
     * and asking a single threaded build for workers is quiet enough to look like it worked, so say so once.
     * @param requested the constructor option
     * @returns the count to create the world with
     */
    private _resolveWorkerCount(requested: number | "auto" | undefined): number {
        const supported = Math.max(1, this._b3._bx_GetMaxWorkers());
        if (requested === undefined) {
            return 1;
        }
        let wanted: number;
        if (requested === "auto") {
            const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
            // half the reported cores: the other half is usually the second thread of each core, and box3d gains
            // little from those, while the renderer still needs somewhere to run
            wanted = Math.max(1, Math.floor(cores / 2));
        } else {
            wanted = Math.max(1, Math.round(requested));
        }
        if (wanted > 1 && supported === 1) {
            this._warnOnce(
                "single-threaded-module",
                `${wanted} workers were requested, but this Box3D module was built without threads, so the step stays on the calling ` +
                    "thread. Load the threaded build (LoadBox3D({ threads: true }), or babylon-box3d/wasm/threads) from a cross origin " +
                    "isolated page: it needs SharedArrayBuffer, which browsers only allow with the COOP and COEP headers set."
            );
        }
        return Math.min(wanted, supported);
    }

    // ----------------------------------------------------------------------------------------
    // helpers
    // ----------------------------------------------------------------------------------------

    private _scratch(): Float32Array {
        return new Float32Array(this._b3.HEAPF32.buffer, this._b3._bx_Scratch(), 64);
    }

    private _warnOnce(key: string, message: string): void {
        if (!this._warned.has(key)) {
            this._warned.add(key);
            Logger.Warn(`Box3DPlugin: ${message}`);
        }
    }

    private _getPluginReference(body: PhysicsBody, instanceIndex?: number): Box3DBodyData {
        return body._pluginDataInstances?.length ? body._pluginDataInstances[instanceIndex ?? 0] : body._pluginData;
    }

    private _applyToBodyOrInstances(body: PhysicsBody, fn: (data: Box3DBodyData) => void, instanceIndex?: number): void {
        if (body._pluginDataInstances?.length > 0 && instanceIndex === undefined) {
            for (const data of body._pluginDataInstances) {
                fn(data);
            }
        } else {
            fn(this._getPluginReference(body, instanceIndex));
        }
    }

    private _motionTypeToNative(motionType: PhysicsMotionType): number {
        switch (motionType) {
            case PhysicsMotionType.STATIC:
                return 0;
            case PhysicsMotionType.ANIMATED:
                return 1;
            default:
                return 2;
        }
    }

    private _nodeTransformToRef(node: TransformNode, position: Vector3, orientation: Quaternion): void {
        if (node.parent) {
            node.computeWorldMatrix(true);
            position.copyFrom(node.absolutePosition);
            orientation.copyFrom(node.absoluteRotationQuaternion);
            return;
        }
        position.copyFrom(node.position);
        if (node.rotationQuaternion) {
            orientation.copyFrom(node.rotationQuaternion);
        } else {
            Quaternion.FromEulerAnglesToRef(node.rotation.x, node.rotation.y, node.rotation.z, orientation);
        }
    }

    // ----------------------------------------------------------------------------------------
    // world
    // ----------------------------------------------------------------------------------------

    public setGravity(gravity: Vector3): void {
        this._b3._bx_World_SetGravity(this._worldSlot, gravity.x, gravity.y, gravity.z);
    }

    public setTimeStep(timeStep: number): void {
        this._fixedTimeStep = timeStep;
    }

    public getTimeStep(): number {
        return this._fixedTimeStep;
    }

    public executeStep(delta: number, physicsBodies: Array<PhysicsBody>): void {
        for (const physicsBody of physicsBodies) {
            if (physicsBody.disablePreStep) {
                continue;
            }
            this.setPhysicsBodyTransformation(physicsBody, physicsBody.transformNode);
        }

        for (const joint of this._motorJoints) {
            // a joint whose bodies were destroyed is gone with them, drop it instead of holding the slot forever
            if (this._b3._bx_Joint_IsValid(joint)) {
                this._b3._bx_Joint_UpdateMotorFrame(joint);
            } else {
                this._motorJoints.delete(joint);
            }
        }

        const deltaTime = this._useDeltaForWorldStep ? delta : this._fixedTimeStep;
        this._timeStep = deltaTime;
        const start = performance.now();
        this._b3._bx_World_Step(this._worldSlot, deltaTime, this.subStepCount);

        // Only bodies that moved report an event, so sync those instead of iterating every body.
        const moveCount = this._b3._bx_World_GetMoveEvents(this._worldSlot);
        if (moveCount > 0) {
            const movePointer = this._b3._bx_MoveEventsPtr();
            let buffer = new Float32Array(this._b3.HEAPF32.buffer, movePointer, moveCount * MOVE_STRIDE);
            for (let i = 0; i < moveCount; i++) {
                if (buffer.buffer !== this._b3.HEAPF32.buffer) {
                    // a world matrix observer grew the wasm memory; the records are still in place
                    buffer = new Float32Array(this._b3.HEAPF32.buffer, movePointer, moveCount * MOVE_STRIDE);
                }
                const offset = i * MOVE_STRIDE;
                const ref = this._bodies[buffer[offset]];
                if (!ref || ref.body.disableSync) {
                    continue;
                }
                this._syncBodyFromBuffer(ref.body, ref.index, buffer, offset + 1);
            }
            for (const mesh of this._touchedInstanceMeshes) {
                mesh.thinInstanceBufferUpdated("matrix");
            }
            this._touchedInstanceMeshes.clear();
        }

        this._notifyCollisions();
        this._notifyTriggers();
        this.lastStepTimeMs = performance.now() - start;

        // Every native entry point returns quietly when it does not recognize a handle. That is what teardown needs and
        // it hides everything else, so say it once instead of simulating a world where half the calls do nothing.
        const rejected = this._b3._bx_GetRejectedSlotCount();
        if (rejected > this._rejectedSlots) {
            this._rejectedSlots = rejected;
            this._warnOnce(
                "rejected-slots",
                `the native module did not recognize ${rejected} of the handles it was given, and those calls did nothing. Something is using a ` +
                    "body, shape or joint after it was destroyed, or box3d.js and box3d.wasm are from different builds."
            );
        }
    }

    public getPluginVersion(): number {
        return 2;
    }

    public setVelocityLimits(maxLinearVelocity: number, maxAngularVelocity: number): void {
        this._b3._bx_World_SetMaximumLinearSpeed(this._worldSlot, maxLinearVelocity);
        this._maxAngularVelocity = maxAngularVelocity;
    }

    public getMaxLinearVelocity(): number {
        return this._b3._bx_World_GetMaximumLinearSpeed(this._worldSlot);
    }

    public getMaxAngularVelocity(): number {
        return this._maxAngularVelocity;
    }

    /**
     * Box3D counters and timings for the current world.
     * @returns body, shape, contact, joint and island counts plus the last step time in milliseconds
     */
    public getStats(): { bodies: number; shapes: number; contacts: number; joints: number; islands: number; stepMs: number; collideMs: number; solveMs: number } {
        this._b3._bx_World_GetStats(this._worldSlot);
        const s = this._scratch();
        return { bodies: s[0], shapes: s[1], contacts: s[2], joints: s[3], islands: s[4], stepMs: s[5], collideMs: s[6], solveMs: s[7] };
    }

    /**
     * Enables or disables island sleeping.
     * @param enabled true to let resting bodies sleep
     */
    public setSleepingEnabled(enabled: boolean): void {
        this._b3._bx_World_EnableSleeping(this._worldSlot, enabled ? 1 : 0);
    }

    /**
     * Enables or disables continuous collision against static geometry.
     * @param enabled true to enable continuous collision
     */
    public setContinuousEnabled(enabled: boolean): void {
        this._b3._bx_World_EnableContinuous(this._worldSlot, enabled ? 1 : 0);
    }

    // ----------------------------------------------------------------------------------------
    // bodies
    // ----------------------------------------------------------------------------------------

    private _createNativeBody(motionType: PhysicsMotionType, position: Vector3, orientation: Quaternion, startAsleep: boolean): Box3DBodyData {
        const slot = this._b3._bx_CreateBody(
            this._worldSlot,
            this._motionTypeToNative(motionType),
            position.x,
            position.y,
            position.z,
            orientation.x,
            orientation.y,
            orientation.z,
            orientation.w,
            startAsleep ? 0 : 1
        );
        const data = new Box3DBodyData(slot);
        data.motionType = motionType;
        return data;
    }

    public initBody(body: PhysicsBody, motionType: PhysicsMotionType, position: Vector3, orientation: Quaternion): void {
        const data = this._createNativeBody(motionType, position, orientation, body.startAsleep);
        body._pluginData = data;
        this._bodies[data.slot] = { body, index: 0, data };
    }

    public initBodyInstances(body: PhysicsBody, motionType: PhysicsMotionType, mesh: Mesh): void {
        const instancesCount = mesh._thinInstanceDataStorage?.instancesCount ?? 0;
        const matrixData = mesh._thinInstanceDataStorage?.matrixData;
        if (!matrixData) {
            return;
        }
        const shape = body.shape?._pluginData as Box3DShapeData | undefined;
        if (instancesCount > 8 && shape && this._bakesMeshCopies(shape)) {
            this._warnOnce(
                "instanced-mesh-child",
                "a mesh inside a container has no local transform in Box3D, so every instance gets its own baked copy of the mesh data; " +
                    "put the mesh on the body directly, or bake the offset into the mesh, to share it."
            );
        }
        this._createOrUpdateBodyInstances(body, motionType, matrixData, 0, instancesCount, false);
    }

    private _createOrUpdateBodyInstances(body: PhysicsBody, motionType: PhysicsMotionType, matrixData: Float32Array, startIndex: number, endIndex: number, update: boolean): void {
        const rotation = TmpVectors.Quaternion[0];
        const rotationMatrix = TmpVectors.Matrix[0];
        const position = TmpVectors.Vector3[0];
        for (let i = startIndex; i < endIndex; i++) {
            position.set(matrixData[i * 16 + 12], matrixData[i * 16 + 13], matrixData[i * 16 + 14]);
            Matrix.FromArrayToRef(matrixData, i * 16, rotationMatrix);
            rotationMatrix.decompose(undefined, rotation, undefined);
            if (update) {
                const data = body._pluginDataInstances[i];
                this._b3._bx_Body_SetTransform(data.slot, position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w);
            } else {
                const data = this._createNativeBody(motionType, position, rotation, body.startAsleep);
                const sibling = body._pluginDataInstances[0] as Box3DBodyData | undefined;
                if (sibling) {
                    // a new instance behaves like the ones already there: same mass properties, events and activation
                    data.userMassProps = sibling.userMassProps;
                    data.eventMask = sibling.eventMask;
                    this._applyEventFlags(data);
                    if (sibling.activation !== PhysicsActivationControl.SIMULATION_CONTROLLED) {
                        data.activation = sibling.activation;
                        this._applyNativeMotionType(data);
                        this._b3._bx_Body_EnableSleep(data.slot, sibling.activation === PhysicsActivationControl.ALWAYS_ACTIVE ? 0 : 1);
                    }
                }
                body._pluginDataInstances.push(data);
                this._bodies[data.slot] = { body, index: i, data };
            }
        }
    }

    public updateBodyInstances(body: PhysicsBody, mesh: Mesh): void {
        const instancesCount = mesh._thinInstanceDataStorage?.instancesCount ?? 0;
        const matrixData = mesh._thinInstanceDataStorage?.matrixData;
        if (!matrixData) {
            return;
        }
        const pluginInstancesCount = body._pluginDataInstances.length;
        const motionType = this.getMotionType(body);
        if (instancesCount > pluginInstancesCount) {
            this._createOrUpdateBodyInstances(body, motionType, matrixData, pluginInstancesCount, instancesCount, false);
            const shape = body.shape;
            if (shape && shape._pluginData) {
                for (let i = pluginInstancesCount; i < instancesCount; i++) {
                    this._setBodyShape(body._pluginDataInstances[i], shape._pluginData as Box3DShapeData);
                }
            }
        } else if (instancesCount < pluginInstancesCount) {
            const instancesToRemove = pluginInstancesCount - instancesCount;
            for (let i = 0; i < instancesToRemove; i++) {
                const data = body._pluginDataInstances.pop() as Box3DBodyData;
                this._destroyBodyData(data);
            }
            this._createOrUpdateBodyInstances(body, motionType, matrixData, 0, instancesCount, true);
        }
    }

    private _destroyBodyData(data: Box3DBodyData): void {
        if (!data) {
            return;
        }
        for (const shape of this._shapes) {
            shape?.users.delete(data);
        }
        this._bodyCollisionObservable.delete(data.slot);
        this._bodyCollisionEndedObservable.delete(data.slot);
        this._bodies[data.slot] = undefined;
        this._b3._bx_DestroyBody(data.slot);
        data.slot = 0;
    }

    public removeBody(body: PhysicsBody): void {
        // Box3D has no add/remove without destroying. The body is destroyed and re-created by initBody if needed.
        if (body._pluginDataInstances?.length) {
            for (const data of body._pluginDataInstances) {
                this._destroyBodyData(data);
            }
        }
        if (body._pluginData) {
            this._destroyBodyData(body._pluginData);
        }
    }

    public sync(body: PhysicsBody): void {
        this.syncTransform(body, body.transformNode);
    }

    private _syncBodyFromBuffer(body: PhysicsBody, index: number, buffer: Float32Array, offset: number): void {
        const node = body.transformNode;
        if (body._pluginDataInstances.length) {
            const m = node as Mesh;
            const matrixData = m._thinInstanceDataStorage?.matrixData;
            if (!matrixData) {
                return;
            }
            const scale = this._tmpVec3[0];
            const base = index * 16;
            scale.set(
                Math.hypot(matrixData[base], matrixData[base + 1], matrixData[base + 2]),
                Math.hypot(matrixData[base + 4], matrixData[base + 5], matrixData[base + 6]),
                Math.hypot(matrixData[base + 8], matrixData[base + 9], matrixData[base + 10])
            );
            const quat = this._tmpQuat[0];
            quat.set(buffer[offset + 3], buffer[offset + 4], buffer[offset + 5], buffer[offset + 6]);
            const position = this._tmpVec3[1];
            position.set(buffer[offset], buffer[offset + 1], buffer[offset + 2]);
            const matrix = TmpVectors.Matrix[0];
            Matrix.ComposeToRef(scale, quat, position, matrix);
            matrix.copyToArray(matrixData, base);
            this._touchedInstanceMeshes.add(m);
            return;
        }
        this._applyTransformToNode(node, buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3], buffer[offset + 4], buffer[offset + 5], buffer[offset + 6]);
    }

    private _applyTransformToNode(node: TransformNode, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): void {
        const quat = this._tmpQuat[0];
        quat.set(qx, qy, qz, qw);
        const parent = node.parent as TransformNode;
        if (parent && !parent.getWorldMatrix().isIdentity()) {
            parent.computeWorldMatrix(true);
            const savedScaling = this._tmpVec3[2];
            savedScaling.copyFrom(node.scaling);
            const finalTransform = TmpVectors.Matrix[0];
            const finalTranslation = this._tmpVec3[3];
            finalTranslation.set(px, py, pz);
            Matrix.ComposeToRef(node.absoluteScaling, quat, finalTranslation, finalTransform);
            const parentInverse = TmpVectors.Matrix[1];
            parent.getWorldMatrix().invertToRef(parentInverse);
            const localTransform = TmpVectors.Matrix[2];
            finalTransform.multiplyToRef(parentInverse, localTransform);
            localTransform.decomposeToTransformNode(node);
            node.rotationQuaternion?.normalize();
            node.scaling.copyFrom(savedScaling);
        } else {
            node.position.set(px, py, pz);
            if (node.rotationQuaternion) {
                node.rotationQuaternion.copyFrom(quat);
            } else {
                quat.toEulerAnglesToRef(node.rotation);
            }
        }
    }

    public syncTransform(body: PhysicsBody, transformNode: TransformNode): void {
        if (body._pluginDataInstances.length) {
            const m = transformNode as Mesh;
            const matrixData = m._thinInstanceDataStorage?.matrixData;
            if (!matrixData) {
                return;
            }
            for (let i = 0; i < body._pluginDataInstances.length; i++) {
                const data = body._pluginDataInstances[i] as Box3DBodyData;
                this._b3._bx_Body_GetTransform(data.slot);
                this._syncBodyFromBuffer(body, i, this._scratch(), 0);
            }
            m.thinInstanceBufferUpdated("matrix");
            this._touchedInstanceMeshes.delete(m);
            return;
        }
        const data = body._pluginData as Box3DBodyData;
        if (!data || !data.slot) {
            return;
        }
        this._b3._bx_Body_GetTransform(data.slot);
        const s = this._scratch();
        this._applyTransformToNode(transformNode, s[0], s[1], s[2], s[3], s[4], s[5], s[6]);
    }

    /**
     * Pushes the transform node's pose into the physics body (called during the pre step).
     * @param body the physics body
     * @param node the transform node to read from
     */
    public setPhysicsBodyTransformation(body: PhysicsBody, node: TransformNode): void {
        const prestep = body.getPrestepType();
        if (prestep == PhysicsPrestepType.TELEPORT) {
            if (body._pluginDataInstances.length > 0) {
                const m = node as Mesh;
                const matrixData = m._thinInstanceDataStorage?.matrixData;
                if (!matrixData) {
                    return;
                }
                this._createOrUpdateBodyInstances(body, body.getMotionType(), matrixData, 0, body._pluginDataInstances.length, true);
                return;
            }
            const data = body._pluginData as Box3DBodyData;
            const position = this._tmpVec3[0];
            const orientation = this._tmpQuat[0];
            this._nodeTransformToRef(node, position, orientation);
            this._b3._bx_Body_SetTransform(data.slot, position.x, position.y, position.z, orientation.x, orientation.y, orientation.z, orientation.w);
        } else if (prestep == PhysicsPrestepType.ACTION) {
            this.setTargetTransform(body, node.absolutePosition, node.absoluteRotationQuaternion);
        } else if (prestep == PhysicsPrestepType.DISABLED) {
            Logger.Warn("Prestep type is set to DISABLED. Unable to set physics body transformation.");
        }
    }

    public setTargetTransform(body: PhysicsBody, position: Vector3, rotation: Quaternion, instanceIndex?: number): void {
        this._applyToBodyOrInstances(
            body,
            (data) => {
                this._b3._bx_Body_SetTargetTransform(data.slot, position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, this._timeStep);
            },
            instanceIndex
        );
    }

    /** True when the shape puts a mesh inside a container, which Box3D can only do by baking a copy per body. */
    private _bakesMeshCopies(data: Box3DShapeData, visited = new Set<Box3DShapeData>()): boolean {
        if (visited.has(data)) {
            return false;
        }
        visited.add(data);
        return data.children.some((child) => child.type === PhysicsShapeType.MESH || this._bakesMeshCopies(child, visited));
    }

    private _setBodyShape(data: Box3DBodyData, shape: Nullable<Box3DShapeData>): void {
        for (const existing of this._shapes) {
            existing?.users.delete(data);
        }
        this._b3._bx_Body_SetShape(data.slot, shape ? shape.slot : 0);
        if (shape) {
            shape.users.add(data);
        }
        this._applyEventFlags(data);
        this._internalUpdateMassProperties(data);
    }

    public setShape(body: PhysicsBody, shape: Nullable<PhysicsShape>): void {
        const shapeData = shape && shape._pluginData ? (shape._pluginData as Box3DShapeData) : null;
        this._applyToBodyOrInstances(body, (data) => this._setBodyShape(data, shapeData));
    }

    public getShape(body: PhysicsBody): Nullable<PhysicsShape> {
        return body.shape ?? null;
    }

    public getShapeType(shape: PhysicsShape): PhysicsShapeType {
        return shape.type ?? (shape._pluginData as Box3DShapeData)?.type ?? PhysicsShapeType.CONTAINER;
    }

    /** Turns the body's event mask into Box3D's two shape flags, so a body only pays for the events it asked for. */
    private _applyEventFlags(data: Box3DBodyData): void {
        const touch = data.eventMask & (Box3DEventBits.COLLISION_STARTED | Box3DEventBits.COLLISION_FINISHED) ? 1 : 0;
        const hit = data.eventMask & Box3DEventBits.COLLISION_CONTINUED ? 1 : 0;
        this._b3._bx_Body_SetEventFlags(data.slot, touch, hit);
    }

    public setEventMask(body: PhysicsBody, eventMask: number, instanceIndex?: number): void {
        this._applyToBodyOrInstances(
            body,
            (data) => {
                data.eventMask = eventMask;
                this._applyEventFlags(data);
            },
            instanceIndex
        );
    }

    public getEventMask(body: PhysicsBody, instanceIndex?: number): number {
        return this._getPluginReference(body, instanceIndex).eventMask;
    }

    public setMotionType(body: PhysicsBody, motionType: PhysicsMotionType, instanceIndex?: number): void {
        this._applyToBodyOrInstances(
            body,
            (data) => {
                data.motionType = motionType;
                this._applyNativeMotionType(data);
                this._internalUpdateMassProperties(data);
            },
            instanceIndex
        );
    }

    /** The Box3D body type: the Babylon motion type, unless the body is parked by ALWAYS_INACTIVE. */
    private _applyNativeMotionType(data: Box3DBodyData): void {
        const native = data.activation === PhysicsActivationControl.ALWAYS_INACTIVE ? 0 : this._motionTypeToNative(data.motionType);
        this._b3._bx_Body_SetType(data.slot, native);
    }

    /**
     * Babylon's activation control, matched to Havok's behaviour with Box3D sleeping.
     * ALWAYS_ACTIVE turns sleeping off for the body, SIMULATION_CONTROLLED turns it back on. ALWAYS_INACTIVE parks the
     * body: in Havok such a body ignores impulses and velocity changes, is not woken by anything that touches it and
     * still blocks other bodies, which Box3D sleeping alone cannot do, so it becomes a static Box3D body until the
     * control changes. Coming back it is left asleep, like Havok, until something wakes it.
     * @param body the physics body
     * @param controlMode how the body may be activated and deactivated
     * @param instanceIndex optional thin instance index
     */
    public setActivationControl(body: PhysicsBody, controlMode: PhysicsActivationControl, instanceIndex?: number): void {
        this._applyToBodyOrInstances(
            body,
            (data) => {
                if (data.activation === controlMode) {
                    return;
                }
                const wasInactive = data.activation === PhysicsActivationControl.ALWAYS_INACTIVE;
                data.activation = controlMode;
                if (controlMode === PhysicsActivationControl.ALWAYS_INACTIVE) {
                    this._b3._bx_Body_SetLinearVelocity(data.slot, 0, 0, 0);
                    this._b3._bx_Body_SetAngularVelocity(data.slot, 0, 0, 0);
                    this._applyNativeMotionType(data);
                    return;
                }
                this._applyNativeMotionType(data);
                this._internalUpdateMassProperties(data);
                this._b3._bx_Body_EnableSleep(data.slot, controlMode === PhysicsActivationControl.ALWAYS_ACTIVE ? 0 : 1);
                if (wasInactive && controlMode === PhysicsActivationControl.SIMULATION_CONTROLLED) {
                    this._b3._bx_Body_SetAwake(data.slot, 0);
                }
            },
            instanceIndex
        );
    }

    public getMotionType(body: PhysicsBody, instanceIndex?: number): PhysicsMotionType {
        return this._getPluginReference(body, instanceIndex).motionType;
    }

    /**
     * Reads Box3D's mass data and converts it to Babylon's form: the inertia is the principal moments of the tensor
     * divided by the mass (Babylon's inertia is per unit mass) and the orientation rotates the principal axes into
     * body space.
     */
    private _readMassData(data: Box3DBodyData): PhysicsMassProperties {
        // Box3D keeps mass 0 on static and kinematic bodies; Havok reports what the shapes weigh whatever the type
        if (data.motionType === PhysicsMotionType.DYNAMIC && data.activation !== PhysicsActivationControl.ALWAYS_INACTIVE) {
            this._b3._bx_Body_GetMassData(data.slot);
        } else {
            this._b3._bx_Body_ComputeShapeMassData(data.slot);
        }
        const s = this._scratch();
        const mass = s[0];
        const principal = new Vector3();
        const orientation = new Quaternion();
        DiagonalizeInertia([s[4], s[5], s[6], s[7], s[8], s[9]], principal, orientation);
        if (mass > 0) {
            principal.scaleInPlace(1 / mass);
        }
        return {
            mass,
            centerOfMass: new Vector3(s[1], s[2], s[3]),
            inertia: principal,
            inertiaOrientation: orientation,
        };
    }

    /** The mass properties of the body: what the user asked for, filled in from the shapes where they said nothing. */
    private _resolveMassProperties(data: Box3DBodyData): Required<PhysicsMassProperties> {
        const computed = this._readMassData(data);
        const user = data.userMassProps ?? {};
        // no invented mass here: a body with no shapes really does weigh nothing, only the tensor written to Box3D
        // needs a positive mass (see _internalUpdateMassProperties)
        const mass = user.mass !== undefined && user.mass > 0 ? user.mass : computed.mass!;
        return {
            mass,
            centerOfMass: user.centerOfMass ?? computed.centerOfMass!,
            inertia: user.inertia ?? computed.inertia!,
            inertiaOrientation: user.inertiaOrientation ?? (user.inertia ? Quaternion.Identity() : computed.inertiaOrientation!),
        };
    }

    private _internalUpdateMassProperties(data: Box3DBodyData): void {
        if (data.motionType !== PhysicsMotionType.DYNAMIC || data.activation === PhysicsActivationControl.ALWAYS_INACTIVE) {
            // motion locks are world space velocity locks, they would fight a kinematic body's target transform
            this._applyMotionLocks(data, false, false, false);
            return;
        }
        this._b3._bx_Body_ApplyMassFromShapes(data.slot);
        const user = data.userMassProps;
        const hasUser = !!user && (user.mass !== undefined || !!user.centerOfMass || !!user.inertia || !!user.inertiaOrientation);
        if (!hasUser) {
            this._applyMotionLocks(data, false, false, false);
            return;
        }
        const props = this._resolveMassProperties(data);
        // a dynamic body with no mass at all would ignore gravity and every impulse
        const mass = props.mass > 0 ? props.mass : 1;
        const inertia = props.inertia;
        const orientation = props.inertiaOrientation;
        // Babylon's inertia is per unit mass and a zero component means infinite inertia about that principal axis.
        // Box3D needs an invertible tensor, so a locked axis gets a very large moment; where the free axes stay aligned
        // with the world, Box3D's motion locks are added on top and make it exact.
        const locked = [inertia.x <= 0, inertia.y <= 0, inertia.z <= 0];
        const largest = Math.max(inertia.x, inertia.y, inertia.z, 1e-4) * LockedInertiaRatio;
        const moments = [locked[0] ? largest : inertia.x, locked[1] ? largest : inertia.y, locked[2] ? largest : inertia.z].map((value) => value * mass);
        const tensor = ComposeInertia(moments, orientation);
        this._b3._bx_Body_SetMassDataFull(
            data.slot,
            mass,
            props.centerOfMass.x,
            props.centerOfMass.y,
            props.centerOfMass.z,
            tensor[0],
            tensor[1],
            tensor[2],
            tensor[3],
            tensor[4],
            tensor[5]
        );
        this._applyLockedAxes(data, locked, orientation);
    }

    /**
     * Box3D locks are world space, Babylon's zero inertia components are body local. Locking two of them leaves a single
     * free axis, and if that axis is world aligned the body can only ever spin about it, so the world locks are exact
     * and stay exact. Everything else relies on the large moment above.
     */
    private _applyLockedAxes(data: Box3DBodyData, locked: boolean[], orientation: Quaternion): void {
        const count = locked.filter(Boolean).length;
        if (count === 3) {
            this._applyMotionLocks(data, true, true, true);
            return;
        }
        if (count !== 2) {
            this._applyMotionLocks(data, false, false, false);
            return;
        }
        this._b3._bx_Body_GetTransform(data.slot);
        const s = this._scratch();
        const bodyRotation = this._tmpQuat[0].set(s[3], s[4], s[5], s[6]);
        const free = locked.indexOf(false);
        const axis = this._tmpVec3[0].set(free === 0 ? 1 : 0, free === 1 ? 1 : 0, free === 2 ? 1 : 0);
        axis.applyRotationQuaternionInPlace(orientation).applyRotationQuaternionInPlace(bodyRotation);
        const components = [Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z)];
        const dominant = components.indexOf(Math.max(...components));
        if (components[dominant] > 0.9999) {
            this._applyMotionLocks(data, dominant !== 0, dominant !== 1, dominant !== 2);
        } else {
            this._applyMotionLocks(data, false, false, false);
        }
    }

    private _applyMotionLocks(data: Box3DBodyData, x: boolean, y: boolean, z: boolean): void {
        const locks = (x ? 1 : 0) | (y ? 2 : 0) | (z ? 4 : 0);
        if (locks === data.angularLocks) {
            return;
        }
        data.angularLocks = locks;
        this._b3._bx_Body_SetMotionLocks(data.slot, 0, 0, 0, x ? 1 : 0, y ? 1 : 0, z ? 1 : 0);
    }

    public computeMassProperties(body: PhysicsBody, instanceIndex?: number): PhysicsMassProperties {
        const data = this._getPluginReference(body, instanceIndex);
        this._b3._bx_Body_ApplyMassFromShapes(data.slot);
        const computed = this._readMassData(data);
        this._internalUpdateMassProperties(data);
        return computed;
    }

    public setMassProperties(body: PhysicsBody, massProps: PhysicsMassProperties, instanceIndex?: number): void {
        this._applyToBodyOrInstances(
            body,
            (data) => {
                data.userMassProps = massProps;
                this._internalUpdateMassProperties(data);
            },
            instanceIndex
        );
    }

    public getMassProperties(body: PhysicsBody, instanceIndex?: number): PhysicsMassProperties {
        return this._resolveMassProperties(this._getPluginReference(body, instanceIndex));
    }

    public setLinearDamping(body: PhysicsBody, damping: number, instanceIndex?: number): void {
        this._applyToBodyOrInstances(body, (data) => this._b3._bx_Body_SetLinearDamping(data.slot, damping), instanceIndex);
    }

    public getLinearDamping(body: PhysicsBody, instanceIndex?: number): number {
        return this._b3._bx_Body_GetLinearDamping(this._getPluginReference(body, instanceIndex).slot);
    }

    public setAngularDamping(body: PhysicsBody, damping: number, instanceIndex?: number): void {
        this._applyToBodyOrInstances(body, (data) => this._b3._bx_Body_SetAngularDamping(data.slot, damping), instanceIndex);
    }

    public getAngularDamping(body: PhysicsBody, instanceIndex?: number): number {
        return this._b3._bx_Body_GetAngularDamping(this._getPluginReference(body, instanceIndex).slot);
    }

    public setLinearVelocity(body: PhysicsBody, linVel: Vector3, instanceIndex?: number): void {
        this._applyToBodyOrInstances(body, (data) => this._b3._bx_Body_SetLinearVelocity(data.slot, linVel.x, linVel.y, linVel.z), instanceIndex);
    }

    public getLinearVelocityToRef(body: PhysicsBody, linVel: Vector3, instanceIndex?: number): void {
        this._b3._bx_Body_GetLinearVelocity(this._getPluginReference(body, instanceIndex).slot);
        const s = this._scratch();
        linVel.set(s[0], s[1], s[2]);
    }

    public applyImpulse(body: PhysicsBody, impulse: Vector3, location: Vector3, instanceIndex?: number): void {
        this._applyToBodyOrInstances(
            body,
            (data) => this._b3._bx_Body_ApplyLinearImpulse(data.slot, impulse.x, impulse.y, impulse.z, location.x, location.y, location.z),
            instanceIndex
        );
    }

    public applyAngularImpulse(body: PhysicsBody, angularImpulse: Vector3, instanceIndex?: number): void {
        this._applyToBodyOrInstances(body, (data) => this._b3._bx_Body_ApplyAngularImpulse(data.slot, angularImpulse.x, angularImpulse.y, angularImpulse.z), instanceIndex);
    }

    public applyForce(body: PhysicsBody, force: Vector3, location: Vector3, instanceIndex?: number): void {
        this._applyToBodyOrInstances(body, (data) => this._b3._bx_Body_ApplyForce(data.slot, force.x, force.y, force.z, location.x, location.y, location.z), instanceIndex);
    }

    public applyTorque(body: PhysicsBody, torque: Vector3, instanceIndex?: number): void {
        this._applyToBodyOrInstances(body, (data) => this._b3._bx_Body_ApplyTorque(data.slot, torque.x, torque.y, torque.z), instanceIndex);
    }

    public setAngularVelocity(body: PhysicsBody, angVel: Vector3, instanceIndex?: number): void {
        this._applyToBodyOrInstances(body, (data) => this._b3._bx_Body_SetAngularVelocity(data.slot, angVel.x, angVel.y, angVel.z), instanceIndex);
    }

    public getAngularVelocityToRef(body: PhysicsBody, angVel: Vector3, instanceIndex?: number): void {
        this._b3._bx_Body_GetAngularVelocity(this._getPluginReference(body, instanceIndex).slot);
        const s = this._scratch();
        angVel.set(s[0], s[1], s[2]);
    }

    public getBodyGeometry(body: PhysicsBody): { positions: Float32Array | number[]; indices: Uint32Array | number[] } {
        const shape = body.shape?._pluginData as Box3DShapeData | undefined;
        if (!shape) {
            return { positions: [], indices: [] };
        }
        const vertexCount = this._b3._bx_ShapeDesc_BuildDebugGeometry(shape.slot);
        const indexCount = this._b3._bx_DebugIndexCount();
        if (!vertexCount || !indexCount) {
            return { positions: [], indices: [] };
        }
        const positions = new Float32Array(this._b3.HEAPF32.buffer, this._b3._bx_DebugPositionsPtr(), vertexCount * 3).slice();
        const indices = new Uint32Array(this._b3.HEAPU32.buffer, this._b3._bx_DebugIndicesPtr(), indexCount).slice();
        return { positions, indices };
    }

    public disposeBody(body: PhysicsBody): void {
        this.removeBody(body);
        body._pluginData = undefined;
        body._pluginDataInstances.length = 0;
    }

    public setCollisionCallbackEnabled(body: PhysicsBody, enabled: boolean, instanceIndex?: number): void {
        // Havok replaces the mask with all three collision events, or clears it
        this.setEventMask(body, enabled ? Box3DEventBits.ALL : 0, instanceIndex);
    }

    public setCollisionEndedCallbackEnabled(body: PhysicsBody, enabled: boolean, instanceIndex?: number): void {
        this._applyToBodyOrInstances(
            body,
            (data) => {
                data.eventMask = enabled ? data.eventMask | Box3DEventBits.COLLISION_FINISHED : data.eventMask & ~Box3DEventBits.COLLISION_FINISHED;
                this._applyEventFlags(data);
            },
            instanceIndex
        );
    }

    public getCollisionObservable(body: PhysicsBody, instanceIndex?: number): Observable<IPhysicsCollisionEvent> {
        const slot = this._getPluginReference(body, instanceIndex).slot;
        let observable = this._bodyCollisionObservable.get(slot);
        if (!observable) {
            observable = new Observable<IPhysicsCollisionEvent>();
            this._bodyCollisionObservable.set(slot, observable);
        }
        return observable;
    }

    public getCollisionEndedObservable(body: PhysicsBody, instanceIndex?: number): Observable<IBasePhysicsCollisionEvent> {
        const slot = this._getPluginReference(body, instanceIndex).slot;
        let observable = this._bodyCollisionEndedObservable.get(slot);
        if (!observable) {
            observable = new Observable<IBasePhysicsCollisionEvent>();
            this._bodyCollisionEndedObservable.set(slot, observable);
        }
        return observable;
    }

    public setGravityFactor(body: PhysicsBody, factor: number, instanceIndex?: number): void {
        this._applyToBodyOrInstances(body, (data) => this._b3._bx_Body_SetGravityScale(data.slot, factor), instanceIndex);
    }

    public getGravityFactor(body: PhysicsBody, instanceIndex?: number): number {
        return this._b3._bx_Body_GetGravityScale(this._getPluginReference(body, instanceIndex).slot);
    }

    // ----------------------------------------------------------------------------------------
    // shapes
    // ----------------------------------------------------------------------------------------

    private _registerShape(shape: PhysicsShape, slot: number, type: PhysicsShapeType): Box3DShapeData {
        if (!slot) {
            throw new Error("Box3DPlugin: shape creation failed (degenerate geometry?)");
        }
        const data = new Box3DShapeData(slot, type);
        shape._pluginData = data;
        this._shapes[slot] = data;
        return data;
    }

    private _withFloatBuffer<T>(values: ArrayLike<number>, fn: (ptr: number) => T): T {
        const ptr = this._b3._malloc(values.length * 4);
        new Float32Array(this._b3.HEAPF32.buffer, ptr, values.length).set(values);
        try {
            return fn(ptr);
        } finally {
            this._b3._free(ptr);
        }
    }

    /** Copies bytes into the module for the length of `fn`; with no bytes, `fn` gets a null pointer. */
    private _withByteBuffer<T>(values: Nullable<Uint8Array>, fn: (ptr: number) => T): T {
        if (!values || values.length === 0) {
            return fn(0);
        }
        const ptr = this._b3._malloc(values.length);
        new Uint8Array(this._b3.HEAPU8.buffer, ptr, values.length).set(values);
        try {
            return fn(ptr);
        } finally {
            this._b3._free(ptr);
        }
    }

    private _withIntBuffer<T>(values: ArrayLike<number>, fn: (ptr: number) => T): T {
        const ptr = this._b3._malloc(values.length * 4);
        new Int32Array(this._b3.HEAP32.buffer, ptr, values.length).set(values);
        try {
            return fn(ptr);
        } finally {
            this._b3._free(ptr);
        }
    }

    private _createOptionsFromGroundMesh(options: PhysicsShapeParameters): void {
        const mesh = options.groundMesh;
        if (!mesh) {
            return;
        }
        const pos = mesh.getVerticesData(VertexBuffer.PositionKind) as FloatArray;
        const transform = mesh.computeWorldMatrix(true);
        const transformed: number[] = [];
        const p = TmpVectors.Vector3[0];
        for (let i = 0; i < pos.length; i += 3) {
            Vector3.FromArrayToRef(pos, i, p);
            Vector3.TransformCoordinatesToRef(p, transform, p);
            p.toArray(transformed, i);
        }
        const arraySize = ~~(Math.sqrt(transformed.length / 3) - 1);
        const boundingInfo = mesh.getBoundingInfo();
        const dim = Math.min(boundingInfo.boundingBox.extendSizeWorld.x, boundingInfo.boundingBox.extendSizeWorld.z);
        const minX = boundingInfo.boundingBox.minimumWorld.x;
        const minY = boundingInfo.boundingBox.minimumWorld.y;
        const minZ = boundingInfo.boundingBox.minimumWorld.z;
        const matrix = new Float32Array((arraySize + 1) * (arraySize + 1));
        const elementSize = (dim * 2) / arraySize;
        matrix.fill(minY);
        for (let i = 0; i < transformed.length; i += 3) {
            const x = Math.round((transformed[i + 0] - minX) / elementSize);
            const z = arraySize - Math.round((transformed[i + 2] - minZ) / elementSize);
            matrix[z * (arraySize + 1) + x] = transformed[i + 1] - minY;
        }
        options.numHeightFieldSamplesX = arraySize + 1;
        options.numHeightFieldSamplesZ = arraySize + 1;
        options.heightFieldSizeX = boundingInfo.boundingBox.extendSizeWorld.x * 2;
        options.heightFieldSizeZ = boundingInfo.boundingBox.extendSizeWorld.z * 2;
        options.heightFieldData = matrix;
    }

    public initShape(shape: PhysicsShape, type: PhysicsShapeType, options: PhysicsShapeParameters): void {
        const b3 = this._b3;
        const center = options.center ?? Vector3.ZeroReadOnly;
        const rotation = options.rotation ?? Quaternion.Identity();
        switch (type) {
            case PhysicsShapeType.SPHERE: {
                const radius = options.radius ?? 1;
                this._registerShape(shape, b3._bx_ShapeDesc_CreateSphere(center.x, center.y, center.z, radius), type);
                break;
            }
            case PhysicsShapeType.CAPSULE: {
                const a = options.pointA ?? Vector3.ZeroReadOnly;
                const b = options.pointB ?? Vector3.UpReadOnly;
                this._registerShape(shape, b3._bx_ShapeDesc_CreateCapsule(a.x, a.y, a.z, b.x, b.y, b.z, options.radius ?? 0), type);
                break;
            }
            case PhysicsShapeType.BOX: {
                const extents = options.extents ?? Vector3.OneReadOnly;
                this._registerShape(
                    shape,
                    b3._bx_ShapeDesc_CreateBox(extents.x * 0.5, extents.y * 0.5, extents.z * 0.5, center.x, center.y, center.z, rotation.x, rotation.y, rotation.z, rotation.w),
                    type
                );
                break;
            }
            case PhysicsShapeType.CYLINDER: {
                const a = options.pointA ?? Vector3.ZeroReadOnly;
                const b = options.pointB ?? Vector3.UpReadOnly;
                const axis = b.subtract(a);
                const height = axis.length();
                const q = this._tmpQuat[0];
                if (height > 1e-6) {
                    axis.scaleInPlace(1 / height);
                    Quaternion.FromUnitVectorsToRef(Vector3.UpReadOnly, axis, q);
                } else {
                    q.set(0, 0, 0, 1);
                }
                // Box3D's cylinder runs from 0 to height along its local Y, so it goes at pointA, not at the middle.
                this._registerShape(shape, b3._bx_ShapeDesc_CreateCylinder(height, options.radius ?? 0, 16, a.x, a.y, a.z, q.x, q.y, q.z, q.w), type);
                break;
            }
            case PhysicsShapeType.CONVEX_HULL:
            case PhysicsShapeType.MESH: {
                if (!options.mesh && options.positions) {
                    this._initShapeFromPositions(shape, type, options.positions, options.positionIndices);
                    break;
                }
                const mesh = options.mesh;
                if (!mesh) {
                    throw new Error("No mesh provided to create physics shape.");
                }
                const needIndices = type === PhysicsShapeType.MESH;
                const flipWinding = !mesh.getScene().useRightHandedSystem;
                const accum = new MeshGeometryAccumulator(needIndices, flipWinding);
                accum.addNodeMeshes(mesh, !!options.includeChildMeshes);
                if (type === PhysicsShapeType.CONVEX_HULL) {
                    const slot = this._withFloatBuffer(accum.vertices, (ptr) => b3._bx_ShapeDesc_CreateHull(ptr, accum.vertexCount));
                    this._registerShape(shape, slot, type);
                } else {
                    const slot = this._withFloatBuffer(accum.vertices, (vptr) =>
                        this._withIntBuffer(accum.indices, (iptr) => b3._bx_ShapeDesc_CreateMesh(vptr, accum.vertexCount, iptr, accum.triangleCount, 1, 1, 1, 0, 0))
                    );
                    this._registerShape(shape, slot, type);
                }
                break;
            }
            case PhysicsShapeType.HEIGHTFIELD: {
                if (options.groundMesh) {
                    this._createOptionsFromGroundMesh(options);
                }
                const nx = options.numHeightFieldSamplesX;
                const nz = options.numHeightFieldSamplesZ;
                if (!nx || !nz || !options.heightFieldSizeX || !options.heightFieldSizeZ || !options.heightFieldData) {
                    throw new Error("Missing required heightfield parameters");
                }
                const heights = new Float32Array(nx * nz);
                for (let x = 0; x < nx; x++) {
                    for (let z = 0; z < nz; z++) {
                        // box3d rows run along z (index z * countX + x); Babylon data rows are flipped along z
                        heights[z * nx + x] = options.heightFieldData[(nz - 1 - z) * nx + x];
                    }
                }
                const scaleX = options.heightFieldSizeX / (nx - 1);
                const scaleZ = options.heightFieldSizeZ / (nz - 1);
                const cellsX = nx - 1;
                const cellsZ = nz - 1;
                const source = options.heightFieldMaterials;
                if (source && source.length !== cellsX * cellsZ) {
                    throw new Error(`heightFieldMaterials needs ${cellsX * cellsZ} cells (${cellsX} × ${cellsZ}), got ${source.length}`);
                }
                // Cells flip along z the same way the heights do.
                const materials = source ? new Uint8Array(cellsX * cellsZ) : null;
                if (source && materials) {
                    for (let x = 0; x < cellsX; x++) {
                        for (let z = 0; z < cellsZ; z++) {
                            materials[z * cellsX + x] = source[(cellsZ - 1 - z) * cellsX + x];
                        }
                    }
                }
                const slot = this._withFloatBuffer(heights, (heightsPtr) =>
                    this._withByteBuffer(materials, (materialsPtr) =>
                        b3._bx_ShapeDesc_CreateHeightField(
                            heightsPtr,
                            materialsPtr,
                            nx,
                            nz,
                            scaleX,
                            1,
                            scaleZ,
                            0,
                            -options.heightFieldSizeX! * 0.5,
                            0,
                            -options.heightFieldSizeZ! * 0.5
                        )
                    )
                );
                this._registerShape(shape, slot, type);
                break;
            }
            case PhysicsShapeType.CONTAINER: {
                this._registerShape(shape, b3._bx_ShapeDesc_CreateContainer(), type);
                break;
            }
            default:
                throw new Error("Unsupported Shape Type.");
        }
    }

    private _initShapeFromPositions(shape: PhysicsShape, type: PhysicsShapeType, positions: ArrayLike<number>, indices: ArrayLike<number> | undefined): void {
        const b3 = this._b3;
        if (positions.length % 3 !== 0) {
            throw new Error(`positions needs x, y, z triplets, got ${positions.length} numbers`);
        }
        const vertexCount = positions.length / 3;
        if (type === PhysicsShapeType.CONVEX_HULL) {
            this._registerShape(
                shape,
                this._withFloatBuffer(positions, (ptr) => b3._bx_ShapeDesc_CreateHull(ptr, vertexCount)),
                type
            );
            return;
        }
        if (!indices || indices.length % 3 !== 0) {
            throw new Error("a MESH shape from positions needs positionIndices, three per triangle");
        }
        for (let i = 0; i < indices.length; i++) {
            if (indices[i] < 0 || indices[i] >= vertexCount || !Number.isInteger(indices[i])) {
                throw new Error(`positionIndices[${i}] is ${indices[i]}, but there are ${vertexCount} points`);
            }
        }
        this._registerShape(
            shape,
            this._withFloatBuffer(positions, (vptr) =>
                this._withIntBuffer(indices, (iptr) => b3._bx_ShapeDesc_CreateMesh(vptr, vertexCount, iptr, indices.length / 3, 1, 1, 1, 0, 0))
            ),
            type
        );
    }

    // Re-instantiates the shape on every body that uses it (or uses a container holding it). Only needed for geometry
    // and child changes; filters, materials and density are applied in place, see _syncShapeUsers.
    private _refreshShapeUsers(data: Box3DShapeData, visited = new Set<Box3DShapeData>()): void {
        if (visited.has(data)) {
            return;
        }
        visited.add(data);
        for (const body of data.users) {
            this._b3._bx_Body_SetShape(body.slot, data.slot);
            this._applyEventFlags(body);
            this._internalUpdateMassProperties(body);
        }
        for (const parent of data.parents) {
            this._refreshShapeUsers(parent, visited);
        }
    }

    /**
     * Pushes changed description properties into the Box3D shapes that are already on the bodies using this shape,
     * directly or through a container. Rebuilding them instead would drop their contacts and re-apply the body mass.
     */
    private _syncShapeUsers(data: Box3DShapeData, what: Box3DShapeSync, visited = new Set<Box3DShapeData>(), changed = data): void {
        if (visited.has(data)) {
            return;
        }
        visited.add(data);
        for (const body of data.users) {
            this._b3._bx_Body_SyncShapeDesc(body.slot, changed.slot, what);
            if (what & Box3DShapeSync.DENSITY) {
                this._internalUpdateMassProperties(body);
            }
        }
        for (const parent of data.parents) {
            this._syncShapeUsers(parent, what, visited, changed);
        }
    }

    public setShapeFilterMembershipMask(shape: PhysicsShape, membershipMask: number): void {
        const data = shape._pluginData as Box3DShapeData;
        const collide = this._b3._bx_ShapeDesc_GetMaskBits(data.slot);
        this._b3._bx_ShapeDesc_SetFilter(data.slot, membershipMask >>> 0, collide >>> 0);
        this._syncShapeUsers(data, Box3DShapeSync.FILTER);
    }

    public getShapeFilterMembershipMask(shape: PhysicsShape): number {
        return this._b3._bx_ShapeDesc_GetCategoryBits((shape._pluginData as Box3DShapeData).slot);
    }

    public setShapeFilterCollideMask(shape: PhysicsShape, collideMask: number): void {
        const data = shape._pluginData as Box3DShapeData;
        const membership = this._b3._bx_ShapeDesc_GetCategoryBits(data.slot);
        this._b3._bx_ShapeDesc_SetFilter(data.slot, membership >>> 0, collideMask >>> 0);
        this._syncShapeUsers(data, Box3DShapeSync.FILTER);
    }

    public getShapeFilterCollideMask(shape: PhysicsShape): number {
        return this._b3._bx_ShapeDesc_GetMaskBits((shape._pluginData as Box3DShapeData).slot);
    }

    public setMaterial(shape: PhysicsShape, material: PhysicsMaterial): void {
        const data = shape._pluginData as Box3DShapeData;
        data.material = material;
        this._b3._bx_ShapeDesc_SetMaterial(data.slot, material.friction ?? 0.5, material.restitution ?? 0);
        this._syncShapeUsers(data, Box3DShapeSync.MATERIAL);
    }

    public getMaterial(shape: PhysicsShape): PhysicsMaterial {
        const data = shape._pluginData as Box3DShapeData;
        return {
            friction: this._b3._bx_ShapeDesc_GetFriction(data.slot),
            staticFriction: data.material.staticFriction,
            restitution: this._b3._bx_ShapeDesc_GetRestitution(data.slot),
            frictionCombine: data.material.frictionCombine,
            restitutionCombine: data.material.restitutionCombine,
        };
    }

    public setDensity(shape: PhysicsShape, density: number): void {
        const data = shape._pluginData as Box3DShapeData;
        this._b3._bx_ShapeDesc_SetDensity(data.slot, density);
        this._syncShapeUsers(data, Box3DShapeSync.DENSITY);
    }

    public getDensity(shape: PhysicsShape): number {
        return this._b3._bx_ShapeDesc_GetDensity((shape._pluginData as Box3DShapeData).slot);
    }

    public addChild(shape: PhysicsShape, newChild: PhysicsShape, translation?: Vector3, rotation?: Quaternion, scale?: Vector3): void {
        const parent = shape._pluginData as Box3DShapeData;
        const child = newChild._pluginData as Box3DShapeData;
        const t = translation ?? Vector3.ZeroReadOnly;
        const r = rotation ?? Quaternion.Identity();
        const s = scale ?? Vector3.OneReadOnly;
        this._b3._bx_ShapeDesc_AddChild(parent.slot, child.slot, t.x, t.y, t.z, r.x, r.y, r.z, r.w, s.x, s.y, s.z);
        parent.children.push(child);
        child.parents.add(parent);
        this._refreshShapeUsers(parent);
    }

    public removeChild(shape: PhysicsShape, childIndex: number): void {
        const parent = shape._pluginData as Box3DShapeData;
        this._b3._bx_ShapeDesc_RemoveChild(parent.slot, childIndex);
        const [child] = parent.children.splice(childIndex, 1);
        if (child && !parent.children.includes(child)) {
            child.parents.delete(parent);
        }
        this._refreshShapeUsers(parent);
    }

    public getNumChildren(shape: PhysicsShape): number {
        return this._b3._bx_ShapeDesc_GetChildCount((shape._pluginData as Box3DShapeData).slot);
    }

    public getBoundingBox(shape: PhysicsShape): BoundingBox {
        this._b3._bx_ShapeDesc_GetAABB((shape._pluginData as Box3DShapeData).slot);
        const s = this._scratch();
        TmpVectors.Vector3[0].set(s[0], s[1], s[2]);
        TmpVectors.Vector3[1].set(s[3], s[4], s[5]);
        return new BoundingBox(TmpVectors.Vector3[0], TmpVectors.Vector3[1], Matrix.IdentityReadOnly);
    }

    public getBodyBoundingBox(body: PhysicsBody): BoundingBox {
        const data = this._getPluginReference(body);
        this._b3._bx_Body_GetAABB(data.slot);
        const s = this._scratch();
        TmpVectors.Vector3[0].set(s[0], s[1], s[2]);
        TmpVectors.Vector3[1].set(s[3], s[4], s[5]);
        return new BoundingBox(TmpVectors.Vector3[0], TmpVectors.Vector3[1], Matrix.IdentityReadOnly);
    }

    public disposeShape(shape: PhysicsShape): void {
        const data = shape._pluginData as Box3DShapeData;
        if (!data) {
            return;
        }
        for (const parent of data.parents) {
            const index = parent.children.indexOf(data);
            if (index >= 0) {
                parent.children.splice(index, 1);
                this._b3._bx_ShapeDesc_RemoveChild(parent.slot, index);
            }
        }
        for (const child of data.children) {
            child.parents.delete(data);
        }
        this._shapes[data.slot] = undefined;
        this._b3._bx_ShapeDesc_Destroy(data.slot);
        shape._pluginData = undefined;
    }

    public setTrigger(shape: PhysicsShape, isTrigger: boolean): void {
        const data = shape._pluginData as Box3DShapeData;
        this._b3._bx_ShapeDesc_SetSensor(data.slot, isTrigger ? 1 : 0);
        // Box3D decides at creation whether a shape is a sensor, so this one does need a rebuild
        this._refreshShapeUsers(data);
    }

    // ----------------------------------------------------------------------------------------
    // constraints
    // ----------------------------------------------------------------------------------------

    private _frameToBuffer(buffer: Float32Array, offset: number, pivot: Vector3, xAxis: Vector3, yAxis: Vector3, zAxis: Vector3): void {
        const m = TmpVectors.Matrix[0];
        Matrix.FromValuesToRef(xAxis.x, xAxis.y, xAxis.z, 0, yAxis.x, yAxis.y, yAxis.z, 0, zAxis.x, zAxis.y, zAxis.z, 0, 0, 0, 0, 1, m);
        const q = this._tmpQuat[2];
        Quaternion.FromRotationMatrixToRef(m, q);
        q.normalize();
        buffer[offset] = pivot.x;
        buffer[offset + 1] = pivot.y;
        buffer[offset + 2] = pivot.z;
        buffer[offset + 3] = q.x;
        buffer[offset + 4] = q.y;
        buffer[offset + 5] = q.z;
        buffer[offset + 6] = q.w;
    }

    private _buildFrames(cdata: Box3DConstraintData, constraint: PhysicsConstraint, bodyA: Box3DBodyData, bodyB: Box3DBodyData): void {
        const options = constraint.options;
        const pivotA = options.pivotA ?? Vector3.ZeroReadOnly;
        const pivotB = options.pivotB ?? Vector3.ZeroReadOnly;
        const axisA = (options.axisA ?? Vector3.RightReadOnly).normalizeToNew();
        const axisB = (options.axisB ?? Vector3.RightReadOnly).normalizeToNew();
        const perpA = options.perpAxisA ? options.perpAxisA.normalizeToNew() : axisA.getNormalToRef(new Vector3());
        const perpB = options.perpAxisB ? options.perpAxisB.normalizeToNew() : axisB.getNormalToRef(new Vector3());
        // Gram-Schmidt in case the user's perp axis is not exactly perpendicular
        perpA.subtractInPlace(axisA.scale(Vector3.Dot(axisA, perpA))).normalize();
        perpB.subtractInPlace(axisB.scale(Vector3.Dot(axisB, perpB))).normalize();
        const thirdA = Vector3.Cross(axisA, perpA);
        const thirdB = Vector3.Cross(axisB, perpB);

        if (!constraint._initOptions) {
            constraint._initOptions = {
                axisA: axisA.clone(),
                axisB: axisB.clone(),
                perpAxisA: perpA.clone(),
                perpAxisB: perpB.clone(),
                pivotA: pivotA.clone(),
                pivotB: pivotB.clone(),
            };
        }

        const frames = cdata.frames;
        if (cdata.plan) {
            // SIX_DOF: the constraint basis is Havok's [axis, perpAxis, axis x perpAxis]; the plan picks which of them
            // becomes Box3D's frame x, y and z (cyclic permutations, so the frames stay right handed)
            const basis = cdata.plan.basis;
            if (basis) {
                const basisA = [axisA, perpA, thirdA];
                const basisB = [axisB, perpB, thirdB];
                this._frameToBuffer(frames, 0, pivotA, basisA[basis[0]], basisA[basis[1]], basisA[basis[2]]);
                this._frameToBuffer(frames, 7, pivotB, basisB[basis[0]], basisB[basis[1]], basisB[basis[2]]);
            } else {
                frames.set([pivotA.x, pivotA.y, pivotA.z, 0, 0, 0, 1, pivotB.x, pivotB.y, pivotB.z, 0, 0, 0, 1]);
            }
            return;
        }
        switch (cdata.type) {
            case PhysicsConstraintType.HINGE:
            case PhysicsConstraintType.BALL_AND_SOCKET:
                // box3d: revolute rotates about the frame z axis, spherical cone is centered on frame A z
                this._frameToBuffer(frames, 0, pivotA, perpA, Vector3.Cross(axisA, perpA), axisA);
                this._frameToBuffer(frames, 7, pivotB, perpB, Vector3.Cross(axisB, perpB), axisB);
                break;
            case PhysicsConstraintType.PRISMATIC:
            case PhysicsConstraintType.SLIDER:
                // box3d: prismatic slides along the frame A x axis
                this._frameToBuffer(frames, 0, pivotA, axisA, perpA, thirdA);
                this._frameToBuffer(frames, 7, pivotB, axisB, perpB, thirdB);
                break;
            case PhysicsConstraintType.LOCK: {
                // weld the bodies in their current relative pose
                this._b3._bx_Body_GetTransform(bodyA.slot);
                let s = this._scratch();
                const qA = this._tmpQuat[0];
                qA.set(s[3], s[4], s[5], s[6]);
                this._b3._bx_Body_GetTransform(bodyB.slot);
                s = this._scratch();
                const qB = this._tmpQuat[1];
                qB.set(s[3], s[4], s[5], s[6]);
                // frameB rotation = inv(qB) * qA so both frames coincide in world space now
                const rel = qB.invert().multiply(qA).normalize();
                frames.set([pivotA.x, pivotA.y, pivotA.z, 0, 0, 0, 1, pivotB.x, pivotB.y, pivotB.z, rel.x, rel.y, rel.z, rel.w]);
                break;
            }
            default:
                frames.set([pivotA.x, pivotA.y, pivotA.z, 0, 0, 0, 1, pivotB.x, pivotB.y, pivotB.z, 0, 0, 0, 1]);
                break;
        }
    }

    private _createJoint(cdata: Box3DConstraintData, bodyA: Box3DBodyData, bodyB: Box3DBodyData): number {
        this._scratch().set(cdata.frames);
        const joint = this._b3._bx_CreateJoint(this._worldSlot, cdata.jointType, bodyA.slot, bodyB.slot, cdata.collisions ? 1 : 0, cdata.length);
        if (!joint) {
            Logger.Warn("Box3DPlugin: joint creation failed.");
            return 0;
        }
        // A slider allows rotation about the axis in Havok. Box3D's prismatic locks it.
        this._applyAxisState(cdata, joint, bodyA, bodyB);
        return joint;
    }

    /** Reads Physics6DoFConstraint.limits into the axis table with Havok's rules. */
    private _readSixDofLimits(cdata: Box3DConstraintData, limits: ReadonlyArray<Physics6DoFLimit> | undefined): void {
        for (const limit of limits ?? []) {
            const state = this._axisState(cdata, limit.axis);
            if (limit.minLimit === 0 && limit.maxLimit === 0) {
                state.mode = PhysicsConstraintAxisLimitMode.LOCKED;
                state.min = 0;
                state.max = 0;
            } else if (limit.minLimit !== undefined || limit.maxLimit !== undefined) {
                // a missing side is unbounded
                state.mode = PhysicsConstraintAxisLimitMode.LIMITED;
                state.min = limit.minLimit ?? -Infinity;
                state.max = limit.maxLimit ?? Infinity;
            }
            state.stiffness = limit.stiffness ?? 0;
            state.damping = limit.damping ?? 0;
        }
    }

    /**
     * Maps the six axes of a SIX_DOF constraint onto one Box3D joint, following Havok's semantics: an axis that is not
     * listed is free, 0/0 is locked, anything else is limited. The constraint frame is [axis, perpAxis, axis x perpAxis];
     * ANGULAR_X rotates about axis, ANGULAR_Y about perpAxis and ANGULAR_Z about axis x perpAxis, all measured as the
     * rotation of the child frame relative to the parent frame (right handed, like Havok).
     *  - all linear locked, all angular locked: weld
     *  - all linear locked, one angular axis open: revolute about it, with its limits (one sided ranges work)
     *  - all linear locked, two or three angular axes open: spherical, twist limits from ANGULAR_X and one symmetric
     *    cone from ANGULAR_Y/Z (Box3D has no elliptical cone, the larger swing range is used)
     *  - two linear locked, angular locked: prismatic along the open linear axis
     *  - only LINEAR_DISTANCE constrained: distance joint (a spring when min == max and a stiffness is set)
     *  - nothing constrained: filter joint (collision filtering only)
     * Anything else warns once and uses the closest of these.
     */
    private _planSixDof(cdata: Box3DConstraintData): ISixDofPlan {
        const Axis = PhysicsConstraintAxis;
        const Mode = PhysicsConstraintAxisLimitMode;
        const mode = (axis: PhysicsConstraintAxis) => cdata.axes.get(axis)?.mode ?? Mode.FREE;
        const range = (axis: PhysicsConstraintAxis): [number, number] => {
            const state = cdata.axes.get(axis)!;
            return state.mode === Mode.LOCKED ? [0, 0] : [Math.min(state.min, state.max), Math.max(state.min, state.max)];
        };
        const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
        const maxAngle = 0.99 * Math.PI;
        // Box3D's B3_HUGE, keeps an unbounded side of a linear range out of the solver as a real number
        const maxLength = 100000;
        const plan: ISixDofPlan = {
            jointType: Box3DJointType.WELD,
            basis: [0, 1, 2],
            primaryAxis: null,
            coneAngle: -1,
            twist: null,
            limit: null,
            spring: false,
            stiffness: 0,
            damping: 0,
            angularStiffness: false,
        };
        for (const [axis, state] of cdata.axes) {
            if ((state.stiffness > 0 || state.damping > 0) && state.stiffness >= plan.stiffness) {
                plan.stiffness = state.stiffness;
                plan.damping = state.damping;
                plan.angularStiffness = axis === Axis.ANGULAR_X || axis === Axis.ANGULAR_Y || axis === Axis.ANGULAR_Z;
            }
        }
        const linear = [Axis.LINEAR_X, Axis.LINEAR_Y, Axis.LINEAR_Z];
        const angular = [Axis.ANGULAR_X, Axis.ANGULAR_Y, Axis.ANGULAR_Z];
        const linearLocked = linear.filter((a) => mode(a) === Mode.LOCKED).length;
        const linearFree = linear.filter((a) => mode(a) === Mode.FREE).length;
        const angularOpen = angular.filter((a) => mode(a) !== Mode.LOCKED);
        const angularFree = angular.filter((a) => mode(a) === Mode.FREE).length;
        const distanceMode = mode(Axis.LINEAR_DISTANCE);

        if (distanceMode !== Mode.FREE) {
            if (linearFree === 3 && angularFree === 3) {
                const [lower, upper] = range(Axis.LINEAR_DISTANCE);
                plan.jointType = Box3DJointType.DISTANCE;
                plan.basis = null;
                plan.primaryAxis = Axis.LINEAR_DISTANCE;
                plan.limit = [Math.min(Math.max(0, lower), maxLength), Math.min(Math.max(0, upper), maxLength)];
                plan.spring = plan.stiffness > 0 && Math.abs(upper - lower) < 1e-6 && isFinite(lower);
                return plan;
            }
            this._warnOnce("sixdof-distance", "SIX_DOF: LINEAR_DISTANCE combined with other constrained axes is not supported with Box3D, the distance limit is ignored.");
        }

        // one open linear axis (free or limited) with the other two locked slides; see the prismatic case below
        let pointJoint = linearLocked === 3;
        if (!pointJoint && linearLocked !== 2 && linearFree === 0) {
            this._warnOnce("sixdof-linear-limited", "SIX_DOF: two or more limited linear axes are treated as locked with Box3D.");
            pointJoint = true;
        }
        if (pointJoint) {
            if (angularOpen.length === 0) {
                return plan;
            }
            if (angularOpen.length === 1) {
                // Box3D revolutes rotate about frame z
                const axis = angularOpen[0];
                plan.jointType = Box3DJointType.REVOLUTE;
                plan.basis = [
                    [1, 2, 0],
                    [2, 0, 1],
                    [0, 1, 2],
                ][angular.indexOf(axis)] as [number, number, number];
                plan.primaryAxis = axis;
                if (mode(axis) === Mode.LIMITED) {
                    const [lower, upper] = range(axis);
                    plan.limit = [clamp(lower, maxAngle), clamp(upper, maxAngle)];
                }
                return plan;
            }
            // spherical: cone centered on frame z (axis), twist about frame z
            plan.jointType = Box3DJointType.SPHERICAL;
            plan.basis = [1, 2, 0];
            if (mode(Axis.ANGULAR_X) !== Mode.FREE) {
                const [lower, upper] = range(Axis.ANGULAR_X);
                plan.twist = [clamp(lower, maxAngle), clamp(upper, maxAngle)];
            }
            const swingModes = [mode(Axis.ANGULAR_Y), mode(Axis.ANGULAR_Z)];
            if (swingModes.some((m) => m !== Mode.FREE)) {
                const extents: number[] = [];
                let asymmetric = false;
                for (const axis of [Axis.ANGULAR_Y, Axis.ANGULAR_Z]) {
                    if (mode(axis) === Mode.FREE) {
                        continue;
                    }
                    const [lower, upper] = range(axis);
                    extents.push(Math.max(Math.abs(lower), Math.abs(upper)));
                    asymmetric ||= Math.abs(lower + upper) > 1e-4;
                }
                const cone = Math.max(...extents);
                if (isFinite(cone)) {
                    if (swingModes.includes(Mode.FREE) || Math.abs(extents[0] - extents[1]) > 1e-4 || asymmetric) {
                        this._warnOnce(
                            "sixdof-cone",
                            "SIX_DOF: Box3D has one symmetric swing cone, ANGULAR_Y and ANGULAR_Z use the larger of their ranges."
                        );
                    }
                    if (cone > Math.PI / 2) {
                        this._warnOnce("sixdof-cone-90", "SIX_DOF: Box3D cone limits are at most 90 degrees, larger swing ranges are clamped.");
                    }
                    plan.coneAngle = Math.min(cone, Math.PI / 2);
                }
            }
            return plan;
        }

        if (linearLocked === 2) {
            // Box3D prismatics slide along frame x
            const slide = linear.find((a) => mode(a) !== Mode.LOCKED)!;
            plan.jointType = Box3DJointType.PRISMATIC;
            plan.basis = [
                [0, 1, 2],
                [1, 2, 0],
                [2, 0, 1],
            ][linear.indexOf(slide)] as [number, number, number];
            plan.primaryAxis = slide;
            if (mode(slide) === Mode.LIMITED) {
                const [lower, upper] = range(slide);
                plan.limit = [clamp(lower, maxLength), clamp(upper, maxLength)];
            }
            if (angularOpen.length) {
                this._warnOnce("sixdof-prismatic", "SIX_DOF: a sliding axis with rotation is not supported with Box3D, rotation is locked.");
            }
            return plan;
        }

        plan.jointType = Box3DJointType.FILTER;
        plan.basis = null;
        if (linearFree !== 3 || angularFree !== 3) {
            this._warnOnce("sixdof-unsupported", "SIX_DOF: this combination of free and limited axes is not supported with Box3D, the bodies are left unconstrained.");
        }
        return plan;
    }

    /** Box3D spring settings for a Havok spring constant and damping on a body pair. */
    private _springToHertz(stiffness: number, damping: number, angular: boolean, bodyA: Box3DBodyData, bodyB: Box3DBodyData): { hertz: number; dampingRatio: number } {
        // effective mass (or rotational inertia) of the pair, a static or animated body counts as infinitely heavy
        const inverse = (data: Box3DBodyData) => {
            if (data.motionType !== PhysicsMotionType.DYNAMIC) {
                return 0;
            }
            this._b3._bx_Body_GetMassData(data.slot);
            const s = this._scratch();
            const value = angular ? (s[4] + s[5] + s[6]) / 3 : s[0];
            return value > 0 ? 1 / value : 0;
        };
        const inverseSum = inverse(bodyA) + inverse(bodyB);
        const mass = inverseSum > 0 ? 1 / inverseSum : 1;
        const k = Math.max(stiffness, 0);
        return {
            hertz: Math.sqrt(k / mass) / (2 * Math.PI),
            dampingRatio: k > 0 ? damping / (2 * Math.sqrt(k * mass)) : 1,
        };
    }

    public initConstraint(constraint: PhysicsConstraint, body: PhysicsBody, childBody: PhysicsBody, instanceIndex?: number, childInstanceIndex?: number): void {
        const type = constraint.type;
        const options = constraint.options;
        if (!type || !options) {
            Logger.Warn("No constraint type or options. Constraint is invalid.");
            return;
        }
        if ((body._pluginDataInstances.length > 0 && instanceIndex === undefined) || (childBody._pluginDataInstances.length > 0 && childInstanceIndex === undefined)) {
            Logger.Warn("Body is instanced but no instance index was specified. Constraint will not be applied.");
            return;
        }
        const firstPair = !constraint._pluginData;
        const cdata: Box3DConstraintData = constraint._pluginData ?? new Box3DConstraintData();
        constraint._pluginData = cdata;
        cdata.type = type;
        if (firstPair) {
            cdata.collisions = !!options.collision;
        }
        switch (type) {
            case PhysicsConstraintType.BALL_AND_SOCKET:
                cdata.jointType = Box3DJointType.SPHERICAL;
                break;
            case PhysicsConstraintType.HINGE:
                cdata.jointType = Box3DJointType.REVOLUTE;
                break;
            case PhysicsConstraintType.PRISMATIC:
            case PhysicsConstraintType.SLIDER:
                cdata.jointType = Box3DJointType.PRISMATIC;
                break;
            case PhysicsConstraintType.LOCK:
                cdata.jointType = Box3DJointType.WELD;
                break;
            case PhysicsConstraintType.DISTANCE:
                cdata.jointType = Box3DJointType.DISTANCE;
                break;
            case PhysicsConstraintType.SIX_DOF:
                // later pairs of the same constraint share the axis table, including changes made since the first pair
                if (firstPair) {
                    this._readSixDofLimits(cdata, (constraint as Physics6DoFConstraint).limits);
                }
                cdata.plan = this._planSixDof(cdata);
                cdata.jointType = cdata.plan.jointType;
                break;
            default:
                Logger.Warn("Box3DPlugin: unknown constraint type " + type);
                return;
        }

        const bodyA = this._getPluginReference(body, instanceIndex);
        const bodyB = this._getPluginReference(childBody, childInstanceIndex);
        this._buildFrames(cdata, constraint, bodyA, bodyB);
        this._updateJointLength(cdata, options.maxDistance, bodyA, bodyB);
        // joints[i] belongs to pairs[i], 0 while the constraint is disabled or when creation failed
        const joint = cdata.enabled ? this._createJoint(cdata, bodyA, bodyB) : 0;
        cdata.joints.push(joint);
        cdata.pairs.push({ parent: body, parentIndex: instanceIndex ?? 0, child: childBody, childIndex: childInstanceIndex ?? 0, parentData: bodyA, childData: bodyB });
    }

    /** Length parameter passed to Box3D's distance joint at creation (the rest length of its spring). */
    private _updateJointLength(cdata: Box3DConstraintData, maxDistance: number | undefined, bodyA: Box3DBodyData, bodyB: Box3DBodyData): void {
        if (cdata.type === PhysicsConstraintType.DISTANCE) {
            cdata.length = maxDistance ?? 0;
        } else if (cdata.plan?.jointType === Box3DJointType.DISTANCE && cdata.plan.limit) {
            // a spring rests at its (single) limit; for a rope the rest length is unused, its limits do the work
            cdata.length = cdata.plan.limit[0];
        } else {
            return;
        }
        if (cdata.length <= 0) {
            // use the current distance between the world space pivots
            cdata.length = Math.max(0.01, this._currentPivotDistance(cdata, bodyA, bodyB));
        }
    }

    private _currentPivotDistance(cdata: Box3DConstraintData, bodyA: Box3DBodyData, bodyB: Box3DBodyData): number {
        const f = cdata.frames;
        const worldA = this._tmpVec3[0];
        const worldB = this._tmpVec3[1];
        this._b3._bx_Body_GetTransform(bodyA.slot);
        let s = this._scratch();
        this._tmpQuat[0].set(s[3], s[4], s[5], s[6]);
        worldA.set(f[0], f[1], f[2]).applyRotationQuaternionInPlace(this._tmpQuat[0]).addInPlaceFromFloats(s[0], s[1], s[2]);
        this._b3._bx_Body_GetTransform(bodyB.slot);
        s = this._scratch();
        this._tmpQuat[0].set(s[3], s[4], s[5], s[6]);
        worldB.set(f[7], f[8], f[9]).applyRotationQuaternionInPlace(this._tmpQuat[0]).addInPlaceFromFloats(s[0], s[1], s[2]);
        return Vector3.Distance(worldA, worldB);
    }

    public setEnabled(constraint: PhysicsConstraint, isEnabled: boolean): void {
        const cdata = constraint._pluginData as Box3DConstraintData;
        if (!cdata || cdata.enabled === isEnabled) {
            return;
        }
        cdata.enabled = isEnabled;
        // Box3D has no enable flag on joints: destroy them, or re-create them from the saved frames, plan and axis state.
        this._recreateJoints(cdata);
    }

    private _destroyJoint(joint: number): void {
        this._motorJoints.delete(joint);
        this._b3._bx_DestroyJoint(joint);
    }

    private _recreateJoints(cdata: Box3DConstraintData): void {
        for (let i = 0; i < cdata.pairs.length; i++) {
            if (cdata.joints[i]) {
                this._destroyJoint(cdata.joints[i]);
            }
            const pair = cdata.pairs[i];
            cdata.joints[i] = cdata.enabled && pair.parentData.slot && pair.childData.slot ? this._createJoint(cdata, pair.parentData, pair.childData) : 0;
        }
    }

    public getEnabled(constraint: PhysicsConstraint): boolean {
        return (constraint._pluginData as Box3DConstraintData)?.enabled ?? false;
    }

    public setCollisionsEnabled(constraint: PhysicsConstraint, isEnabled: boolean): void {
        const cdata = constraint._pluginData as Box3DConstraintData;
        cdata.collisions = isEnabled;
        for (const joint of cdata.joints) {
            if (joint) {
                this._b3._bx_Joint_SetCollideConnected(joint, isEnabled ? 1 : 0);
            }
        }
    }

    public getCollisionsEnabled(constraint: PhysicsConstraint): boolean {
        return (constraint._pluginData as Box3DConstraintData)?.collisions ?? false;
    }

    // The one axis box3d exposes for this constraint type.
    private _primaryAxis(cdata: Box3DConstraintData): Nullable<PhysicsConstraintAxis> {
        switch (cdata.type) {
            case PhysicsConstraintType.HINGE:
                return PhysicsConstraintAxis.ANGULAR_X;
            case PhysicsConstraintType.PRISMATIC:
            case PhysicsConstraintType.SLIDER:
                return PhysicsConstraintAxis.LINEAR_X;
            case PhysicsConstraintType.DISTANCE:
                return PhysicsConstraintAxis.LINEAR_DISTANCE;
            case PhysicsConstraintType.BALL_AND_SOCKET:
                return PhysicsConstraintAxis.ANGULAR_Y;
            case PhysicsConstraintType.SIX_DOF:
                return cdata.plan?.primaryAxis ?? null;
            default:
                return null;
        }
    }

    private _isAngularAxis(axis: PhysicsConstraintAxis): boolean {
        return axis === PhysicsConstraintAxis.ANGULAR_X || axis === PhysicsConstraintAxis.ANGULAR_Y || axis === PhysicsConstraintAxis.ANGULAR_Z;
    }

    private _isPrimaryAxis(cdata: Box3DConstraintData, axis: PhysicsConstraintAxis): boolean {
        if (cdata.type === PhysicsConstraintType.BALL_AND_SOCKET || cdata.plan?.jointType === Box3DJointType.SPHERICAL) {
            return this._isAngularAxis(axis);
        }
        return axis === this._primaryAxis(cdata);
    }

    private _axisState(cdata: Box3DConstraintData, axis: PhysicsConstraintAxis): IAxisState {
        let state = cdata.axes.get(axis);
        if (!state) {
            state = {
                mode: PhysicsConstraintAxisLimitMode.FREE,
                min: 0,
                max: 0,
                motor: PhysicsConstraintMotorType.NONE,
                target: 0,
                maxForce: 0,
                friction: 0,
                stiffness: 0,
                damping: 0,
            };
            cdata.axes.set(axis, state);
        }
        return state;
    }

    private _applyAxisState(cdata: Box3DConstraintData, joint: number, bodyA: Box3DBodyData, bodyB: Box3DBodyData): void {
        const b3 = this._b3;
        if (cdata.plan) {
            this._applySixDofPlan(cdata, joint, bodyA, bodyB);
            b3._bx_Joint_WakeBodies(joint);
            return;
        }
        const primary = this._primaryAxis(cdata);
        if (primary === null) {
            return;
        }
        for (const [axis, state] of cdata.axes) {
            if (!this._isPrimaryAxis(cdata, axis)) {
                continue;
            }
            if (cdata.type === PhysicsConstraintType.BALL_AND_SOCKET) {
                if (axis === PhysicsConstraintAxis.ANGULAR_X) {
                    // twist about the primary axis (frame z in box3d)
                    b3._bx_Joint_SetTwistLimits(joint, state.mode === PhysicsConstraintAxisLimitMode.FREE ? 0 : 1, state.min, state.max);
                    continue;
                }
            }
            const limited = state.mode !== PhysicsConstraintAxisLimitMode.FREE;
            if (limited) {
                const min = state.mode === PhysicsConstraintAxisLimitMode.LOCKED ? 0 : state.min;
                const max = state.mode === PhysicsConstraintAxisLimitMode.LOCKED ? 0 : state.max;
                b3._bx_Joint_SetLimits(joint, min, max);
            }
            b3._bx_Joint_EnableLimit(joint, limited ? 1 : 0);
            if (cdata.type !== PhysicsConstraintType.BALL_AND_SOCKET) {
                this._applyMotor(joint, state);
            }
        }
        if (cdata.type === PhysicsConstraintType.BALL_AND_SOCKET) {
            this._applySphericalMotor(cdata, joint);
        }
        b3._bx_Joint_WakeBodies(joint);
    }

    /**
     * Box3D's spherical joint has one motor for the whole joint: a relative angular velocity, and one spring towards a
     * target rotation. Babylon has a motor per axis, so the three angular axes are combined into one target in the
     * joint frame (ANGULAR_X about frame z, ANGULAR_Y about frame x, ANGULAR_Z about frame y).
     */
    private _applySphericalMotor(cdata: Box3DConstraintData, joint: number): void {
        const b3 = this._b3;
        const twist = cdata.axes.get(PhysicsConstraintAxis.ANGULAR_X);
        const swing1 = cdata.axes.get(PhysicsConstraintAxis.ANGULAR_Y);
        const swing2 = cdata.axes.get(PhysicsConstraintAxis.ANGULAR_Z);
        const states = [twist, swing1, swing2];
        const velocity = (state?: IAxisState) => (state?.motor === PhysicsConstraintMotorType.VELOCITY ? state.target : 0);
        const hasVelocity = states.some((state) => state?.motor === PhysicsConstraintMotorType.VELOCITY);
        const hasPosition = states.some((state) => state?.motor === PhysicsConstraintMotorType.POSITION);
        const maxTorque = Math.max(...states.map((state) => (state?.motor === PhysicsConstraintMotorType.VELOCITY ? state.maxForce : 0)));
        b3._bx_Joint_SetSphericalMotor(joint, hasVelocity ? 1 : 0, velocity(swing1), velocity(swing2), velocity(twist), maxTorque);
        const target = velocity(swing1) !== 0 || velocity(swing2) !== 0 || velocity(twist) !== 0;
        if (hasVelocity && target) {
            // the world space target has to follow body A as it turns
            this._motorJoints.add(joint);
        } else {
            this._motorJoints.delete(joint);
        }
        b3._bx_Joint_EnableSpring(joint, hasPosition ? 1 : 0);
        if (hasPosition) {
            const position = (state?: IAxisState) => (state?.motor === PhysicsConstraintMotorType.POSITION ? state.target : 0);
            const rotation = this._tmpQuat[0];
            Quaternion.RotationYawPitchRollToRef(0, 0, position(twist), rotation);
            const swing = this._tmpQuat[1];
            Quaternion.RotationYawPitchRollToRef(position(swing2), position(swing1), 0, swing);
            rotation.multiplyInPlace(swing);
            b3._bx_Joint_SetSpring(joint, 5, 1);
            b3._bx_Joint_SetSphericalTarget(joint, rotation.x, rotation.y, rotation.z, rotation.w);
        }
    }

    private _applyMotor(joint: number, state: IAxisState): void {
        const b3 = this._b3;
        switch (state.motor) {
            case PhysicsConstraintMotorType.VELOCITY:
                b3._bx_Joint_EnableSpring(joint, 0);
                b3._bx_Joint_EnableMotor(joint, 1);
                b3._bx_Joint_SetMotorSpeed(joint, state.target);
                b3._bx_Joint_SetMaxMotorForce(joint, state.maxForce);
                break;
            case PhysicsConstraintMotorType.POSITION:
                b3._bx_Joint_EnableMotor(joint, 0);
                b3._bx_Joint_EnableSpring(joint, 1);
                b3._bx_Joint_SetSpring(joint, 5, 1);
                b3._bx_Joint_SetTarget(joint, state.target);
                break;
            default:
                b3._bx_Joint_EnableMotor(joint, 0);
                b3._bx_Joint_EnableSpring(joint, 0);
                break;
        }
    }

    /** Applies a SIX_DOF plan's limits, springs and motors to one of its Box3D joints. */
    private _applySixDofPlan(cdata: Box3DConstraintData, joint: number, bodyA: Box3DBodyData, bodyB: Box3DBodyData): void {
        const b3 = this._b3;
        const plan = cdata.plan!;
        switch (plan.jointType) {
            case Box3DJointType.SPHERICAL:
                if (plan.coneAngle >= 0) {
                    b3._bx_Joint_SetLimits(joint, -plan.coneAngle, plan.coneAngle);
                }
                b3._bx_Joint_EnableLimit(joint, plan.coneAngle >= 0 ? 1 : 0);
                b3._bx_Joint_SetTwistLimits(joint, plan.twist ? 1 : 0, plan.twist ? plan.twist[0] : 0, plan.twist ? plan.twist[1] : 0);
                break;
            case Box3DJointType.REVOLUTE:
            case Box3DJointType.PRISMATIC:
                if (plan.limit) {
                    b3._bx_Joint_SetLimits(joint, plan.limit[0], plan.limit[1]);
                }
                b3._bx_Joint_EnableLimit(joint, plan.limit ? 1 : 0);
                break;
            case Box3DJointType.DISTANCE:
                if (plan.spring) {
                    const spring = this._springToHertz(plan.stiffness, plan.damping, false, bodyA, bodyB);
                    b3._bx_Joint_EnableLimit(joint, 0);
                    b3._bx_Joint_EnableSpring(joint, 1);
                    b3._bx_Joint_SetSpring(joint, spring.hertz, spring.dampingRatio);
                    b3._bx_Joint_SetTarget(joint, cdata.length);
                } else {
                    // an enabled spring with 0 hertz leaves the length free between the limits (a rope); Box3D keeps
                    // equal limits rigid
                    b3._bx_Joint_SetLimits(joint, plan.limit![0], plan.limit![1]);
                    b3._bx_Joint_EnableLimit(joint, 1);
                    b3._bx_Joint_EnableSpring(joint, 1);
                    b3._bx_Joint_SetSpring(joint, 0, 0);
                }
                break;
            default:
                break;
        }
        if (plan.stiffness > 0 && !plan.spring) {
            this._warnOnce(
                "sixdof-softness",
                "SIX_DOF: limit stiffness and damping are approximated with Box3D's per joint constraint softness, which applies to every axis of the joint."
            );
            const soft = this._springToHertz(plan.stiffness, plan.damping, plan.angularStiffness, bodyA, bodyB);
            b3._bx_Joint_SetConstraintTuning(joint, soft.hertz, soft.dampingRatio);
        }
        if (plan.jointType === Box3DJointType.SPHERICAL) {
            this._applySphericalMotor(cdata, joint);
        } else if (plan.primaryAxis !== null && plan.jointType !== Box3DJointType.DISTANCE) {
            const state = cdata.axes.get(plan.primaryAxis);
            if (state) {
                this._applyMotor(joint, state);
            }
        }
    }

    private _setAxis(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis, apply: (state: IAxisState) => void): void {
        const cdata = constraint._pluginData as Box3DConstraintData;
        if (!cdata) {
            return;
        }
        const state = this._axisState(cdata, axis);
        const previousMotor = { motor: state.motor, target: state.target, maxForce: state.maxForce };
        apply(state);
        if (cdata.plan) {
            // SIX_DOF: every axis shapes the plan. A different Box3D joint type or frame needs new joints.
            const plan = this._planSixDof(cdata);
            const rebuild = plan.jointType !== cdata.plan.jointType || String(plan.basis) !== String(cdata.plan.basis);
            cdata.plan = plan;
            cdata.jointType = plan.jointType;
            const motorChanged = previousMotor.motor !== state.motor || previousMotor.target !== state.target || previousMotor.maxForce !== state.maxForce;
            if (motorChanged && state.motor !== PhysicsConstraintMotorType.NONE && !this._isPrimaryAxis(cdata, axis)) {
                this._warnOnce(`axis-motor-${axis}`, `SIX_DOF: a motor on axis ${axis} has no effect with the Box3D joint this constraint maps to.`);
            }
            const first = cdata.pairs[0];
            if (first) {
                // the rest length of a distance joint follows its limits, whether or not the joint is rebuilt
                this._updateJointLength(cdata, constraint.options.maxDistance, first.parentData, first.childData);
            }
            if (rebuild) {
                if (first) {
                    this._buildFrames(cdata, constraint, first.parentData, first.childData);
                }
                this._recreateJoints(cdata);
                return;
            }
        } else if (!this._isPrimaryAxis(cdata, axis)) {
            this._warnOnce(`axis-${cdata.type}-${axis}`, `axis ${axis} is not configurable on constraint type ${cdata.type} with Box3D; the value is stored but has no effect.`);
            return;
        }
        for (let i = 0; i < cdata.joints.length; i++) {
            if (cdata.joints[i]) {
                this._applyAxisState(cdata, cdata.joints[i], cdata.pairs[i].parentData, cdata.pairs[i].childData);
            }
        }
    }

    public setAxisFriction(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis, friction: number): void {
        const cdata = constraint._pluginData as Box3DConstraintData;
        if (cdata) {
            this._axisState(cdata, axis).friction = friction;
        }
    }

    public getAxisFriction(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis): Nullable<number> {
        return (constraint._pluginData as Box3DConstraintData)?.axes.get(axis)?.friction ?? null;
    }

    public setAxisMode(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis, limitMode: PhysicsConstraintAxisLimitMode): void {
        this._setAxis(constraint, axis, (state) => (state.mode = limitMode));
    }

    public getAxisMode(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis): Nullable<PhysicsConstraintAxisLimitMode> {
        return (constraint._pluginData as Box3DConstraintData)?.axes.get(axis)?.mode ?? null;
    }

    public setAxisMinLimit(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis, minLimit: number): void {
        this._setAxis(constraint, axis, (state) => {
            state.min = minLimit;
            if (state.mode === PhysicsConstraintAxisLimitMode.FREE) {
                state.mode = PhysicsConstraintAxisLimitMode.LIMITED;
            }
        });
    }

    public getAxisMinLimit(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis): Nullable<number> {
        return (constraint._pluginData as Box3DConstraintData)?.axes.get(axis)?.min ?? null;
    }

    public setAxisMaxLimit(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis, limit: number): void {
        this._setAxis(constraint, axis, (state) => {
            state.max = limit;
            if (state.mode === PhysicsConstraintAxisLimitMode.FREE) {
                state.mode = PhysicsConstraintAxisLimitMode.LIMITED;
            }
        });
    }

    public getAxisMaxLimit(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis): Nullable<number> {
        return (constraint._pluginData as Box3DConstraintData)?.axes.get(axis)?.max ?? null;
    }

    public setAxisMotorType(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis, motorType: PhysicsConstraintMotorType): void {
        this._setAxis(constraint, axis, (state) => (state.motor = motorType));
    }

    public getAxisMotorType(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis): Nullable<PhysicsConstraintMotorType> {
        return (constraint._pluginData as Box3DConstraintData)?.axes.get(axis)?.motor ?? null;
    }

    public setAxisMotorTarget(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis, target: number): void {
        this._setAxis(constraint, axis, (state) => (state.target = target));
    }

    public getAxisMotorTarget(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis): Nullable<number> {
        return (constraint._pluginData as Box3DConstraintData)?.axes.get(axis)?.target ?? null;
    }

    public setAxisMotorMaxForce(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis, maxForce: number): void {
        this._setAxis(constraint, axis, (state) => (state.maxForce = maxForce));
    }

    public getAxisMotorMaxForce(constraint: PhysicsConstraint, axis: PhysicsConstraintAxis): Nullable<number> {
        return (constraint._pluginData as Box3DConstraintData)?.axes.get(axis)?.maxForce ?? null;
    }

    public disposeConstraint(constraint: PhysicsConstraint): void {
        const cdata = constraint._pluginData as Box3DConstraintData;
        if (!cdata) {
            return;
        }
        for (const joint of cdata.joints) {
            if (joint) {
                this._destroyJoint(joint);
            }
        }
        cdata.joints.length = 0;
        cdata.pairs.length = 0;
    }

    public getBodiesUsingConstraint(constraint: PhysicsConstraint): ConstrainedBodyPair[] {
        const cdata = constraint._pluginData as Box3DConstraintData;
        if (!cdata) {
            return [];
        }
        return cdata.pairs.map((p) => ({ parentBody: p.parent, parentBodyIndex: p.parentIndex, childBody: p.child, childBodyIndex: p.childIndex }));
    }

    public addConstraint(body: PhysicsBody, childBody: PhysicsBody, constraint: PhysicsConstraint, instanceIndex?: number, childInstanceIndex?: number): void {
        this.initConstraint(constraint, body, childBody, instanceIndex, childInstanceIndex);
    }

    // ----------------------------------------------------------------------------------------
    // Box3D specific extras
    // ----------------------------------------------------------------------------------------

    /**
     * Applies a radial impulse to every shape within the radius, like a grenade.
     * @param position world position of the explosion
     * @param radius radius of the explosion
     * @param impulsePerArea impulse per surface area of the affected shapes
     * @param falloff distance beyond the radius over which the impulse fades to zero
     */
    public explode(position: Vector3, radius: number, impulsePerArea: number, falloff = 0): void {
        this._b3._bx_World_Explode(this._worldSlot, position.x, position.y, position.z, radius, falloff, impulsePerArea);
    }

    /**
     * Box2D style collision group. Shapes sharing a negative group never collide with each other,
     * shapes sharing a positive group always collide. Zero means no group.
     * @param shape the shape
     * @param groupIndex the group index
     */
    public setShapeFilterGroup(shape: PhysicsShape, groupIndex: number): void {
        const data = shape._pluginData as Box3DShapeData;
        this._b3._bx_ShapeDesc_SetGroup(data.slot, groupIndex | 0);
        this._syncShapeUsers(data, Box3DShapeSync.FILTER);
    }

    /**
     * Rolling resistance for spheres and capsules (Babylon materials have no equivalent).
     * @param shape the shape
     * @param value resistance, typically in [0, 1]
     */
    public setShapeRollingResistance(shape: PhysicsShape, value: number): void {
        const data = shape._pluginData as Box3DShapeData;
        this._b3._bx_ShapeDesc_SetRollingResistance(data.slot, value);
        this._syncShapeUsers(data, Box3DShapeSync.MATERIAL);
    }

    /**
     * Lets a body spin faster than the default angular speed cap (wheels).
     * @param body the body
     * @param allow true to allow fast rotation
     * @param instanceIndex optional thin instance index
     */
    public setAllowFastRotation(body: PhysicsBody, allow: boolean, instanceIndex?: number): void {
        this._applyToBodyOrInstances(body, (data) => this._b3._bx_Body_AllowFastRotation(data.slot, allow ? 1 : 0), instanceIndex);
    }

    /**
     * Creates a Box3D wheel joint between a chassis and a wheel body.
     * @param chassis the chassis body
     * @param wheel the wheel body
     * @param options wheel joint options
     * @returns a handle used to drive and steer the wheel
     */
    public createWheelJoint(chassis: PhysicsBody, wheel: PhysicsBody, options: IBox3DWheelJointOptions): Box3DWheelJoint {
        const s = this._scratch();
        const axisA = (options.axisA ?? Vector3.UpReadOnly).normalizeToNew();
        const axleA = (options.axleA ?? Vector3.Forward()).normalizeToNew();
        // suspension travels along frame A x, the wheel spins about frame z
        axleA.subtractInPlace(axisA.scale(Vector3.Dot(axisA, axleA))).normalize();
        this._frameToBuffer(s, 0, options.pivotA, axisA, Vector3.Cross(axleA, axisA), axleA);
        // frame B must coincide with frame A in world space at creation, compute it from the current poses
        const pivotB = options.pivotB ?? Vector3.ZeroReadOnly;
        s[7] = pivotB.x;
        s[8] = pivotB.y;
        s[9] = pivotB.z;
        const chassisData = this._getPluginReference(chassis);
        const wheelData = this._getPluginReference(wheel);
        this._b3._bx_ComputeAlignedFrameB(chassisData.slot, wheelData.slot);
        const susp = options.suspensionLimits ?? [-0.2, 0.2];
        const steer = options.steeringLimits ?? [-Math.PI / 4, Math.PI / 4];
        s.set(
            [
                1,
                options.suspensionHertz ?? 4,
                options.suspensionDampingRatio ?? 0.7,
                1,
                susp[0],
                susp[1],
                options.enableSpinMotor ? 1 : 0,
                options.maxSpinTorque ?? 5,
                0,
                options.enableSteering ? 1 : 0,
                options.steeringHertz ?? 10,
                options.steeringDampingRatio ?? 0.7,
                0,
                options.maxSteeringTorque ?? 5,
                1,
                steer[0],
                steer[1],
            ],
            14
        );
        const slot = this._b3._bx_CreateJoint(this._worldSlot, Box3DJointType.WHEEL, chassisData.slot, wheelData.slot, 0, 0);
        if (!slot) {
            throw new Error("Box3DPlugin: wheel joint creation failed");
        }
        return new Box3DWheelJoint(this, slot);
    }

    /**
     * Creates a Box3D parallel joint: a spring that keeps a local axis of bodyB parallel to an axis
     * of bodyA, for example to keep a vehicle upright without locking its motion.
     * @param bodyA first body (often a static body)
     * @param bodyB body to align
     * @param axisA axis in bodyA local space
     * @param axisB axis in bodyB local space
     * @param hertz spring stiffness
     * @param dampingRatio spring damping
     * @param maxTorque maximum spring torque
     * @returns a joint slot that can be passed to disposeExtraJoint
     */
    public createParallelJoint(bodyA: PhysicsBody, bodyB: PhysicsBody, axisA: Vector3, axisB: Vector3, hertz = 1, dampingRatio = 1, maxTorque = 3.4e38): number {
        const s = this._scratch();
        const a = axisA.normalizeToNew();
        const pa = a.getNormalToRef(new Vector3());
        this._frameToBuffer(s, 0, Vector3.ZeroReadOnly, pa, Vector3.Cross(a, pa), a);
        const b = axisB.normalizeToNew();
        const pb = b.getNormalToRef(new Vector3());
        this._frameToBuffer(s, 7, Vector3.ZeroReadOnly, pb, Vector3.Cross(b, pb), b);
        s.set([hertz, dampingRatio, maxTorque], 14);
        return this._b3._bx_CreateJoint(this._worldSlot, Box3DJointType.PARALLEL, this._getPluginReference(bodyA).slot, this._getPluginReference(bodyB).slot, 1, 0);
    }

    /**
     * Destroys a joint created by createParallelJoint.
     * @param slot the joint slot
     */
    public disposeExtraJoint(slot: number): void {
        this._destroyExtraJoint(slot);
    }

    /**
     * @internal
     */
    public _destroyExtraJoint(slot: number): void {
        if (slot) {
            this._destroyJoint(slot);
        }
    }

    /**
     * @internal
     */
    public _wheelCall(fn: string, slot: number, ...args: number[]): void {
        if (slot) {
            this._b3[fn](slot, ...args);
        }
    }

    // ----------------------------------------------------------------------------------------
    // queries
    // ----------------------------------------------------------------------------------------

    public raycast(from: Vector3, to: Vector3, result: PhysicsRaycastResult | Array<PhysicsRaycastResult>, query?: IRaycastQuery): void {
        const results = Array.isArray(result) ? result : [result];
        for (const r of results) {
            r.reset(from, to);
        }
        const membership = (query?.membership ?? ~0) >>> 0;
        const collideWith = (query?.collideWith ?? ~0) >>> 0;
        const ignore = query?.ignoreBody ? ((query.ignoreBody._pluginData as Box3DBodyData)?.slot ?? 0) : 0;
        const closestOnly = results.length === 1;
        const count = this._b3._bx_World_CastRay(
            this._worldSlot,
            from.x,
            from.y,
            from.z,
            to.x - from.x,
            to.y - from.y,
            to.z - from.z,
            membership,
            collideWith,
            ignore,
            query?.shouldHitTriggers ? 1 : 0,
            closestOnly ? 1 : 0
        );
        if (count <= 0) {
            return;
        }
        const buffer = new Float32Array(this._b3.HEAPF32.buffer, this._b3._bx_RayHitsPtr(), count * RAY_STRIDE);
        const hits: number[] = [];
        for (let i = 0; i < count; i++) {
            hits.push(i);
        }
        hits.sort((a, b) => buffer[a * RAY_STRIDE + 6] - buffer[b * RAY_STRIDE + 6]);
        if (!results.length) {
            for (let i = 0; i < count; i++) {
                const r = new PhysicsRaycastResult();
                r.reset(from, to);
                results.push(r);
            }
        }
        const n = Math.min(count, results.length);
        for (let i = 0; i < n; i++) {
            const o = hits[i] * RAY_STRIDE;
            const r = results[i];
            const bodyRef = this._bodies[buffer[o + 7]];
            r.body = bodyRef?.body;
            r.bodyIndex = bodyRef?.index;
            r.shape = bodyRef?.body.shape ?? undefined;
            r.setHitData({ x: buffer[o + 3], y: buffer[o + 4], z: buffer[o + 5] }, { x: buffer[o], y: buffer[o + 1], z: buffer[o + 2] }, buffer[o + 9]);
            r.calculateHitDistance();
        }
    }

    // ----------------------------------------------------------------------------------------
    // events
    // ----------------------------------------------------------------------------------------

    /**
     * Copies `count` event records out of wasm memory and resolves their two body slots (at `slotOffset`) to the plugin's
     * body references. Observers run user code that can grow the wasm memory, which detaches every HEAPF32 view (creating
     * bodies or shapes, casting rays), or dispose bodies and hand their slots to new ones, so nothing is read from wasm
     * memory or the slot table once the first observer has been called.
     */
    private _readEvents(pointer: number, count: number, stride: number, slotOffset: number) {
        const records = new Float32Array(this._b3.HEAPF32.buffer, pointer, count * stride).slice();
        const refs: Array<{ body: PhysicsBody; index: number; data: Box3DBodyData } | undefined> = new Array(count * 2);
        for (let i = 0; i < count; i++) {
            refs[i * 2] = this._bodies[records[i * stride + slotOffset]];
            refs[i * 2 + 1] = this._bodies[records[i * stride + slotOffset + 1]];
        }
        return { records, refs };
    }

    private _notifyCollisions(): void {
        const count = this._b3._bx_World_GetContactEvents(this._worldSlot);
        if (!count) {
            return;
        }
        const { records: buffer, refs } = this._readEvents(this._b3._bx_ContactEventsPtr(), count, CONTACT_STRIDE, 3);
        for (let i = 0; i < count; i++) {
            const o = i * CONTACT_STRIDE;
            const kind = buffer[o];
            const refA = refs[i * 2];
            const refB = refs[i * 2 + 1];
            // a body disposed by an earlier observer has slot 0, its remaining events are dropped
            if (!refA || !refB || !refA.data.slot || !refB.data.slot) {
                continue;
            }
            // like Havok, an event is reported when either body asked for that event type
            const bit = kind === 0 ? Box3DEventBits.COLLISION_STARTED : kind === 1 ? Box3DEventBits.COLLISION_FINISHED : Box3DEventBits.COLLISION_CONTINUED;
            if (((refA.data.eventMask | refB.data.eventMask) & bit) === 0) {
                continue;
            }
            if (kind === 1) {
                const ended: IBasePhysicsCollisionEvent = {
                    collider: refA.body,
                    colliderIndex: refA.index,
                    collidedAgainst: refB.body,
                    collidedAgainstIndex: refB.index,
                    type: PhysicsEventType.COLLISION_FINISHED,
                };
                this.onCollisionEndedObservable.notifyObservers(ended);
                this._bodyCollisionEndedObservable.get(refA.data.slot)?.notifyObservers(ended);
                const endedB = this._bodyCollisionEndedObservable.get(refB.data.slot);
                if (endedB) {
                    endedB.notifyObservers({ ...ended, collider: refB.body, colliderIndex: refB.index, collidedAgainst: refA.body, collidedAgainstIndex: refA.index });
                }
                continue;
            }
            // begin events carry the manifold point, normal and normal impulse, hit events the approach speed
            const type = kind === 0 ? PhysicsEventType.COLLISION_STARTED : PhysicsEventType.COLLISION_CONTINUED;
            const point = new Vector3(buffer[o + 5], buffer[o + 6], buffer[o + 7]);
            const normal = new Vector3(buffer[o + 8], buffer[o + 9], buffer[o + 10]);
            const info: IPhysicsCollisionEvent = {
                collider: refA.body,
                colliderIndex: refA.index,
                collidedAgainst: refB.body,
                collidedAgainstIndex: refB.index,
                type,
                point,
                normal,
                distance: 0,
                impulse: buffer[o + 11],
            };
            this.onCollisionObservable.notifyObservers(info);
            if (this._bodyCollisionObservable.size) {
                this._bodyCollisionObservable.get(refA.data.slot)?.notifyObservers(info);
                const obsB = this._bodyCollisionObservable.get(refB.data.slot);
                if (obsB) {
                    obsB.notifyObservers({
                        ...info,
                        collider: refB.body,
                        colliderIndex: refB.index,
                        collidedAgainst: refA.body,
                        collidedAgainstIndex: refA.index,
                        normal: normal ? normal.negate() : null,
                    });
                }
            }
        }
    }

    private _notifyTriggers(): void {
        const count = this._b3._bx_World_GetSensorEvents(this._worldSlot);
        if (!count || !this.onTriggerCollisionObservable.hasObservers()) {
            return;
        }
        const { records: buffer, refs } = this._readEvents(this._b3._bx_SensorEventsPtr(), count, SENSOR_STRIDE, 3);
        for (let i = 0; i < count; i++) {
            const o = i * SENSOR_STRIDE;
            const refA = refs[i * 2];
            const refB = refs[i * 2 + 1];
            if (!refA || !refB || !refA.data.slot || !refB.data.slot) {
                continue;
            }
            this.onTriggerCollisionObservable.notifyObservers({
                collider: refA.body,
                colliderIndex: refA.index,
                collidedAgainst: refB.body,
                collidedAgainstIndex: refB.index,
                type: buffer[o] === 0 ? PhysicsEventType.TRIGGER_ENTERED : PhysicsEventType.TRIGGER_EXITED,
            });
        }
    }

    public dispose(): void {
        this._motorJoints.clear();
        this.onCollisionObservable.clear();
        this.onCollisionEndedObservable.clear();
        this.onTriggerCollisionObservable.clear();
        this._bodyCollisionObservable.clear();
        this._bodyCollisionEndedObservable.clear();
        for (const shape of this._shapes) {
            if (shape) {
                this._b3._bx_ShapeDesc_Destroy(shape.slot);
            }
        }
        this._shapes.length = 0;
        this._bodies.length = 0;
        if (this._worldSlot) {
            this._b3._bx_DestroyWorld(this._worldSlot);
            this._worldSlot = 0;
        }
    }
}
