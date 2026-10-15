import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';

// Runs a generator inside the benchmark's network namespace. `docker run -i` has no
// Node IPC channel, so the harness's messages travel as JSON lines: stdin in, stdout
// out. The generator's own output goes to stderr to keep stdout for messages.
const child = fork(process.argv[2], [], { stdio: ['ignore', 2, 2, 'ipc'] });
child.on('message', message => process.stdout.write(JSON.stringify(message) + '\n'));
createInterface({ input: process.stdin }).on('line', line => {
  if (line && child.connected) child.send(JSON.parse(line));
}).on('close', () => { if (child.connected) child.disconnect(); });
child.on('exit', (code, signal) => process.stdout.write('', () => process.exit(code ?? (signal ? 1 : 0))));
process.once('SIGTERM', () => { child.kill(); process.exit(143); });
