import { createHash } from "node:crypto";
import type { GeneratedMedia } from "../../core/provider.js";
import { GeminiWebError } from "./errors.js";

const MAX_MEDIA_ITEMS = 10;
const GOOGLE_IMAGE_HOST = "lh3.googleusercontent.com";
const GOOGLE_FULL_IMAGE_HOST = "lh3.google.com";
const MEDIA_DOWNLOAD_HOST = "contribution.usercontent.google.com";

/** Captured from the website's image ratio picker; values are packed field 56.1. */
export const GEMINI_IMAGE_RATIOS = Object.freeze({ "9:16": 59, "3:4": 60, "1:1": 61, "4:3": 62, "16:9": 63 });

export function validateGeminiMediaRatio(kind: "image" | "video", ratio?: string): void {
  if (ratio === undefined) return;
  if (kind === "image" ? !Object.hasOwn(GEMINI_IMAGE_RATIOS, ratio) : ratio !== "16:9" && ratio !== "9:16") {
    throw new GeminiWebError("invalid_request", "Unsupported Gemini media aspect ratio");
  }
}

/** Website media tool and ratio controls, expressed in the legacy JSPB request. */
export function applyGeminiMediaControls(payload: unknown[], kind: "image" | "video", ratio?: string): void {
  validateGeminiMediaRatio(kind, ratio);
  payload[49] = kind === "image" ? 14 : 11;
  if (kind === "image") {
    if (ratio) payload[55] = [[GEMINI_IMAGE_RATIOS[ratio as keyof typeof GEMINI_IMAGE_RATIOS]]];
  } else {
    payload[17] = [[1]];
    if (ratio) {
      const message = payload[0] as unknown[];
      const options: unknown[] = Array(7).fill(null);
      options[6] = [[null, null, null, ratio === "9:16" ? 2 : 1]];
      message[9] = options;
    }
  }
}

export interface GeminiCandidateMedia {
  media: GeminiGeneratedMedia[];
  mediaPresent: boolean;
  completionStatus?: number;
}

export interface GeminiGeneratedMedia extends GeneratedMedia {
  /** In-memory readiness probe only; never returned or persisted. */
  probeUrl?: string;
}

function nested(value: unknown, path: readonly number[]): unknown {
  let current = value;
  for (const index of path) {
    if (!Array.isArray(current)) return undefined;
    current = current[index];
  }
  return current;
}

function field(container: unknown, number: number): unknown {
  if (Array.isArray(container)) {
    const positional = container[number];
    if (positional !== undefined && positional !== null) return positional;
    const sparse = container.at(-1);
    if (sparse && typeof sparse === "object" && !Array.isArray(sparse)) {
      const sparseValue = (sparse as Record<string, unknown>)[String(number + 1)];
      if (sparseValue !== undefined && sparseValue !== null) return sparseValue;
    }
    return positional;
  }
  if (container && typeof container === "object") {
    const record = container as Record<string, unknown>;
    return record[String(number)] ?? record[String(number + 1)];
  }
  return undefined;
}

function stableId(kind: "image" | "video", identity: string): string {
  return createHash("sha256").update(`gemini:${kind}:${identity}`).digest("hex");
}

/** Keep website-supplied media links out of persisted sessions; accept only verified HTTPS origins. */
export function verifiedGeminiMediaURL(value: unknown, kind: "image" | "video"): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || authority.includes(":") || url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return undefined;
  if (kind === "video" && url.hostname === MEDIA_DOWNLOAD_HOST && url.pathname === "/download" &&
      validQuery(url.searchParams, ["c", "filename", "opi"])) {
    return url.toString();
  }
  if (kind === "image" && url.hostname === GOOGLE_FULL_IMAGE_HOST && /^\/rd-gg\//.test(url.pathname) && !url.search) {
    return url.toString();
  }
  if (kind === "image" && url.hostname === GOOGLE_IMAGE_HOST && /^\/gg\//.test(url.pathname) &&
      validQueryChoice(url.searchParams, [], ["alr"])) return url.toString();
  if (kind === "image" && url.hostname === GOOGLE_IMAGE_HOST && /^\/rd-gg\//.test(url.pathname) && !url.search) {
    return url.toString();
  }
  return undefined;
}

function validQuery(params: URLSearchParams, allowed: readonly string[]): boolean {
  const keys = [...params.keys()];
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length) return false;
  return [...params.values()].every(value => value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value));
}

function validQueryChoice(params: URLSearchParams, ...choices: readonly string[][]): boolean {
  return choices.some(keys => validQuery(params, keys));
}

