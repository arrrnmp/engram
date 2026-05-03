import { createLogger, format, transports } from "winston";
import { join } from "path";
import { mkdirSync } from "fs";

const LOGS_DIR = join(import.meta.dir, "../../logs");
mkdirSync(LOGS_DIR, { recursive: true });

const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: "HH:mm:ss" }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const cleaned = Object.fromEntries(
      Object.entries(meta).map(([k, v]) =>
        v instanceof Error ? [k, { message: v.message, stack: v.stack }] : [k, v]
      )
    );
    const extra = Object.keys(cleaned).length ? " " + JSON.stringify(cleaned) : "";
    return `${timestamp} ${level} ${message}${extra}`;
  })
);

const fileFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }),
  format.json()
);

export const logger = createLogger({
  level: "info",
  transports: [
    new transports.Console({ format: consoleFormat }),
    new transports.File({ filename: join(LOGS_DIR, "error.log"), level: "error", format: fileFormat }),
    new transports.File({ filename: join(LOGS_DIR, "engram.log"), format: fileFormat }),
  ],
});
