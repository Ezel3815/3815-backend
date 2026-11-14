import { GetFileUrl, ToStoredFileName } from "./files.utils";

/**
 * Optional 360° photo set kept inside a card's `data`:
 *   data.spin = { side: "front" | "back", frames: [mediaName, ...], labels?: [{ frame, text }] }
 * `frames` holds Media names (same as front_image_name). Cards without it are unaffected.
 */
export const MAX_SPIN_FRAMES = 72;

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

export function SpinFrameNames(data: any): string[] {
    if (typeof data === "string" && !data.includes('"spin"') && !data.includes('\\"spin\\"'))
        return [];
    const f = asObject(data)?.spin?.frames;
    return Array.isArray(f) ? f.filter((x) => typeof x === "string" && x) : [];
}

/** Output: frame names -> full URLs (Cloudinary-resized), keeping the same shape as the input. */
export function WithSpinUrls<T>(data: T): T {
    const names = SpinFrameNames(data);
    if (!names.length) return data;
    const obj = asObject(data);
    obj.spin.frames = names.map(GetFileUrl);
    return (typeof data === "string" ? JSON.stringify(obj) : obj) as T;
}

/** Input: validates `spin` and stores frame names (undoing any URL the dashboard sent back). */
export function NormalizeSpin<T extends object>(data: T): T {
    const spin = (data as any)?.spin;
    if (spin === undefined || spin === null) {
        if (spin === null) delete (data as any).spin;
        return data;
    }
    if (
        typeof spin !== "object" ||
        !Array.isArray(spin.frames) ||
        spin.frames.some((f: any) => typeof f !== "string" || !f)
    )
        throw new Error("spin.frames must be a list of file names");
    if (spin.frames.length > MAX_SPIN_FRAMES)
        throw new Error(`spin.frames: at most ${MAX_SPIN_FRAMES} photos`);
    if (spin.frames.length < 2) {
        delete (data as any).spin; // one photo is not a spin; drop it
        return data;
    }
    spin.frames = spin.frames.map(ToStoredFileName);
    spin.side = spin.side === "back" ? "back" : "front";
    return data;
}
