import type { GeneratedMedia, MediaGenerationRequest } from "../../core/provider.js";
import { DoubaoWebError } from "./errors.js";

type JsonObject = Record<string, any>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new DoubaoWebError("invalid_response", "Invalid Doubao creation result", true);

export const DOUBAO_IMAGE_MODELS = ["Seedream 5.0 Flash", "Seedream 5.0 Pro", "Seedream 4.5", "Seedream 4.0"] as const;
export const DOUBAO_VIDEO_MODELS = ["Seedance 2.0 Fast", "Seedance 2.5", "Seedance 2.0", "Seedance 2.0 Mini"] as const;
export const DOUBAO_IMAGE_RATIOS = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"] as const;
export const DOUBAO_VIDEO_RATIOS = ["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "21:9"] as const;
export const DOUBAO_IMAGE_STYLES = {
  "人像摄影": "skill_image_styles_portrait", "电影写真": "skill_image_styles_film", "中国风": "skill_image_styles_chinese",
  "动漫": "skill_image_styles_japanese_anime", "3D渲染": "skill_image_styles_3d", "赛博朋克": "image_gen_style_cyberpunk",
  "CG 动画": "skill_image_styles_cg", "水墨画": "skill_image_styles_ink_wash_painting", "油画": "skill_image_styles_oil_painting",
  "古典": "skill_image_styles_classic", "水彩画": "skill_image_styles_watercolor", "卡通": "skill_image_styles_cartoon",
  "平面插画": "skill_image_styles_flat_illustration", "风景": "skill_image_styles_landscape", "港风动漫": "skill_image_styles_hongkong_anime",
  "像素风格": "skill_image_styles_pixel_style", "荧光绘画": "skill_image_styles_fluorescence", "彩铅画": "skill_image_styles_colored_pencil",
  "手办": "skill_image_styles_figure", "儿童绘画": "skill_image_styles_children_illustration", "抽象": "skill_image_styles_abstract",
  "锐笔插画": "skill_image_styles_sharp_illustration", "二次元": "skill_image_styles_acg", "油墨印刷": "skill_image_styles_ink_print",
  "版画": "skill_image_styles_bnw_printing", "莫奈": "skill_image_styles_monet", "毕加索": "skill_image_styles_picasso",
  "伦勃朗": "skill_image_styles_rembrandt", "马蒂斯": "skill_image_styles_matisse", "巴洛克": "skill_image_styles_baroque",
  "复古动漫": "skill_image_styles_oldschool", "绘本": "skill_image_styles_picturebook",
} as const;
const videoModels: Readonly<Record<typeof DOUBAO_VIDEO_MODELS[number], { value: string; maxDuration: number }>> = {
  "Seedance 2.0 Fast": { value: "seedance_v2.0", maxDuration: 15 },
  "Seedance 2.5": { value: "seedance_v2.5", maxDuration: 30 },
  "Seedance 2.0": { value: "seedance_v2.0_std", maxDuration: 15 },
  "Seedance 2.0 Mini": { value: "seedance_v2.0_mini", maxDuration: 15 },
};

/** Website-owned generation parameters observed on 2026-10-19; no signature generation. */
export function creationAbility(request: MediaGenerationRequest) {
  const model = request.model ?? (request.kind === "image" ? DOUBAO_IMAGE_MODELS[0] : DOUBAO_VIDEO_MODELS[0]);
  const videoModel = Object.hasOwn(videoModels, model) ? videoModels[model as keyof typeof videoModels] : undefined;
  const ratio = request.ratio ?? "auto";
  const ratios: readonly string[] = request.kind === "image" ? DOUBAO_IMAGE_RATIOS : DOUBAO_VIDEO_RATIOS;
  if (!["image", "video"].includes(request.kind) || !request.prompt.trim() || request.prompt.length > 10000 || !ratios.includes(ratio) ||
      (request.kind === "image" ? !(DOUBAO_IMAGE_MODELS as readonly string[]).includes(model) : !videoModel) ||
      (request.style !== undefined && (request.kind !== "image" || !Object.hasOwn(DOUBAO_IMAGE_STYLES, request.style))) ||
      (request.referenceImages !== undefined && (request.kind !== "image" || !Array.isArray(request.referenceImages) ||
        !request.referenceImages.length || request.referenceImages.length > 5 ||
        request.referenceImages.reduce((size, file) => size + (file?.buffer?.length ?? Infinity), 0) > 20 * 1024 * 1024)) ||
      (request.kind === "image" && request.durationSeconds !== undefined) ||
      (request.kind === "video" && (!Number.isInteger(request.durationSeconds ?? 4) || (request.durationSeconds ?? 4) < 4 || (request.durationSeconds ?? 4) > (videoModel?.maxDuration ?? 0)))) {
    throw new DoubaoWebError("invalid_request", "Invalid Doubao generation parameters");
  }
  const input = { user_input_content: request.prompt, reply_message_format: request.kind === "image" ? "生成图片：%s" : "生成视频：%s" };
  return request.kind === "image"
    ? { ability_type: 3, ability_param: JSON.stringify({ ability_type: 1, ability_param: { model, ratio,
        ...(request.style ? { style: DOUBAO_IMAGE_STYLES[request.style as keyof typeof DOUBAO_IMAGE_STYLES] } : {}), input_box_content: input } }) }
    : { ability_type: 17, ability_param: JSON.stringify({ model: videoModel!.value, ratio, duration: request.durationSeconds ?? 4,
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
