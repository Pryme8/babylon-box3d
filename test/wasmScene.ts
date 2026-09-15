// Helpers for tests that run the plugin against the real Box3D WebAssembly module (lib/node) through Babylon's
// regular physics v2 classes on a NullEngine scene.

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox } from "@babylonjs/core/Physics/v2/physicsShape";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Logger } from "@babylonjs/core/Misc/logger";
// Babylon 9 registers Scene.enablePhysics / getPhysicsEngine in the joined component only (8.x pulled it in from the v2
// component), so import both.
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import "@babylonjs/core/Physics/v2/physicsEngineComponent";
import Box3D from "../lib/node/box3d.mjs";
import { Box3DPlugin } from "../src/box3dPlugin";

let modulePromise: Promise<any> | undefined;

/** The Box3D module is instantiated once per test file and shared by every world. */
export function LoadBox3D(): Promise<any> {
    modulePromise ??= Box3D();
    return modulePromise;
}

export interface IWasmScene {
    b3: any;
    engine: NullEngine;
    scene: Scene;
    plugin: Box3DPlugin;
    /** steps the physics engine the way the render loop does, `count` times with a fixed 1/60 s step */
    step: (count?: number, each?: (index: number) => void) => void;
    dispose: () => void;
}

export async function CreateWasmScene(gravity = new Vector3(0, -9.81, 0), subStepCount = 4): Promise<IWasmScene> {
    const b3 = await LoadBox3D();
    Logger.LogLevels = Logger.ErrorLogLevel;
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const plugin = new Box3DPlugin(false, b3);
    plugin.subStepCount = subStepCount;
    scene.enablePhysics(gravity, plugin);
    const physicsEngine = scene.getPhysicsEngine()!;
    return {
        b3,
        engine,
        scene,
        plugin,
        step: (count = 1, each) => {
            for (let i = 0; i < count; i++) {
                (physicsEngine as any)._step(1 / 60);
                each?.(i);
            }
        },
        dispose: () => {
            scene.dispose();
            engine.dispose();
        },
    };
}

export interface ITestBody {
    node: TransformNode;
    body: PhysicsBody;
    shape: PhysicsShapeBox;
}

/** A body on its own transform node with a box shape, optionally offset and rotated inside the body. */
export function CreateBoxBody(
    scene: Scene,
    name: string,
    position: Vector3,
    extents: Vector3,
    motionType: PhysicsMotionType,
    mass?: number,
    options: { rotation?: Quaternion; shapeCenter?: Vector3; shapeRotation?: Quaternion } = {}
): ITestBody {
    const node = new TransformNode(name, scene);
    node.position.copyFrom(position);
    node.rotationQuaternion = (options.rotation ?? Quaternion.Identity()).clone();
    const body = new PhysicsBody(node, motionType, false, scene);
    const shape = new PhysicsShapeBox(options.shapeCenter ?? Vector3.Zero(), options.shapeRotation ?? Quaternion.Identity(), extents, scene);
    body.shape = shape;
    if (mass !== undefined && motionType === PhysicsMotionType.DYNAMIC) {
        body.setMassProperties({ mass });
    }
    return { node, body, shape };
}

/** Frame quaternion of a Babylon constraint frame: x = axis, y = perpAxis, z = axis x perpAxis (Havok's convention). */
export function ConstraintFrame(axis: Vector3, perp: Vector3): Quaternion {
    const x = axis.normalizeToNew();
    const y = perp.subtract(x.scale(Vector3.Dot(x, perp))).normalize();
    const z = Vector3.Cross(x, y);
    return Quaternion.FromRotationMatrix(Matrix.FromValues(x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1));
}

/** Rotation of the child's constraint frame relative to the parent's, expressed in the parent frame, w >= 0. */
export function RelativeFrameRotation(parent: TransformNode, child: TransformNode, frameA: Quaternion, frameB: Quaternion): Quaternion {
    const qA = parent.rotationQuaternion!.multiply(frameA);
    const qB = child.rotationQuaternion!.multiply(frameB);
    const rel = Quaternion.Inverse(qA).multiply(qB).normalize();
    if (rel.w < 0) {
        rel.scaleInPlace(-1);
    }
    return rel;
}

/** Twist about the frame x axis (ANGULAR_X), swing of the frame x axis away from the parent's, radians. */
export function SwingTwist(rel: Quaternion): { twist: number; swing: number } {
    const twist = 2 * Math.atan2(rel.x, rel.w);
    const swing = 2 * Math.atan2(Math.hypot(rel.y, rel.z), Math.hypot(rel.x, rel.w));
    return { twist, swing };
}

/** Signed hinge angle about one frame axis (0 = x, 1 = y, 2 = z) and the off axis deviation, radians. */
export function HingeAngle(rel: Quaternion, axis: 0 | 1 | 2): { angle: number; offAxis: number } {
    const c = [rel.x, rel.y, rel.z];
    const angle = 2 * Math.atan2(c[axis], rel.w);
    const others = c.filter((_, i) => i !== axis);
    const offAxis = 2 * Math.atan2(Math.hypot(others[0], others[1]), Math.hypot(c[axis], rel.w));
    return { angle, offAxis };
}

export const DegToRad = Math.PI / 180;
export const RadToDeg = 180 / Math.PI;
