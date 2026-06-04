import { LLMMessage, LLMProvider, LLMResponse } from "../types";
import { parseModelOutput } from "./parseResponse";

export class OllamaProvider implements LLMProvider {
  readonly modelName: string;
  private baseUrl: string;

  constructor(baseUrl = "http://localhost:11434", model = "llama3") {
    this.baseUrl = baseUrl;
    this.modelName = model;
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.modelName,
        messages,
        stream: false,
      }),
    });

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
