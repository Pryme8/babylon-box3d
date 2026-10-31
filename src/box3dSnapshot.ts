// Snapshots of a whole Box3D module: every world in it put back as it was, to the bit.
//
// A single threaded module's state - every world with its bodies, shapes, joints, contacts and their warm starts, the
// shim's slots and shape descriptions, and the allocator's books - lies in its linear memory below the break
// (`_bx_Memory_End`), and nothing of it anywhere else. A copy of those bytes taken between steps and written back
// later puts every world back as it was, so the steps that follow are the ones that followed then, bit for bit, and
// every slot and handle means what it meant. Successive snapshots share the pieces of memory that did not change
// between them, so a run of snapshots costs what moved, not the module's size each time.
//
// What a snapshot does not hold is anything outside the module. A Box3DPlugin's bodies and shapes are JavaScript
// objects over the module's slots, and a restore does not move them back, so snapshots are for code that drives the
// module through its raw exports and keeps its own state beside it. Nor is the clock in memory: a world whose timer is
// on (the default; `_bx_World_EnableTimer`) keeps its last step's timings, which a step after a restore reads afresh,
// so its steps repeat to the bit while those few bytes of its memory do not. Nor do snapshots work on a threaded build,
// whose workers' stacks, semaphore and task ring lie in the same memory: writing those under a parked worker is not
// safe.

import type { Box3DModule } from "babylon-box3d/wasm";

/** Bytes in each piece of a snapshot, shared with the snapshot before it where they did not change. */
export const BOX3D_SNAPSHOT_CHUNK = 16384;

/** A module's state at a moment between steps (`SnapshotBox3D`), to be written back with `RestoreBox3D`. */
export interface IBox3DSnapshot {
    /** The break when it was taken: the module's state is its memory's bytes [0, end). */
    readonly end: number;
    /** The build it was taken on: where its heap begins, and whether it holds positions in doubles. */
    readonly base: number;
    readonly doublePrecision: boolean;
    /**
     * Those bytes in BOX3D_SNAPSHOT_CHUNK pieces, the last cut short at `end`. A piece is shared with the snapshot it was
     * taken after where it is the same, so none of them may be written to.
     */
    readonly chunks: readonly Uint8Array[];
}

/**
 * Takes a module's whole state, between steps: every world in it, as `RestoreBox3D` will put it back.
 * @param module a single threaded module, either precision
 * @param previous a snapshot of the same module taken before, whose unchanged pieces this one shares
 * @returns the snapshot, which holds no reference to the module
 */
export function SnapshotBox3D(module: Box3DModule, previous?: IBox3DSnapshot): IBox3DSnapshot {
    RefuseThreads(module, "snapshot");
    const end = module._bx_Memory_End() >>> 0;
    const heap = module.HEAPU8;
    const chunks = new Array<Uint8Array>(Math.ceil(end / BOX3D_SNAPSHOT_CHUNK));
    for (let i = 0; i < chunks.length; i++) {
        const from = i * BOX3D_SNAPSHOT_CHUNK;
        const to = Math.min(end, from + BOX3D_SNAPSHOT_CHUNK);
        const before = previous?.chunks[i];
        chunks[i] = before !== undefined && before.length === to - from && SameBytes(heap, from, before) ? before : heap.slice(from, to);
    }
    return { end, base: module._bx_Memory_Base() >>> 0, doublePrecision: module._bx_IsDoublePrecision() === 1, chunks };
}

/**
 * Puts a module back as a snapshot found it: every world, body and shape it held then, each at the slot it had, and
 * none made since. Write it into the module it was taken of, or a fresh instance of the same build, which then steps
 * as the module did after the snapshot.
 * @param module a single threaded module of the build the snapshot was taken on
 * @param snapshot what `SnapshotBox3D` took
 */
export function RestoreBox3D(module: Box3DModule, snapshot: IBox3DSnapshot): void {
    RefuseThreads(module, "restore");
    if ((module._bx_Memory_Base() >>> 0) !== snapshot.base || (module._bx_IsDoublePrecision() === 1) !== snapshot.doublePrecision) {
        throw new Error(
            "babylon-box3d: a snapshot can only be restored into the build it was taken on, and this module's memory is laid out " +
                "differently"
        );
    }
    // a fresh instance with less memory than the snapshot holds
    if (module.HEAPU8.length < snapshot.end && module._bx_Memory_Reserve(snapshot.end) !== 1) {
        throw new Error(`babylon-box3d: the module could not grow to the ${snapshot.end} bytes the snapshot holds`);
    }
    const now = module._bx_Memory_End() >>> 0;
    const heap = module.HEAPU8;
    for (let i = 0; i < snapshot.chunks.length; i++) {
        heap.set(snapshot.chunks[i], i * BOX3D_SNAPSHOT_CHUNK);
    }
    // what the module has taken since the snapshot, given back as memory is first given: zeroed
    if (now > snapshot.end) {
        heap.fill(0, snapshot.end, now);
    }
}

function RefuseThreads(module: Box3DModule, what: string): void {
    if (typeof SharedArrayBuffer !== "undefined" && module.HEAPU8.buffer instanceof SharedArrayBuffer) {
        throw new Error(
            `babylon-box3d: a threaded module cannot be put in a ${what}: its workers' stacks and task ring lie in the memory a ` +
                "restore writes. Load the single threaded build for snapshots; it steps a world to the same bits."
        );
    }
}

/** Whether the heap's bytes from `from` are the piece's, compared as whole words where they line up, so to the bit. */
function SameBytes(heap: Uint8Array, from: number, piece: Uint8Array): boolean {
    let i = 0;
    if (((heap.byteOffset + from) & 3) === 0 && (piece.byteOffset & 3) === 0) {
        const words = piece.length >> 2;
        const a = new Int32Array(heap.buffer, heap.byteOffset + from, words);
        const b = new Int32Array(piece.buffer, piece.byteOffset, words);
        for (; i < words; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        i = words << 2;
    }
    for (; i < piece.length; i++) {
        if (heap[from + i] !== piece[i]) {
            return false;
        }
    }
    return true;
}
