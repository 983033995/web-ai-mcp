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
Session keys are not credentials; remote session metadata must not be logged. Expired/unknown keys fail closed. State is in memory, so restarts lose it. Concurrent requests to one session are rejected until the first completes.

## Upstream license review
The upstream README states MIT, but its root license file and origin of its embedded WASM require independent verification before code redistribution. Import pinned source locally rather than checking copied third-party code into this public repository. See THIRD_PARTY_NOTICES.md.