export function geminiMediaURL(value: string, kind: "image" | "video"): URL {
  const safe = verifiedGeminiMediaURL(value, kind);
  if (!safe) throw new GeminiWebError("unsupported_capability", `Gemini ${kind} URL host or shape is not verified`);
  return new URL(safe);
}

function generatedImage(image: unknown, index: number, lineage: { conversationId?: string; replyId?: string; candidateId?: string }): GeminiGeneratedMedia | undefined {
  const previewURL = nested(image, [0, 3, 3]);
  const websiteId = nested(image, [1, 0]);
  if (typeof previewURL !== "string") return undefined;
  const url = verifiedGeminiMediaURL(previewURL, "image");
  const identity = typeof websiteId === "string" && websiteId.trim()
    ? `${lineage.conversationId ?? ""}:${lineage.replyId ?? ""}:${lineage.candidateId ?? ""}:${websiteId}`
    : `${lineage.conversationId ?? ""}:${lineage.replyId ?? ""}:${lineage.candidateId ?? ""}:${index}`;
  return {
    id: stableId("image", identity), type: "image", status: "unavailable",
    ...(url ? { url, status: "pending" as const } : {}),
    ...(url ? { probeUrl: previewURL } : {}),
  };
}

function generatedVideo(candidate: unknown, lineage: { conversationId?: string; replyId?: string; candidateId?: string }): GeneratedMedia | undefined {
  const videoInfo = nested(field(nested(candidate, [12]), 59), [0, 0, 0]);
  const urls = nested(videoInfo, [0, 7]);
  const primaryURL = Array.isArray(urls) && typeof urls[1] === "string" ? urls[1] : undefined;
  const alternateURL = nested(field(nested(candidate, [12]), 59), [0, 0, 8, 7, 1]);
  const url = (primaryURL && verifiedGeminiMediaURL(primaryURL, "video") && primaryURL) ||
    (typeof alternateURL === "string" && verifiedGeminiMediaURL(alternateURL, "video") ? alternateURL : undefined);
  if (!url && !primaryURL && typeof alternateURL !== "string") return undefined;
  const identity = `${lineage.conversationId ?? ""}:${lineage.replyId ?? ""}:${lineage.candidateId ?? ""}:0`;
  return { id: stableId("video", identity), type: "video", status: url ? "pending" : "unavailable", ...(url ? { url } : {}) };
}

/** Extract generated outputs only. Rich field 1 is retrieved web imagery and is intentionally ignored. */
export function extractGeminiCandidateMedia(
  candidate: unknown,
  lineage: { conversationId?: string; replyId?: string; candidateId?: string },
  requestedKind?: "image" | "video",
): GeminiCandidateMedia {
  if (!Array.isArray(candidate)) throw new GeminiWebError("invalid_response", "Invalid Gemini candidate media block", true);
  const statusValue = nested(candidate, [8, 0]);
  const completionStatus = Number.isSafeInteger(statusValue) ? Number(statusValue) : undefined;
  const rich = candidate[12];
  const generatedImages = requestedKind === "video" ? undefined : field(rich, 7);
  const videoField = requestedKind === "image" ? undefined : field(rich, 59);
  const selectedField = requestedKind === "video" ? videoField : generatedImages;
  const mediaPresent = selectedField !== undefined && selectedField !== null;
  if (mediaPresent && !Array.isArray(selectedField)) throw new GeminiWebError("invalid_response", "Invalid Gemini media field", true);
  const images = Array.isArray(generatedImages)
    ? generatedImages.length === 0 ? [] : Array.isArray(generatedImages[0]) ? generatedImages[0] : undefined
    : [];
  if (!images) throw new GeminiWebError("invalid_response", "Invalid Gemini generated image list", true);
  if (images.length > MAX_MEDIA_ITEMS) throw new GeminiWebError("invalid_response", "Gemini returned too many media items", true);
  const media = images.map((image, index) => generatedImage(image, index, lineage)).filter((item): item is GeminiGeneratedMedia => Boolean(item));
  const video = requestedKind === "image" ? undefined : generatedVideo(candidate, lineage);
  if (video) media.push(video);
  if (media.length > MAX_MEDIA_ITEMS) throw new GeminiWebError("invalid_response", "Gemini returned too many media items", true);
  return { media, mediaPresent, completionStatus };
}

export function pendingGeminiMedia(kind: "image" | "video", lineage: { conversationId?: string; replyId?: string; candidateId?: string }): GeneratedMedia {
  return { id: stableId(kind, `${lineage.conversationId ?? ""}:${lineage.replyId ?? ""}:${lineage.candidateId ?? ""}:pending`), type: kind, status: "pending" };
}
