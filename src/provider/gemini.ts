import { LLMMessage, LLMProvider, LLMResponse } from "../types";
import { parseModelOutput } from "./parseResponse";

interface GeminiContent {
  role: "user" | "model";
  parts: { text: string }[];
}

function toGeminiMessages(messages: LLMMessage[]): {
  system: string | null;
  contents: GeminiContent[];
} {
  let system: string | null = null;
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      system = m.content;
    } else {
      contents.push({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.content }],
      });
    }
  }

  return { system, contents };
}

export class GeminiProvider implements LLMProvider {
  readonly modelName: string;
  private apiKey: string;

  constructor(apiKey: string, model = "gemini-1.5-flash") {
    this.apiKey = apiKey;
    this.modelName = model;
  }

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const { system, contents } = toGeminiMessages(messages);

    const body: Record<string, unknown> = { contents };
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] };
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${this.modelName}:generateContent?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      candidates: { content: { parts: { text: string }[] } }[];
    };

    const raw = data.candidates[0]?.content?.parts[0]?.text ?? "";
    return parseModelOutput(raw);
  }
}
