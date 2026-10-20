import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface JobOperationResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface JobMetadata {
  job_id: string;
  status: JobStatus;
  poll_after_seconds: number;
  elapsed_seconds: number;
  deadline_seconds: number;
  cancel_requested?: boolean;
}

/** MCP-compatible result. Job state is also exposed as MCP metadata for clients that support it. */
export interface JobToolResult extends JobOperationResult {
  _meta?: { web_ai_job: JobMetadata };
}

export interface JobManagerOptions {
  /** Maximum age of a settled job. Running jobs are never evicted. */
  ttlMs?: number;
  /** Maximum time an operation may run before its AbortSignal is triggered. */
  deadlineMs?: number;
  /** Maximum number of retained jobs (hard-capped at 32). */
  maxJobs?: number;
  /** Suggested delay between read-only status calls. */
  pollAfterSeconds?: number;
  /** Injectable clock for deterministic expiry tests. */
  now?: () => number;
}

interface JobRecord {
  id: string;
  requestId: string;
  fingerprint: string;
  status: JobStatus;
  startedAt: number;
  controller: AbortController;
  cancelRequested: boolean;
  operation?: (signal: AbortSignal) => Promise<JobOperationResult>;
  result?: JobOperationResult;
  settledAt?: number;
}

interface RequestRecord {
  jobId: string;
  fingerprint: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_DEADLINE_MS = 12 * 60_000;
const HARD_MAX_JOBS = 32;
const MAX_REQUEST_IDS = 1024;

function textResult(text: string, isError = false): JobToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function cloneResult(result: JobOperationResult): JobOperationResult {
  if (!Array.isArray(result.content) || result.content.some((item) => item.type !== "text" || typeof item.text !== "string")) {
    throw new Error("Invalid job operation result");
  }
  if (result.content.reduce((bytes, item) => bytes + Buffer.byteLength(item.text, "utf8"), 0) > 16 * 1024 * 1024) {
    throw new Error("Job result exceeds the in-memory size limit");
  }
  return {
    content: result.content.map(({ type, text }) => ({ type, text })),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

/**
 * Keeps long website operations alive independently of the MCP request that started them.
 * Only request IDs and SHA-256 fingerprints are retained; messages/results stay in process memory.
 */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly requests = new Map<string, RequestRecord>();
  private runningJobId?: string;
  private readonly ttlMs: number;
  private readonly deadlineMs: number;
  private readonly maxJobs: number;
  private readonly pollAfterSeconds: number;
  private readonly now: () => number;

  constructor(options: JobManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.maxJobs = options.maxJobs ?? HARD_MAX_JOBS;
    this.pollAfterSeconds = options.pollAfterSeconds ?? 10;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error("Job TTL must be a positive finite number");
    if (!Number.isFinite(this.deadlineMs) || this.deadlineMs <= 0) throw new Error("Job deadline must be a positive finite number");
    if (!Number.isInteger(this.maxJobs) || this.maxJobs < 1 || this.maxJobs > HARD_MAX_JOBS) {
      throw new Error(`Job capacity must be between 1 and ${HARD_MAX_JOBS}`);
    }
    if (!Number.isFinite(this.pollAfterSeconds) || this.pollAfterSeconds < 1) {
      throw new Error("Job poll interval must be at least one second");
    }
  }

  /**
   * Starts an operation on the next microtask and immediately returns its job ID.
   * Reusing a request ID with the same digest is idempotent; a different digest is rejected.
   */
  start(
    requestId: string,
    fingerprint: string,
    operation: (signal: AbortSignal) => Promise<JobOperationResult>,
  ): JobToolResult {
    this.cleanup();
    if (!UUID_PATTERN.test(requestId)) return textResult("request_id must be a UUID.", true);
    if (!SHA256_PATTERN.test(fingerprint)) return textResult("fingerprint must be a SHA-256 hex digest.", true);
    requestId = requestId.toLowerCase();
    fingerprint = fingerprint.toLowerCase();

    const prior = this.requests.get(requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return textResult("request_id is already bound to a different request. Do not reuse it for changed input.", true);
      }
      const existing = this.jobs.get(prior.jobId);
      if (!existing) return this.unknownJobResult("The job for this request has expired. Do not replay it.");
      return this.snapshot(existing);
    }

    if (this.runningJobId) return textResult("busy: another website operation is running. This request was not queued; wait and submit it with a fresh request_id.", true);
    if (this.jobs.size >= this.maxJobs) return textResult("busy: the in-memory job queue is full. Settled jobs expire automatically; this request was not queued.", true);
    if (this.requests.size >= MAX_REQUEST_IDS) return textResult("Request ID capacity reached. Read any pending results and explicitly restart MCP before submitting new work; this request was not queued.", true);

    const job: JobRecord = {
      id: randomUUID(),
      requestId,
      fingerprint,
      status: "running",
      startedAt: this.now(),
      controller: new AbortController(),
      cancelRequested: false,
      operation,
    };
    this.jobs.set(job.id, job);
    this.requests.set(requestId, { jobId: job.id, fingerprint });
    this.runningJobId = job.id;

    // The callback runs only after this synchronous acknowledgement has been returned.
    queueMicrotask(() => { void this.execute(job); });
    return this.snapshot(job);
  }

  /** Returns a read-only snapshot. Polling never calls the website operation. */
  status(jobId: string): JobToolResult {
    this.cleanup();
    const job = this.jobs.get(jobId.toLowerCase());
    if (!job) return this.unknownJobResult();
    return this.snapshot(job);
  }

  /** Requests local cancellation. The website may already have accepted the request. */
  cancel(jobId: string): JobToolResult {
    this.cleanup();
    const job = this.jobs.get(jobId.toLowerCase());
    if (!job) return this.unknownJobResult();
    if (job.status !== "running") return this.snapshot(job);
    if (!job.cancelRequested) {
      job.cancelRequested = true;
      job.controller.abort(new Error("Local cancellation requested"));
    }
    return this.snapshot(job);
  }

  private async execute(job: JobRecord): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      if (job.controller.signal.aborted) {
        job.result = textResult("The operation was cancelled before it started. This does not establish whether an earlier website request was accepted.", true);
        job.status = "cancelled";
        return;
      }

      timer = setTimeout(() => {
        job.controller.abort(new Error("Job deadline exceeded"));
      }, this.deadlineMs);
      // A background request must not keep the MCP process alive after all clients exit.
      timer.unref?.();

      const result = await job.operation!(job.controller.signal);
      job.result = cloneResult(result);
      job.status = job.cancelRequested ? "cancelled" : result.isError ? "failed" : "completed";
    } catch {
      job.result = textResult(
        job.cancelRequested
          ? "Local cancellation was requested, but the website outcome may be uncertain. Do not replay this request; verify the session with the corresponding provider's sessions_list tool."
          : "The background operation failed or timed out; the website outcome may be uncertain. Do not replay this request; verify the session with the corresponding provider's sessions_list tool.",
        true,
      );
      job.status = job.cancelRequested ? "cancelled" : "failed";
    } finally {
      if (timer) clearTimeout(timer);
      job.operation = undefined;
      job.settledAt = this.now();
      if (this.runningJobId === job.id) this.runningJobId = undefined;
      const expiry = setTimeout(() => {
        job.result = undefined;
        this.jobs.delete(job.id);
      }, this.ttlMs);
      expiry.unref();
      this.cleanup();
    }
  }

  private metadata(job: JobRecord): JobMetadata {
    return {
      job_id: job.id,
      status: job.status,
      poll_after_seconds: this.pollAfterSeconds,
      elapsed_seconds: Math.max(0, Math.floor(((job.settledAt ?? this.now()) - job.startedAt) / 1000)),
      deadline_seconds: Math.ceil(this.deadlineMs / 1000),
      ...(job.cancelRequested ? { cancel_requested: true } : {}),
    };
  }

  private snapshot(job: JobRecord): JobToolResult {
    const metadata = this.metadata(job);
    if (job.status === "running") {
      return {
        ...textResult(JSON.stringify({
          ...metadata,
          message: job.cancelRequested
            ? "Local cancellation requested. This cannot undo a request already accepted by the website; poll status and verify sessions before continuing."
            : "Operation is running. Polling status is read-only and will not submit the message again.",
        })),
        _meta: { web_ai_job: metadata },
      };
    }

    const result = job.result ?? textResult("The job finished without a result.", true);
    const cloned = cloneResult(result);
    cloned.content.push({ type: "text", text: `Job metadata: ${JSON.stringify(metadata)}` });
    return { ...cloned, _meta: { web_ai_job: metadata } };
  }

  private unknownJobResult(detail = "Unknown or expired job ID."): JobToolResult {
    return textResult(`${detail} Do not replay the original request. Use the corresponding provider's sessions_list tool and the official website to check state; the local list alone cannot confirm website acceptance.`, true);
  }

  private cleanup(): void {
    const now = this.now();
    for (const [id, job] of this.jobs) {
      // A running operation is never evicted. A settled cancellation is terminal and safe to age out.
      if (job.status !== "running" && job.settledAt !== undefined && now - job.settledAt >= this.ttlMs) {
        this.jobs.delete(id);
      }
    }
  }
}
