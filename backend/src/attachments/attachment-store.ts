import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AttachmentSchema,
  type Attachment,
  type AttachmentDiagnostics,
  type AttachmentTextFallback,
} from "../contracts/attachments.js";

/** Validation limits + feature flags for the attachment store. */
export interface AttachmentConfig {
  enabled: boolean;
  allowedMimeTypes: string[];
  maxImageBytes: number;
  maxImageDimension: number;
  textFallbackMaxBase64Bytes: number;
  textFallbackMaxImageDimension: number;
  textFallbackPreferredMimeType: string;
}

/** Default limits, faithful to the original Nexus attachment store. */
export const DEFAULT_ATTACHMENT_CONFIG: AttachmentConfig = {
  enabled: true,
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  maxImageBytes: 5 * 1024 * 1024,
  maxImageDimension: 4096,
  textFallbackMaxBase64Bytes: 512 * 1024,
  textFallbackMaxImageDimension: 1280,
  textFallbackPreferredMimeType: "image/webp",
};

/** Scope used to authorize reads of an attachment within a turn. */
export interface AttachmentScope {
  threadId?: string;
  workspace?: string;
}

/** Input accepted by {@link AttachmentStore.put}. */
export interface AttachmentPutInput {
  name: string;
  data: Buffer;
  mimeType?: string;
  textFallback?: AttachmentTextFallback;
  threadId?: string;
  workspace?: string;
}

/** An attachment's metadata together with its raw bytes. */
export type AttachmentContent = Attachment & { data: Buffer };

export interface AttachmentStoreOptions {
  /** Base data directory; attachments live under `<dataDir>/attachments`. */
  dataDir: string;
  config?: AttachmentConfig;
  /** Clock override, mainly for tests. */
  nowIso?: () => string;
}

/** Result of magic-byte image sniffing. */
interface DetectedImage {
  mimeType: string;
  width?: number;
  height?: number;
}

/**
 * Content-addressed, on-disk store for image attachments. Ids are
 * `att_` + sha256(bytes).slice(0, 24). Bytes and JSON metadata are persisted
 * side by side under `<dataDir>/attachments/`. Faithful port of the original
 * Nexus `FileAttachmentStore`.
 */
export class AttachmentStore {
  private readonly rootDir: string;
  private readonly config: AttachmentConfig;
  private readonly nowIso: () => string;

