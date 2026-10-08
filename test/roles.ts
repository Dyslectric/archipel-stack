import { permissions, type Permission, type Store, type User } from "../src/store.js";

// Gives an account a role with exactly these grants on top of what every role starts with.
export function grant(
  store: Store,
  admin: User,
  id: string,
  flags: Partial<Record<Permission, boolean>>,
) {
  const name = `test ${permissions.map((p) => (flags[p] === undefined ? "-" : Number(flags[p]))).join("")}`;
  const role =
    store.roles(admin).find((r) => r.name === name) ||
    store.createRole(admin, { name, ...flags });
  return store.setUserRole(admin, id, role.id);
}
