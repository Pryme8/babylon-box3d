// Box3D's two character movers, from its samples (samples/dynamic_mover.cpp and samples/geometric_mover.cpp, Erin
// Catto, MIT), on Babylon.js. Box3D keeps them as samples for a game to copy and change rather than as library code,
// so they are written here the way the samples are, as plain calls into the module, and copy out of this file the same
// way: everything a mover does is in its update.
//
// Both are y up, as the samples are: the ground is what a ray finds below along -y, and a surface is walkable when its
// normal's y is at least minGroundNormalY.
//
//   const mover = new Box3DDynamicMover(plugin, scene, { position: new Vector3(0, 2, 0) });
//   plugin.onBeforeWorldStepObservable.add((dt) => mover.update(dt, forward, right, input.forward, input.right));
//   if (input.jumpPressed) mover.jump();

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { PhysicsActivationControl, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeCapsule } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { type Scene } from "@babylonjs/core/scene.js";
import { type Box3DPlugin } from "./box3dPlugin.js";

/** bxJointType and the body types in wasm/box3d_shim.c */
const MoverJointType = 8;
const PogoJointType = 9;
const StaticBodyType = 0;

const FloatEpsilon = 1.1920929e-7;
const FloatMax = 3.4028234663852886e38;
/** two local frames at the bodies' origins, as bx_CreateJoint and bx_Joint_SetLocalFrames read them */
const IdentityFrames = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];

/**
 * Every native entry point the movers call. Like the plugin's own list, it turns a box3d.js or box3d.wasm from an older
 * build into an error when a mover is made, instead of a mover that throws partway through an update.
 */
const MoverNativeExports = [
    "_bx_Body_ApplyLinearImpulseToCenter", "_bx_Body_GetLinearVelocity", "_bx_Body_GetLocalPoint", "_bx_Body_GetMassData",
    "_bx_Body_GetPointVelocity", "_bx_Body_GetTransform", "_bx_Body_PushFromMover", "_bx_ClipMoverVector", "_bx_CreateBody",
    "_bx_CreateJoint", "_bx_DestroyBody", "_bx_DestroyJoint", "_bx_GetMoverPlaneCapacity", "_bx_Joint_IsValid",
    "_bx_Joint_SetLocalFrames", "_bx_MoverJoint_SetLinearVelocity", "_bx_MoverJoint_SetMaxForce", "_bx_MoverPlanesPtr",
    "_bx_PogoJoint_GetState", "_bx_PogoJoint_Set", "_bx_RayHitPointsF64Ptr", "_bx_RayHitsPtr", "_bx_Scratch", "_bx_ScratchF64",
    "_bx_SolveMoverPlanes", "_bx_World_CastMover", "_bx_World_CastRay", "_bx_World_CollideMover",
];

function CheckMoverExports(b3: any): void {
    const missing = MoverNativeExports.filter((name) => typeof b3[name] !== "function");
    if (missing.length) {
        throw new Error(
            `Box3D character movers: the module is missing ${missing.length} entry point${missing.length === 1 ? "" : "s"} (${missing.join(", ")}). ` +
                "box3d.js and box3d.wasm have to come from the same build as this babylon-box3d."
        );
    }
}

/** One-dimensional mass-spring-damper, Box3D's b3SpringDamper: the new velocity of a spring driving its position to zero. */
function SpringDamper(hertz: number, dampingRatio: number, position: number, velocity: number, timeStep: number): number {
    const omega = 2 * Math.PI * hertz;
    const omegaH = omega * timeStep;
    return (velocity - omega * omegaH * position) / (1 + 2 * dampingRatio * omegaH + omegaH * omegaH);
}

/** A ray a mover cast to find the ground, for drawing. */
export interface IBox3DMoverProbe {
    /** where the ray starts */
    origin: Vector3;
    /** the ray, from its origin */
    translation: Vector3;
    /** how far along the translation it hit, 1 when it did not */
    fraction: number;
    hit: boolean;
}

/** What a mover's ground ray hit. */
export interface IBox3DMoverGround {
    hit: boolean;
    /** the hit point in world space */
    point: Vector3;
    /** the surface normal there */
    normal: Vector3;
    /** how far along the ray */
    fraction: number;
    /** the body hit, and its instance */
    body?: PhysicsBody;
    instanceIndex: number;
    /** @internal the native slot of the body hit */
    _slot: number;
}

function NewGround(): IBox3DMoverGround {
    return { hit: false, point: new Vector3(), normal: new Vector3(), fraction: 1, instanceIndex: 0, _slot: 0 };
}

function CopyGround(from: IBox3DMoverGround, to: IBox3DMoverGround): void {
    to.hit = from.hit;
    to.point.copyFrom(from.point);
    to.normal.copyFrom(from.normal);
    to.fraction = from.fraction;
    to.body = from.body;
    to.instanceIndex = from.instanceIndex;
    to._slot = from._slot;
}

/** The closest shape along the ray that is not a sensor or the ignored body. */
function CastGroundRay(
    plugin: Box3DPlugin,
    origin: Vector3,
    translation: Vector3,
    membershipMask: number,
    collideMask: number,
    ignoreBody: number,
    result: IBox3DMoverGround
): IBox3DMoverGround {
    const { b3, world } = plugin._native();
    const count = b3._bx_World_CastRay(world, origin.x, origin.y, origin.z, translation.x, translation.y, translation.z, membershipMask, collideMask, ignoreBody, 0, 1);
    result.hit = count > 0;
    if (!result.hit) {
        result.fraction = 1;
        result.body = undefined;
        result.instanceIndex = 0;
        result._slot = 0;
        return result;
    }
    const f32 = b3.HEAPF32;
    const at = b3._bx_RayHitsPtr() >> 2;
    const point = b3._bx_RayHitPointsF64Ptr() >> 3;
    result.point.set(b3.HEAPF64[point], b3.HEAPF64[point + 1], b3.HEAPF64[point + 2]);
    result.normal.set(f32[at + 3], f32[at + 4], f32[at + 5]);
    result.fraction = f32[at + 6];
    result._slot = f32[at + 7];
    const ref = plugin._bodyFromSlot(result._slot);
    result.body = ref?.body;
    result.instanceIndex = ref?.index ?? 0;
    return result;
}

