import { createHash } from "node:crypto";
import { GeminiWebError, authenticationError } from "./errors.js";
import { parseGeminiTextHistory } from "./history.js";
import type { GeminiSelectedReply } from "./web-client.js";
import { parseGeminiRpc } from "./web-client.js";
import { parseGeminiModels, type GeminiModelCatalog } from "./selection.js";

export interface BrowserChatInput {
  spaceId: number;
  email: string;
  message: string;
  model?: string;
  thinkingLevel: "low" | "medium" | "high";
  previous?: { conversationId: string; replyId: string; candidateId: string; accountHash: string };
  files: string[];
  timeoutMs: number;
}

/** Only the documented ego-browser surface; no browser launch or attestation APIs. */
interface Page {
  label: string;
  goto(url: string): Promise<unknown>;
  url(): Promise<string>;
  snapshot(): Promise<string>;
  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  click(selector: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<unknown>;
  press(selector: string, key: string): Promise<unknown>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg: A, options: { timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, options: { state: "visible" | "hidden"; timeout: number }): Promise<unknown>;
  waitForFileChooser(options: { timeout: number }): Promise<{ setFiles(paths: string[]): Promise<unknown> }>;
}
export interface BrowserRuntime {
  taskSpace(id: number): Promise<{ page(label: string): Page }>;
}

export type BrowserModelsInput = Pick<BrowserChatInput, "spaceId" | "email" | "timeoutMs">;

/** Uses the existing website login for read-only model discovery; never refreshes cookies. */
export async function browserModels(input: BrowserModelsInput, runtime: BrowserRuntime): Promise<GeminiModelCatalog> {
  const task = await runtime.taskSpace(input.spaceId), page = task.page("p1");
  if (new URL(await page.url()).origin !== "https://gemini.google.com") throw new GeminiWebError("configuration_error", "The configured browser Page must be on Gemini");
  const raw = await page.evaluate(async ({ email }) => {
    const data = (window as unknown as { WIZ_global_data?: Record<string, string> }).WIZ_global_data;
    if (!data?.oPEP7c || data.oPEP7c.toLowerCase() !== email.toLowerCase()) return { auth: false as const };
    const url = new URL("/_/BardChatUi/data/batchexecute", location.origin);
    url.search = new URLSearchParams({ rpcids: "otAQ7b", "source-path": "/app", bl: data.cfb2h,
      "f.sid": data.FdrFJe, hl: "en", _reqid: "100000", rt: "c" }).toString();
    const response = await fetch(url, { method: "POST", credentials: "same-origin", redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
      body: new URLSearchParams({ at: data.SNlM0e, "f.req": JSON.stringify([[["otAQ7b", "[]", null, "generic"]]]) }) });
    return { auth: true as const, status: response.status, text: await response.text() };
  }, { email: input.email });
  if (!raw.auth) throw authenticationError();
  if (raw.status !== 200 || Buffer.byteLength(raw.text) > 256 * 1024) throw new GeminiWebError("invalid_response", "Browser model discovery failed");
  return parseGeminiModels(parseGeminiRpc(raw.text, "otAQ7b"));
}

const picker = 'loc=css:button[aria-label^="Open mode picker"]';
const editor = 'loc=css:[contenteditable="true"][role="textbox"][aria-label="Enter a prompt for Gemini"]';

/** One normal UI send. Existing replies are checked read-only; errors never replay a send. */
export async function browserChat(input: BrowserChatInput, runtime: BrowserRuntime): Promise<GeminiSelectedReply> {
  let sent = false;
  let phase = "preflight";
  const deadline = Date.now() + input.timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const task = await runtime.taskSpace(input.spaceId);
  const page = task.page("p1");
  const fail = (code: string, message: string): never => { throw new GeminiWebError(code, message, sent); };
  const state = () => page.evaluate(() => {
    const context = (window as unknown as { WIZ_global_data?: Record<string, string> }).WIZ_global_data;
    const replies = [...document.querySelectorAll('model-response message-content[id]')];
    return { email: context?.oPEP7c ?? "", path: location.pathname,
      replyId: replies.at(-1)?.id.replace(/^message-content-id-/, ""),
      busy: Boolean(document.querySelector('button[aria-label="Stop response"]')),
      draft: document.querySelector('[contenteditable="true"][role="textbox"][aria-label="Enter a prompt for Gemini"]')?.textContent?.trim() ?? "",
      attachments: document.querySelectorAll('button[aria-label^="close "]').length,
      userTurns: document.querySelectorAll("user-query").length };
  });
  const verifyOwner = (email: string) => {
    if (email.trim().toLowerCase() !== input.email.toLowerCase()) throw authenticationError(sent);
  };
  const history = async (conversationId: string, replyId: string, candidateId?: string) => {
    const raw = await page.evaluate(async ({ conversationId }) => {
      const data = (window as unknown as { WIZ_global_data: Record<string, string> }).WIZ_global_data;
      const url = new URL("/_/BardChatUi/data/batchexecute", location.origin);
      url.search = new URLSearchParams({ rpcids: "hNvQHb", "source-path": "/app", bl: data.cfb2h,
        "f.sid": data.FdrFJe, hl: "en", _reqid: "100000", rt: "c" }).toString();
      const payload = [conversationId, 10, null, 1, [1], [4], null, 1];
      const response = await fetch(url, { method: "POST", credentials: "same-origin", redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
        body: new URLSearchParams({ at: data.SNlM0e, "f.req": JSON.stringify([[["hNvQHb", JSON.stringify(payload), null, "generic"]]]) }) });
      if (!response.ok) throw new Error("Browser history request failed");
      return response.text();
    }, { conversationId });
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) fail("invalid_response", "Oversized browser history");
    return parseGeminiTextHistory(new Response(raw).body!, AbortSignal.timeout(remaining()), replyId, candidateId);
  };

