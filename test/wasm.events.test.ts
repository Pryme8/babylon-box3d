// Collision and trigger events against the real Box3D wasm.

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { type IBasePhysicsCollisionEvent, type IPhysicsCollisionEvent, PhysicsEventType, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox, PhysicsShapeSphere } from "@babylonjs/core/Physics/v2/physicsShape";
import { afterEach, describe, expect, it } from "vitest";
import { CreateBoxBody, CreateWasmScene, type IWasmScene } from "./wasmScene";

let world: IWasmScene | undefined;
afterEach(() => {
    world?.dispose();
    world = undefined;
});

function CreateSphere(w: IWasmScene, name: string, position: Vector3, radius = 0.25): PhysicsBody {
    const node = new TransformNode(name, w.scene);
    node.position.copyFrom(position);
    node.rotationQuaternion = Quaternion.Identity();
    const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, w.scene);
    body.shape = new PhysicsShapeSphere(Vector3.Zero(), radius, w.scene);
    return body;
}

/** Creates bodies (with shapes, which allocate in Box3D's world) until the wasm memory has grown. */
function GrowMemoryWithBodies(w: IWasmScene): number {
    const heap = w.b3.HEAPF32.buffer;
    let created = 0;
    const shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(0.1, 0.1, 0.1), w.scene);
    while (w.b3.HEAPF32.buffer === heap && created < 200000) {
        const node = new TransformNode("filler", w.scene);
        node.position.set(1000 + (created % 100), 1000 + Math.floor(created / 100) % 100, 1000 + Math.floor(created / 10000));
        const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, w.scene);
        body.shape = shape;
        created++;
    }
    return created;
}

describe("Box3D events (real wasm)", () => {
    it("delivers every collision event when an observer grows the wasm memory during dispatch", async () => {
        world = await CreateWasmScene();
        const w = world;
        CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
        const balls: PhysicsBody[] = [];
        for (let i = 0; i < 8; i++) {
            const ball = CreateSphere(w, `ball${i}`, new Vector3(i * 2 - 8, 1.0, 0));
            ball.setCollisionCallbackEnabled(true);
            balls.push(ball);
        }
        const started: IPhysicsCollisionEvent[] = [];
        let grownBy = 0;
        w.plugin.onCollisionObservable.add((event) => {
            if (event.type !== PhysicsEventType.COLLISION_STARTED) {
                return;
            }
            if (!started.length) {
                grownBy = GrowMemoryWithBodies(w);
            }
            started.push({ ...event, point: event.point?.clone() ?? null, normal: event.normal?.clone() ?? null });
        });
        w.step(60);
        expect(grownBy).toBeGreaterThan(0);
        expect(started.length).toBe(8);
        const touched = new Set(started.map((e) => (balls.includes(e.collider) ? e.collider : e.collidedAgainst)));
        expect(touched.size).toBe(8);
        for (const event of started) {
            const ball = balls.includes(event.collider) ? event.collider : event.collidedAgainst;
            expect(event.collider === ball || event.collidedAgainst === ball).toBe(true);
        }
    });

    it("delivers every trigger event when an observer grows the wasm memory during dispatch", async () => {
        world = await CreateWasmScene();
        const w = world;
        const trigger = CreateBoxBody(w.scene, "trigger", new Vector3(0, 0, 0), new Vector3(30, 1, 4), PhysicsMotionType.STATIC);
        trigger.shape.isTrigger = true;
        const balls: PhysicsBody[] = [];
        for (let i = 0; i < 8; i++) {
            balls.push(CreateSphere(w, `ball${i}`, new Vector3(i * 2 - 8, 1.5, 0)));
        }
        const entered: IBasePhysicsCollisionEvent[] = [];
        let grownBy = 0;
        w.plugin.onTriggerCollisionObservable.add((event) => {
            if (event.type !== PhysicsEventType.TRIGGER_ENTERED) {
                return;
            }
            if (!entered.length) {
                grownBy = GrowMemoryWithBodies(w);
            }
            entered.push({ ...event });
        });
        w.step(60);
        expect(grownBy).toBeGreaterThan(0);
        expect(entered.length).toBe(8);
        expect(new Set(entered.map((e) => e.collidedAgainst)).size).toBe(8);
        expect(entered.every((e) => e.collider === trigger.body && balls.includes(e.collidedAgainst))).toBe(true);
    });

    it("skips the remaining events of a body disposed by an earlier observer, even when its slot is reused", async () => {
        const drop = async (disposeOnStart: boolean) => {
            world?.dispose();
            world = await CreateWasmScene();
            const w = world;
            CreateBoxBody(w.scene, "ground", new Vector3(0, -0.5, 0), new Vector3(40, 1, 40), PhysicsMotionType.STATIC);
            const ball = CreateSphere(w, "ball", new Vector3(0, 3, 0));
            ball.setCollisionCallbackEnabled(true);
            const seen: Array<{ type: PhysicsEventType; step: number; bodies: PhysicsBody[] }> = [];
            let step = 0;
            let replacement: PhysicsBody | undefined;
            const ballSlot = (ball as any)._pluginData.slot;
            w.plugin.onCollisionObservable.add((event) => {
                seen.push({ type: event.type, step, bodies: [event.collider, event.collidedAgainst] });
                if (disposeOnStart && event.type === PhysicsEventType.COLLISION_STARTED) {
                    ball.dispose();
                    // takes over the freed Box3D body slot
                    replacement = CreateSphere(w, "replacement", new Vector3(5, 5, 5));
                    replacement.setCollisionCallbackEnabled(true);
                }
            });
            w.step(90, (i) => (step = i + 1));
            return { seen, replacement, ballSlot };
        };
        // control: the step that starts the contact also reports a hit for the same pair, queued behind the begin event
        const control = await drop(false);
        const first = control.seen.filter((e) => e.step === control.seen[0].step).map((e) => e.type);
        expect(first).toEqual([PhysicsEventType.COLLISION_STARTED, PhysicsEventType.COLLISION_CONTINUED]);

        const disposed = await drop(true);
        expect(disposed.replacement).toBeDefined();
        expect((disposed.replacement as any)._pluginData.slot).toBe(disposed.ballSlot);
        expect(disposed.seen.map((e) => e.type)).toEqual([PhysicsEventType.COLLISION_STARTED]);
    });
});
