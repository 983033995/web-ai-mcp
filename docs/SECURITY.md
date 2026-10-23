# Security, authorization and known limits

## Web authentication
Use user-provided own-account website credentials only. Treat every token or Cookie string as a password. Never persist credentials in Git history, log output, issue bodies, session stores or screenshots.

| Provider | Credential shape | Notes |
| --- | --- | --- |
| DeepSeek | `DEEPSEEK_USER_TOKEN` (Local Storage `userToken`) | No email/password login automation or browser cookie extraction. |
| Doubao (experimental) | `DOUBAO_COOKIE` plus captured chat URL and User-Agent | Must include the website session Cookie fields the user copied from a normal browser session. Do not invent device fingerprints or request signatures. |
| Gemini (experimental, source) | `GEMINI_COOKIE` + `GEMINI_USER_AGENT`, or a private `GEMINI_ACCOUNTS_FILE` | Multi-account JSON is for **ordered media-quota routing** after a definitive quota rejection—not credential pooling, scraping or rotation of logins. Cookies are never written into the session lineage store. |

No automatic browser login, ambient cookie scraping or silent credential refresh beyond re-reading an explicitly configured private accounts file before a new operation.

## Website usage
Upstream website interfaces are private, unsupported and changeable without notice. Normal access restrictions still apply. Stop and return actionable errors for 401/403/429, CAPTCHA/WAF, session expiry and unsupported request schemas. Do not circumvent restrictions or impersonate official APIs.

## Local file data
File analysis and media reference uploads transfer local data to the selected website. Require an explicit root allowlist via `WEB_AI_ALLOWED_ROOTS`. Entries and selected file paths **must be absolute**. Resolve real paths (including symlinks), enforce byte quotas, reject files outside allowed roots. Limit by default to <=5 files, <=10 MiB each, <=20 MiB total. Tool errors redact local absolute paths (basename only) in addition to credential redaction. Do not read sensitive files merely to demonstrate functionality.

Media downloads write only under an existing absolute `WEB_AI_MEDIA_DIR`; that directory never grants upload rights.

## MCP scope
stdio means the calling local process receives the tools; it does not grant API/web-service usage rights. Do not turn it into an unauthenticated network MCP service. Never conflate user-visible reasoning fragments with guaranteed access to internal model reasoning.

## Sessions
Conversation IDs/session keys are not credentials; raw website lineage must not be logged or committed. The project-private store preserves IDs, optional user-selected names, website lineage and timestamps across restarts, but never tokens, Cookies, dialogue, uploaded files or message-derived titles. The store defaults to `<WEB_AI_PROJECT_ROOT or cwd>/.web-ai-mcp/sessions.json`; keep it out of Git and isolate it per website account. Gemini may keep a separate secret-free cooldown file beside the session store. Local expiry is disabled by default; a positive TTL opts in. Expired/unknown IDs fail closed.

Disk writes use atomic rename and private file permissions (0600/0700 where supported). A file lease spans each chat request, preventing concurrent MCP processes from competing on the same parent ID. Pending state is committed before dispatch; a crash or ambiguous outcome remains blocked on restart rather than resuming from stale lineage. A stale lock is not automatically stolen. Confirm its process has stopped before removing it, then explicitly close the interrupted conversation.

An ambiguous completion failure (network loss, malformed stream, timeout or cancellation after dispatch) marks the local ID/name uncertain; it cannot silently reopen a new conversation. Known provider rejections preserve the last committed state. A completed reply without a response message ID is returned as nonresumable. Transports never retry chat/file writes automatically, reject redirects, and accept only the intended website origin or a loopback fixture URL. HTTP 401 and observed website authentication failures prompt a secure credential update and server restart; 403/429 are not mislabeled as token expiry.

## Upstream license review
The upstream README states MIT, but its root license file and origin of its embedded WASM require independent verification before code redistribution. Import pinned source locally rather than checking copied third-party code into this public repository. See THIRD_PARTY_NOTICES.md.
