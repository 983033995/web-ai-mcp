import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseGeminiStream } from "../src/providers/gemini/stream.js";
import { GeminiQuotaError } from "../src/providers/gemini/cooldown.js";

function frame(content: string, ids = true): string {
  const record: unknown[] = Array(26).fill(null);
  if (ids) record[1] = ["c_fixture", "r_fixture"];
  record[4] = [[ids ? "rc_fixture" : null, [content]]];
  const serialized = JSON.stringify([["wrb.fr", null, JSON.stringify(record)]]);
  return serialized;
}

function chunkedResponse(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({ pull(controller) {
    if (index >= chunks.length) controller.close();
    else controller.enqueue(chunks[index++]);
  } });
}

function signal(): AbortSignal { return new AbortController().signal; }

test("Gemini parser handles XSSI, UTF-8 byte framing split across chunks, and the terminal trailer", async () => {
  const json = frame("你好，Gemini 👋");
  const bytes = Buffer.from(`)]}'\n${Buffer.byteLength(json)}\n${json}\ndi\n`, "utf8");
  const chunks = [bytes.subarray(0, 13), bytes.subarray(13, 44), bytes.subarray(44, bytes.length - 4), bytes.subarray(bytes.length - 4)];
  const parsed = await parseGeminiStream(chunkedResponse(chunks), signal());
  assert.deepEqual(parsed, { content: "你好，Gemini 👋", conversationId: "c_fixture", replyId: "r_fixture", candidateId: "rc_fixture" });
});

test("Gemini parser validates a UTF-16-code-unit frame length variant", async () => {
  const json = frame("汉字回复");
  const stream = `)]}'\n${json.length + 2}\n${json}\n["di",1]`;
  const parsed = await parseGeminiStream(new Response(stream).body!, signal());
  assert.equal(parsed.content, "汉字回复");
});

test("Gemini parser retains an answer when the website omits lineage", async () => {
  const parsed = await parseGeminiStream(new Response(`)]}'\n${frame("answer", false)}\ndi`).body!, signal());
  assert.equal(parsed.content, "answer");
  assert.equal(parsed.conversationId, undefined);
  assert.equal(parsed.replyId, undefined);
  assert.equal(parsed.candidateId, undefined);
});

test("ordinary chat parsing does not expose media cards unless a media generation kind was requested", async () => {
  const record: unknown[] = Array(26).fill(null);
  record[1] = ["c_fixture", "r_fixture"];
  const candidate: unknown[] = Array(13).fill(null);
  candidate[0] = "rc_fixture";
  candidate[1] = ["ordinary answer"];
  const rich: unknown[] = [];
  rich[7] = [[[[null, null, null, [null, null, "alt", "https://lh3.googleusercontent.com/gg/example?alr=1"]], ["image-id"]]]];
  candidate[12] = rich;
  record[4] = [candidate];
  const json = JSON.stringify([["wrb.fr", null, JSON.stringify(record)]]);
  const parsed = await parseGeminiStream(new Response(`)]}'\n${json}\ndi`).body!, signal());
  assert.equal(parsed.content, "ordinary answer");
  assert.equal(parsed.media, undefined);
});

test("an empty-content video candidate remains pending only with explicit in-progress status and complete lineage", async () => {
  const candidate: unknown[] = Array(13).fill(null);
  candidate[0] = "rc_fixture";
  candidate[8] = [1];
  candidate[12] = [];
  const record: unknown[] = Array(26).fill(null);
  record[1] = ["c_fixture", "r_fixture"];
  record[4] = [candidate];
  const body = `)]}'\n${JSON.stringify([["wrb.fr", null, JSON.stringify(record)]])}\ndi`;
  const parsed = await parseGeminiStream(new Response(body).body!, signal(), { quotaKind: "video" });
  assert.equal(parsed.content, "");
  assert.equal(parsed.completionStatus, 1);
  assert.deepEqual([parsed.conversationId, parsed.replyId, parsed.candidateId], ["c_fixture", "r_fixture", "rc_fixture"]);
});

