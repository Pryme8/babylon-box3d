// portal: a floor portal and a wall portal, after "Babylon Lite - Havok Manifold Modifiers or plane clipping" on the
// Babylon.js forum. Box3DPlugin.setBodyClipPlane drops every contact point past a plane, so the part of a body that has
// gone into a portal passes through the surface the portal is on, while the rest of it keeps colliding.
//
// A portal here is:
// - its plane, on a surface with no hole in it. A body near the portal clips its contacts with that plane, so the
//   surface, and anything else past the plane, is open to it.
// - a rim: four static boxes past the plane around the opening, the sides of the hole. They are on their own
//   collision category, which the clip plane's mask leaves out, so a body hanging over the edge of the opening rests on
//   them instead of sinking into the surface.
// - a teleport: once a body's centre crosses the plane it moves to the other portal, velocity turned with it, and
//   clips with that portal's plane until it is clear of it.
//
// The part of a body sticking out of the far portal before it teleports is drawn there (a clipped copy of its mesh)
// but does not collide. A full portal game adds a second body there for that part.

import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { type Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsPrestepType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { type Nullable } from "@babylonjs/core/types";
import { type IDemoContext } from "./common";

// collision categories (shape membership masks)
const SURFACE = 1 << 2;
const RIM = 1 << 3;
// what a body in a portal stops colliding with past its plane: everything but the rims
const CLIP_MASK = ~RIM >>> 0;

const HALF = 1.6; // half the opening, metres
const RIM_DEPTH = 3; // how far past the plane the hole's sides go
const RIM_WIDTH = 4; // how far out from the opening they reach, so a long body leaning over the edge stays on them

class Portal {
    public other!: Portal;
    /** the plane with its positive side past the portal, the side Box3D clips and Babylon's clip planes hide */
    public readonly clip: Plane;
    /** the portal's frame: right, up, out of the surface */
    private readonly _basis: Matrix;

    public constructor(
        ctx: IDemoContext,
        public readonly center: Vector3,
        public readonly normal: Vector3,
        public readonly up: Vector3,
        color: string
    ) {
        const right = Vector3.Cross(up, normal);
        this._basis = Matrix.FromXYZAxesToRef(right, up, normal, new Matrix());
        this.clip = Plane.FromPositionAndNormal(center, normal.negate());

        const rotation = Quaternion.FromRotationMatrix(this._basis);
        // the opening: dark, just off the surface, and a glowing frame
        const hole = MeshBuilder.CreatePlane("portalHole", { size: 2 * HALF }, ctx.scene);
        hole.position = center.add(normal.scale(0.01));
        // a plane faces -z, turn it to face out of the surface
        hole.rotationQuaternion = rotation.multiply(Quaternion.RotationAxis(Vector3.Up(), Math.PI));
        const holeMat = new StandardMaterial("portalHoleMat", ctx.scene);
        holeMat.diffuseColor = Color3.Black();
        holeMat.specularColor = Color3.Black();
        holeMat.emissiveColor = Color3.FromHexString(color).scale(0.15);
        hole.material = holeMat;
        const frameMat = new StandardMaterial("portalFrameMat", ctx.scene);
        frameMat.emissiveColor = Color3.FromHexString(color);
        frameMat.disableLighting = true;
        for (const [x, y, w, h] of [
            [0, HALF, 2 * HALF + 0.3, 0.15],
            [0, -HALF, 2 * HALF + 0.3, 0.15],
            [HALF, 0, 0.15, 2 * HALF],
            [-HALF, 0, 0.15, 2 * HALF],
        ]) {
            const bar = MeshBuilder.CreateBox("portalFrame", { width: w, height: h, depth: 0.04 }, ctx.scene);
            bar.position = Vector3.TransformCoordinates(new Vector3(x, y, 0.02), this._basis).addInPlace(center);
            bar.rotationQuaternion = rotation.clone();
            bar.material = frameMat;
        }

        // the sides of the hole: invisible static boxes past the plane, on the RIM category only
        for (const [x, y, w, h] of [
            [0, HALF + RIM_WIDTH / 2, 2 * (HALF + RIM_WIDTH), RIM_WIDTH],
            [0, -HALF - RIM_WIDTH / 2, 2 * (HALF + RIM_WIDTH), RIM_WIDTH],
            [HALF + RIM_WIDTH / 2, 0, RIM_WIDTH, 2 * HALF],
            [-HALF - RIM_WIDTH / 2, 0, RIM_WIDTH, 2 * HALF],
        ]) {
            const rim = MeshBuilder.CreateBox("portalRim", { width: w, height: h, depth: RIM_DEPTH }, ctx.scene);
            rim.position = Vector3.TransformCoordinates(new Vector3(x, y, -RIM_DEPTH / 2), this._basis).addInPlace(center);
            rim.rotationQuaternion = rotation.clone();
            rim.isVisible = false;
            const aggregate = new PhysicsAggregate(rim, PhysicsShapeType.BOX, { mass: 0, friction: 0.6 }, ctx.scene);
            aggregate.shape.filterMembershipMask = RIM;
        }
    }

    /** Where a point is in the portal's frame: x right, y up, z out of the surface. */
    public local(point: Vector3): Vector3 {
        return Vector3.TransformNormal(point.subtract(this.center), this._basis.transpose());
    }

    /** Whether a sphere around `point` of `radius` overlaps the opening's doorway, on the near side or past it. */
    public near(point: Vector3, radius: number): boolean {
        const p = this.local(point);
        return Math.abs(p.x) < HALF + radius && Math.abs(p.y) < HALF + radius && p.z < radius + 0.1 && p.z > -RIM_DEPTH;
    }

    /**
     * Whether a body's centre at `point`, moving at `velocity`, has gone through: inside the opening, a little past the
     * plane and still moving in. Without the last two a body balanced on the rim with its centre in the plane would
     * swap portals every step.
     */
    public crossed(point: Vector3, velocity: Vector3): boolean {
        const p = this.local(point);
        return Math.abs(p.x) < HALF && Math.abs(p.y) < HALF && p.z < -0.02 && Vector3.Dot(velocity, this.normal) < 0;
    }

    /** The rotation from this portal's frame to the other's: in through this one is out through that one. */
    public turn(): Matrix {
        // through a portal: right and out flip, up stays
        const flip = Matrix.FromValues(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);
        return this._basis.transpose().multiply(flip).multiply(this.other._basis);
    }

    /** A world position moved through this portal to the other. */
    public carry(point: Vector3): Vector3 {
        return Vector3.TransformNormal(point.subtract(this.center), this.turn()).addInPlace(this.other.center);
    }
}

interface IThing {
    aggregate: PhysicsAggregate;
    mesh: Mesh;
    /** the copy of the mesh drawn at the far portal while the body is in one */
    ghost: Mesh;
    radius: number;
    /** the portal whose plane the body clips with, null while it is clear of both */
    portal: Nullable<Portal>;
}

/** Draws a mesh clipped by a plane, by setting the scene's clip plane around its draw. */
function ClipWhileDrawing(mesh: Mesh, plane: () => Nullable<Plane>): void {
    mesh.onBeforeRenderObservable.add(() => {
        mesh.getScene().clipPlane = plane();
    });
    mesh.onAfterRenderObservable.add(() => {
        mesh.getScene().clipPlane = null;
    });
}

export function BuildPortal(ctx: IDemoContext): void {
    const scene = ctx.scene;
    ctx.help = "space / click: drop something into the orange portal · c: clipping on/off\nlong planks hang half through the floor and come out of the blue portal";

    // floor and back wall, both solid: the portals are only planes on them
    const floor = MeshBuilder.CreateBox("floor", { width: 40, height: 1, depth: 40 }, scene);
    floor.position.y = -0.5;
    const wall = MeshBuilder.CreateBox("wall", { width: 40, height: 14, depth: 1 }, scene);
    wall.position.set(0, 7, 12.5);
    for (const [mesh, color] of [
        [floor, new Color3(0.85, 0.85, 0.82)],
        [wall, new Color3(0.7, 0.72, 0.76)],
    ] as const) {
        const mat = new StandardMaterial(mesh.name + "Mat", scene);
        mat.diffuseColor = color;
        mat.specularColor = Color3.Black();
        mesh.material = mat;
        mesh.receiveShadows = true;
        const aggregate = new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 0, friction: 0.7 }, scene);
        aggregate.shape.filterMembershipMask = SURFACE;
    }

    const orange = new Portal(ctx, new Vector3(0, 0, -2), new Vector3(0, 1, 0), new Vector3(0, 0, 1), "#ff8a1e");
    const blue = new Portal(ctx, new Vector3(0, 3.5, 12), new Vector3(0, 0, -1), new Vector3(0, 1, 0), "#2f9bff");
    orange.other = blue;
    blue.other = orange;

    let clipping = true;
    const things: IThing[] = [];

    const spawn = (): void => {
        const kind = Math.floor(Math.random() * 4);
        const mat = ctx.material();
        let mesh: Mesh;
        let type: PhysicsShapeType;
        let radius: number;
        if (kind <= 1) {
            mesh = MeshBuilder.CreateBox("plank", { width: 0.5, height: 0.25, depth: 4.5 }, scene);
            type = PhysicsShapeType.BOX;
            radius = 2.3;
        } else if (kind === 2) {
            mesh = MeshBuilder.CreateCapsule("rod", { radius: 0.25, height: 4 }, scene);
            type = PhysicsShapeType.CAPSULE;
            radius = 2;
        } else {
            mesh = MeshBuilder.CreateBox("crate", { size: 1 }, scene);
            type = PhysicsShapeType.BOX;
            radius = 0.9;
        }
        mesh.material = mat;
        mesh.position.set((Math.random() - 0.5) * 1.5, 6 + Math.random() * 2, -2 + (Math.random() - 0.5) * 1.5);
        // long things mostly end first, some at a slant so they catch the rim and hang half through
        const pitch = kind === 3 ? Math.random() * Math.PI : Math.PI / 2 + (Math.random() - 0.5) * 1.4;
        mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.random() * Math.PI, kind === 2 ? pitch - Math.PI / 2 : pitch, 0);
        ctx.watch(mesh);
        const ghost = mesh.clone(mesh.name + "Ghost", null, true)!;
        ghost.isVisible = false;
        const aggregate = new PhysicsAggregate(mesh, type, { mass: 20, friction: 0.6, restitution: 0.05 }, scene);
        // so setPhysicsBodyTransformation moves it when it goes through
        aggregate.body.setPrestepType(PhysicsPrestepType.TELEPORT);
        const thing: IThing = { aggregate, mesh, ghost, radius, portal: null };
        // the body hides what is past its portal, the copy shows only what is past the far one
        ClipWhileDrawing(mesh, () => (thing.portal && clipping ? thing.portal.clip : null));
        ClipWhileDrawing(ghost, () => thing.portal?.other.clip ?? null);
        things.push(thing);
        if (things.length > 30) {
            const old = things.shift()!;
            old.aggregate.dispose();
            old.mesh.dispose();
            old.ghost.dispose();
        }
    };

    const setPortal = (thing: IThing, portal: Nullable<Portal>): void => {
        thing.portal = portal;
        ctx.plugin.setBodyClipPlane(thing.aggregate.body, portal && clipping ? portal.clip : null, CLIP_MASK);
    };

    const velocity = new Vector3();
    scene.onAfterPhysicsObservable.add(() => {
        for (const thing of things) {
            const body = thing.aggregate.body;
            const node = thing.mesh;
            const center = node.getAbsolutePosition();
            body.getLinearVelocityToRef(velocity);
            if (thing.portal === null) {
                const portal = orange.near(center, thing.radius) ? orange : blue.near(center, thing.radius) ? blue : null;
                if (portal) {
                    setPortal(thing, portal);
                }
            } else if (clipping && thing.portal.crossed(center, velocity)) {
                // through: move the body to the other portal, turned, and keep it going
                const from = thing.portal;
                const turn = Quaternion.FromRotationMatrix(from.turn());
                node.position.copyFrom(from.carry(center));
                node.rotationQuaternion = turn.multiply(node.rotationQuaternion!);
                node.computeWorldMatrix(true);
                ctx.plugin.setPhysicsBodyTransformation(body, node);
                body.setLinearVelocity(Vector3.TransformNormal(velocity, from.turn()));
                body.getAngularVelocityToRef(velocity);
                body.setAngularVelocity(Vector3.TransformNormal(velocity, from.turn()));
                setPortal(thing, from.other);
            } else if (!thing.portal.near(center, thing.radius)) {
                setPortal(thing, null);
            }

            // the copy at the far portal
            thing.ghost.isVisible = thing.portal !== null && clipping;
            if (thing.ghost.isVisible) {
                const from = thing.portal!;
                thing.ghost.position.copyFrom(from.carry(center));
                thing.ghost.rotationQuaternion = Quaternion.FromRotationMatrix(from.turn()).multiply(node.rotationQuaternion!);
            }
            if (center.y < -30) {
                // fell out of the world with clipping turned off mid-portal
                node.position.set(0, 8, -2);
                node.computeWorldMatrix(true);
                ctx.plugin.setPhysicsBodyTransformation(body, node);
                body.setLinearVelocity(Vector3.Zero());
            }
        }
    });

    scene.onKeyboardObservable.add((info) => {
        if (info.type !== 1) {
            return;
        }
        if (info.event.key === " ") {
            spawn();
        } else if (info.event.key.toLowerCase() === "c") {
            clipping = !clipping;
            for (const thing of things) {
                setPortal(thing, thing.portal);
            }
        }
    });
    scene.onPointerObservable.add((info) => {
        if (info.type === 32 /* POINTERTAP */ && info.event.button === 0) {
            spawn();
        }
    });

    for (let i = 0; i < 4; i++) {
        setTimeout(spawn, 400 * i);
    }
    (window as any).portalDemo = { things, spawn, orange, blue };

    ctx.camera.setTarget(new Vector3(0, 2.5, 4));
    ctx.camera.radius = 26;
    ctx.camera.alpha = -Math.PI / 2 - 0.9;
    ctx.camera.beta = Math.PI / 2.8;
}
