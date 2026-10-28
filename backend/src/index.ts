import { serve } from "@hono/node-server";
import "dotenv/config";
import app from "./app";
import { protocolScheduler } from "./cron/scheduler";
import { assertRuntimeConfig } from "./config/validate";

assertRuntimeConfig();

const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
console.log(`Tyrian AI Gateway Backend berjalan di http://localhost:${port}`);

if (process.env.DISABLE_SCHEDULER !== "true") {
  protocolScheduler.start();
}

if (!process.env.DATABASE_URL) {
  console.log(
    "DATABASE_URL belum diisi. Endpoint database tidak aktif; /health tetap jalan.",
  );
}
