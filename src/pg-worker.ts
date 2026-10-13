// The PostgreSQL connection lives on this thread. The server's thread hands it one statement at a
// time and sleeps until the answer is posted back, which is what lets the rest of the server
// treat PostgreSQL like the embedded database: one statement after another, in order.
import { workerData, type MessagePort } from "node:worker_threads";
import pg from "pg";

type Request = {
  op: "connect" | "begin" | "commit" | "rollback" | "close" | "exec" | "query" | "statistics";
  text?: string;
  values?: unknown[];
  tx?: boolean; // the server believes a transaction is open
  recover?: boolean;
  result?: "rows" | "first" | "count";
};

const { port, shared, url, schema } = workerData as {
  port: MessagePort;
  shared: SharedArrayBuffer;
  url: string;
  schema: string | null;
};
const flag = new Int32Array(shared);

// Values come back the way the embedded database gives them: integers and sums as numbers,
// and a comparison's result as 1 or 0.
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);
pg.types.setTypeParser(16, (value) => (value === "t" ? 1 : 0));

let client: pg.Client | null = null,
  open = false; // a transaction is open on this connection
// statements counts driver calls (a multi-command migration is one call).
const statistics = { statements: 0, queries: 0, transferredRows: 0 };
function execute(db: pg.Client, text: string, values?: unknown[]) {
  statistics.statements++;
  return db.query(text, values);
}

async function connect(patient: boolean) {
  for (let attempt = 0; ; attempt++) {
    const next = new pg.Client({ connectionString: url, application_name: "archipel" });
    // A dropped connection is replaced when the next statement arrives.
    next.on("error", () => {
      if (client === next) client = null;
    });
    try {
      await next.connect();
      if (schema) await next.query(`SET search_path TO "${schema}", public`);
      client = next;
      open = false;
      return;
    } catch (error) {
      await next.end().catch(() => {});
      // At startup the database may still be coming up beside the application.
      const starting = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "57P03"].includes(
        String((error as { code?: string }).code),
      );
      if (!patient || !starting || attempt >= 20) throw error;
      await new Promise((done) => setTimeout(done, 1500));
    }
  }
}

async function handle(request: Request) {
  if (request.op === "statistics") return { statistics: { ...statistics } };
  if (request.op === "close") {
    const last = client;
    client = null;
    await last?.end().catch(() => {});
    return {};
  }
  if (request.op === "connect") {
    await connect(true);
    return {};
  }
  if (!client) {
    // What was written before the connection dropped is gone with it; nothing may follow
    // as though it were still there.
    if (request.op === "rollback") return {};
    if (request.op === "commit" || request.tx)
      throw new Error("The database connection was lost during a transaction.");
    await connect(false);
  }
  const db = client!;
  if (request.op === "begin" || request.op === "commit" || request.op === "rollback") {
    await execute(db, request.op.toUpperCase());
    open = request.op === "begin";
    return {};
  }
  if (request.tx && !open)
    throw new Error("The database connection was lost during a transaction.");
  if (request.op === "exec") {
    await execute(db, request.text!);
    return {};
  }
  // A failed statement would leave the whole transaction refusing everything after it;
  // behind a savepoint only the statement is undone, as in the embedded database.
  const recover = open && request.recover !== false;
  if (recover) await execute(db, "SAVEPOINT statement");
  try {
    statistics.queries++;
    const result = await execute(db, request.text!, request.values);
    if (recover) await execute(db, "RELEASE SAVEPOINT statement");
    const rows = request.result === "count" ? [] : request.result === "first" ? result.rows.slice(0, 1) : result.rows;
    statistics.transferredRows += rows.length;
    return { rows, count: result.rowCount ?? 0 };
  } catch (error) {
    if (recover && client === db) {
      await execute(db, "ROLLBACK TO SAVEPOINT statement").catch(() => {});
      await execute(db, "RELEASE SAVEPOINT statement").catch(() => {});
    }
    throw error;
  }
}

port.on("message", (request: Request) => {
  void handle(request)
    .catch((error: Error & { code?: string; detail?: string }) => ({
      error: {
        message: String(error?.message || error),
        code: error?.code,
        detail: error?.detail,
      },
    }))
    .then((answer) => {
      port.postMessage(answer);
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    });
});
