// Engine agnostic benchmark scenes. Every engine gets exactly the same bodies at exactly the same positions, the
// generators are deterministic (no Math.random).

export type BodyShape = "box" | "sphere";

export interface IBodySpec {
    shape: BodyShape;
    x: number;
    y: number;
    z: number;
    /** Euler angles in radians */
    rx: number;
    ry: number;
    rz: number;
}

export interface IStaticBoxSpec {
    x: number;
    y: number;
    z: number;
    width: number;
    height: number;
    depth: number;
}

export interface ISceneSpec {
    id: string;
    label: string;
    /** edge length of box bodies and diameter of sphere bodies */
    bodySize: number;
    statics: IStaticBoxSpec[];
    bodies: IBodySpec[];
    steps: number;
    /** scene specific quality check, reads the final body positions */
    quality: (final: Float64Array) => Record<string, number>;
}

// Small deterministic PRNG (mulberry32) so jitter is identical for every engine and every run.
function Prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function GroundSlab(size: number): IStaticBoxSpec {
    return { x: 0, y: -0.5, z: 0, width: size, height: 1, depth: size };
}

/**
 * Box3D's "Large Pyramid" benchmark: a 2D pyramid of unit boxes, `rows` boxes wide at the base.
 * Stacking tall pyramids is the classic solver stress test, the quality metric is how far boxes drifted.
 */
export function Pyramid(rows: number, steps = 600): ISceneSpec {
    const h = 0.5;
    const bodies: IBodySpec[] = [];
    for (let i = 0; i < rows; i++) {
        const y = (2 * i + 1) * h;
        for (let j = i; j < rows; j++) {
            const x = (i + 1) * h + 2 * (j - i) * h - h * rows;
            bodies.push({ shape: "box", x, y, z: 0, rx: 0, ry: 0, rz: 0 });
        }
    }
    const topIndex = bodies.length - 1;
    const topStartY = bodies[topIndex].y;
    return {
        id: `pyramid-${rows}`,
        label: `Pyramid, ${rows} rows`,
        bodySize: 1,
        statics: [GroundSlab(Math.max(40, rows * 2 + 20))],
        bodies,
        steps,
        quality: (final) => {
            let maxDrift = 0;
            let sumDrift = 0;
            for (let i = 0; i < bodies.length; i++) {
                const b = bodies[i];
                const d = Math.hypot(final[i * 3] - b.x, final[i * 3 + 1] - b.y, final[i * 3 + 2] - b.z);
                maxDrift = Math.max(maxDrift, d);
                sumDrift += d;
            }
            return {
                maxDrift,
                meanDrift: sumDrift / bodies.length,
                topHeightRetained: final[topIndex * 3 + 1] / topStartY,
            };
        },
    };
}

/**
 * A heap of mixed boxes and spheres dropped into a walled bin. Stresses broadphase, narrowphase and the solver with
 * lots of simultaneous contacts. The quality metric counts bodies that tunneled out of the bin.
 */
export function Pile(count: number, steps = 600): ISceneSpec {
    const perSide = 20;
    const spacing = 1.1;
    const size = 0.9;
    const inner = perSide * spacing + 1;
    const half = inner / 2;
    const layers = Math.ceil(count / (perSide * perSide));
    const wallHeight = 4 + layers * spacing * 1.2;
    const random = Prng(1234);
    const bodies: IBodySpec[] = [];
    for (let n = 0; n < count; n++) {
        const layer = Math.floor(n / (perSide * perSide));
        const cell = n % (perSide * perSide);
        const ix = cell % perSide;
        const iz = Math.floor(cell / perSide);
        bodies.push({
            shape: (ix + iz + layer) % 2 === 0 ? "box" : "sphere",
            x: (ix - (perSide - 1) / 2) * spacing + (random() - 0.5) * 0.1,
            y: 2 + layer * spacing,
            z: (iz - (perSide - 1) / 2) * spacing + (random() - 0.5) * 0.1,
            rx: random() * Math.PI,
            ry: random() * Math.PI,
            rz: random() * Math.PI,
        });
    }
    const t = 1;
    return {
        id: `pile-${count}`,
        label: `Pile, ${count} boxes and spheres`,
        bodySize: size,
        statics: [
            GroundSlab(inner + 4),
            { x: -half - t / 2, y: wallHeight / 2, z: 0, width: t, height: wallHeight, depth: inner + 2 * t },
            { x: half + t / 2, y: wallHeight / 2, z: 0, width: t, height: wallHeight, depth: inner + 2 * t },
            { x: 0, y: wallHeight / 2, z: -half - t / 2, width: inner, height: wallHeight, depth: t },
            { x: 0, y: wallHeight / 2, z: half + t / 2, width: inner, height: wallHeight, depth: t },
        ],
        bodies,
        steps,
        quality: (final) => {
            let escaped = 0;
            let maxY = 0;
            for (let i = 0; i < bodies.length; i++) {
                const x = final[i * 3];
                const y = final[i * 3 + 1];
                const z = final[i * 3 + 2];
                if (y < -1 || Math.abs(x) > half + 0.5 || Math.abs(z) > half + 0.5 || !Number.isFinite(y)) {
                    escaped++;
                }
                maxY = Math.max(maxY, y);
            }
            return { escaped, pileHeight: maxY };
        },
    };
}

/** The default matrix used for published numbers. */
export function DefaultScenes(): ISceneSpec[] {
    return [Pyramid(20), Pyramid(50), Pyramid(100), Pile(1000), Pile(4000)];
}

export function SceneById(id: string): ISceneSpec {
    const [kind, n] = id.split("-");
    const count = parseInt(n, 10);
    if (kind === "pyramid" && count > 1) {
        return Pyramid(count);
    }
    if (kind === "pile" && count > 0) {
        return Pile(count);
    }
    throw new Error(`Unknown scene ${id}, use pyramid-<rows> or pile-<count>`);
}
