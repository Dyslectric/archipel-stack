// Holds event-stream sockets handed over by the server and writes the frames it
// is told to. Who may see what is decided entirely by the server: this process
// only copies prepared bytes to the sockets named for them, so the writing for
// many readers can run on other cores than the API.
import type { Socket } from "node:net";

type Message =
  | { type: "write"; chunks: Uint8Array[]; targets: Int32Array[] }
  | { type: "end"; ids: number[] };

const sockets = new Map<number, Socket>();
const LIMIT = 1024 * 1024; // a reader this far behind is let go, as the server would
const closed = (id: number) => {
  if (!sockets.delete(id)) return;
  process.send?.({ type: "closed", id });
};

process.on("message", (message: Message | { type: "adopt"; id: number }, handle?: Socket) => {
  if (message.type === "adopt") {
    if (!handle) return void process.send?.({ type: "closed", id: message.id });
    const id = message.id;
    sockets.set(id, handle);
    handle.setNoDelay(true);
    handle.on("close", () => closed(id));
    handle.on("error", () => handle.destroy());
    // Nothing is expected from a reader; whatever arrives is discarded.
    handle.on("data", () => {});
    return;
  }
  if (message.type === "write") {
    for (let i = 0; i < message.chunks.length; i++) {
      const chunk = message.chunks[i];
      for (const id of message.targets[i]) {
        const socket = sockets.get(id);
        if (!socket) continue;
        if (socket.writableLength > LIMIT) { socket.destroy(); continue; }
        socket.write(chunk);
      }
    }
    return;
  }
  if (message.type === "end")
    for (const id of message.ids) sockets.get(id)?.end("0\r\n\r\n");
});
process.on("disconnect", () => process.exit(0));
