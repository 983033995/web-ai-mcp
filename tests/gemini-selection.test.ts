import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  computeGeminiCapacity,
  encodeGeminiSelection,
  GEMINI_THINKING_LEVELS,
  parseGeminiModels,
  resolveGeminiModel,
  resolveGeminiThinkingLevel,
  type GeminiThinkingOption,
} from "../src/providers/gemini/selection.js";

const modelId = "a1b2c3d4e5f60718";
const uuid = "2d7f3e20-88e1-4a2c-9ab9-66e8995de501";

function modelEntry(id = modelId, category = "Flash", display = "3.8 Flash"): unknown[] {
  const model: unknown[] = [];
  model[0] = id;
  model[1] = category;
  model[2] = "Fast general model";
  model[9] = 1;
  model[10] = category;
  model[11] = display;
  model[12] = "Description from the account model list";
  model[17] = 2;
  return model;
}

function modelBody(args: { status?: number | null; tier?: number[]; capabilities?: number[]; models?: unknown[] } = {}): unknown[] {
  const body: unknown[] = [];
  body[14] = args.status === undefined ? 1000 : args.status;
  body[15] = args.models ?? [modelEntry()];
  body[16] = args.tier ?? [8];
  body[17] = args.capabilities ?? [];
  return body;
}

test("parses account model IDs, names, availability, and computed capacity", () => {
  const catalog = parseGeminiModels(modelBody());
  assert.equal(catalog.accountStatus, 1000);
  assert.deepEqual({ capacity: catalog.capacity, field: catalog.capacityField }, { capacity: 2, field: 12 });
  assert.equal(catalog.models.length, 1);
  assert.deepEqual(catalog.models[0], {
    modelId, modelName: "gemini-flash", displayName: "3.8 Flash",
    description: "Description from the account model list", capacity: 2, capacityField: 12,
    modelNumber: 2, available: true, selectable: true,
  });
});

test("null and explicit status 1000 both permit models after HTML-context authentication", () => {
  for (const status of [null, 1000] as const) {
    const catalog = parseGeminiModels(modelBody({ status, tier: [8, 0, 38] }));
    assert.equal(catalog.accountStatus, status);
    assert.deepEqual(catalog.models.map(model => model.selectable), [true]);
    assert.deepEqual({ capacity: catalog.capacity, field: catalog.capacityField }, { capacity: 2, field: 12 });
  }
  for (const status of [1016, 1033, 1060]) {
    assert.throws(() => parseGeminiModels(modelBody({ status })), (error: any) => error.code === "access_denied");
  }
});

test("account capacity flags follow observed priority without embedding model IDs", () => {
  assert.deepEqual(computeGeminiCapacity([21, 22, 16, 8], [115, 106, 19]), { capacity: 1, capacityField: 13 });
  assert.deepEqual(computeGeminiCapacity([22], []), { capacity: 2, capacityField: 13 });
  assert.deepEqual(computeGeminiCapacity([16], [115]), { capacity: 4, capacityField: 12 });
  assert.deepEqual(computeGeminiCapacity([], [106]), { capacity: 3, capacityField: 12 });
  assert.deepEqual(computeGeminiCapacity([8], []), { capacity: 2, capacityField: 12 });
  assert.deepEqual(computeGeminiCapacity([], []), { capacity: 1, capacityField: 12 });
});

test("model resolution accepts exact account identifiers and rejects fuzzy or unavailable choices", () => {
  const catalog = parseGeminiModels(modelBody({ models: [modelEntry(), modelEntry("0123456789abcdef", "Pro", "3.1 Pro")] }));
  assert.equal(resolveGeminiModel(modelId, catalog.models)?.modelNumber, 2);
  assert.equal(resolveGeminiModel("3.1 Pro", catalog.models)?.modelId, "0123456789abcdef");
  assert.equal(resolveGeminiModel("gemini-flash", catalog.models)?.displayName, "3.8 Flash");
  assert.equal(resolveGeminiModel(undefined, catalog.models), undefined);
  for (const selection of ["3.8", "Flash", "not-listed-model", " "]) {
    if (selection === " ") continue;
    assert.throws(() => resolveGeminiModel(selection, catalog.models), (error: any) => error.code === "invalid_request");
  }
  const unobservedCapacity = parseGeminiModels(modelBody({ tier: [21] }));
  assert.equal(unobservedCapacity.models[0].selectable, false);
  assert.throws(() => resolveGeminiModel(modelId, unobservedCapacity.models), (error: any) => error.code === "unsupported_capability");
});