test("a sparse follow-up candidate without status preserves a confirmed pending video state", async () => {
  const first: unknown[] = Array(13).fill(null);
  first[0] = "rc_fixture"; first[8] = [1]; first[12] = [];
  const next: unknown[] = Array(13).fill(null);
  next[0] = "rc_fixture"; next[12] = [];
  const rpc = (candidate: unknown) => {
    const record: unknown[] = Array(26).fill(null);
    record[1] = ["c_fixture", "r_fixture"]; record[4] = [candidate];
    return JSON.stringify([["wrb.fr", null, JSON.stringify(record)]]);
  };
  const parsed = await parseGeminiStream(new Response(`)]}'\n${rpc(first)}\n${rpc(next)}\ndi`).body!, signal(), { quotaKind: "video" });
  assert.equal(parsed.completionStatus, 1);
});

test("a later candidate snapshot without a media field does not erase previously observed generated media", async () => {
  const first: unknown[] = Array(13).fill(null);
  first[0] = "rc_fixture"; first[1] = ["answer"];
  first[12] = [];
  first[12][7] = [[
    [
      [null, null, null, [null, null, "alt", "https://lh3.googleusercontent.com/gg/fixture?alr=1"]],
      ["image-id"]
    ]
  ]];
  const later: unknown[] = Array(13).fill(null);
  later[0] = "rc_fixture"; later[1] = ["answer"];
  later[8] = [2];
  later[12] = [];
  const rpc = (candidate: unknown) => {
    const record: unknown[] = Array(26).fill(null);
    record[1] = ["c_fixture", "r_fixture"]; record[4] = [candidate];
    return JSON.stringify([["wrb.fr", null, JSON.stringify(record)]]);
  };
  const body = `)]}'\n${rpc(first)}\n${rpc(later)}\ndi`;
  const parsed = await parseGeminiStream(new Response(body).body!, signal(), { quotaKind: "image" });
  assert.equal(parsed.media?.length, 1);
  assert.equal(parsed.media?.[0].id?.length, 64);
});

for (const [name, body] of [
  ["malformed JSON", `)]}'\n{broken\ndi`],
  ["truncated JSON", `)]}'\n[["wrb.fr",null,"{`],
  ["truncated frame length", `)]}'\n999\n${frame("answer")}\ndi`],
  ["missing terminal trailer", `)]}'\n${frame("answer")}`],
  ["content after terminal trailer", `)]}'\n${frame("answer")}\ndi\n${frame("extra")}`],
  ["XSSI repeated midstream", `)]}'\n${frame("answer")}\n)]}'\ndi`],
  ["XSSI with trailing junk", `)]}' junk\n${frame("answer")}\ndi`],
  ["malformed JSON terminal prefix", `)]}'\n${frame("answer")}\n["di",\n`],
  ["missing assistant answer", `)]}'\n${JSON.stringify([["wrb.fr", null, JSON.stringify(Array(26).fill(null))]])}\ndi`],
  ["conflicting reply IDs", `)]}'\n${frame("first")}\n${JSON.stringify([["wrb.fr", null, JSON.stringify(Object.assign(Array(26).fill(null), { 1: ["c_fixture", "r_other"], 4: [["rc_fixture", ["second"]]] }))]])}\ndi`],
  ["invalid conversation ID prefix", `)]}'\n${JSON.stringify([["wrb.fr", null, JSON.stringify(Object.assign(Array(26).fill(null), { 1: ["not-a-conversation-id", "r_fixture"], 4: [["rc_fixture", ["answer"]]] }))]])}\ndi`],
  ["unknown frame record", `)]}'\n${JSON.stringify([["unknown.record", 1]])}\ndi`],
  ["invalid transport metadata", `)]}'\n${frame("answer")}\n${JSON.stringify([["af.httprm", "unexpected", "fixture", 1]])}\ndi`]
] as const) {
  test(`Gemini parser rejects ${name}`, async () => {
    await assert.rejects(parseGeminiStream(new Response(body).body!, signal()), (error: any) => error.code === "invalid_response" && error.sessionUncertain);
  });
}

