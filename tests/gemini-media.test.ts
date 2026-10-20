import { test } from "node:test";
import { strict as assert } from "node:assert";
import { extractGeminiCandidateMedia, geminiMediaURL } from "../src/providers/gemini/media.js";
import { findGeminiMediaTurn, parseGeminiHistory } from "../src/providers/gemini/history.js";
import { GeminiMediaQuotaError } from "../src/providers/gemini/errors.js";
import { GeminiQuotaError } from "../src/providers/gemini/cooldown.js";

const lineage = { conversationId: "c_media", replyId: "r_media", candidateId: "rc_media" };
const imagePreview = "https://lh3.googleusercontent.com/gg/generated-image?alr=1";
const imageOfficial = "https://contribution.usercontent.google.com/download?c=image-id&filename=image.png&opi=123";
const videoOfficial = "https://contribution.usercontent.google.com/download?c=video-id&filename=video.mp4&opi=123";

function generatedImage(official = imageOfficial, preview = imagePreview): unknown[] {
  const result: unknown[] = [];
  result[0] = [null, null, null, [null, null, "generated alt", preview]];
  result[1] = ["image-id"];
  result[3] = [];
  result[3][22] = [];
  result[3][22][7] = ["thumbnail", official];
  return result;
}

function imageCandidate(status = 2, sparse = false): unknown[] {
  const candidate: unknown[] = Array(13).fill(null);
  candidate[0] = lineage.candidateId;
  candidate[8] = [status];
  if (sparse) candidate[12] = [{ "8": [[generatedImage()]] }];
  else {
    const rich: unknown[] = Array(8).fill(null);
    rich[1] = [["retrieved web image must be ignored"]];
    rich[7] = [[generatedImage()]];
    candidate[12] = rich;
  }
  return candidate;
}

function videoCandidate(status = 1): unknown[] {
  const candidate: unknown[] = Array(13).fill(null);
  candidate[0] = lineage.candidateId;
  candidate[8] = [status];
  const videoInfo: unknown[] = [];
  videoInfo[0] = [];
  videoInfo[0][7] = ["https://lh3.googleusercontent.com/gg/preview?alr=1", videoOfficial];
  const rich: unknown[] = [];
  rich[59] = [[[videoInfo]]];
  // A video response may carry a companion preview image; it is not a generated image result.
  rich[7] = [[generatedImage()]];
  candidate[12] = rich;
  return candidate;
}

function framed(value: unknown): string {
  const json = JSON.stringify(value);
  return `${json.length + 2}\n${json}\n`;
}