/**
 * Options for a {@link Box3DDynamicMover}. The tunings default to the values in Box3D's sample.
 */
export interface IBox3DDynamicMoverOptions {
    /** the capsule's center in world space (default the node's position, or the origin) */
    position?: Vector3;
    /** half the distance between the capsule's two sphere centers, along y (0.5) */
    capsuleHalfHeight?: number;
    /** the capsule's radius (0.3) */
    capsuleRadius?: number;
    /** the capsule's density, in kg/m^3 (200) */
    density?: number;
    /** the capsule's membership mask, which the ground rays query with too (all) */
    membershipMask?: number;
    /** the capsule's collide mask, which the ground rays query with too (all) */
    collideMask?: number;
    /** the node the mover's body drives. One is made when none is given. Its rotation is set to identity: turn a child */
    transformNode?: TransformNode;
    /** which bodies the mover rides, see {@link Box3DDynamicMover.isPlatform} */
    isPlatform?: (body: PhysicsBody, instanceIndex: number) => boolean;
    jumpSpeed?: number;
    maxSpeed?: number;
    minSpeed?: number;
    stopSpeed?: number;
    accelerate?: number;
    airSteer?: number;
    friction?: number;
    gravityScale?: number;
    maxGroundForce?: number;
    maxAirForce?: number;
    pogoRestLength?: number;
    pogoHertz?: number;
    pogoDampingRatio?: number;
    pogoCompressionScale?: number;
    pogoTensionScale?: number;
    enableSkirtPogo?: boolean;
    minGroundNormalY?: number;
    slideDuration?: number;
}

/**
 * Box3D's dynamic character mover. The capsule is a rigid body with its rotation locked, so it collides and is pushed
 * like everything else in the world and pushes back with its own mass. A mover joint drives it to the target velocity
 * with a limited force, and a pogo joint, a spring along a ray to the ground, holds it above the ground so it walks up
 * steps without the capsule touching them. On a kinematic platform the mover joint is attached to the platform, so the
 * mover rides it.
 *
 * Movement follows Quake's ground and air model. Call {@link update} once per world step, from
 * {@link Box3DPlugin.onBeforeWorldStepObservable}, and {@link jump} when the player jumps.
 *
 * Box3D's sample is inspired by Tom Waterson's presentation, https://www.youtube.com/watch?v=_jRLlTDqoGI.
 */
export class Box3DDynamicMover {
    /** The number of rays in the skirt around the capsule. */
    public static readonly SkirtCount = 8;

    /** Up speed a jump gives, on top of the ground's. */
    public jumpSpeed: number;
    /** Top speed along the ground. */
    public maxSpeed: number;
    /** Below this ground speed the mover stops. */
    public minSpeed: number;
    /** Below this speed friction takes a fixed amount of speed, above it a fraction. */
    public stopSpeed: number;
    /** How fast the mover reaches its top speed, in top speeds per second. */
    public accelerate: number;
    /** The fraction of the ground acceleration the mover has in the air. */
    public airSteer: number;
    /** Ground friction, in 1/s. */
    public friction: number;
    /** The force the mover joint has to reach the target velocity on the ground, in newtons. */
    public maxGroundForce: number;
    /** The force it has in the air, small so a jump keeps its momentum. */
    public maxAirForce: number;
    /** How far the pogo holds the bottom of the capsule's lower sphere center above the ground. */
    public pogoRestLength: number;
    public pogoHertz: number;
    public pogoDampingRatio: number;
    /** The most the pogo pushes up, in multiples of the mover's weight. */
    public pogoCompressionScale: number;
    /** The most the pogo pulls down, in multiples of the mover's weight. */
    public pogoTensionScale: number;
    /**
     * When the central ray misses or finds a surface too steep to walk, cast a skirt of rays around the capsule, so the
     * mover stands on a ledge or a thin rail and steps off the foot of a steep slope.
     */
    public enableSkirtPogo: boolean;
    /** Surfaces whose normal's y is below this are too steep to walk. */
    public minGroundNormalY: number;
    /** How long the mover takes to lose its grip on a slope too steep to walk, in seconds. */
    public slideDuration: number;
    /**
     * Which bodies the mover rides: its mover joint is attached to the body it stands on, so the target velocity is
     * relative to it. By default every animated (kinematic) body. Box3D's sample asks for a platform material as well.
     */
    public isPlatform: (body: PhysicsBody, instanceIndex: number) => boolean;

    /** The capsule's rigid body. */
    public readonly body: PhysicsBody;
    /** The node the body drives. */
    public readonly transformNode: TransformNode;
    /** The mover's horizontal velocity relative to what it stands on, as last given to the mover joint. */
    public readonly velocity = new Vector3();
    /** What the pogo stands on. */
    public readonly ground: IBox3DMoverGround = NewGround();
    /** The rays of the last update, the center first and then the skirt, for drawing. */
    public readonly probes: IBox3DMoverProbe[] = [];
    /** How many of the probes the last update cast. */
    public probeCount = 0;
    /** The probe the pogo stands on. */
    public selectedProbe = 0;

