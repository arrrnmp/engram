import { readFileSync } from "fs";
import sharp from "sharp";
import { logger } from "./logger.js";

let captionServerUnreachableLogged = false;

/** Max long-edge dimension for images sent to caption server.
 *  Qwen3.5-VL's vision encoder memory scales with image area;
 *  a 5.5K image can spike RAM to 10GB+. 1536px preserves detail
 *  while keeping memory under ~3GB. */
const CAPTION_MAX_IMAGE_DIM = 1536;

export async function preprocessImageForCaption(filePath: string, mimeType: string): Promise<Buffer> {
  if (!mimeType.startsWith("image/")) {
    return readFileSync(filePath);
  }

  try {
    const image = sharp(filePath);
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) {
      return readFileSync(filePath);
    }

    const maxDim = Math.max(metadata.width, metadata.height);
    if (maxDim <= CAPTION_MAX_IMAGE_DIM) {
      return readFileSync(filePath);
    }

    // Resize the longer edge to CAPTION_MAX_IMAGE_DIM, Lanczos3 for best detail retention
    const resized = await image
      .resize({
        width: metadata.width > metadata.height ? CAPTION_MAX_IMAGE_DIM : undefined,
        height: metadata.height >= metadata.width ? CAPTION_MAX_IMAGE_DIM : undefined,
        kernel: sharp.kernel.lanczos3,
        fastShrinkOnLoad: false,
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();

    logger.info(
      `[captioning] Resized image from ${metadata.width}x${metadata.height} ` +
      `→ max ${CAPTION_MAX_IMAGE_DIM}px (${(resized.length / 1024).toFixed(0)}KB)`
    );
    return resized;
  } catch (err) {
    logger.debug(
      `[captioning] Image resize skipped (sharp could not parse), using original: ${err instanceof Error ? err.message : String(err)}`
    );
    return readFileSync(filePath);
  }
}

export interface CaptioningConfig {
  host: string;
  model?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  think?: boolean;
  extraBody?: Record<string, unknown>;
}

function extractCaptionText(content: unknown, depth = 0): string | null {
  if (depth > 5 || content === null || content === undefined) return null;

  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(content)) {
    const parts = content
      .flatMap((part) => extractCaptionText(part, depth + 1) ?? [])
      .join(" ")
      .trim();
    return parts.length > 0 ? parts : null;
  }

  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    const candidateFields = [
      obj.text,
      obj.content,
      obj.response,
      obj.output_text,
      obj.output,
      obj.message,
      obj.delta,
    ];

    for (const candidate of candidateFields) {
      const extracted = extractCaptionText(candidate, depth + 1);
      if (extracted) return extracted;
    }
  }

  return null;
}

function hasNoVisionSignal(text: string): boolean {
  return /(cannot (see|view).{0,30}image|unable to (see|view).{0,30}image|only text-based|no actual image|please upload.{0,30}image|image (is )?(missing|not provided))/i.test(text);
}

