import { createHash, randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JobManager, type JobToolResult } from "../src/core/jobs.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function metadata(result: JobToolResult): { job_id: string; status: string; poll_after_seconds: number; cancel_requested?: boolean } {
  assert.ok(result._meta?.web_ai_job);
  return result._meta.web_ai_job;
}

function readText(result: JobToolResult): string {
  return result.content.map((item) => item.text).join("\n");
}

async function waitFor(manager: JobManager, jobId: string, status: string): Promise<JobToolResult> {
  for (let i = 0; i < 100; i++) {
    const result = manager.status(jobId);
    if (metadata(result).status === status) return result;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`job did not reach ${status}`);
}

test("start immediately acknowledges and executes exactly once; status returns original result", async () => {
  const manager = new JobManager();
  const requestId = randomUUID();
  let calls = 0;
  const operation = async () => {
    calls++;
    return { content: [{ type: "text" as const, text: "answer" }] };
  };

  const acknowledgement = manager.start(requestId, digest("prompt"), operation);
  const jobId = metadata(acknowledgement).job_id;
  assert.equal(metadata(acknowledgement).status, "running");
  assert.equal(calls, 0, "operation must be deferred beyond the synchronous acknowledgement");

  const completed = await waitFor(manager, jobId, "completed");
  assert.equal(calls, 1);
  assert.equal(completed.content[0]?.text, "answer");
  assert.equal(completed.isError, undefined);
  assert.equal(metadata(completed).status, "completed");
  assert.match(readText(completed), /Job metadata:/);

  manager.status(jobId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1, "status polling must not submit the operation again");
});

test("same request ID and fingerprint return the same job without duplicate execution", async () => {
  const manager = new JobManager();
  const requestId = randomUUID();
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const operation = async () => {
    calls++;
    await gate;
    return { content: [{ type: "text" as const, text: "done" }] };
  };

  const first = manager.start(requestId, digest("same"), operation);
  const second = manager.start(requestId, digest("same"), operation);
  assert.equal(metadata(second).job_id, metadata(first).job_id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  release();
  await waitFor(manager, metadata(first).job_id, "completed");
  assert.equal(calls, 1);
});

test("different fingerprint on a reused request ID is rejected", () => {
  const manager = new JobManager();
  const requestId = randomUUID();
  const first = manager.start(requestId, digest("one"), async () => ({ content: [] }));
  const second = manager.start(requestId, digest("two"), async () => ({ content: [] }));
  assert.equal(first.isError, undefined);
  assert.equal(second.isError, true);
  assert.match(readText(second), /different request/);
});

test("UUID and digest casing cannot bypass deduplication after completion", async () => {
  const manager = new JobManager();
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let calls = 0;
  const operation = async () => { calls++; return { content: [] }; };
  const first = manager.start(id, digest("same"), operation);
  await waitFor(manager, metadata(first).job_id, "completed");
  const second = manager.start(id.toUpperCase(), digest("same").toUpperCase(), operation);
  assert.equal(metadata(second).job_id, metadata(first).job_id);
  assert.equal(metadata(manager.status(metadata(first).job_id.toUpperCase())).status, "completed");
  assert.equal(calls, 1);
});

test("busy requests are not retained and may be submitted after the active job settles", async () => {
  const manager = new JobManager();
  const firstId = randomUUID();
  const secondId = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = manager.start(firstId, digest("first"), async () => {
    await gate;
    return { content: [{ type: "text" as const, text: "one" }] };
  });
  const busy = manager.start(secondId, digest("second"), async () => ({ content: [] }));
  assert.equal(busy.isError, true);
  assert.match(readText(busy), /busy/);
  release();
  await waitFor(manager, metadata(first).job_id, "completed");

  const retriedAfterBusy = manager.start(secondId, digest("second"), async () => ({ content: [] }));
  assert.ok(metadata(retriedAfterBusy).job_id);
  await waitFor(manager, metadata(retriedAfterBusy).job_id, "completed");
});

test("deadline aborts the operation and thrown provider details are redacted", async () => {
  const manager = new JobManager({ deadlineMs: 5 });
  const started = manager.start(randomUUID(), digest("timeout"), (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("private provider detail")), { once: true });
  }));
  const failed = await waitFor(manager, metadata(started).job_id, "failed");
  assert.equal(failed.isError, true);
  assert.doesNotMatch(readText(failed), /private provider detail/);
  assert.match(readText(failed), /outcome may be uncertain/);
});

test("cancel aborts the local operation and reports that website acceptance cannot be undone", async () => {
  const manager = new JobManager();
  const started = manager.start(randomUUID(), digest("cancel"), (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("provider abort detail")), { once: true });
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const jobId = metadata(started).job_id;
  const cancellation = manager.cancel(jobId);
  assert.equal(metadata(cancellation).status, "running");
  assert.match(readText(cancellation), /cannot undo/);
  const cancelled = await waitFor(manager, jobId, "cancelled");
  assert.equal(cancelled.isError, true);
  assert.doesNotMatch(readText(cancelled), /provider abort detail/);
  assert.match(readText(cancelled), /Do not replay/);
});

test("expired job status and same-request start cannot replay the operation", async () => {
  let now = 0;
  const manager = new JobManager({ ttlMs: 10, now: () => now });
  const requestId = randomUUID();
  let calls = 0;
  const operation = async () => {
    calls++;
    return { content: [{ type: "text" as const, text: "done" }] };
  };
  const started = manager.start(requestId, digest("expiring"), operation);
  const jobId = metadata(started).job_id;
  await waitFor(manager, jobId, "completed");
  now = 11;

  const expiredStatus = manager.status(jobId);
  assert.equal(expiredStatus.isError, true);
  assert.match(readText(expiredStatus), /Do not replay/);
  assert.match(readText(expiredStatus), /deepseek_sessions_list/);
  const repeatedStart = manager.start(requestId, digest("expiring"), operation);
  assert.equal(repeatedStart.isError, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
});

test("expiring and replacing jobs never evicts the request tombstone and replays an old write", async () => {
  let now = 0;
  const manager = new JobManager({ ttlMs: 1, maxJobs: 1, now: () => now });
  const firstId = randomUUID();
  let calls = 0;
  const operation = async () => { calls++; return { content: [] }; };
  const first = manager.start(firstId, digest("first"), operation);
  await waitFor(manager, metadata(first).job_id, "completed");
  now = 2;
  const second = manager.start(randomUUID(), digest("second"), operation);
  await waitFor(manager, metadata(second).job_id, "completed");
  now = 4;
  assert.equal(manager.start(firstId, digest("first"), operation).isError, true);
  assert.equal(calls, 2);
});

test("malformed request IDs and non-digest fingerprints fail before starting", () => {
  const manager = new JobManager();
  const badRequestId = manager.start("not-a-uuid", digest("input"), async () => ({ content: [] }));
  const badFingerprint = manager.start(randomUUID(), "raw user text", async () => ({ content: [] }));
  assert.equal(badRequestId.isError, true);
  assert.match(readText(badRequestId), /UUID/);
  assert.equal(badFingerprint.isError, true);
  assert.match(readText(badFingerprint), /SHA-256/);
});

test("operation exceptions are redacted and produce a failed job", async () => {
  const manager = new JobManager();
  const started = manager.start(randomUUID(), digest("throw"), async () => {
    throw new Error("secret cookie or provider body");
  });
  const failed = await waitFor(manager, metadata(started).job_id, "failed");
  assert.equal(failed.isError, true);
  assert.doesNotMatch(readText(failed), /secret cookie|provider body/);
  assert.match(readText(failed), /sessions_list/);
});