test("Gemini parser accepts bounded four-field af.httprm metadata around a final di frame", async () => {
  for (const value of [0, 1, 2, 513]) {
    const body = `)]}'\n${JSON.stringify([["af.httprm", 3809, "bounded fixture metadata", value]])}\n${frame("answer")}\n${JSON.stringify([["di", 3810]])}`;
    const parsed = await parseGeminiStream(new Response(body).body!, signal());
    assert.equal(parsed.content, "answer");
  }
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const body = `)]}'\n${JSON.stringify([["af.httprm", 2985, "bounded fixture metadata", value]])}\n${frame("answer")}\n${JSON.stringify([["di", 2985]])}`;
    await assert.rejects(parseGeminiStream(new Response(body).body!, signal()), (error: any) => error.code === "invalid_response");
  }
});

test("Gemini parser accepts the captured di/af.httprm frame followed by an e trailer", async () => {
  const framed = (value: unknown) => {
    const json = JSON.stringify(value);
    return `${json.length + 2}\n${json}\n`;
  };
  const records = Array.from({ length: 9 }, (_, index) => {
    const record: unknown[] = Array(26).fill(null);
    record[1] = ["c_fixture", "r_fixture"];
    record[4] = [["rc_fixture", [index === 8 ? "完整的中文回答。" : "部分内容"]]];
    return ["wrb.fr", null, JSON.stringify(record)];
  });
  const prefix = `)]}'\n\n${records.map(record => framed([record])).join("")}${framed([["di", 3810], ["af.httprm", 3809, "bounded fixture metadata", 2]])}`;
  const bodyWithEnd = (entryCount: number, totalOffset = 0, malformedFields = false) => {
    let totalBytes = 0;
    let body = "";
    const eFrame = (total: number) => framed([["e", entryCount, malformedFields ? "unexpected" : null,
      malformedFields ? null : null, total + totalOffset]]);
    for (let i = 0; i < 5; i++) {
      body = prefix + eFrame(totalBytes);
      totalBytes = Buffer.byteLength(body, "utf8");
    }
    return prefix + eFrame(totalBytes);
  };
  const body = bodyWithEnd(12);
  const parsed = await parseGeminiStream(new Response(body).body!, signal());
  assert.deepEqual(parsed, { content: "完整的中文回答。", conversationId: "c_fixture", replyId: "r_fixture", candidateId: "rc_fixture" });
});

test("Gemini parser rejects invalid transport metadata, captured frame length, and malformed e trailer", async () => {
  const framed = (value: unknown, lengthOffset = 0) => {
    const json = JSON.stringify(value);
    return `${json.length + 2 + lengthOffset}\n${json}\n`;
  };
  const answer = [["wrb.fr", null, JSON.stringify(Object.assign(Array(26).fill(null), {
    1: ["c_fixture", "r_fixture"], 4: [["rc_fixture", ["answer"]]]
  }))]];
  const bodyWithTerminal = (eCount: number, eTotalOffset = 0, malformedE = false, invalidTiming = false, wrongLength = false) => {
    const prefix = `)]}'\n${framed(answer)}`;
    const terminalJson = JSON.stringify([["di", 3810], ["af.httprm", invalidTiming ? -1 : 3809, "metadata", 1]]);
    const terminalFrame = `${terminalJson.length + 2 + (wrongLength ? 1 : 0)}\n${terminalJson}\n`;
    let total = 0;
    let body = "";
    for (let i = 0; i < 5; i++) {
      const eJson = JSON.stringify([["e", eCount, malformedE ? "unexpected" : null, null, total + eTotalOffset]]);
      body = `${prefix}${terminalFrame}${eJson.length + 2}\n${eJson}\n`;
      total = Buffer.byteLength(body, "utf8");
    }
    const eJson = JSON.stringify([["e", eCount, malformedE ? "unexpected" : null, null, total + eTotalOffset]]);
    return `${prefix}${terminalFrame}${eJson.length + 2}\n${eJson}\n`;
  };
  assert.equal((await parseGeminiStream(new Response(bodyWithTerminal(4)).body!, signal())).content, "answer");
  for (const [name, body] of [
    ["invalid timing metadata", bodyWithTerminal(4, 0, false, true)],
    ["outer length is wrong", bodyWithTerminal(4, 0, false, false, true)],
    ["malformed e fields", bodyWithTerminal(4, 0, true)],
    ["e entry count differs", bodyWithTerminal(3)],
    ["e total differs from raw byte count", bodyWithTerminal(4, -1)]
  ] as const) {
    await assert.rejects(parseGeminiStream(new Response(body).body!, signal()), (error: any) =>
      error.code === "invalid_response" && error.sessionUncertain, name);
  }
  const beforeDi = `)]}'\n${framed(answer)}${framed([["e", 12, null, null, 100]])}`;
  await assert.rejects(parseGeminiStream(new Response(beforeDi).body!, signal()), (error: any) =>
    error.code === "stream_error" && error.sessionUncertain);
});

