import { Problem } from "./store.js";
export function decodeEmojiImage(encoded: unknown) {
  if (
    typeof encoded !== "string" ||
    encoded.length > 350000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    throw new Problem(
      400,
      "Upload a PNG, JPEG, GIF or WebP image up to 256 KiB.",
    );
  const image = Buffer.from(encoded, "base64");
  if (
    !image.length ||
    image.length > 262144 ||
    image.toString("base64") !== encoded
  )
    throw new Problem(400, "Invalid image or image exceeds 256 KiB.");
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
      "Only PNG, JPEG, GIF and WebP emoji images are supported.",
    );
  return { image, mime };
}
