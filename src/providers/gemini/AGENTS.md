# Gemini provider notes

- Live smoke conversations must use ordinary, non-sensitive prompts. Never mention testing, MCP, or technical markers in website messages.
- Use only the owner's current Gemini Web login and normal browser User-Agent. Do not rotate accounts, retry ambiguous writes, or bypass verification.
- Keep cookies, request tokens, account email, and raw website responses in memory only. Persist only validated conversation lineage and the account hash.
- Treat `di`/`af.httprm` numeric metadata as opaque; observed values can differ and vary by turn. Validate structure, complete framing and final accounting without inventing equality or fixed-value requirements.
