import path from "node:path";
import { createRuntime } from "./server.js";
const runtime = await createRuntime({
  dataDir:
    process.env.CUTUCIRCUITS_DATA_DIR ??
    path.resolve(import.meta.dirname, "../../../.cutucircuits-data"),
  port: Number(process.env.PORT ?? 4310),
  host: process.env.HOST ?? "127.0.0.1",
});
const server = await runtime.listen();
const address = server.address();
console.log(
  `Cutu Circuits runtime: http://${typeof address === "object" && address ? address.address : "127.0.0.1"}:${typeof address === "object" && address ? address.port : 4310}`,
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().then(
      () => {
        process.exitCode = 0;
      },
      (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  });