function normalizeOpenAIHost(host: string): string {
  const trimmed = host.replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

type CaptionAttempt = {
  caption: string | null;
  noVision: boolean;
  reason: "ok" | "http_error" | "no_text" | "exception";
  detail?: string;
};

function buildRequestBody(
  b64: string,
  mimeType: string,
  config: CaptioningConfig,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model ?? "",
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}` } },
        { type: "text", text: config.prompt },
      ],
    }],
    max_tokens: config.maxTokens ?? 256,
    temperature: config.temperature ?? 0.7,
    top_p: config.topP ?? 0.8,
    presence_penalty: config.presencePenalty ?? 1.5,
    top_k: config.topK ?? 20,
    min_p: config.minP ?? 0.0,
    repetition_penalty: config.repetitionPenalty ?? 1.0,
    think: config.think ?? false,
  };

  if (config.extraBody && typeof config.extraBody === "object") {
    for (const [key, value] of Object.entries(config.extraBody)) {
      body[key] = value;
    }
  }

  return body;
}

async function requestCaption(
  b64: string,
  filePath: string,
  mimeType: string,
  config: CaptioningConfig,
): Promise<CaptionAttempt> {
  try {
    const endpoint = `${normalizeOpenAIHost(config.host)}/chat/completions`;
    const body = buildRequestBody(b64, mimeType, config);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      return { caption: null, noVision: false, reason: "http_error", detail: `${res.status} ${res.statusText}` };
    }

    const json = await res.json() as any;
    const caption = extractCaptionText(
      json.choices?.[0]?.message?.content
      ?? json.choices?.[0]?.text
      ?? json.choices?.[0]?.message
      ?? json.message?.content
      ?? json.message
      ?? json.response
      ?? json.output_text
      ?? json.output
    );
    if (caption) {
      if (hasNoVisionSignal(caption)) {
        return { caption: null, noVision: true, reason: "no_text", detail: "model returned non-vision refusal text" };
      }
      return { caption, noVision: false, reason: "ok" };
    }

    const noVisionHint = extractCaptionText(
      json.choices?.[0]?.message?.reasoning
      ?? json.choices?.[0]?.message?.reasoning_content
      ?? json.choices?.[0]?.message?.thinking
      ?? json.thinking
    );
    const keys = json && typeof json === "object"
      ? Object.keys(json as Record<string, unknown>).slice(0, 8).join(", ")
      : typeof json;
    return {
      caption: null,
      noVision: !!(noVisionHint && hasNoVisionSignal(noVisionHint)),
      reason: "no_text",
      detail: `keys: ${keys || "none"}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { caption: null, noVision: false, reason: "exception", detail: msg };
  }
}

export async function isCaptionServerReachable(host: string): Promise<boolean> {
  try {
    const url = `${normalizeOpenAIHost(host)}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "", messages: [] }),
      signal: AbortSignal.timeout(3000),
    });
    // Any response (even 4xx) means the server is reachable; connection refused throws.
    return true;
  } catch {
    return false;
  }
}

export async function captionImage(
  filePath: string,
  mimeType: string,
  config: CaptioningConfig,
): Promise<string | null> {
  if (!captionServerUnreachableLogged) {
    const reachable = await isCaptionServerReachable(config.host);
    if (!reachable) {
      captionServerUnreachableLogged = true;
      logger.warn(
        `[captioning] Caption server not reachable at ${config.host}. ` +
        `Ensure the caption server is running (run \`bun run start\` or start it manually). ` +
        `Image captions will fall back to filenames.`
      );
      return null;
    }
  }

  const data = await preprocessImageForCaption(filePath, mimeType);
  const b64 = data.toString("base64");

  const result = await requestCaption(b64, filePath, mimeType, config);
  if (result.caption) return result.caption;

  if (result.noVision) {
    logger.warn(`[captioning] Model appears to lack usable vision output at ${config.host}; no caption text for ${filePath}`);
    return null;
  }

  if (result.reason === "http_error") {
    logger.warn(`[captioning] Caption request failed for ${filePath}: ${result.detail ?? "http error"}`);
    return null;
  }
  if (result.reason === "exception") {
    const isConnectionError = result.detail?.toLowerCase().includes("unable to connect") ?? false;
    if (isConnectionError && !captionServerUnreachableLogged) {
      captionServerUnreachableLogged = true;
      logger.warn(
        `[captioning] Caption server not reachable at ${config.host}. ` +
        `Ensure the caption server is running (run \`bun run start\` or start it manually). ` +
        `Image captions will fall back to filenames.`
      );
    } else if (!isConnectionError) {
      logger.warn(`[captioning] Caption request threw for ${filePath}: ${result.detail ?? "unknown error"}`);
    }
    return null;
  }
  logger.warn(`[captioning] Caption response had no usable text for ${filePath}${result.detail ? ` (${result.detail})` : ""}`);
  return null;
}
