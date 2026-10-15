import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { createApp } from "./app.js";

const config = loadConfig();
const store = new Store(config.databaseUrl || config.databasePath, config.baseUrl);
const app = createApp(config, store);
// Queued deliveries go out in rounds, as far apart as the instance's settings say.
let federationTimer: NodeJS.Timeout;
let federationJob: Promise<void> | undefined, stopping = false;
const federate = () => {
  clearTimeout(federationTimer);
  if (stopping) return;
  federationTimer = setTimeout(() => {
    federationJob = app.locals.federation
      .tick({wait:false})
      .catch(() => console.error("Federation worker failed."))
      .finally(() => { federationJob = undefined; federate(); });
  }, app.locals.federation.sending().interval);
  federationTimer.unref();
};
app.locals.federation.paceChanged = federate;
federate();
const pushTimer = setInterval(() => {
  void app.locals.push
    .tick()
    .catch(() => console.error("Notification worker failed."));
}, 1500);
pushTimer.unref();
const server = app.listen(config.port, config.host, () => {
  console.log(`Archipel Server is running at ${config.baseUrl}`);
  console.log(`Database: ${store.db.dialect === "postgres" ? "PostgreSQL" : "SQLite"}.`);
  console.log(
    config.devAuth
      ? "Local development accounts: alice (admin), bob, charlie."
      : "OIDC authentication mode.",
  );
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void (async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(federationTimer);
    clearInterval(pushTimer);
    await app.locals.federation.channelFeed.close();
    await federationJob;
    if (config.nativeChatUrl) {
      await app.locals.federation.tick({drainOnly:true})
        .catch(() => console.error("Federation drain failed during shutdown."));
    }
    // Event streams never finish by themselves, and the server waits for what is open.
    app.locals.events.close();
    server.close(() => {
      clearTimeout(federationTimer);
      clearInterval(pushTimer);
      store.close();
      process.exit(0);
    });
  })());
}
server.on("error", (error) => {
  console.error(error.message);
  store.close();
  process.exit(1);
});
