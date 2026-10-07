import { rmSync } from "node:fs";
import { dirname } from "node:path";
export default function cleanup() {
  const path = process.env.ARCHIPEL_E2E_DATABASE;
  if (path && dirname(path).includes("archipel-browser-"))
    rmSync(dirname(path), { recursive: true, force: true });
}