test("model header and request payload use only account-resolved wire fields", () => {
  const model = resolveGeminiModel(modelId, parseGeminiModels(modelBody()).models)!;
  const selection = encodeGeminiSelection(model, undefined, uuid);
  const header = JSON.parse(selection.headers["x-goog-ext-525001261-jspb"]);
  assert.equal(header[4], modelId);
  assert.equal(header[11], 2);
  assert.equal(header[14], 2);
  assert.equal(header[15], 1);
  assert.equal(header[16], uuid.toUpperCase());
  assert.deepEqual(selection.payloadPatch, { 59: uuid.toUpperCase(), 79: 2, 80: 1 });
  assert.deepEqual(JSON.parse(selection.headers["x-goog-ext-525005358-jspb"]), [uuid.toUpperCase(), 1]);
  assert.equal(selection.headers["x-goog-ext-73010989-jspb"], "[0]");
  assert.equal(selection.headers["x-goog-ext-73010990-jspb"], "[0,0,0]");

  const defaultModel = encodeGeminiSelection(undefined, undefined, uuid);
  assert.equal(defaultModel.headers["x-goog-ext-525001261-jspb"], undefined);
  assert.deepEqual(defaultModel.payloadPatch, { 59: uuid.toUpperCase(), 79: 1, 80: 1 });
});

test("thinking options are exact account/UI-verified values and are not merged", () => {
  const options: GeminiThinkingOption[] = [
    { id: "opt-a", label: "Verified option A", wireValue: 1 },
    { id: "opt-b", label: "Verified option B", wireValue: 2 },
    { id: "opt-c", label: "Verified option C", wireValue: 3 },
  ];
  assert.equal(resolveGeminiThinkingLevel("Verified option C", options)?.wireValue, 3);
  assert.equal(resolveGeminiThinkingLevel("opt-b", options)?.wireValue, 2);
  assert.throws(() => resolveGeminiThinkingLevel("Medium", options), (error: any) => error.code === "invalid_request");
  assert.throws(() => resolveGeminiThinkingLevel("opt-a", [{ id: "opt-a", label: "Verified option A", wireValue: 0 }]),
    (error: any) => error.code === "invalid_request");
  const model = resolveGeminiModel(modelId, parseGeminiModels(modelBody()).models)!;
  const encoded = encodeGeminiSelection(model, options[2], uuid);
  const header = JSON.parse(encoded.headers["x-goog-ext-525001261-jspb"]);
  assert.equal(header[15], 3);
  assert.equal(encoded.payloadPatch[80], 3);
});

test("verified read-only thinking preferences retain three distinct account values", () => {
  assert.deepEqual(GEMINI_THINKING_LEVELS, [
    { id: "low", label: "Low", preferenceValue: 1 },
    { id: "medium", label: "Medium", preferenceValue: 4 },
    { id: "high", label: "High", preferenceValue: 2 },
  ]);
  assert.equal(new Set(GEMINI_THINKING_LEVELS.map(option => option.preferenceValue)).size, 3);
  assert.equal(Object.isFrozen(GEMINI_THINKING_LEVELS), true);
  assert.ok(GEMINI_THINKING_LEVELS.every(Object.isFrozen));
});

test("model discovery rejects malformed, duplicate, and unsafe model metadata", () => {
  for (const body of [
    {},
    modelBody({ models: [modelEntry("not-a-hex-id")] }),
    modelBody({ models: [modelEntry(), modelEntry()] }),
    modelBody({ tier: ["8" as unknown as number] }),
    modelBody({ models: Array.from({ length: 65 }, () => modelEntry()) }),
  ]) {
    assert.throws(() => parseGeminiModels(body), (error: any) => error.code === "invalid_response");
  }
  assert.throws(() => encodeGeminiSelection(undefined, undefined, "not-a-uuid"), (error: any) => error.code === "invalid_request");
});
