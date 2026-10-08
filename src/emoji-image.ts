import { Problem } from "./store.js";
export function decodeEmojiImage(encoded: unknown) {
  return decodeRasterImage(encoded, 262144, "emoji");
}
export function decodeRasterImage(encoded: unknown, maxBytes: number, label: string) {
  const limit = maxBytes >= 1048576 ? `${maxBytes / 1048576} MiB` : `${maxBytes / 1024} KiB`;
  if (
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    throw new Problem(
      400,
      `Upload a PNG, JPEG, GIF or WebP image up to ${limit}.`,
    );
  const image = Buffer.from(encoded, "base64");
  if (
    !image.length ||
    image.length > maxBytes ||
    image.toString("base64") !== encoded
  )
    throw new Problem(400, `Invalid image or image exceeds ${limit}.`);
  let mime = "";
  if (
    image.length >= 24 &&
    image
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    image.toString("ascii", 12, 16) === "IHDR"
  )
    mime = "image/png";
  else if (
    image.length >= 4 &&
    image[0] === 255 &&
    image[1] === 216 &&
    image[2] === 255
  )
    mime = "image/jpeg";
  else if (
    image.length >= 13 &&
    ["GIF87a", "GIF89a"].includes(image.toString("ascii", 0, 6))
  )
    mime = "image/gif";
  else if (
    image.length >= 20 &&
    image.toString("ascii", 0, 4) === "RIFF" &&
    image.toString("ascii", 8, 12) === "WEBP"
  )
    mime = "image/webp";
  if (!mime)
    throw new Problem(
      400,
      `Only PNG, JPEG, GIF and WebP ${label} images are supported.`,
    );
  return { image, mime };
}