    private _plugin: Box3DPlugin;
    private _scene: Scene;
    private _ownsNode: boolean;
    private _membershipMask: number;
    private _collideMask: number;
    private _capsuleRadius: number;
    /** the lower sphere center in the body's frame, where the rays start */
    private _foot: Vector3;
    private _gravityScale: number;
    private _groundSlot: number;
    private _moverSlot: number;
    private _surfaceSlot = 0;
    private _moverJoint = 0;
    private _moverJointBase = 0;
    private _pogoJoint = 0;
    private _onGround = false;
    private _walkable = false;
    private _jumping = false;
    private _jumpTicks = 0;
    private _timeSliding = 0;
    private _pogoImpulse = 0;
    private _pogoVelocity = 0;
    private _pogoLength = 0;
    private _skirt = NewGround();
    private _tmp = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];

    /**
     * Makes the mover's body and joints.
     * @param plugin the Box3D plugin the scene's physics runs on
     * @param scene the scene
     * @param options shape, filter and tuning
     */
    public constructor(plugin: Box3DPlugin, scene: Scene, options: IBox3DDynamicMoverOptions = {}) {
        const { b3, world } = plugin._native();
        CheckMoverExports(b3);
        this._plugin = plugin;
        this._scene = scene;

        this.jumpSpeed = options.jumpSpeed ?? 7;
        this.maxSpeed = options.maxSpeed ?? 6;
        this.minSpeed = options.minSpeed ?? 0.1;
        this.stopSpeed = options.stopSpeed ?? 3;
        this.accelerate = options.accelerate ?? 20;
        this.airSteer = options.airSteer ?? 0.25;
        this.friction = options.friction ?? 8;
        this.maxGroundForce = options.maxGroundForce ?? 6000;
        this.maxAirForce = options.maxAirForce ?? 1500;
        this.pogoRestLength = options.pogoRestLength ?? 0.9;
        this.pogoHertz = options.pogoHertz ?? 3;
        this.pogoDampingRatio = options.pogoDampingRatio ?? 0.8;
        this.pogoCompressionScale = options.pogoCompressionScale ?? 100;
        this.pogoTensionScale = options.pogoTensionScale ?? 100;
        this.enableSkirtPogo = options.enableSkirtPogo ?? true;
        this.minGroundNormalY = options.minGroundNormalY ?? 0.7;
        this.slideDuration = options.slideDuration ?? 0.2;
        this.isPlatform = options.isPlatform ?? ((body, index) => body.getMotionType(index) === PhysicsMotionType.ANIMATED);
        this._gravityScale = options.gravityScale ?? 1.5;
        this._membershipMask = (options.membershipMask ?? 0xffffffff) >>> 0;
        this._collideMask = (options.collideMask ?? 0xffffffff) >>> 0;
        for (let i = 0; i <= Box3DDynamicMover.SkirtCount; i++) {
            this.probes.push({ origin: new Vector3(), translation: new Vector3(), fraction: 1, hit: false });
        }

        // the mover joint's anchor when the mover is not on a platform: a static body with no shapes
        this._groundSlot = b3._bx_CreateBody(world, StaticBodyType, 0, 0, 0, 0, 0, 0, 1, 1);

        this._ownsNode = !options.transformNode;
        const node = options.transformNode ?? new TransformNode("box3dDynamicMover", scene);
        if (options.position) {
            node.position.copyFrom(options.position);
        }
        // the capsule stays upright, and the rays and the pogo assume the body's frame is the world's turned by nothing
        node.rotationQuaternion = Quaternion.Identity();
        node.computeWorldMatrix(true);
        this.transformNode = node;

        const half = options.capsuleHalfHeight ?? 0.5;
        this._capsuleRadius = options.capsuleRadius ?? 0.3;
        this._foot = new Vector3(0, -half, 0);
        const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, scene);
        const shape = new PhysicsShapeCapsule(new Vector3(0, -half, 0), new Vector3(0, half, 0), this._capsuleRadius, scene);
        shape.density = options.density ?? 200;
        // the mover joint and the pogo joint do all the moving, surface friction would fight them
        shape.material = { friction: 0, restitution: 0 };
        shape.filterMembershipMask = this._membershipMask;
        shape.filterCollideMask = this._collideMask;
        body.shape = shape;
        // zero inertia on every axis: Box3D's motion locks, the capsule never turns
        body.setMassProperties({ inertia: Vector3.Zero() });
        body.setGravityFactor(this._gravityScale);
        // a mover that fell asleep would stop answering its input
        plugin.setActivationControl(body, PhysicsActivationControl.ALWAYS_ACTIVE);
        this.body = body;
        this._moverSlot = plugin._bodySlot(body);

        this._createMoverJoint(this._groundSlot);
    }

    /** On the ground: friction applies, the mover joint has its ground force and the pogo reaches further down. */
    public get onGround(): boolean {
        return this._onGround;
    }

    /** On ground flat enough to walk. In the air or on a steep slope the mover steers with {@link airSteer}. */
    public get walkable(): boolean {
        return this._walkable;
    }

    /** Rising from a jump or a {@link launch}: the pogo may not pull the mover down. */
    public get jumping(): boolean {
        return this._jumping;
    }

    /** How far the pogo reaches to the ground, 0 in the air. */
    public get pogoLength(): number {
        return this._pogoLength;
    }

    /** The gravity scale of the mover's body, which also sizes the pogo's forces. A character usually falls faster than the world. */
    public get gravityScale(): number {
        return this._gravityScale;
    }

    public set gravityScale(value: number) {
        this._gravityScale = value;
        this.body.setGravityFactor(value);
    }

    /**
     * Jumps if the mover stands on walkable ground, adding the ground's own up speed.
     * @returns false when the mover is in the air or sliding
     */
    public jump(): boolean {
        if (!this._onGround || !this._walkable) {
            return false;
        }
        const b3 = this._plugin._native().b3;
        let surfaceVelocity = 0;
        if (this.ground.hit && this.ground._slot) {
            b3._bx_Body_GetPointVelocity(this.ground._slot, this.ground.point.x, this.ground.point.y, this.ground.point.z);
            surfaceVelocity = this._scratch()[1];
        }
        b3._bx_Body_GetMassData(this._moverSlot);
        const mass = this._scratch()[0];
        b3._bx_Body_GetLinearVelocity(this._moverSlot);
        const vy = this._scratch()[1];
        // replace the pogo's vertical speed and add the ground's
        const dv = Math.max(0, this.jumpSpeed - vy) + surfaceVelocity;
        b3._bx_Body_ApplyLinearImpulseToCenter(this._moverSlot, 0, mass * dv, 0);
        this.launch();
        return true;
    }

    /**
     * Lets go of the ground so an impulse from elsewhere, a jump pad or an explosion, can carry the mover into the air.
     * Otherwise the pogo pulls it back down.
     */
    public launch(): void {
        this._onGround = false;
        this._walkable = false;
        this._jumping = true;
        this._jumpTicks = 0;
    }

    /**
     * Advances the mover by one world step: casts for the ground, sets the pogo and the mover joint's target velocity.
     * Call it once per step, before the step, with the step's time.
     * @param timeStep the step's time, in seconds
     * @param forward the direction the forward throttle moves the mover, usually the camera's forward flattened to the ground
     * @param right the direction the right throttle moves it
     * @param throttleForward the input along forward, -1 to 1
     * @param throttleRight the input along right, -1 to 1
     * @param speedScale scales the top speed, for walking and running (1)
     */
    public update(timeStep: number, forward: Vector3, right: Vector3, throttleForward: number, throttleRight: number, speedScale = 1): void {
        const { b3, world } = this._plugin._native();
        const [origin, translation, pogoOffset, desired, scratchVector] = this._tmp;

        // reach further while grounded, so the spring finds the ground over a step down
        const stepDownLength = this.pogoRestLength;
        const rayLength = this._onGround ? this.pogoRestLength + stepDownLength : this.pogoRestLength;
        translation.set(0, -rayLength, 0);

        b3._bx_Body_GetTransform(this._moverSlot);
        const f64 = b3.HEAPF64;
        const at = b3._bx_ScratchF64() >> 3;
        origin.set(f64[at] + this._foot.x, f64[at + 1] + this._foot.y, f64[at + 2] + this._foot.z);

        const ground = this.ground;
        CastGroundRay(this._plugin, origin, translation, this._membershipMask, this._collideMask, this._moverSlot, ground);
        this._setProbe(0, origin, translation, ground);
        this.probeCount = 1;
        this.selectedProbe = 0;
        pogoOffset.setAll(0);

        const centerWalkable = ground.hit && ground.normal.y >= this.minGroundNormalY;
        if (!centerWalkable && this.enableSkirtPogo) {
            // the skirt turns with the direction of travel, so a tie goes to the leading ray
            b3._bx_Body_GetLinearVelocity(this._moverSlot);
            const s = this._scratch();
            let hx = s[0];
            let hz = s[2];
            const lengthSquared = hx * hx + hz * hz;
            if (lengthSquared < FloatEpsilon) {
                hx = 1;
                hz = 0;
            } else {
                const length = Math.sqrt(lengthSquared);
                hx /= length;
                hz /= length;
            }
            // side = (-heading.z, 0, heading.x)
            let bestDisplacement = Infinity;
            const skirt = this._skirt;
            for (let i = 0; i < Box3DDynamicMover.SkirtCount; i++) {
                const angle = (2 * Math.PI * i) / Box3DDynamicMover.SkirtCount;
                const cosine = Math.cos(angle);
                const sine = Math.sin(angle);
                const ox = this._capsuleRadius * (cosine * hx - sine * hz);
                const oz = this._capsuleRadius * (cosine * hz + sine * hx);
                scratchVector.set(origin.x + ox, origin.y, origin.z + oz);
                CastGroundRay(this._plugin, scratchVector, translation, this._membershipMask, this._collideMask, this._moverSlot, skirt);
                this._setProbe(this.probeCount, scratchVector, translation, skirt);

                // the walkable hit that moves the mover least. With none the mover keeps the central hit and slides off
                if (skirt.hit && skirt.normal.y >= this.minGroundNormalY) {
                    const displacement = Math.abs(skirt.fraction * rayLength - this.pogoRestLength);
                    if (displacement < bestDisplacement) {
                        bestDisplacement = displacement;
                        CopyGround(skirt, ground);
                        this.selectedProbe = this.probeCount;
                        pogoOffset.set(ox, 0, oz);
                    }
                }
                this.probeCount += 1;
            }
        }

        // should the jump end?
        if (this._jumping) {
            this._jumpTicks += 1;
            // the ticks give the jump time to leave the ground; otherwise it would end as the mover nears the ground it left
            if (this._jumpTicks > 2 && ground.hit && Vector3.Dot(this.velocity, ground.normal) <= 0) {
                this._jumping = false;
            }
        }

        if (ground.hit) {
            // too steep to walk?
            this._walkable = ground.normal.y >= this.minGroundNormalY;
            // the ray can still hit while jumping
            this._onGround = !this._jumping;
            if (this._onGround) {
                this._timeSliding = this._walkable
                    ? Math.max(this._timeSliding - timeStep, 0)
                    : Math.min(this._timeSliding + timeStep, this.slideDuration);
            }
        } else {
            this._onGround = false;
            this._walkable = false;
            this._timeSliding = Math.max(this._timeSliding - timeStep, 0);
        }

        // on a platform the mover joint holds to it, which acts as friction
        let baseSlot = this._groundSlot;
        if (ground.hit && ground.body && this.isPlatform(ground.body, ground.instanceIndex)) {
            baseSlot = ground._slot;
        }

        // a platform destroyed under the mover takes the mover joint with it
        const moverJointValid = this._moverJoint !== 0 && b3._bx_Joint_IsValid(this._moverJoint) !== 0;
        if (!moverJointValid || this._moverJointBase !== baseSlot) {
            if (this._moverJoint) {
                b3._bx_DestroyJoint(this._moverJoint);
            }
            this._createMoverJoint(baseSlot);
        }

        b3._bx_Body_GetLinearVelocity(this._moverSlot);
        let s = this._scratch();
        const vx = s[0];
        const vy = s[1];
        const vz = s[2];
        b3._bx_Body_GetLinearVelocity(baseSlot);
        s = this._scratch();
        const velocity = this.velocity.set(vx - s[0], vy - s[1], vz - s[2]);

        // friction acts in the horizontal plane, the pogo owns the vertical motion
        if (this._onGround) {
            const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
            if (speed < this.minSpeed) {
                velocity.x = 0;
                velocity.z = 0;
            } else {
                // linear damping above stopSpeed and a fixed reduction below it; friction is in 1/s
                const control = speed < this.stopSpeed ? this.stopSpeed : speed;
                const drop = control * this.friction * timeStep;
                const ratio = Math.max(0, speed - drop) / speed;
                velocity.x *= ratio;
                velocity.z *= ratio;
            }
        }

        let maxForce: number;
        if (this._onGround) {
            if (this.slideDuration > 0) {
                maxForce = Math.min(Math.max(1 - this._timeSliding / this.slideDuration, 0), 1) * this.maxGroundForce;
            } else {
                maxForce = this._walkable ? this.maxGroundForce : 0;
            }
        } else {
            maxForce = this.maxAirForce;
        }
        b3._bx_MoverJoint_SetMaxForce(this._moverJoint, maxForce);

        const maxSpeed = speedScale * this.maxSpeed;
        desired.set(
            maxSpeed * throttleForward * forward.x + maxSpeed * throttleRight * right.x,
            0,
            maxSpeed * throttleForward * forward.z + maxSpeed * throttleRight * right.z
        );
        let desiredSpeed = desired.length();
        if (desiredSpeed < FloatEpsilon) {
            desired.setAll(0);
            desiredSpeed = 0;
        } else {
            desired.scaleInPlace(1 / desiredSpeed);
        }
        desiredSpeed = Math.min(desiredSpeed, maxSpeed);

        // accelerate
        const currentSpeed = Vector3.Dot(velocity, desired);
        const addSpeed = desiredSpeed - currentSpeed;
        if (addSpeed > 0) {
            const steer = this._walkable ? 1 : this.airSteer;
            const accelSpeed = Math.min(steer * this.accelerate * maxSpeed * timeStep, addSpeed);
            velocity.x += accelSpeed * desired.x;
            velocity.z += accelSpeed * desired.z;
        }

        const normalLengthSquared = ground.normal.lengthSquared();
        if (ground.hit && Math.abs(1 - normalLengthSquared) < 100 * FloatEpsilon) {
            this._pogoLength = ground.fraction * rayLength;

            b3._bx_Body_GetMassData(this._moverSlot);
            const mass = this._scratch()[0];
            const gravity = this._scene.getPhysicsEngine()?.gravity.length() ?? 9.81;
            const weight = this._gravityScale * gravity * mass;
            const maxTension = this._jumping ? 0 : this.pogoTensionScale * weight;
            const maxCompression = this.pogoCompressionScale * weight;

            const pogoValid = this._pogoJoint !== 0 && b3._bx_Joint_IsValid(this._pogoJoint) !== 0;
            if (ground._slot !== this._surfaceSlot || !pogoValid) {
                // a new surface takes a new pogo joint, warm started from the one it replaces
                if (pogoValid) {
                    b3._bx_PogoJoint_GetState(this._pogoJoint);
                    s = this._scratch();
                    this._pogoVelocity = s[1];
                    this._pogoImpulse = s[2];
                }
                if (this._pogoJoint) {
                    b3._bx_DestroyJoint(this._pogoJoint);
                    this._pogoJoint = 0;
                }
                this._surfaceSlot = ground._slot;
                this._setPogoFrames(pogoOffset);
                s = this._scratch();
                s[14] = ground.normal.x;
                s[15] = ground.normal.y;
                s[16] = ground.normal.z;
                s[17] = this.pogoHertz;
                s[18] = this.pogoDampingRatio;
                s[19] = this.pogoRestLength;
                // the pogo pulls down at a multiple of the weight, but not while jumping
                s[20] = maxTension;
                s[21] = maxCompression;
                s[22] = this._pogoImpulse;
                s[23] = this._pogoVelocity;
                this._pogoJoint = b3._bx_CreateJoint(world, PogoJointType, this._surfaceSlot, this._moverSlot, 1, 0);
            } else {
                // the same surface keeps its joint, which is cheaper
                this._setPogoFrames(pogoOffset);
                b3._bx_Joint_SetLocalFrames(this._pogoJoint);
                b3._bx_PogoJoint_Set(
                    this._pogoJoint,
                    ground.normal.x,
                    ground.normal.y,
                    ground.normal.z,
                    this.pogoHertz,
                    this.pogoDampingRatio,
                    this.pogoRestLength,
                    maxTension,
                    maxCompression
                );
            }
        } else {
            if (this._pogoJoint) {
                b3._bx_DestroyJoint(this._pogoJoint);
                this._pogoJoint = 0;
            }
            this._surfaceSlot = 0;
            this._pogoImpulse = 0;
            this._pogoVelocity = 0;
            this._pogoLength = 0;
        }

        b3._bx_MoverJoint_SetLinearVelocity(this._moverJoint, velocity.x, velocity.y, velocity.z);
    }

    /** Destroys the mover's joints, its body and its shape, and its node when the mover made it. */
    public dispose(): void {
        const b3 = this._plugin._native().b3;
        for (const joint of [this._pogoJoint, this._moverJoint]) {
            if (joint) {
                b3._bx_DestroyJoint(joint);
            }
        }
        this._pogoJoint = 0;
        this._moverJoint = 0;
        const shape = this.body.shape;
        this.body.dispose();
        shape?.dispose();
        if (this._groundSlot) {
            b3._bx_DestroyBody(this._groundSlot);
            this._groundSlot = 0;
        }
        if (this._ownsNode) {
            this.transformNode.dispose();
        }
    }

    private _scratch(): Float32Array {
        const b3 = this._plugin._native().b3;
        return new Float32Array(b3.HEAPF32.buffer, b3._bx_Scratch(), 64);
    }

    private _setProbe(index: number, origin: Vector3, translation: Vector3, result: IBox3DMoverGround): void {
        const probe = this.probes[index];
        probe.origin.copyFrom(origin);
        probe.translation.copyFrom(translation);
        probe.fraction = result.hit ? result.fraction : 1;
        probe.hit = result.hit;
    }

    private _createMoverJoint(baseSlot: number): void {
        const { b3, world } = this._plugin._native();
        const s = this._scratch();
        s.set(IdentityFrames, 0);
        s[14] = this.velocity.x;
        s[15] = this.velocity.y;
        s[16] = this.velocity.z;
        // collide connected: the mover still stands on the platform it is jointed to
        this._moverJoint = b3._bx_CreateJoint(world, MoverJointType, baseSlot, this._moverSlot, 1, this.maxGroundForce);
        this._moverJointBase = baseSlot;
    }

    /** Frame A at the ground point on the surface, frame B at the ray's start on the mover. */
    private _setPogoFrames(pogoOffset: Vector3): void {
        const b3 = this._plugin._native().b3;
        const point = this.ground.point;
        b3._bx_Body_GetLocalPoint(this._surfaceSlot, point.x, point.y, point.z);
        const s = this._scratch();
        const ax = s[0];
        const ay = s[1];
        const az = s[2];
        s.set(IdentityFrames, 0);
        s[0] = ax;
        s[1] = ay;
        s[2] = az;
        s[7] = this._foot.x + pogoOffset.x;
        s[8] = this._foot.y + pogoOffset.y;
        s[9] = this._foot.z + pogoOffset.z;
    }
}

