// babylon-box3d: Box3D physics for Babylon.js.
//
//   import { Box3D, Box3DPlugin } from "babylon-box3d";
//   const box3d = await Box3D();
//   scene.enablePhysics(new Vector3(0, -9.81, 0), new Box3DPlugin(true, box3d));

// the .js extension keeps the emitted dist/index.js importable by plain node ESM, not just by bundlers
export { Box3DPlugin, Box3DWheelJoint, type IBox3DWheelJointOptions } from "./box3dPlugin.js";
export { default as Box3D } from "babylon-box3d/wasm";
export type { Box3DModule, Box3DModuleOptions, Box3DExports, Box3DHeap } from "babylon-box3d/wasm";
