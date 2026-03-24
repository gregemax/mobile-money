import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

import { transactionRoutes } from "./routes/transactions";
import { bulkRoutes } from "./routes/bulk";
import {
  transactionDisputeRoutes,
  disputeRoutes,
} from "./routes/disputes";
import { errorHandler } from "./middleware/errorHandler";
import { connectRedis, redisClient } from "./config/redis";
import { pool } from "./config/database";
import {
  globalTimeout,
  haltOnTimedout,
  timeoutErrorHandler,
} from "./middleware/timeout";
import {
  createQueueDashboard,
  getQueueHealth,
  pauseQueueEndpoint,
  resumeQueueEndpoint,
} from "./queue";
import { register } from "./utils/metrics";
import { metricsMiddleware } from "./middleware/metrics";
import { startJobs } from "./jobs/scheduler";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});

app.use(metricsMiddleware);
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(limiter);

app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/ready", async (req, res) => {
  const checks: Record<string, string> = {
    database: "down",
    redis: "down",
  };

  let allReady = true;

  try {
    await pool.query("SELECT 1");
    checks.database = "ok";
  } catch (err) {
    console.error("Database check failed", err);
    checks.database = "error";
    allReady = false;
  }

  try {
    if (redisClient?.isOpen) {
      await redisClient.ping();
      checks.redis = "ok";
    } else {
      checks.redis = "closed";
      allReady = false;
    }
  } catch (err) {
    console.error("Redis check failed", err);
    checks.redis = "error";
    allReady = false;
  }

  res.status(allReady ? 200 : 503).json({
    status: allReady ? "ready" : "not ready",
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.use(globalTimeout);
app.use(haltOnTimedout);

app.use("/api/transactions", transactionRoutes);
app.use("/api/transactions", transactionDisputeRoutes);
app.use("/api/transactions/bulk", bulkRoutes);
app.use("/api/disputes", disputeRoutes);

app.get("/health/queue", getQueueHealth);
app.post("/admin/queues/pause", pauseQueueEndpoint);
app.post("/admin/queues/resume", resumeQueueEndpoint);

app.use(timeoutErrorHandler);
app.use(errorHandler);

connectRedis()
  .then(() => {
    console.log("Redis initialized");
  })
  .catch((err) => {
    console.error("Failed to connect to Redis:", err);
    console.warn("Distributed locks will not be available");
  });

const queueRouter = createQueueDashboard();
app.use("/admin/queues", queueRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startJobs();
});