/**
 * Options for a {@link Box3DGeometricMover}. The tunings default to the values in Box3D's sample.
 */
export interface IBox3DGeometricMoverOptions {
    /** the capsule's center in world space (default the node's position, or the origin) */
    position?: Vector3;
    /** half the distance between the capsule's two sphere centers, along y (0.5) */
    capsuleHalfHeight?: number;
    /** the capsule's radius (0.3) */
    capsuleRadius?: number;
    /** the mover queries the world as a shape with this membership mask (all) */
    membershipMask?: number;
    /** and meets the shapes this mask lets through (all) */
    collideMask?: number;
    /** a node the mover moves to its position after each update */
    transformNode?: TransformNode;
    jumpSpeed?: number;
    maxSpeed?: number;
    minSpeed?: number;
    stopSpeed?: number;
    accelerate?: number;
    friction?: number;
    gravity?: number;
    pogoRestLength?: number;
    pogoHertz?: number;
    pogoDampingRatio?: number;
}

/** A collision plane between a geometric mover and a shape, from its last update. */
export interface IBox3DMoverPlane {
    /** the plane's normal, pointing at the mover */
    normal: Vector3;
    /** the closest point on the shape, in world space */
    point: Vector3;
    /** how far the plane pushed the mover */
    push: number;
    /** the body the plane is on, and its instance */
    body?: PhysicsBody;
    instanceIndex: number;
}

