import { mkdir, writeFile, rename, rm, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_RENAME_RETRY_ATTEMPTS = 6;
const DEFAULT_RENAME_RETRY_BASE_DELAY_MS = 25;
const RETRYABLE_RENAME_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

interface RenameRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

interface AtomicWriteOptions {
  renameRetry?: RenameRetryOptions;
}

const delay = (ms: number): Promise<void> => {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/** Write a file via a unique temp file + atomic rename, with retry on transient errors. */
export async function atomicWriteFile(path: string, contents: string, options: AtomicWriteOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, contents, "utf-8");
    try {
      await renameWithRetry(tmp, path, options.renameRetry);
    } catch (error) {
      if (!shouldFallbackToDirectWrite(error)) {
        throw error;
      }
      await writeFile(path, contents, "utf-8");
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await rm(tmp, { force: true }).catch(() => undefined);
}

async function renameWithRetry(from: string, to: string, options?: RenameRetryOptions): Promise<void> {
  const attempts = Math.max(1, Math.floor(options?.attempts ?? DEFAULT_RENAME_RETRY_ATTEMPTS));
  const baseDelayMs = Math.max(0, Math.floor(options?.baseDelayMs ?? DEFAULT_RENAME_RETRY_BASE_DELAY_MS));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !isRetryableRenameError(error)) {
        throw error;
      }
      await delay(baseDelayMs * attempt);
    }
  }
}

function isRetryableRenameError(error: unknown): boolean {
  return RETRYABLE_RENAME_ERROR_CODES.has(String((error as NodeJS.ErrnoException)?.code ?? ""));
}

function shouldFallbackToDirectWrite(error: unknown): boolean {
  return process.platform === "win32" && isRetryableRenameError(error);
}

/** Append a single JSONL line to a file, creating parent dirs as needed. */
export async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf-8");
}
