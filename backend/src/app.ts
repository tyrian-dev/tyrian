import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authRouter } from "./routes/auth";
import { keysRouter } from "./routes/keys";
import { gatewayRouter, handleGetQuota } from "./routes/gateway";
import { epochRouter } from "./routes/epoch";
import { treasuryRouter } from "./routes/treasury";
import { metricsRouter } from "./routes/metrics";
import { metricsService } from "./services/metrics";
import { indexerService } from "./services/indexer";
import { tyrianChainId, tyrianNetworkName } from "./config/network";

const app = new Hono();

const allowedOrigins = (process.env.FRONTEND_URL ?? "*")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const credentials = allowedOrigins[0] !== "*";

app.use("*", logger());

// Instrument HTTP metrics across all requests
app.use("*", async (c, next) => {
  await next();
  metricsService.recordHttpRequest(c.req.method, c.req.path, c.res.status);
});

app.use(
  "*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials,
  }),
);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "tyrian-ai-gateway",
    network: tyrianNetworkName,
    chainId: tyrianChainId,
  }),
);

// Ponder indexer health check & latency benchmark (IDX-007 / IDX-OPS-006)
app.get("/health/indexer", async (c) => {
  const status = await indexerService.getIndexerStatus();
  return c.json(status, status.healthy ? 200 : 503);
});

// Prometheus metrics endpoint at standard /metrics path
app.get("/metrics", async (c) => {
  const data = await metricsService.toPrometheusFormat();
  return c.text(data, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

// Mount Tyrian Gateway, Telemetry, and Auth Modules
app.route("/api/auth", authRouter);
app.route("/api/keys", keysRouter);
app.route("/api/epoch", epochRouter);
app.route("/api/treasury", treasuryRouter);
app.route("/api/metrics", metricsRouter);
app.get("/api/quota", handleGetQuota); // Alias adhering to Developer Brief §3 F4 (GAP-013)
app.route("/v1", gatewayRouter);

export { app };
export default app;
