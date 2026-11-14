import { GetFileUrl, ToStoredFileName } from "./files.utils";

/**
 * Optional 3D model kept inside a card's `data`:
 *   data.model = { side: "front" | "back", url: <Media name of a .glb file> }
 * "front" = shown with the question (and stays visible after the answer is revealed),
 * "back"  = shown only after the answer is revealed.
 * Cards without it are unaffected. Several cards may point at the same file.
 */
function asObject(data: any): any {
    let v = data;
    for (let i = 0; i < 3 && typeof v === "string"; i++) {
        try {
            v = JSON.parse(v);
        } catch {
            return null;
        }
    }
    return v && typeof v === "object" ? v : null;
}

export function ModelFileNames(data: any): string[] {
    if (typeof data === "string" && !data.includes("model")) return [];
    const u = asObject(data)?.model?.url;
    return typeof u === "string" && u ? [u] : [];
}

/** Output: stored name -> full URL, keeping the same shape as the input. */
export function WithModelUrl<T>(data: T): T {
    const names = ModelFileNames(data);
    if (!names.length) return data;
    const obj = asObject(data);
    obj.model.url = GetFileUrl(names[0]);
    return (typeof data === "string" ? JSON.stringify(obj) : obj) as T;
}

/** Input: validates `model` and stores the file name (undoing any URL the dashboard sent back). */
export function NormalizeModel<T extends object>(data: T): T {
    const m = (data as any)?.model;
    if (m === undefined) return data;
    if (m === null || m.url === null || m.url === "") {
        delete (data as any).model;
        return data;
    }
    if (typeof m !== "object" || typeof m.url !== "string" || m.url.length > 2048)
        throw new Error("model.url must be a file name or link");
    m.url = ToStoredFileName(m.url);
    m.side = m.side === "back" ? "back" : "front";
    return data;
}
