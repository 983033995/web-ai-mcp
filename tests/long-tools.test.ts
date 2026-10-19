import { test } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JobManager } from "../src/core/jobs.js";
import { SessionStore } from "../src/core/session-store.js";
import { ProviderError, type WebAIProvider } from "../src/core/provider.js";
import { registerCommonTools } from "../src/tools/common.js";
import { registerDeepSeekTools } from "../src/tools/deepseek.js";
import { registerDoubaoTools } from "../src/tools/doubao.js";
import { USAGE, dispatchChat } from "../src/tools/guidance.js";

const text = (result: any) => result.content.map((item: any) => item.text).join("\n");
test("an already-cancelled submission never starts a background website write", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = await dispatchChat({ message: "x", background: true, request_id: randomUUID() },
    { signal: controller.signal, async sendNotification() {} }, new JobManager(), "fixture", async () => { calls++; return { content: [] }; });
  assert.equal(result.isError, true); assert.equal(calls, 0);
});
for (const id of ["deepseek", "doubao"] as const) {
  test(`${id} background tool acknowledges once, polls without writes and safely resumes the completed session`, async (t) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: any[] = [];
    const provider: WebAIProvider = {
      id, displayName: "fixture", capabilities: { chat: true, thinking: true, files: false, sessionResume: true, webSearch: false },
      async initialize() {}, async chat(request, previous) {
        calls.push({ request, previous });
        if (request.message === "long") await gate;
        if (request.message === "cancel") await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new ProviderError("fixture cancelled", "cancelled", true));
          if (request.signal?.aborted) abort(); else request.signal?.addEventListener("abort", abort, { once: true });
        });
        return { content: "final answer", remoteSession: { fixture: "hidden-remote", lastMessageId: Number(previous?.lastMessageId ?? 0) + 1 } };
      },
    };
    const jobs = new JobManager(); const sessions = new SessionStore();
    const server = new McpServer({ name: "fixture", version: "0" }, { instructions: USAGE });
    registerCommonTools(server, jobs);
    (id === "deepseek" ? registerDeepSeekTools : registerDoubaoTools)(server, provider, sessions, jobs);
    const client = new Client({ name: "fixture", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    t.after(async () => { release(); await client.close(); await server.close(); });
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, { timeout: 1000 });
    assert.match(client.getInstructions()!, /message/);
    assert.match(text(await call("webai_usage", {})), /unknown\/expired/);
    const requestId = randomUUID();
    const args = { message: "long", conversation_name: "fixture", background: true, request_id: requestId };
    const ack = await call(id + "_reasoner", args);
    const jobId = (ack._meta as any).web_ai_job.job_id;
    assert.equal((ack._meta as any).web_ai_job.status, "running");
    assert.equal(calls.length, 1); assert.equal(calls[0].request.thinking, true);
    assert.equal((await call(id + "_reasoner", { ...args, message: "changed" })).isError, true);
    assert.equal((await call(id + "_chat", args)).isError, true, "request ID must not alias a different tool");
    assert.equal((await call(id + "_reasoner", args))._meta?.web_ai_job && calls.length, 1);
    for (let i = 0; i < 3; i++) assert.equal((await call("webai_job_status", { job_id: jobId }))._meta?.web_ai_job && calls.length, 1);
    assert.equal((await call(id + "_chat", { ...args, request_id: randomUUID() })).isError, true);
    release();
    let result: any;
    for (let i = 0; i < 100; i++) {
      result = await call("webai_job_status", { job_id: jobId });
      if (result._meta.web_ai_job.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(result._meta.web_ai_job.status, "completed"); assert.match(text(result), /final answer/);
    const key = text(result).match(/session_key: ([a-f0-9-]+)/)![1];
    const followup = await call(id + "_chat", { message: "followup", session_key: key });
    assert.equal(followup.isError, undefined); assert.equal(calls[1].previous.lastMessageId, 1);
    assert.ok(!text(followup).includes("hidden-remote"));
    const cancelAck = await call(id + "_chat", { message: "cancel", session_key: key, background: true, request_id: randomUUID() });
    const cancelId = (cancelAck._meta as any).web_ai_job.job_id;
    await call("webai_job_cancel", { job_id: cancelId });
    for (let i = 0; i < 100; i++) {
      result = await call("webai_job_status", { job_id: cancelId });
      if (result._meta.web_ai_job.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(result._meta.web_ai_job.status, "cancelled"); assert.equal(result.isError, true);
    assert.throws(() => sessions.require(key, id), /invalidated/);
    const count = calls.length;
    for (const bad of [{ mode: "quick" }, { message: "x", make_default: "true" },
      { message: "x", session_key: key, conversation_name: "fixture" }, { message: "x", background: true },
      { message: "x", request_id: randomUUID() }]) assert.equal((await call(id + "_chat", bad)).isError, true);
    assert.equal(calls.length, count);
  });
}
