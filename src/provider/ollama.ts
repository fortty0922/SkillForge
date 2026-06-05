import { LLMMessage, LLMProvider, LLMResponse } from "../types";
import { parseModelOutput } from "./parseResponse";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 min — local models can be slow

export class OllamaProvider implements LLMProvider {
  readonly modelName: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(
    baseUrl = "http://localhost:11434",
    model = "llama3",
    timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    this.baseUrl = baseUrl;
    this.modelName = model;
    this.timeoutMs = timeoutMs;
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.modelName,
          messages,
          stream: false,
          think: false,   // disable thinking mode for models that support it (e.g. qwen3)
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      const isTimeout =
        e.name === "AbortError" ||
        e.code === "UND_ERR_HEADERS_TIMEOUT" ||
        e.message?.includes("UND_ERR_HEADERS_TIMEOUT");

      if (isTimeout) {
        throw new Error(
          `Ollama timeout after ${this.timeoutMs / 1000}s — ` +
          `model="${this.modelName}". Try a smaller model or increase timeout via OLLAMA_TIMEOUT_MS.`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };

    const raw = data.choices[0]?.message?.content ?? "";
    return parseModelOutput(raw);
  }
}
