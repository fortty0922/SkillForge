import { LLMProvider, ModelName, Step, StepModelPolicy } from "../types";
import { OllamaProvider } from "./ollama";
import { GeminiProvider } from "./gemini";

export const DEFAULT_POLICY: StepModelPolicy = {
  assess:    "ollama",
  generate:  "gemini",
  choose:    "ollama",
  attach:    "gemini",
  synthesize:"gemini",
  done:      "ollama",
};

export interface ProviderConfig {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
}

export class ProviderFactory {
  private ollama: OllamaProvider;
  private gemini: GeminiProvider | null;
  private policy: StepModelPolicy;

  constructor(config: ProviderConfig = {}, policy: Partial<StepModelPolicy> = {}) {
    this.ollama = new OllamaProvider(config.ollamaBaseUrl, config.ollamaModel);
    this.gemini = config.geminiApiKey
      ? new GeminiProvider(config.geminiApiKey, config.geminiModel)
      : null;
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  forStep(step: Step): LLMProvider {
    const name: ModelName = this.policy[step];
    if (name === "gemini") {
      if (!this.gemini) {
        // Fallback to Ollama when Gemini key is absent
        return this.ollama;
      }
      return this.gemini;
    }
    return this.ollama;
  }
}
