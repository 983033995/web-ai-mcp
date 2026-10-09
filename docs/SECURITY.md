# Security, authorization and known limits

## Web authentication
Use a user-provided DEEPSEEK_USER_TOKEN for the user's own DeepSeek Web account. No email/password login automation, browser cookie extraction, account pooling or credential rotation in MVP. Treat the token as a password. Never persist it in Git history, log output, issue bodies or screenshots.

## Website usage
The upstream DeepSeek website interface is private, unsupported and changeable without notice. Normal access restrictions still apply. Stop and return actionable errors for 401/403/429, CAPTCHA/WAF, session expiry and unsupported request schemas. Do not circumvent restrictions or impersonate official APIs.

## Local file data
deepseek_analyze_files transfers local data to DeepSeek Web. Require an explicit root allowlist. Resolve real paths (including symlinks), enforce byte quotas, reject files outside allowed roots. Limit by default to <=5 files, <=10 MiB each, <=20 MiB total. Do not read sensitive files merely to demonstrate functionality.

## MCP scope
stdio means the calling local process receives the tools; it does not grant API/web-service usage rights. Do not turn it into an unauthenticated network MCP service. Never conflate user-visible reasoning fragments with guaranteed access to internal model reasoning.

## Sessions
Conversation IDs/session keys are not credentials; raw website lineage must not be logged or committed. The project-private store preserves IDs, optional user-selected names, website lineage and timestamps across restarts, but never tokens, dialogue, uploaded files or message-derived titles. The store defaults to `<WEB_AI_PROJECT_ROOT or cwd>/.web-ai-mcp/sessions.json`; keep it out of Git and isolate it per website account. Local expiry is disabled by default; a positive TTL opts in. Expired/unknown IDs fail closed.

Disk writes use atomic rename and private file permissions (0600/0700 where supported). A file lease spans each chat request, preventing concurrent MCP processes from competing on the same parent ID. Pending state is committed before dispatch; a crash or ambiguous outcome remains blocked on restart rather than resuming from stale lineage. A stale lock is not automatically stolen. Confirm its process has stopped before removing it, then explicitly close the interrupted conversation.

An ambiguous completion failure (network loss, malformed stream, timeout or cancellation after dispatch) marks the local ID/name uncertain; it cannot silently reopen a new conversation. Known provider rejections preserve the last committed state. A completed reply without a response message ID is returned as nonresumable. The transport never retries chat/file writes automatically, rejects redirects, and accepts only the DeepSeek website origin or a loopback fixture URL. HTTP 401 and observed website authentication code 40003 prompt a secure token update and server restart; 403/429 are not mislabeled as token expiry.

## Upstream license review
The upstream README states MIT, but its root license file and origin of its embedded WASM require independent verification before code redistribution. Import pinned source locally rather than checking copied third-party code into this public repository. See THIRD_PARTY_NOTICES.md.