  try {
    if (new URL(await page.url()).origin !== "https://gemini.google.com") fail("configuration_error", "The configured browser Page must already be on Gemini");
    const initial = await state();
    verifyOwner(initial.email);
    if (initial.busy || initial.draft || initial.attachments) fail("session_state_error", "The configured browser Page is busy or contains a draft");
    phase = "navigation";
    const path = input.previous ? `/app/${input.previous.conversationId.slice(2)}` : "/app";
    if (initial.path !== path) {
      try { await page.goto("https://gemini.google.com" + path); }
      catch (error) { if (!(error instanceof Error) || error.name !== "PageNavigationTimeoutError") throw error; }
    }
    await page.waitForSelector(editor, { state: "visible", timeout: Math.min(15_000, remaining()) });
    if (input.previous) await page.waitForFunction(() => document.querySelector('model-response message-content[id]'), undefined,
      { timeout: Math.min(15_000, remaining()) });
    let current = await state();
    verifyOwner(current.email);
    if (current.path !== path || current.busy || current.draft || current.attachments) fail("session_state_error", "The browser conversation is unavailable or busy");
    const accountHash = createHash("sha256").update(current.email.trim().toLowerCase()).digest("hex");
    if (input.previous) {
      if (accountHash !== input.previous.accountHash) throw authenticationError();
      if (current.replyId !== input.previous.replyId) fail("session_state_error", "The browser conversation advanced outside this MCP session");
      await history(input.previous.conversationId, input.previous.replyId, input.previous.candidateId);
    }

    phase = "model selection";
    await page.waitForSelector(picker, { state: "visible", timeout: Math.min(30_000, remaining()) });
    await page.press(editor, "Escape");
    await page.snapshot();
    await page.click(picker);
    await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].some(element => element.getClientRects().length), undefined, { timeout: 5000 });
    const models = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].filter(element => element.getClientRects().length).map(element => {
      const lines = (element.textContent ?? "").trim();
      const text = (element as HTMLElement).innerText.split("\n").map(line => line.trim()).filter(Boolean);
      return { text, selected: lines.includes("check") };
    }));
    const selected = input.model ? models.filter(item => item.text.includes(input.model!)) : models.filter(item => item.selected);
    if (selected.length !== 1) fail("invalid_request", "The browser model must exactly match a visible picker option");
    const model = input.model ?? selected[0].text.find(line => line !== "check");
    if (!model) fail("invalid_response", "The browser model picker did not identify a model");
    await page.click(`loc=role:menuitem[name*=${JSON.stringify(model)}]`);
    phase = "thinking selection";
    await page.click(picker);
    await page.click('text="Thinking level"');
    const level = input.thinkingLevel[0].toUpperCase() + input.thinkingLevel.slice(1);
    await page.waitForSelector(`loc=role:menuitem[name*=${JSON.stringify(level)}]`, { state: "visible", timeout: 5000 });
    await page.click(`loc=role:menuitem[name*=${JSON.stringify(level)}]`);

    if (input.files.length) {
      phase = "upload";
      await page.click('loc=css:button[aria-label="Upload and tools"]');
      const upload = 'loc=css:button[aria-label="Upload files. Documents, data, code files"]';
      await page.waitForSelector(upload, { state: "visible", timeout: 5000 });
      const chooser = page.waitForFileChooser({ timeout: 10_000 });
      await page.click(upload);
      await (await chooser).setFiles(input.files);
      // The UI truncates filenames. Confirm the submitted file count and the native ready-to-send state.
      await page.waitForFunction(count => document.querySelectorAll('button[aria-label^="close "]').length === count &&
        ![...document.querySelectorAll('[role="progressbar"]')].some(element => element.getClientRects().length) &&
        document.querySelector('button[aria-label="Send message"]:not([disabled])'), input.files.length,
      { timeout: Math.min(60_000, remaining()) });
    }
    phase = "send preflight";
    current = await state();
    verifyOwner(current.email);
    if (current.busy || current.draft || current.attachments !== input.files.length) fail("session_state_error", "The browser Page changed before sending");
    await page.fill(editor, input.message);
    const send = 'loc=css:button[aria-label="Send message"]';
    await page.waitForSelector(send, { state: "visible", timeout: Math.min(15_000, remaining()) });
    sent = true;
    phase = "native send";
    await page.click(send);
    await page.waitForFunction(({ replyId, userTurns }) => {
      const latest = [...document.querySelectorAll('model-response message-content[id]')].at(-1);
      return document.querySelectorAll("user-query").length > userTurns && latest &&
        latest.id !== "message-content-id-" + replyId && latest.textContent?.trim() &&
        !document.querySelector('button[aria-label="Stop response"]');
    }, { replyId: current.replyId, userTurns: current.userTurns }, { timeout: remaining() });
    phase = "history confirmation";
    const completed = await state();
    verifyOwner(completed.email);
    const match = /^\/app\/([A-Za-z0-9_-]+)$/.exec(completed.path);
    if (!match || !completed.replyId || !/^r_[A-Za-z0-9_-]+$/.test(completed.replyId)) return fail("invalid_response", "The browser reply has no verified lineage");
    const conversationId = "c_" + match[1];
    if (input.previous && conversationId !== input.previous.conversationId) fail("session_state_error", "The browser changed conversation");
    const result = await history(conversationId, completed.replyId);
    return { ...result, conversationId, accountHash, model, thinkingLevel: input.thinkingLevel };
  } catch (error) {
    if (error instanceof GeminiWebError) throw new GeminiWebError(error.code, error.message, sent || error.sessionUncertain);
    const failure = new GeminiWebError("browser_error", `Gemini browser interaction failed during ${phase}; inspect the configured Page before any further write`, sent);
    failure.cause = error;
    throw failure;
  }
}
