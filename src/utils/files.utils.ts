import { v7 as uuid } from "uuid";
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Images are stored on Cloudinary at their original size (up to 10 MB each).
// Serving those originals to the app made decks with many pictures very
// slow to load. Cloudinary can resize/compress on the fly via the URL:
//   c_limit  -> never upscale, only shrink if wider than w_
//   w_1080   -> max width 1080px (plenty for a phone screen)
//   q_auto   -> automatic quality/compression
//   f_auto   -> best format for the device (WebP/AVIF instead of PNG/JPEG)
// The result is cached on Cloudinary's CDN after the first request.
const CLOUDINARY_IMAGE_TRANSFORM = "c_limit,f_auto,q_auto,w_1080";

function OptimizeCloudinaryImageUrl(url: string): string {
    const marker = "/image/upload/";
    const index = url.indexOf(marker);
    if (!url.includes("res.cloudinary.com") || index === -1) return url; // PDFs, other hosts

    const head = url.slice(0, index + marker.length);
    const tail = url.slice(index + marker.length);

    // Only touch plain URLs (path starts with the version, e.g. v1712345678/).
    // If a transformation is already present, leave it alone.
    if (!/^v\d+\//.test(tail)) return url;

    return `${head}${CLOUDINARY_IMAGE_TRANSFORM}/${tail}`;
}

export function GetFileUrl(name: string) {
    if (name.startsWith("http://") || name.startsWith("https://")) {
        return OptimizeCloudinaryImageUrl(name);
    }
    return `${process.env.PROTOCOL}://${process.env.HOST}:${process.env.PORT}/public/${name}`;
}

export function GetRandomNameForFile(file: Express.Multer.File) {
    const ext =
        file.originalname.split(".")[file.originalname.split(".").length - 1];
    return `${uuid()}.${ext}`;
}

export async function SaveFile(name: string, buffer: Buffer): Promise<string> {
    const isPdf = name.toLowerCase().endsWith(".pdf");
    const result = await new Promise<any>((resolve, reject) => {
        cloudinary.uploader
            .upload_stream(
                {
                    public_id: name,
                    resource_type: isPdf ? "raw" : "image",
                    folder: "soalix",
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                },
            )
            .end(buffer);
    });
    return result.secure_url;
}

export async function DeleteFile(name: string) {
    if (!name.startsWith("http")) return;
    const isPdf = name.toLowerCase().includes(".pdf");
    const matches = name.match(/soalix\/([^./]+)/);
    if (matches) {
        await cloudinary.uploader.destroy(`soalix/${matches[1]}`, {
            resource_type: isPdf ? "raw" : "image",
        });
    }
}
