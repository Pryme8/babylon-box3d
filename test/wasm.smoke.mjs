// Node smoke test for the Box3D WASM shim: node test/wasm.smoke.mjs
// Drops a sphere onto a static box, checks it comes to rest, then exercises joints, events and ray casts.

import Box3DModule from "../lib/node/box3d.mjs";

const b3 = await Box3DModule();
const scratch = () => new Float32Array(b3.HEAPF32.buffer, b3._bx_Scratch(), 64);

function Check(condition, message) {
    if (!condition) {
        console.error(`FAIL: ${message}`);
        process.exitCode = 1;
    } else {
        console.log(`ok: ${message}`);
    }
}

console.log(`box3d version ${b3._bx_GetVersion()}`);

const world = b3._bx_CreateWorld(0, -9.81, 0);
Check(world > 0, "world created");

// ground: static body with a 20x1x20 box hull
const ground = b3._bx_CreateBody(world, 0, 0, -0.5, 0, 0, 0, 0, 1, 1);
const groundShape = b3._bx_ShapeDesc_CreateBox(10, 0.5, 10, 0, 0, 0, 0, 0, 0, 1);
b3._bx_Body_SetShape(ground, groundShape);
Check(b3._bx_Body_GetShapeCount(ground) === 1, "ground shape attached");

// dynamic sphere
const ball = b3._bx_CreateBody(world, 2, 0, 5, 0, 0, 0, 0, 1, 1);
const ballShape = b3._bx_ShapeDesc_CreateSphere(0, 0, 0, 0.5);
b3._bx_ShapeDesc_SetMaterial(ballShape, 0.6, 0.0);
b3._bx_Body_SetShape(ball, ballShape);
b3._bx_Body_EnableContactEvents(ball, 1);
b3._bx_Body_GetMassData(ball);
const mass = scratch()[0];
Check(mass > 520 && mass < 530, `sphere mass from shapes at water density (${mass.toFixed(1)})`);

let contactBegin = 0;
let contactHit = 0;
for (let i = 0; i < 180; i++) {
    b3._bx_World_Step(world, 1 / 60, 4);
    const events = b3._bx_World_GetContactEvents(world);
    const buf = new Float32Array(b3.HEAPF32.buffer, b3._bx_ContactEventsPtr(), events * 12);
    for (let e = 0; e < events; e++) {
        if (buf[e * 12] === 0) contactBegin++;
        if (buf[e * 12] === 2) contactHit++;
    }
}
b3._bx_Body_GetTransform(ball);
const y = scratch()[1];
Check(Math.abs(y - 0.5) < 0.02, `sphere rests on ground (y=${y.toFixed(3)})`);
Check(contactBegin === 1, `one contact begin event (${contactBegin})`);
Check(contactHit >= 1, `hit event reported (${contactHit})`);

// move events report the sleeping body once, then nothing
b3._bx_World_Step(world, 1 / 60, 4);
const moved = b3._bx_World_GetMoveEvents(world);
Check(moved <= 1, `move events after rest (${moved})`);

// hinge chain: static anchor + 4 capsules, revolute about z
const anchor = b3._bx_CreateBody(world, 0, 0, 6, 0, 0, 0, 0, 1, 1);
let prev = anchor;
const links = [];
for (let i = 0; i < 4; i++) {
    const link = b3._bx_CreateBody(world, 2, 0.5 + i, 6, 0, 0, 0, 0, 1, 1);
    const cap = b3._bx_ShapeDesc_CreateCapsule(-0.4, 0, 0, 0.4, 0, 0, 0.1);
    b3._bx_Body_SetShape(link, cap);
    const s = scratch();
    // frame A at +0.5 on the previous body (0 for the anchor), frame B at -0.5 on the link, identity rotation
    s.set([prev === anchor ? 0 : 0.5, 0, 0, 0, 0, 0, 1, -0.5, 0, 0, 0, 0, 0, 1]);
    const joint = b3._bx_CreateJoint(world, 2, prev, link, 0, 0);
    Check(joint > 0, `hinge ${i} created`);
    links.push(link);
    prev = link;
}
let minTipY = 6;
let maxReach = 0;
for (let i = 0; i < 120; i++) {
    b3._bx_World_Step(world, 1 / 60, 4);
    b3._bx_Body_GetTransform(links[3]);
    const tip = scratch();
    minTipY = Math.min(minTipY, tip[1]);
    maxReach = Math.max(maxReach, Math.hypot(tip[0], tip[1] - 6, tip[2]));
}
Check(minTipY < 3 && maxReach < 4.1, `chain swings under gravity (min tip y=${minTipY.toFixed(2)}, reach=${maxReach.toFixed(2)})`);

// ray cast straight down onto the ground
const hits = b3._bx_World_CastRay(world, 5, 3, 5, 0, -10, 0, 0xffffffff, 0xffffffff, 0, 0, 1);
const hit = new Float32Array(b3.HEAPF32.buffer, b3._bx_RayHitsPtr(), 11);
Check(hits === 1 && Math.abs(hit[1]) < 1e-3 && hit[7] === ground, `ray hits ground at y=${hit[1].toFixed(3)} body=${hit[7]}`);

// sensor
const trigger = b3._bx_CreateBody(world, 0, 0, 0.5, 0, 0, 0, 0, 1, 1);
const triggerShape = b3._bx_ShapeDesc_CreateBox(1, 1, 1, 0, 0, 0, 0, 0, 0, 1);
b3._bx_ShapeDesc_SetSensor(triggerShape, 1);
b3._bx_Body_SetShape(trigger, triggerShape);
b3._bx_World_Step(world, 1 / 60, 4);
const sensorEvents = b3._bx_World_GetSensorEvents(world);
const sensorBuf = new Float32Array(b3.HEAPF32.buffer, b3._bx_SensorEventsPtr(), sensorEvents * 5);
let sawBall = false;
for (let e = 0; e < sensorEvents; e++) {
    if (sensorBuf[e * 5] === 0 && sensorBuf[e * 5 + 3] === trigger && sensorBuf[e * 5 + 4] === ball) sawBall = true;
}
Check(sawBall, `sensor overlap with ball reported (${sensorEvents} events)`);

// destroy and recreate
b3._bx_DestroyBody(ball);
b3._bx_ShapeDesc_Destroy(ballShape);
b3._bx_World_Step(world, 1 / 60, 4);
b3._bx_World_GetStats(world);
const stats = Array.from(scratch().slice(0, 4));
Check(stats[0] === 7, `body count after destroy (${stats[0]})`);
b3._bx_DestroyWorld(world);
Check(b3._bx_CreateWorld(0, -10, 0) === 1, "world slot reused");
console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
