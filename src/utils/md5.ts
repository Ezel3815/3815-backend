import { createHash } from "crypto";

/** Same result as the `md5` npm package for strings (hex of the UTF-8 bytes), but uses Node's built-in crypto: no extra package to install. */
export function md5(value: string): string {
    return createHash("md5").update(value, "utf8").digest("hex");
}
