import { Worker } from "node:worker_threads";
import { DeepSeekWebError } from "./errors.js";

export interface PowChallenge {
  algorithm: string; challenge: string; salt: string; difficulty: number;
  expire_at: number; signature: string; target_path: string;
}

// ABI observed in the pinned upstream client; WASM remains a local-only import.
// The synchronous solver runs off the MCP thread so cancellation can interrupt it.
const workerSource = String.raw`
(async () => {
  const { parentPort, workerData } = await import("node:worker_threads");
  const { module, challenge } = workerData;
  const { exports: api } = await WebAssembly.instantiate(module);
  const encode = (text) => {
    const bytes = new TextEncoder().encode(text);
    const pointer = api.__wbindgen_export_0(bytes.length, 1);
    new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
    return [pointer, bytes.length];
  };
  const result = api.__wbindgen_add_to_stack_pointer(-16);
  try {
    const hash = encode(challenge.challenge);
    const prefix = encode(challenge.salt + "_" + challenge.expire_at + "_");
    api.wasm_solve(result, ...hash, ...prefix, challenge.difficulty);
    const view = new DataView(api.memory.buffer);
    if (view.getInt32(result, true) === 0) throw new Error("Unsolved challenge");
    const answer = view.getFloat64(result + 8, true);
    if (!Number.isSafeInteger(answer) || answer < 0) throw new Error("Invalid answer");
    parentPort.postMessage(answer);
  } finally { api.__wbindgen_add_to_stack_pointer(16); }
})().catch(() => { throw new Error("DeepSeek Web PoW solver failed"); });
`;

export async function solvePow(module: WebAssembly.Module, challenge: PowChallenge, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  if (challenge.algorithm !== "DeepSeekHashV1") {
    throw new DeepSeekWebError("pow_algorithm_error", "Unsupported DeepSeek Web PoW algorithm");
  }
  const worker = new Worker(workerSource, { eval: true, execArgv: [], workerData: { module, challenge } });
  try {
    return await new Promise<number>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", (answer: number) => { signal.removeEventListener("abort", abort); resolve(answer); });
      worker.once("error", () => {
        signal.removeEventListener("abort", abort);
        reject(new DeepSeekWebError("pow_solve_error", "DeepSeek Web PoW solver failed"));
      });
      worker.once("exit", (code) => {
        signal.removeEventListener("abort", abort);
        if (code !== 0) reject(new DeepSeekWebError("pow_solve_error", "DeepSeek Web PoW worker exited"));
      });
    });
  } finally { await worker.terminate(); }
}
