import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JobManager } from "../core/jobs.js";
import { USAGE } from "./guidance.js";

export function registerCommonTools(server: McpServer, jobs: JobManager): void {
  server.registerTool("webai_usage", {
    description: "Read before first Web AI call: required arguments, session lifecycle, long-task submission/polling, timeout and quota stop rules. Read-only; no website requests.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ({ content: [{ type: "text", text: USAGE }] }));
  server.registerTool("webai_job_status", {
    description: "Read an existing background job, returning running/completed/failed/cancelled and the original answer/key when finished. Wait poll_after_seconds between checks. Does not send website messages. Unknown/expired job: stop and inspect sessions/website, never replay. Results are process-local and retained 30 minutes after completion.",
    inputSchema: { job_id: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ job_id }) => ({ ...jobs.status(job_id) }));
  server.registerTool("webai_job_cancel", {
    description: "Explicitly cancel local waiting for a background job. Cannot undo a website request. Continue polling until settled; verify session state before any new write. Never automatically replay cancelled work.",
    inputSchema: { job_id: z.string().uuid() },
  }, async ({ job_id }) => ({ ...jobs.cancel(job_id) }));
}