  constructor(options: AttachmentStoreOptions) {
    this.rootDir = join(options.dataDir, "attachments");
    this.config = options.config ?? DEFAULT_ATTACHMENT_CONFIG;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  /**
   * Validate and persist `input.data`. If an attachment with the same content
   * hash already exists, its scope is widened (and text fallback refreshed)
   * rather than creating a duplicate.
   */
  async put(input: AttachmentPutInput): Promise<Attachment> {
    await mkdir(this.rootDir, { recursive: true });
    const image = detectImage(input.data);
    if (!image) throw new Error("unsupported image MIME type");
    if (input.mimeType && input.mimeType !== image.mimeType)
      throw new Error("declared MIME type does not match image content");
    if (!this.config.allowedMimeTypes.includes(image.mimeType))
      throw new Error(`image MIME type is not allowed: ${image.mimeType}`);
    if (input.data.byteLength > this.config.maxImageBytes)
      throw new Error(`image exceeds ${this.config.maxImageBytes} byte limit`);
    const maxDimension = Math.max(image.width ?? 0, image.height ?? 0);
    if (maxDimension > this.config.maxImageDimension) {
      throw new Error(`image exceeds ${this.config.maxImageDimension}px dimension limit`);
    }
    if (input.textFallback) validateTextFallback(input.textFallback, this.config);

    const hash = createHash("sha256").update(input.data).digest("hex");
    const id = `att_${hash.slice(0, 24)}`;
    const contentPath = this.contentPath(id);
    const metadataPath = this.metadataPath(id);
    const now = this.nowIso();

    const existing = await this.get(id);
    if (existing) {
      const next = mergeScope(
        {
          ...existing,
          ...(input.textFallback ? { textFallback: input.textFallback } : {}),
          updatedAt: now,
        },
        input,
      );
      await writeFile(contentPath, input.data);
      await writeFile(metadataPath, JSON.stringify(next, null, 2), "utf8");
      return next;
    }

    const metadata = AttachmentSchema.parse(
      mergeScope(
        {
          id,
          name: input.name,
          mimeType: image.mimeType,
          byteSize: input.data.byteLength,
          hash,
          ...(image.width ? { width: image.width } : {}),
          ...(image.height ? { height: image.height } : {}),
          ...(input.textFallback ? { textFallback: input.textFallback } : {}),
          threadIds: [],
          workspaces: [],
          createdAt: now,
          updatedAt: now,
        },
        input,
      ),
    );
    await writeFile(contentPath, input.data);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
    return metadata;
  }

  /**
   * Load attachment metadata by id, returning `null` if it is missing or
   * corrupt. When a `scope` is supplied, authorization is enforced.
   */
  async get(id: string, scope?: AttachmentScope): Promise<Attachment | null> {
    let metadata: Attachment;
    try {
      metadata = AttachmentSchema.parse(JSON.parse(await readFile(this.metadataPath(id), "utf8")));
    } catch {
      return null;
    }
    if (scope && !isAuthorized(metadata, scope)) {
      throw new Error(`attachment is not authorized for this turn: ${id}`);
    }
    return metadata;
  }

  /**
   * Load attachment metadata plus raw bytes. Throws if the attachment is
   * missing or not authorized for `scope`.
   */
  async getContent(id: string, scope: AttachmentScope): Promise<AttachmentContent> {
    const metadata = await this.get(id);
    if (!metadata) throw new Error(`attachment not found: ${id}`);
    if (!isAuthorized(metadata, scope))
      throw new Error(`attachment is not authorized for this turn: ${id}`);
    return {
      ...metadata,
      data: await readFile(this.contentPath(id)),
    };
  }

  /** Summary of the store's current state, used for diagnostics endpoints. */
  async diagnostics(): Promise<AttachmentDiagnostics> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir).catch(() => [] as string[]);
    const metadata = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) =>
          readFile(join(this.rootDir, entry), "utf8")
            .then((text) => AttachmentSchema.parse(JSON.parse(text)))
            .catch(() => null),
        ),
    );
    const records = metadata.filter((record): record is Attachment => Boolean(record));
    return {
      enabled: this.config.enabled,
      rootDir: this.rootDir,
      count: records.length,
      totalBytes: records.reduce((total, record) => total + record.byteSize, 0),
    };
  }

  /** Policy hints describing how text fallbacks should be produced. */
  textFallbackPolicy(): {
    textFallbackMaxBase64Bytes: number;
    textFallbackMaxImageDimension: number;
    textFallbackPreferredMimeType: string;
  } {
    return {
      textFallbackMaxBase64Bytes: this.config.textFallbackMaxBase64Bytes,
      textFallbackMaxImageDimension: this.config.textFallbackMaxImageDimension,
      textFallbackPreferredMimeType: this.config.textFallbackPreferredMimeType,
    };
  }

  private contentPath(id: string): string {
    return join(this.rootDir, `${id}.bin`);
  }

  private metadataPath(id: string): string {
    return join(this.rootDir, `${id}.json`);
  }
}

function mergeScope(metadata: Attachment, input: { threadId?: string; workspace?: string }): Attachment {
  return {
    ...metadata,
    threadIds: mergeUnique(metadata.threadIds, input.threadId),
    workspaces: mergeUnique(metadata.workspaces, input.workspace),
  };
}

function mergeUnique(values: string[], value?: string): string[] {
  return value && !values.includes(value) ? [...values, value] : values;
}

/**
 * An attachment with no recorded thread/workspace is globally readable;
 * otherwise the requesting scope must match one of the recorded ids.
 */
export function isAuthorized(metadata: Attachment, scope: AttachmentScope): boolean {
  if (metadata.threadIds.length === 0 && metadata.workspaces.length === 0) return true;
  if (scope.threadId && metadata.threadIds.includes(scope.threadId)) return true;
  if (scope.workspace && metadata.workspaces.includes(scope.workspace)) return true;
  return false;
}

function validateTextFallback(fallback: AttachmentTextFallback, config: AttachmentConfig): void {
  if (!config.allowedMimeTypes.includes(fallback.mimeType)) {
    throw new Error(`fallback image MIME type is not allowed: ${fallback.mimeType}`);
  }
  if (Buffer.byteLength(fallback.dataBase64, "utf8") > config.textFallbackMaxBase64Bytes) {
    throw new Error(`fallback image exceeds ${config.textFallbackMaxBase64Bytes} base64 byte limit`);
  }
  const maxDimension = Math.max(fallback.width ?? 0, fallback.height ?? 0);
  if (maxDimension > config.textFallbackMaxImageDimension) {
    throw new Error(`fallback image exceeds ${config.textFallbackMaxImageDimension}px dimension limit`);
  }
}

/**
 * Magic-byte image sniffing. PNG yields dimensions from the IHDR chunk; JPEG
 * and WEBP are recognized by their signatures only (dimensions omitted).
 */
function detectImage(buffer: Buffer): DetectedImage | null {
  if (
    buffer.length >= 24 &&
    buffer[0] === 137 &&
    buffer[1] === 80 &&
    buffer[2] === 78 &&
    buffer[3] === 71
  ) {
    return { mimeType: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return { mimeType: "image/jpeg" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp" };
  }
  return null;
}
