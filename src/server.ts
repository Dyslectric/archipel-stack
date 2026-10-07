import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { createApp } from "./app.js";

const config = loadConfig();
const store = new Store(config.databasePath, config.baseUrl);
const app = createApp(config, store);
const federationTimer = setInterval(() => {
  void app.locals.federation
    .tick()
    .catch(() => console.error("Federation worker failed."));
}, 1000);
federationTimer.unref();
const server = app.listen(config.port, config.host, () => {
  console.log(`Archipel is running at ${config.baseUrl}`);
  console.log(
    config.devAuth
      ? "Local development accounts: alice (admin), bob, charlie."
      : "OIDC authentication mode.",
  );
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () =>
    server.close(() => {
      clearInterval(federationTimer);
      store.close();
      process.exit(0);
    }),
  );
}
server.on("error", (error) => {
  console.error(error.message);
  store.close();
  process.exit(1);
});