/**
 * Box3D's geometric character mover. The capsule is not a body: it is moved by casting it through the world and by
 * solving the collision planes it touches, so the game keeps full control of the motion. A pogo spring holds it above
 * the ground so it walks up steps, and it pushes the dynamic bodies it walks into.
 *
 * Movement follows Quake's ground and air model. Call {@link update} once per frame or step and {@link jump} when the
 * player jumps. Other bodies do not collide with the mover; give it a kinematic body that follows it when they should.
 */
export class Box3DGeometricMover {
    /** The most collision planes an update keeps. */
    public static readonly PlaneCapacity = 8;

    public jumpSpeed: number;
    public maxSpeed: number;
    public minSpeed: number;
    public stopSpeed: number;
    public accelerate: number;
    /** Friction, in 1/s. */
    public friction: number;
    /** The mover is not simulated, so it has its own gravity, in m/s^2 downwards. */
    public gravity: number;
    public pogoRestLength: number;
    public pogoHertz: number;
    public pogoDampingRatio: number;
    /**
     * Clip the velocity against the planes the mover touched, so speed cannot build up against a wall. Off, the
     * velocity is the distance moved over the time, which follows soft collision as it pushes the mover out.
     */
    public clipVelocity = true;
    /** Whether the mover pushes a dynamic body it touches. All of them by default. */
    public canPush: (body: PhysicsBody, instanceIndex: number) => boolean = () => true;
    /**
     * Called for each plane the mover finds, to soften it: return how far the plane may push the mover in one update,
     * Infinity for a rigid one, and whether the velocity is clipped against it (false for soft collision).
     */
    public softenPlane?: (body: PhysicsBody, instanceIndex: number) => { maxPush: number; clipVelocity: boolean } | undefined;
    /** A body the mover passes through, such as a kinematic body that follows it so other bodies collide with it. */
    public ignoreBody?: PhysicsBody;

