import { isIP } from "node:net";

export function parseTrustedProxies(value = ""): string[] {
  if (!value.trim()) return [];
  const addresses = value.split(",").map((entry) => entry.trim());
  for (const address of addresses) {
    const parts = address.split("/");
    const family = isIP(parts[0]);
    if (!family || parts.length > 2)
      throw new Error(
        "TRUSTED_PROXY must contain IP addresses or CIDRs separated by commas",
      );
    if (
      parts.length === 2 &&
      (!/^\d+$/.test(parts[1]) ||
        Number(parts[1]) < 1 ||
        Number(parts[1]) > (family === 4 ? 32 : 128))
    ) {
      throw new Error(
        "TRUSTED_PROXY CIDR prefixes must be 1–32 for IPv4 or 1–128 for IPv6",
      );
    }
  }
  return [...new Set(addresses)];
}
