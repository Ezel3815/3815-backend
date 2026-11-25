/**
 * Merges several single-file 3D models (.glb) into ONE .glb, with no extra package.
 * Every part keeps its own position, so parts cut from the same body (a muscle and the bones it
 * attaches to) end up exactly where they belong. Animations and cameras are dropped.
 */
interface Glb { json: any; bin: Buffer }

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function parseGlb(buf: Buffer, label: string): Glb {
    if (buf.length < 20 || buf.readUInt32LE(0) !== MAGIC) throw new Error(`${label} is not a .glb file`);
    const end = Math.min(buf.readUInt32LE(8), buf.length);
    let off = 12;
    let json: any = null;
    let bin: Buffer = Buffer.alloc(0);
    while (off + 8 <= end) {
        const len = buf.readUInt32LE(off);
        const type = buf.readUInt32LE(off + 4);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === JSON_CHUNK) json = JSON.parse(data.toString("utf8"));
        else if (type === BIN_CHUNK && !bin.length) bin = Buffer.from(data);
        off += 8 + len;
    }
    if (!json) throw new Error(`${label} has no model data`);
    if ((json.buffers?.length ?? 0) > 1 || json.buffers?.[0]?.uri) throw new Error(`${label} uses external files; only single-file .glb models can be merged`);
    return { json, bin };
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;
const add = (v: any, n: number) => (typeof v === "number" ? v + n : v);

/** Adds `n` to every texture reference ({ index: N }) found anywhere inside a material. */
function shiftTextureRefs(o: any, n: number) {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
        const v = o[k];
        if (v && typeof v === "object") {
            if (!Array.isArray(v) && typeof v.index === "number") v.index += n;
            shiftTextureRefs(v, n);
        }
    }
}

export function mergeGlbs(files: { name: string; data: Buffer }[]): Buffer {
    if (!files.length) throw new Error("Nothing to merge");
    const parsed = files.map((f) => parseGlb(f.data, f.name));
    const base = parsed[0];
    const J = base.json;
    for (const k of ["bufferViews", "accessors", "samplers", "images", "textures", "materials", "meshes", "nodes", "skins", "scenes"]) J[k] = J[k] ?? [];
    delete J.animations;
    let bin = base.bin;
    if (!J.scenes.length) { J.scenes.push({ nodes: J.nodes.map((_: any, i: number) => i) }); J.scene = 0; }
    const scene = J.scenes[J.scene ?? 0];
    scene.nodes = scene.nodes ?? [];
    const used = new Set<string>(J.extensionsUsed ?? []);
    const required = new Set<string>(J.extensionsRequired ?? []);

    for (const p of parsed.slice(1)) {
        const o = p.json;
        const bvOff = J.bufferViews.length, accOff = J.accessors.length, smpOff = J.samplers.length, imgOff = J.images.length;
        const texOff = J.textures.length, matOff = J.materials.length, meshOff = J.meshes.length, nodeOff = J.nodes.length, skinOff = J.skins.length;

        // 1) the binary data: appended after the data we already have (4-byte aligned)
        const gap = pad4(bin.length);
        const shift = bin.length + gap;
        bin = Buffer.concat([bin, Buffer.alloc(gap), p.bin]);

        for (const bv of o.bufferViews ?? []) J.bufferViews.push({ ...bv, buffer: 0, byteOffset: (bv.byteOffset ?? 0) + shift });
        for (const a of o.accessors ?? []) {
            const c = { ...a };
            if (c.bufferView !== undefined) c.bufferView = add(c.bufferView, bvOff);
            if (c.sparse) c.sparse = { ...c.sparse, indices: { ...c.sparse.indices, bufferView: add(c.sparse.indices.bufferView, bvOff) }, values: { ...c.sparse.values, bufferView: add(c.sparse.values.bufferView, bvOff) } };
            J.accessors.push(c);
        }
        for (const s of o.samplers ?? []) J.samplers.push({ ...s });
        for (const im of o.images ?? []) { const c = { ...im }; if (c.bufferView !== undefined) c.bufferView = add(c.bufferView, bvOff); J.images.push(c); }
        for (const t of o.textures ?? []) {
            const c = JSON.parse(JSON.stringify(t));
            c.source = add(c.source, imgOff); c.sampler = add(c.sampler, smpOff);
            for (const e of Object.values<any>(c.extensions ?? {})) if (e && typeof e.source === "number") e.source += imgOff;
            J.textures.push(c);
        }
        for (const m of o.materials ?? []) { const c = JSON.parse(JSON.stringify(m)); shiftTextureRefs(c, texOff); J.materials.push(c); }
        for (const m of o.meshes ?? []) {
            const c = JSON.parse(JSON.stringify(m));
            for (const pr of c.primitives ?? []) {
                for (const k of Object.keys(pr.attributes ?? {})) pr.attributes[k] += accOff;
                pr.indices = add(pr.indices, accOff); pr.material = add(pr.material, matOff);
                for (const t of pr.targets ?? []) for (const k of Object.keys(t)) t[k] += accOff;
            }
            J.meshes.push(c);
        }
        for (const s of o.skins ?? []) {
            const c = { ...s };
            c.inverseBindMatrices = add(c.inverseBindMatrices, accOff); c.skeleton = add(c.skeleton, nodeOff);
            c.joints = (c.joints ?? []).map((j: number) => j + nodeOff);
            J.skins.push(c);
        }
        for (const n of o.nodes ?? []) {
            const c = { ...n };
            delete c.camera;
            c.mesh = add(c.mesh, meshOff); c.skin = add(c.skin, skinOff);
            if (c.children) c.children = c.children.map((x: number) => x + nodeOff);
            J.nodes.push(c);
        }
        const oScene = o.scenes?.[o.scene ?? 0];
        const roots: number[] = oScene?.nodes ?? (o.nodes ?? []).map((_: any, i: number) => i);
        for (const r of roots) scene.nodes.push(r + nodeOff);
        for (const e of o.extensionsUsed ?? []) used.add(e);
        for (const e of o.extensionsRequired ?? []) required.add(e);
    }

    for (const k of ["bufferViews", "accessors", "samplers", "images", "textures", "materials", "meshes", "nodes", "skins"]) if (!J[k].length) delete J[k];
    if (used.size) J.extensionsUsed = [...used]; else delete J.extensionsUsed;
    if (required.size) J.extensionsRequired = [...required]; else delete J.extensionsRequired;
    J.buffers = [{ byteLength: bin.length + pad4(bin.length) }];

    const jsonBuf = Buffer.from(JSON.stringify(J), "utf8");
    const jsonPad = Buffer.alloc(pad4(jsonBuf.length), 0x20);
    const binPad = Buffer.alloc(pad4(bin.length));
    const jsonLen = jsonBuf.length + jsonPad.length, binLen = bin.length + binPad.length;
    const total = 12 + 8 + jsonLen + 8 + binLen;
    const head = Buffer.alloc(12); head.writeUInt32LE(MAGIC, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonLen, 0); jh.writeUInt32LE(JSON_CHUNK, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(binLen, 0); bh.writeUInt32LE(BIN_CHUNK, 4);
    return Buffer.concat([head, jh, jsonBuf, jsonPad, bh, bin, binPad]);
}
