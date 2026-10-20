import { ProviderError } from "../../core/provider.js";

export interface GeminiModel {
  modelId: string;
  modelName: string;
  displayName: string;
  description: string;
  capacity: number;
  capacityField: 12 | 13;
  modelNumber: number;
  available: boolean;
  selectable: boolean;
}

export interface GeminiModelCatalog {
  accountStatus: number | null;
  capacity: number;
  capacityField: 12 | 13;
  models: GeminiModel[];
}

/** A UI-verified option; wireValue is supplied by observed account/request metadata. */
export interface GeminiThinkingOption {
  id: string;
  label: string;
  /** Exact numeric value captured from the account's current website request. */
  wireValue: number;
}

/**
 * Observed in L5adhe preference writes [0][264] and the current generation
 * protobuf field 81 (legacy StreamGenerate JSPB slot 80). No preference is changed here.
 */
export const GEMINI_THINKING_LEVELS = Object.freeze([
  Object.freeze({ id: "low", label: "Low", preferenceValue: 1 }),
  Object.freeze({ id: "medium", label: "Medium", preferenceValue: 4 }),
  Object.freeze({ id: "high", label: "High", preferenceValue: 2 }),
] as const);

export interface GeminiEncodedSelection {
  headers: Record<string, string>;
  payloadPatch: { 59: string; 79: number; 80: number };
}

const MAX_MODELS = 64;
const MODEL_ID = /^[a-f0-9]{8,64}$/i;
const REQUEST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code: string, message: string) => new ProviderError(message, code);

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  return text;
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function flagArray(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 256 || value.some(item => !integer(item, 0, 1_000_000))) {
    throw fail("invalid_response", "Gemini model discovery returned invalid account capability flags");
  }
  return value;
}

/** Derive the account-specific model capacity from the observed status flag fields. */
export function computeGeminiCapacity(tierFlags: readonly number[], capabilityFlags: readonly number[]): {
  capacity: number;
  capacityField: 12 | 13;
} {
  if (tierFlags.includes(21)) return { capacity: 1, capacityField: 13 };
  if (tierFlags.includes(22)) return { capacity: 2, capacityField: 13 };
  if (capabilityFlags.includes(115)) return { capacity: 4, capacityField: 12 };
  if (tierFlags.includes(16) || capabilityFlags.includes(106)) return { capacity: 3, capacityField: 12 };
  if (tierFlags.includes(8) || capabilityFlags.includes(19)) return { capacity: 2, capacityField: 12 };
  return { capacity: 1, capacityField: 12 };
}

function modelName(category: string | undefined, displayName: string | undefined, modelId: string): string {
  const source = category || displayName || modelId;
  const slug = source.toLowerCase().trim().replace(/\s+/g, "-");
  return slug.startsWith("gemini-") ? slug : `gemini-${slug}`;
}

/** Parse the decoded GET_USER_STATUS body. `partBody` is the JSON at wrb.fr[2]. */
export function parseGeminiModels(partBody: unknown): GeminiModelCatalog {
  if (!Array.isArray(partBody) || !(partBody[14] === null || integer(partBody[14], 0, 100_000)) ||
      !Array.isArray(partBody[15]) || partBody[15].length > MAX_MODELS) {
    throw fail("invalid_response", "Gemini model discovery returned an unexpected account status payload");
  }
  const accountStatus = partBody[14] as number | null;
  if (accountStatus !== null && accountStatus !== 1000) {
    throw fail("access_denied", "Gemini account status does not permit selecting models");
  }
  const { capacity, capacityField } = computeGeminiCapacity(flagArray(partBody[16]), flagArray(partBody[17]));
  // The caller first verifies authenticated email in the HTML context. Some logged-in
  // sessions legitimately return null here; status 1000 is the explicit available code.
  const available = accountStatus === null || accountStatus === 1000;
  const models: GeminiModel[] = [];
  for (const item of partBody[15]) {
    if (!Array.isArray(item) || !item.length) throw fail("invalid_response", "Gemini model discovery contains a malformed model entry");
    const modelId = safeText(item[0], 128);
    if (!modelId || !MODEL_ID.test(modelId)) throw fail("invalid_response", "Gemini model discovery contains an invalid model ID");
    const categoryName = safeText(item[1], 128) ?? safeText(item[10], 128);
    const displayName = safeText(item[11], 160) ?? safeText(item[19], 160) ?? categoryName ?? modelId;
    const description = safeText(item[12], 512) ?? safeText(item[2], 512) ?? "";
    const rawModelNumber = item[17] ?? item[9] ?? 1;
    if (!integer(rawModelNumber, 1, 65535)) throw fail("invalid_response", "Gemini model discovery contains an invalid model number");
    models.push({
      modelId,
      modelName: modelName(categoryName, displayName, modelId),
      displayName,
      description,
      capacity,
      capacityField,
      modelNumber: rawModelNumber,
      available,
      // Capacity field 13 is described in the public reference as not yet observed.
      selectable: available && capacityField === 12,
    });
  }
  if (new Set(models.map(model => model.modelId.toLowerCase())).size !== models.length) {
    throw fail("invalid_response", "Gemini model discovery returned duplicate model IDs");
  }
  return { accountStatus, capacity, capacityField, models };
}

