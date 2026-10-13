pub fn mime(image: &[u8]) -> Option<&'static str> {
    if image.len() >= 24
        && image.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
        && &image[12..16] == b"IHDR"
    {
        Some("image/png")
    } else if image.len() >= 4 && image.starts_with(&[255, 216, 255]) {
        Some("image/jpeg")
    } else if image.len() >= 13 && (image.starts_with(b"GIF87a") || image.starts_with(b"GIF89a")) {
        Some("image/gif")
    } else if image.len() >= 20 && image.starts_with(b"RIFF") && &image[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