    /** The capsule's center in world space. */
    public readonly position = new Vector3();
    public readonly velocity = new Vector3();
    /** The node the mover moves, if any. */
    public readonly transformNode?: TransformNode;
    /** The planes the last update solved, for drawing or reacting to. */
    public readonly planes: IBox3DMoverPlane[] = [];
    /** How many of the planes the last update found. */
    public planeCount = 0;
    /** The plane solver's iterations in the last update, for diagnostics. */
    public totalIterations = 0;
    /** The pogo's ray in the last update, and whether it found the ground. */
    public readonly pogoProbe: IBox3DMoverProbe = { origin: new Vector3(), translation: new Vector3(), fraction: 1, hit: false };

    private _plugin: Box3DPlugin;
    private _membershipMask: number;
    private _collideMask: number;
    private _c1: Vector3;
    private _c2: Vector3;
    private _radius: number;
    private _pogoVelocity = 0;
    private _onGround = false;
    private _ground = NewGround();
    private _tmp = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];

    /**
     * @param plugin the Box3D plugin the scene's physics runs on
     * @param options shape, filter and tuning
     */
    public constructor(plugin: Box3DPlugin, options: IBox3DGeometricMoverOptions = {}) {
        CheckMoverExports(plugin._native().b3);
        this._plugin = plugin;
        this.jumpSpeed = options.jumpSpeed ?? 5;
        this.maxSpeed = options.maxSpeed ?? 6;
        this.minSpeed = options.minSpeed ?? 0.01;
        this.stopSpeed = options.stopSpeed ?? 1;
        this.accelerate = options.accelerate ?? 30;
        this.friction = options.friction ?? 4;
        this.gravity = options.gravity ?? 15;
        this.pogoRestLength = options.pogoRestLength ?? 0.9;
        this.pogoHertz = options.pogoHertz ?? 4;
        this.pogoDampingRatio = options.pogoDampingRatio ?? 0.7;
        this._membershipMask = (options.membershipMask ?? 0xffffffff) >>> 0;
        this._collideMask = (options.collideMask ?? 0xffffffff) >>> 0;
        const half = options.capsuleHalfHeight ?? 0.5;
        this._c1 = new Vector3(0, -half, 0);
        this._c2 = new Vector3(0, half, 0);
        this._radius = options.capsuleRadius ?? 0.3;
        this.transformNode = options.transformNode;
        this.position.copyFrom(options.position ?? options.transformNode?.position ?? Vector3.ZeroReadOnly);
        for (let i = 0; i < Box3DGeometricMover.PlaneCapacity; i++) {
            this.planes.push({ normal: new Vector3(), point: new Vector3(), push: 0, instanceIndex: 0 });
        }
    }

    /** Whether the pogo found ground in the last update. */
    public get onGround(): boolean {
        return this._onGround;
    }

    /**
     * Jumps if the mover is on the ground.
     * @returns false in the air
     */
    public jump(): boolean {
        if (!this._onGround) {
            return false;
        }
        this.velocity.y = this.jumpSpeed;
        this._onGround = false;
        return true;
    }

    /**
     * Moves the mover by one update.
     * @param timeStep the time, in seconds
     * @param forward the direction the forward throttle moves the mover
     * @param right the direction the right throttle moves it
     * @param throttleForward the input along forward, -1 to 1
     * @param throttleRight the input along right, -1 to 1
     * @param speedScale scales the top speed (1)
     */
    public update(timeStep: number, forward: Vector3, right: Vector3, throttleForward: number, throttleRight: number, speedScale = 1): void {
        const { b3, world } = this._plugin._native();
        const [desired, target, start, delta] = this._tmp;
        const velocity = this.velocity;
        const ignore = this.ignoreBody ? this._plugin._bodySlot(this.ignoreBody) : 0;

        // friction: linear damping above stopSpeed and a fixed reduction below it, in 1/s
        const speed = velocity.length();
        if (speed < this.minSpeed) {
            velocity.x = 0;
            velocity.z = 0;
        } else {
            const control = speed < this.stopSpeed ? this.stopSpeed : speed;
            const ratio = Math.max(0, speed - control * this.friction * timeStep) / speed;
            velocity.x *= ratio;
            velocity.z *= ratio;
        }

        const maxSpeed = speedScale * this.maxSpeed;
        desired.set(
            maxSpeed * throttleForward * forward.x + maxSpeed * throttleRight * right.x,
            maxSpeed * throttleForward * forward.y + maxSpeed * throttleRight * right.y,
            maxSpeed * throttleForward * forward.z + maxSpeed * throttleRight * right.z
        );
        let desiredSpeed = desired.length();
        if (desiredSpeed < FloatEpsilon) {
            desired.setAll(0);
            desiredSpeed = 0;
        } else {
            desired.scaleInPlace(1 / desiredSpeed);
        }
        desiredSpeed = Math.min(desiredSpeed, maxSpeed);

        if (this._onGround) {
            velocity.y = 0;
        }

        // accelerate
        const addSpeed = desiredSpeed - Vector3.Dot(velocity, desired);
        if (addSpeed > 0) {
            const accelSpeed = Math.min(this.accelerate * maxSpeed * timeStep, addSpeed);
            velocity.addInPlace(desired.scaleInPlace(accelSpeed));
        }

        velocity.y -= this.gravity * timeStep;

        // the pogo's ray reaches past the rest length so the spring can stretch
        const rayLength = this.pogoRestLength + this._radius;
        const probe = this.pogoProbe;
        probe.origin.copyFrom(this.position).addInPlace(this._c1);
        probe.translation.set(0, -rayLength, 0);
        const ground = CastGroundRay(this._plugin, probe.origin, probe.translation, this._membershipMask, this._collideMask, ignore, this._ground);
        probe.fraction = ground.hit ? ground.fraction : 1;

        // gravity has been applied: still rising means a jump, which the pogo must not pull back down
        if (!ground.hit || velocity.y > 0) {
            this._onGround = false;
            this._pogoVelocity = 0;
        } else {
            this._onGround = true;
            const offset = ground.fraction * rayLength - this.pogoRestLength;
            this._pogoVelocity = SpringDamper(this.pogoHertz, this.pogoDampingRatio, offset, this._pogoVelocity, timeStep);
        }
        probe.hit = this._onGround;

        start.copyFrom(this.position);
        target.set(
            this.position.x + timeStep * velocity.x,
            this.position.y + timeStep * (velocity.y + this._pogoVelocity),
            this.position.z + timeStep * velocity.z
        );

        const c1 = this._c1;
        const c2 = this._c2;
        const tolerance = 0.01;
        const plane = b3._bx_MoverPlanesPtr() >> 2;
        this.totalIterations = 0;
        for (let iteration = 0; iteration < 5; iteration++) {
            const origin = this.position;
            const count = b3._bx_World_CollideMover(
                world,
                origin.x,
                origin.y,
                origin.z,
                c1.x,
                c1.y,
                c1.z,
                c2.x,
                c2.y,
                c2.z,
                this._radius,
                this._membershipMask,
                this._collideMask,
                ignore,
                Box3DGeometricMover.PlaneCapacity
            );
            this._readPlanes(b3, plane, count, origin);

            this.totalIterations += b3._bx_SolveMoverPlanes(target.x - origin.x, target.y - origin.y, target.z - origin.z, count);
            let s = this._scratch();
            delta.set(s[0], s[1], s[2]);
            const fraction = b3._bx_World_CastMover(
                world,
                origin.x,
                origin.y,
                origin.z,
                c1.x,
                c1.y,
                c1.z,
                c2.x,
                c2.y,
                c2.z,
                this._radius,
                delta.x,
                delta.y,
                delta.z,
                this._membershipMask,
                this._collideMask,
                ignore
            );
            s = b3.HEAPF32;
            for (let i = 0; i < count; i++) {
                this.planes[i].push = s[plane + i * 12 + 5];
            }
            delta.scaleInPlace(fraction);
            this.position.addInPlace(delta);
            if (delta.lengthSquared() < tolerance * tolerance) {
                break;
            }
        }

        this._pushBodies();

        if (this.clipVelocity) {
            // stop pushing into surfaces, so speed cannot build up against a wall
            b3._bx_ClipMoverVector(velocity.x, velocity.y, velocity.z, this.planeCount);
            const s = this._scratch();
            velocity.set(s[0], s[1], s[2]);
        } else if (timeStep > 0) {
            velocity.copyFrom(this.position).subtractInPlace(start).scaleInPlace(1 / timeStep);
        }

        this.transformNode?.position.copyFrom(this.position);
    }

    private _scratch(): Float32Array {
        const b3 = this._plugin._native().b3;
        return new Float32Array(b3.HEAPF32.buffer, b3._bx_Scratch(), 64);
    }

    /** Reads the gathered planes, gives each its softness, and writes that back for the solver. */
    private _readPlanes(b3: any, plane: number, count: number, origin: Vector3): void {
        const f32: Float32Array = b3.HEAPF32;
        this.planeCount = count;
        for (let i = 0; i < count; i++) {
            const at = plane + i * 12;
            const out = this.planes[i];
            out.normal.set(f32[at], f32[at + 1], f32[at + 2]);
            // the plane point is relative to the origin the planes were gathered at
            out.point.set(origin.x + f32[at + 7], origin.y + f32[at + 8], origin.z + f32[at + 9]);
            out.push = 0;
            const ref = this._plugin._bodyFromSlot(f32[at + 10]);
            out.body = ref?.body;
            out.instanceIndex = ref?.index ?? 0;
            const soft = this.softenPlane && ref ? this.softenPlane(ref.body, ref.index) : undefined;
            if (soft) {
                f32[at + 4] = Number.isFinite(soft.maxPush) ? soft.maxPush : FloatMax;
                f32[at + 6] = soft.clipVelocity ? 1 : 0;
            }
        }
    }

    /**
     * Solves a normal constraint between the mover and each dynamic body it touches: the solver's contact velocity
     * constraint with the mover's mass taken as infinite, so all of the impulse lands on the body.
     */
    private _pushBodies(): void {
        const b3 = this._plugin._native().b3;
        const velocity = this.velocity;
        for (let i = 0; i < this.planeCount; i++) {
            const plane = this.planes[i];
            if (!plane.body || plane.body.getMotionType(plane.instanceIndex) !== PhysicsMotionType.DYNAMIC || !this.canPush(plane.body, plane.instanceIndex)) {
                continue;
            }
            // the plane's normal points at the mover, the push goes into the body
            b3._bx_Body_PushFromMover(
                this._plugin._bodySlot(plane.body, plane.instanceIndex),
                plane.point.x,
                plane.point.y,
                plane.point.z,
                -plane.normal.x,
                -plane.normal.y,
                -plane.normal.z,
                velocity.x,
                velocity.y,
                velocity.z
            );
        }
    }
}
