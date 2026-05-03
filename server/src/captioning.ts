import { readFileSync } from "fs";
import { logger } from "./logger.js";

export interface CaptioningConfig {
  host: string;
  model: string;
  prompt: string;
  provider?: "auto" | "ollama" | "openai";
  fallbackHost?: string;
  fallbackModel?: string;
  fallbackProvider?: "ollama" | "openai";
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

function looksLikeOllamaHost(host: string): boolean {
  try {
    const url = new URL(host);
    return url.port === "11434" || /ollama/i.test(url.hostname);
  } catch {
    return false;
  }
}

function resolveProvider(host: string, provider: CaptioningConfig["provider"]): "ollama" | "openai" {
  if (provider === "ollama" || provider === "openai") return provider;
  return looksLikeOllamaHost(host) ? "ollama" : "openai";
}

type CaptionAttempt = {
  caption: string | null;
  noVision: boolean;
  reason: "ok" | "http_error" | "no_text" | "exception";
  detail?: string;
};

async function requestOpenAICaption(
  b64: string,
  filePath: string,
  mimeType: string,
  host: string,
  model: string,
  prompt: string,
): Promise<CaptionAttempt> {
  try {
    const endpoint = `${normalizeOpenAIHost(host)}/chat/completions`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}` } },
            { type: "text", text: prompt },
          ],
        }],
        max_tokens: 256,
        temperature: 0.7,
        top_p: 0.8,
        presence_penalty: 1.5,
        extra_body: {
          think: false,
          top_k: 20,
          min_p: 0.0,
          repetition_penalty: 1.0,
        },
      }),
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

async function requestOllamaCaption(
  b64: string,
  host: string,
  model: string,
  prompt: string,
): Promise<CaptionAttempt> {
  const base = host.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        images: [b64],
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.8,
          top_k: 20,
          min_p: 0.0,
          repeat_penalty: 1.0,
          presence_penalty: 1.5,
        },
      }),
    });
    if (!res.ok) {
      return { caption: null, noVision: false, reason: "http_error", detail: `${res.status} ${res.statusText}` };
    }
    const json = await res.json() as any;
    const caption = extractCaptionText(json.response ?? json.message?.content ?? json.output ?? json.output_text);
    if (caption) {
      if (hasNoVisionSignal(caption)) {
        return { caption: null, noVision: true, reason: "no_text", detail: "model returned non-vision refusal text" };
      }
      return { caption, noVision: false, reason: "ok" };
    }
    const noVisionHint = extractCaptionText(json.thinking ?? json.reasoning ?? json.response);
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

async function requestCaption(
  b64: string,
  filePath: string,
  mimeType: string,
  host: string,
  model: string,
  prompt: string,
  provider: "ollama" | "openai",
): Promise<CaptionAttempt> {
  if (provider === "ollama") {
    const ollamaAttempt = await requestOllamaCaption(b64, host, model, prompt);
    if (ollamaAttempt.caption || ollamaAttempt.reason !== "http_error") return ollamaAttempt;
    // Host might expose only OpenAI-compatible API; fallback in-process.
    return requestOpenAICaption(b64, filePath, mimeType, host, model, prompt);
  }
  return requestOpenAICaption(b64, filePath, mimeType, host, model, prompt);
}

export async function captionImage(
  filePath: string,
  mimeType: string,
  config: CaptioningConfig,
): Promise<string | null> {
  const data = readFileSync(filePath);
  const b64 = data.toString("base64");

  const primaryProvider = resolveProvider(config.host, config.provider);
  const primary = await requestCaption(
    b64,
    filePath,
    mimeType,
    config.host,
    config.model,
    config.prompt,
    primaryProvider,
  );
  if (primary.caption) return primary.caption;

  const fallbackHost = config.fallbackHost;
  if (fallbackHost) {
    const fallbackProvider = config.fallbackProvider ?? resolveProvider(fallbackHost, "auto");
    const fallbackModel = config.fallbackModel ?? config.model;
    logger.info(`[captioning] Retrying caption via fallback provider (${fallbackProvider}) for ${filePath}`);
    const fallback = await requestCaption(
      b64,
      filePath,
      mimeType,
      fallbackHost,
      fallbackModel,
      config.prompt,
      fallbackProvider,
    );
    if (fallback.caption) return fallback.caption;
    const fallbackDetail = fallback.detail ? ` (${fallback.detail})` : "";
    logger.warn(`[captioning] Fallback caption request failed for ${filePath}: ${fallback.reason}${fallbackDetail}`);
  }

  if (primary.noVision) {
    logger.warn(`[captioning] Model "${config.model}" appears to lack usable vision output at ${config.host}; no caption text for ${filePath}`);
    return null;
  }

  if (primary.reason === "http_error") {
    logger.warn(`[captioning] Caption request failed for ${filePath}: ${primary.detail ?? "http error"}`);
    return null;
  }
  if (primary.reason === "exception") {
    logger.warn(`[captioning] Caption request threw for ${filePath}: ${primary.detail ?? "unknown error"}`);
    return null;
  }
  logger.warn(`[captioning] Caption response had no usable text for ${filePath}${primary.detail ? ` (${primary.detail})` : ""}`);
  return null;
}