function candidateStream(candidate: unknown[], conversationId = lineage.conversationId, replyId = lineage.replyId): Response {
  const record: unknown[] = Array(26).fill(null);
  record[1] = [conversationId, replyId];
  record[4] = [candidate];
  return new Response(`)]}'\n${framed([["wrb.fr", null, JSON.stringify(record)]])}${framed([["di", 4], ["af.httprm", 5, "fixture", 2]])}`, {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function historyResponse(candidate: unknown): Response {
  const turn: unknown[] = [];
  turn[0] = [null, lineage.replyId];
  turn[3] = [[candidate]];
  const record = JSON.stringify([[turn]]);
  const rpc = ["wrb.fr", "hNvQHb", record, null, null, null];
  const prefix = `)]}'\n${framed([rpc])}${framed([["di", 5], ["af.httprm", 4, "fixture", 2]])}`;
  let bytes = 0;
  let body = "";
  for (let i = 0; i < 5; i++) {
    body = prefix + framed([["e", 4, null, null, bytes]]);
    bytes = Buffer.byteLength(body);
  }
  body = prefix + framed([["e", 4, null, null, bytes]]);
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

test("generated image parser retains verified preview URL and ignores web-image field", () => {
  const parsed = extractGeminiCandidateMedia(imageCandidate(), lineage, "image");
  assert.equal(parsed.completionStatus, 2);
  assert.equal(parsed.media.length, 1);
  assert.equal(parsed.media[0].type, "image");
  assert.equal(parsed.media[0].url, imagePreview);
  assert.equal(parsed.media[0].resourceId, undefined);
  assert.equal(parsed.media[0].probeUrl, imagePreview);
  assert.notEqual(parsed.media[0].status, "completed");
  assert.equal(geminiMediaURL(imagePreview, "image").href, imagePreview);
});

test("generated image parser accepts sparse field 7 key 8", () => {
  const parsed = extractGeminiCandidateMedia(imageCandidate(2, true), lineage, "image");
  assert.equal(parsed.media.length, 1);
  assert.equal(parsed.media[0].url, imagePreview);
});

test("generated image identity is scoped by reply even when the website image ID repeats", () => {
  const first = extractGeminiCandidateMedia(imageCandidate(), lineage, "image").media[0];
  const next = extractGeminiCandidateMedia(imageCandidate(), { ...lineage, replyId: "r_next" }, "image").media[0];
  const sameReply = extractGeminiCandidateMedia(imageCandidate(), lineage, "image").media[0];
  assert.notEqual(first.id, next.id);
  assert.equal(first.id, sameReply.id);
});

test("video filtering ignores companion image cards and preserves opaque signed download query", () => {
  const parsed = extractGeminiCandidateMedia(videoCandidate(), lineage, "video");
  assert.equal(parsed.media.length, 1);
  assert.equal(parsed.media[0].type, "video");
  assert.equal(parsed.media[0].url, videoOfficial);
  assert.equal(geminiMediaURL(videoOfficial, "video").href, videoOfficial);
});

test("web search imagery is never parsed as generated output", () => {
  const candidate: unknown[] = Array(13).fill(null);
  const rich: unknown[] = [];
  rich[1] = [[generatedImage()]];
  candidate[12] = rich;
  assert.deepEqual(extractGeminiCandidateMedia(candidate, lineage).media, []);
});

test("media URLs reject unverified hosts, paths, ports, fragments, and foreign query fields", () => {
  for (const [value, kind] of [
    ["https://lh3.googleusercontent.com/a/avatar.png?alr=1", "image"],
    ["https://lh3.googleusercontent.com/gg/image?token=secret", "image"],
    ["https://lh3.googleusercontent.com:443/gg/image?alr=1", "image"],
    ["https://contribution.usercontent.google.com/download?c=image-id&filename=image.png&opi=123", "image"],
    ["https://evil.example/download?c=x&filename=a.mp4&opi=1", "video"],
    ["https://contribution.usercontent.google.com/download?c=x&filename=a.mp4&opi=1&cookie=secret", "video"],
    ["https://contribution.usercontent.google.com/download?c=x&filename=a.mp4&opi=1#fragment", "video"]
  ] as const) assert.throws(() => geminiMediaURL(value, kind));
});

test("history resolves the exact reply and candidate and updates pending video to a full-size result", async () => {
  const candidate = videoCandidate(2);
  const response = historyResponse(candidate);
  const parsed = await parseGeminiHistory(response.body!, new AbortController().signal, { ...lineage, mediaKind: "video" });
  assert.equal(parsed.completionStatus, 2);
  assert.equal(parsed.media.length, 1);
  assert.equal(parsed.media[0].url, videoOfficial);
  assert.equal(parsed.media[0].status, "pending");

  const differentTurn = historyResponse(videoCandidate(2));
  await assert.rejects(parseGeminiHistory(differentTurn.body!, new AbortController().signal,
    { ...lineage, replyId: "r_other", mediaKind: "video" }), (error: any) => error.code === "history_not_found");
});

test("a completed website failure without media is terminal, never pending or a quota failover", async () => {
  const candidate: unknown[] = Array(13).fill(null);
  candidate[0] = lineage.candidateId;
  candidate[1] = ["Sorry, something went wrong. Please try your request again."];
  candidate[8] = [2]; candidate[12] = [null, null, null, null, null, null, null, []];
  await assert.rejects(parseGeminiHistory(historyResponse(candidate).body!, new AbortController().signal, { ...lineage, mediaKind: "video" }),
    (e: any) => e.code === "media_generation_failed" && !e.sessionUncertain);
  await assert.rejects(findGeminiMediaTurn(historyResponse(candidate).body!, new AbortController().signal, "video"),
    (e: any) => e.code === "media_generation_failed");
  candidate[1] = ["我只是一个语言模型，不具备这方面的信息或能力，所以恐怕帮不上忙。"];
  await assert.rejects(parseGeminiHistory(historyResponse(candidate).body!, new AbortController().signal, { ...lineage, mediaKind: "video" }),
    (e: any) => e.code === "media_generation_failed");
  await assert.rejects(parseGeminiHistory(historyResponse(candidate).body!, new AbortController().signal, { ...lineage, replyId: "r_other", mediaKind: "video" }),
    (e: any) => e.code === "history_not_found");
  candidate[8] = [1];
  const waiting = await parseGeminiHistory(historyResponse(candidate).body!, new AbortController().signal, { ...lineage, mediaKind: "video" });
  assert.equal(waiting.media[0].status, "pending");
  candidate[8] = [2]; candidate[1] = ["A normal clarification response."];
  const clarification = await parseGeminiHistory(historyResponse(candidate).body!, new AbortController().signal, { ...lineage, mediaKind: "video" });
  assert.deepEqual(clarification.media, []);
});

test("a completed video quota card is terminal and never the pre-acceptance failover signal", async () => {
  const c = videoCandidate(2);
  c[1] = ["I can create more videos as soon as your limit resets. Check your usage in Settings."];
  (c[12] as any[])[59] = [[[null, ["private website diagnostic"], null, 6]]];
  const check = (e: any) => e instanceof GeminiMediaQuotaError && e.kind === "video" && !(e instanceof GeminiQuotaError) && !e.message.includes("private");
  await assert.rejects(parseGeminiHistory(historyResponse(c).body!, new AbortController().signal, { ...lineage, mediaKind: "video" }), check);
  await assert.rejects(findGeminiMediaTurn(historyResponse(c).body!, new AbortController().signal, "video"), check);
  c[1] = ["\nI can create more videos as soon as your limit resets. Check your usage in Settings. \n"];
  await assert.rejects(parseGeminiHistory(historyResponse(c).body!, new AbortController().signal, { ...lineage, mediaKind: "video" }), check);
  await assert.rejects(findGeminiMediaTurn(historyResponse(c).body!, new AbortController().signal, "video"), check);
  c[8] = [1];
  const pending = await parseGeminiHistory(historyResponse(c).body!, new AbortController().signal, { ...lineage, mediaKind: "video" });
  assert.equal(pending.media[0].status, "pending");
});
