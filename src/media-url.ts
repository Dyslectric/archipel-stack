// Upload URLs are kept in messages as written. Browsers on other instances fetch them
// through their own authenticated API instead of sending cookies to the file's server.
export const mediaPath = /^\/media\/[A-Za-z0-9_-]{43}\.(png|jpg|gif|webp|mp4|webm|bin)$/;
export function mediaUrl(url: URL, origin: string) {
  if (origin && url.origin !== origin && mediaPath.test(url.pathname) &&
      !url.username && !url.password && !url.hash && !url.search &&
      ["http:", "https:"].includes(url.protocol))
    return new URL(`/api/media?url=${encodeURIComponent(url.href)}`, origin).href;
  return url.href;
}