/** Resolve only exact identifiers/display names that this account listed. */
export function resolveGeminiModel(selection: string | undefined, models: readonly GeminiModel[]): GeminiModel | undefined {
  if (selection === undefined || selection.trim() === "") return undefined;
  if (typeof selection !== "string" || selection.length > 160 || /[\u0000-\u001f\u007f]/.test(selection)) {
    throw fail("invalid_request", "Gemini model selection is invalid");
  }
  const normalized = selection.trim().toLowerCase();
  const matches = models.filter(model => [model.modelId, model.modelName, model.displayName]
    .some(value => value.toLowerCase() === normalized));
  if (matches.length !== 1) throw fail("invalid_request", "Gemini model must exactly match an available account model");
  const selected = matches[0];
  if (!selected.available || !selected.selectable || selected.capacityField !== 12) {
    throw fail("unsupported_capability", "This Gemini account cannot select the requested model through the verified Web transport");
  }
  return selected;
}

/** Resolve only the account/UI-verified level list supplied by the caller. */
export function resolveGeminiThinkingLevel(
  selection: string | undefined,
  verifiedOptions: readonly GeminiThinkingOption[],
): GeminiThinkingOption | undefined {
  if (selection === undefined || selection.trim() === "") return undefined;
  if (typeof selection !== "string" || selection.length > 128 || /[\u0000-\u001f\u007f]/.test(selection)) {
    throw fail("invalid_request", "Gemini thinking-level selection is invalid");
  }
  const normalized = selection.trim().toLowerCase();
  const matches = verifiedOptions.filter(option => option.id.toLowerCase() === normalized || option.label.toLowerCase() === normalized);
  if (matches.length !== 1 || !integer(matches[0]?.wireValue, 1, 65535)) {
    throw fail("invalid_request", "Gemini thinking level must exactly match a verified account option");
  }
  return matches[0];
}

/** Encode selection from a parsed account model; arbitrary model IDs/headers are never accepted. */
export function encodeGeminiSelection(
  model: GeminiModel | undefined,
  thinkingLevel: GeminiThinkingOption | undefined,
  requestUUID: string,
): GeminiEncodedSelection {
  if (!REQUEST_UUID.test(requestUUID)) throw fail("invalid_request", "Gemini selection request UUID is invalid");
  if (thinkingLevel && (!safeText(thinkingLevel.id, 128) || !safeText(thinkingLevel.label, 128) ||
      !integer(thinkingLevel.wireValue, 1, 65535))) {
    throw fail("invalid_request", "Gemini thinking level is not a verified wire option");
  }
  const wireThinking = thinkingLevel?.wireValue ?? 1;
  const headers: Record<string, string> = {
    "x-goog-ext-525005358-jspb": JSON.stringify([requestUUID.toUpperCase(), 1]),
  };
  let modelNumber = 1;
  if (model) {
    if (!MODEL_ID.test(model.modelId) || !model.available || !model.selectable || model.capacityField !== 12 ||
        !integer(model.capacity, 1, 4) || !integer(model.modelNumber, 1, 65535)) {
      throw fail("unsupported_capability", "Gemini model selection is not verified for this account");
    }
    modelNumber = model.modelNumber;
    const modelHeader: unknown[] = [1, null, null, null, model.modelId, null, null, 0, [4, 5, 6, 8], null, null,
      model.capacity, null, null, model.modelNumber, wireThinking, requestUUID.toUpperCase()];
    headers["x-goog-ext-525001261-jspb"] = JSON.stringify(modelHeader);
    headers["x-goog-ext-73010989-jspb"] = "[0]";
    headers["x-goog-ext-73010990-jspb"] = "[0,0,0]";
  }
  return { headers, payloadPatch: { 59: requestUUID.toUpperCase(), 79: modelNumber, 80: wireThinking } };
}
