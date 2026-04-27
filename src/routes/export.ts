import { Router, Request, Response } from "express";
import { rateLimitExport as exportRateLimiter } from "../middleware/rateLimit";
import QueryStream from "pg-query-stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import ExcelJS from "exceljs";
import { pool } from "../config/database";
import { requireAuth } from "../middleware/auth";
import { TransactionStatus } from "../models/transaction";

  if (scopedUserId) {
    filters.userId = scopedUserId;
  }

  const { text, values } = buildTransactionExportQuery(filters);

  client = await db.connect();
  const queryStream = createQueryStream(text, values);
  const rowStream = client.query(queryStream);

  const format = req.query.format === "json" ? "json" : "csv";
  const filename = `transactions-${new Date().toISOString().slice(0, 10)}.${format}`;

  res.status(200);
  res.setHeader(
    "Content-Type",
    format === "json" ? "application/json" : "text/csv; charset=utf-8",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );

  let transform: Transform;

  if (format === "csv") {
    res.write(`${CSV_HEADERS.join(",")}\n`);
    transform = new Transform({
      objectMode: true,
      transform(chunk: Record<string, unknown>, _encoding, callback) {
        callback(null, transactionRowToCsv(chunk));
      },
    });
  } else {
    let first = true;
    res.write("[\n");
    transform = new Transform({
      objectMode: true,
      transform(chunk: Record<string, unknown>, _encoding, callback) {
        const data =
          (first ? "" : ",\n") + JSON.stringify(chunk, null, 2);
        first = false;
        callback(null, data);
      },
      flush(callback) {
        res.write("\n]");
        callback();
      },
    });
  }

  res.on("close", () => {
    if ("destroy" in rowStream && typeof rowStream.destroy === "function") {
      rowStream.destroy();
    }
    releaseClient();
  });

  const sheet = workbook.addWorksheet("Transactions");
  sheet.addRow(CSV_HEADERS).commit();

  for await (const row of rowStream as AsyncIterable<Record<string, unknown>>) {
    sheet.addRow(transactionRowToWorksheetRow(row)).commit();
  }

  sheet.commit();
  await workbook.commit();
}

const exportRateLimiterMiddleware = exportRateLimiter;

export function createExportRoutes(
  dependencies: ExportRouteDependencies = {},
): Router {
  const router = Router();
  const db = dependencies.db ?? pool;
  const createQueryStream =
    dependencies.createQueryStream ?? defaultQueryStreamFactory;

  router.get(
    "/export",
    exportRateLimiterMiddleware,
    requireAuth,
    async (req: Request, res: Response) => {
      let client: QueryableClient | null = null;
      let released = false;

    const releaseClient = () => {
      if (client && !released) {
        released = true;
        client.release();
      }
    };

    try {
      const filters = parseTransactionExportFilters(req.query);
      const { text, values } = buildTransactionExportQuery(filters);

      client = await db.connect();
      const queryStream = createQueryStream(text, values);
      const rowStream = client.query(queryStream);

      const format = req.query.format === "json" ? "json" : "csv";
      const filename = `transactions-${new Date().toISOString().slice(0, 10)}.${format}`;

      res.status(200);
      res.setHeader("Content-Type", format === "json" ? "application/json" : "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );

      let transform: Transform;
      if (format === "csv") {
        res.write(`${CSV_HEADERS.join(",")}\n`);
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _encoding, callback) {
            callback(null, transactionRowToCsv(chunk));
          },
        });
      } else {
        let first = true;
        res.write("[\n");
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _encoding, callback) {
            const data = (first ? "" : ",\n") + JSON.stringify(chunk, null, 2);
            first = false;
            callback(null, data);
          },
          flush(callback) {
            res.write("\n]");
            callback();
          },
        });
      }

      res.on("close", () => {
        if ("destroy" in rowStream && typeof rowStream.destroy === "function") {
          rowStream.destroy();
        }
        releaseClient();
      });

      await pipeline(rowStream, transform, res);
      releaseClient();
    } catch (error) {
      releaseClient();
      const message =
        error instanceof Error ? error.message : "Failed to export transactions";
      const statusCode = message.startsWith("Invalid") ? 400 : 500;
      if (!res.headersSent) {
        res.status(statusCode).json({ error: message });
      } else {
        console.error("Error after headers sent:", message);
        res.end();
      }
    }
  });
}