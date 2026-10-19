import type { GeneratedMedia, MediaGenerationRequest } from "../../core/provider.js";
import { DoubaoWebError } from "./errors.js";

type JsonObject = Record<string, any>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new DoubaoWebError("invalid_response", "Invalid Doubao creation result", true);

/** Website-owned generation parameters observed on 2026-10-19; no signature generation. */
export function creationAbility(request: MediaGenerationRequest) {
  const ratio = request.ratio ?? "auto";
  const ratios = request.kind === "image" ? ["auto", "1:1"] : ["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "21:9"];
  if (!["image", "video"].includes(request.kind) || !request.prompt.trim() || request.prompt.length > 10000 || !ratios.includes(ratio) ||
      (request.kind === "image" && request.durationSeconds !== undefined) ||
      (request.kind === "video" && (!Number.isInteger(request.durationSeconds ?? 4) || (request.durationSeconds ?? 4) < 4 || (request.durationSeconds ?? 4) > 30))) {
    throw new DoubaoWebError("invalid_request", "Invalid Doubao generation parameters");
  }
  const input = { user_input_content: request.prompt, reply_message_format: request.kind === "image" ? "生成图片：%s" : "生成视频：%s" };
  return request.kind === "image"
    ? { ability_type: 3, ability_param: JSON.stringify({ ability_type: 1, ability_param: { model: "Seedream 5.0 Flash", ratio, input_box_content: input } }) }
    : { ability_type: 17, ability_param: JSON.stringify({ model: "seedance_v2.5", ratio, duration: request.durationSeconds ?? 4,
        camera_movement: "fixed", input_box_content: input }) };
}

function mediaURL(value: unknown, type: "image" | "video"): string {
  if (typeof value !== "string" || value.length > 8192) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const host = type === "image" ? /^p\d+-flow-imagex-sign\.byteimg\.com$/ : /^v\d+-vdl\.doubao\.com$/;
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !host.test(url.hostname) ||
      [...url.searchParams.keys()].some(key => /cookie|sessionid|csrf/i.test(key))) throw invalid();
  return url.href;
}

function dimension(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const result = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result <= 0 || result > 65536) throw invalid();
  return result;
}

/** Only a real creation card is evidence of generation; prose never is. */
export function creationMedia(value: unknown): GeneratedMedia[] {
  if (!object(value) || !Array.isArray(value.creations) || value.creations.length > 20) throw invalid();
  const seen = new Set<string>();
  return value.creations.map((creation: unknown) => {
    if (!object(creation) || typeof creation.id !== "string" || !creation.id.trim() || creation.id.length > 256 || seen.has(creation.id) ||
        ![1, 2].includes(creation.type)) throw invalid();
    seen.add(creation.id);
    const type = creation.type === 1 ? "image" : "video";
    const resource = creation[type];
    if (!object(resource) || !Number.isInteger(resource.status)) throw invalid();
    const completed = type === "image" ? resource.status === 2 : resource.status === 3;
    // Other website statuses are deliberately not interpreted as successful generation.
    const status = completed ? "completed" : type === "image" && resource.status === 1 ? "pending" : "unavailable";
    if (!completed) return { type, status };
    const image = resource.image_ori;
    if (type === "image" && !object(image)) throw invalid();
    const result: GeneratedMedia = { type, status, url: mediaURL(type === "image" ? image.url : resource.download_url, type),
      width: dimension(type === "image" ? image.width : resource.width), height: dimension(type === "image" ? image.height : resource.height) };
    if (type === "video" && resource.duration !== undefined) {
      if (typeof resource.duration !== "number" || !Number.isFinite(resource.duration) || resource.duration <= 0) throw invalid();
      result.durationSeconds = resource.duration;
    }
    return result;
  });
}