test("Gemini parser rejects explicit errors even after receiving partial answer content", async () => {
  for (const errorFrame of [
    JSON.stringify([["er", { code: "private-upstream-value" }]]),
    JSON.stringify([["e", "private-upstream-value"]]),
    JSON.stringify([["wrb.fr", null, JSON.stringify(["unknown-error-record", null, null, null, null])]])
  ]) {
    const body = `)]}'\n${frame("partial answer")}\n${errorFrame}`;
    await assert.rejects(parseGeminiStream(new Response(body).body!, signal()), (error: any) => {
      assert.equal(error.code, "stream_error");
      assert.equal(error.sessionUncertain, true);
      assert.ok(!error.message.includes("private-upstream-value"));
      return true;
    });
  }
});

test("only a definitive 1037 with no earlier candidate is typed as media quota exhaustion", async () => {
  const emptyRecord = JSON.stringify(Array(26).fill(null));
  const quotaPart = ["wrb.fr", null, emptyRecord, null, null, [null, null, [[null, [1037]]]]];
  const quotaBody = `)]}'\n${JSON.stringify([quotaPart])}\ndi`;
  await assert.rejects(parseGeminiStream(new Response(quotaBody).body!, signal(), { quotaKind: "image" }),
    (error: any) => error instanceof GeminiQuotaError && error.kind === "image" && !error.sessionUncertain);
  await assert.rejects(parseGeminiStream(new Response(quotaBody).body!, signal()),
    (error: any) => error.code === "stream_error" && error.sessionUncertain);

  const acceptedCandidate: unknown[] = Array(26).fill(null);
  acceptedCandidate[1] = ["c_fixture", "r_fixture"];
  acceptedCandidate[4] = [["rc_fixture", ["already accepted"]]];
  const accepted = JSON.stringify(["wrb.fr", null, JSON.stringify(acceptedCandidate)]);
  const afterCandidate = `)]}'\n${accepted}\n${JSON.stringify([quotaPart])}\ndi`;
  await assert.rejects(parseGeminiStream(new Response(afterCandidate).body!, signal(), { quotaKind: "video" }),
    (error: any) => error.code === "stream_error" && !(error instanceof GeminiQuotaError));

  const sameEntry = Array(26).fill(null);
  sameEntry[4] = [["rc_fixture", ["started"]]];
  const sameEntryQuota = ["wrb.fr", null, JSON.stringify(sameEntry), null, null, [null, null, [[null, [1037]]]]];
  await assert.rejects(parseGeminiStream(new Response(`)]}'\n${JSON.stringify([sameEntryQuota])}\ndi`).body!, signal(), { quotaKind: "video" }),
    (error: any) => error instanceof GeminiQuotaError && error.kind === "video");
});

test("Gemini parser enforces the bounded response size", async () => {
  const body = `)]}'\n${"x".repeat(2 * 1024 * 1024 + 1)}`;
  await assert.rejects(parseGeminiStream(new Response(body).body!, signal()), (error: any) => error.code === "invalid_response");
});

test("Gemini parser returns promptly when stream cancellation cleanup stalls", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { return new Promise<void>(() => {}); }
  });
  const check = assert.rejects(parseGeminiStream(body, signal()), (error: any) => error.code === "invalid_response");
  await Promise.race([check, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cleanup hung")), 100))]);
});

test("Gemini parser cancels a stalled stream when its signal aborts", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ start() {}, cancel() { return new Promise<void>(() => {}); } });
  const pending = parseGeminiStream(body, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const check = assert.rejects(pending, (error: any) => error.name === "AbortError" || error.code === "cancelled");
  await Promise.race([check, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("abort cleanup hung")), 100))]);
});
