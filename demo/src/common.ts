import { type Scene } from "@babylonjs/core/scene";
import { type ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { type ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { type Mesh } from "@babylonjs/core/Meshes/mesh";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { type Box3DPlugin } from "../../src/box3dPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import Box3D from "../../lib/esm/box3d.js";
import wasmUrl from "../../lib/esm/box3d.wasm?url";

/** Shared state handed to every demo builder. */
export interface IDemoContext {
    scene: Scene;
    plugin: Box3DPlugin;
    camera: ArcRotateCamera;
    shadows: ShadowGenerator;
    /** query string parameters, keys lower cased */
    params: URLSearchParams;
    /** keys currently held down (lower case) */
    keys: Set<string>;
    material: (index?: number) => StandardMaterial;
    /** registers a mesh as shadow caster and receiver */
    watch: (mesh: Mesh) => void;
    /** lines shown in the HUD under the demo links */
    help: string;
}

export const Palette = ["#f94144", "#f3722c", "#f8961e", "#f9c74f", "#90be6d", "#43aa8b", "#577590", "#277da1"];

export function MakeMaterialFactory(scene: Scene): (index?: number) => StandardMaterial {
    const cache = new Map<number, StandardMaterial>();
    let next = 0;
    return (index?: number) => {
        const i = (index ?? next++) % Palette.length;
        let mat = cache.get(i);
        if (!mat) {
            mat = new StandardMaterial("mat" + i, scene);
            mat.diffuseColor = Color3.FromHexString(Palette[i]);
            mat.specularColor = new Color3(0.15, 0.15, 0.15);
            cache.set(i, mat);
        }
        return mat;
    };
}

// Flat static ground box, top surface at y = 0.
export function Ground(ctx: IDemoContext, size = 60, friction = 0.7): Mesh {
    const ground = MeshBuilder.CreateBox("ground", { width: size, height: 1, depth: size }, ctx.scene);
    ground.position.y = -0.5;
    const mat = new StandardMaterial("groundMat", ctx.scene);
    mat.diffuseColor = new Color3(0.85, 0.85, 0.82);
    mat.specularColor = Color3.Black();
    ground.material = mat;
    ground.receiveShadows = true;
    new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0, friction }, ctx.scene);
    return ground;
}

// Reads a numeric query parameter with a default.
export function Param(ctx: IDemoContext, name: string, fallback: number): number {
    const value = parseFloat(ctx.params.get(name.toLowerCase()) ?? "");
    return Number.isFinite(value) ? value : fallback;
}

export async function LoadBox3D(): Promise<any> {
    // Vite serves the wasm as an asset, tell the emscripten loader where it is.
    return await Box3D({ locateFile: () => wasmUrl });
}
