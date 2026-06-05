import { LLMResponse } from "../types";

// Remove <think>...</think> blocks emitted by reasoning models (e.g. qwen3).
function stripThinking(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// Strip markdown fences and leading/trailing noise, then parse JSON.
// Returns null if no valid JSON found.
function extractJson(raw: string): unknown | null {
  // Try direct parse first
  try {
    return JSON.parse(raw);
  } catch {}

  // Strip ```json ... ``` or ``` ... ```
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }

  // Find first { ... } block
  const braceStart = raw.indexOf("{");
  const braceEnd = raw.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(raw.slice(braceStart, braceEnd + 1));
    } catch {}
  }

  return null;
}

// Parse raw model output into LLMResponse.
// Expected JSON schema:
//   { "text": "...", "tool": "...", "args": {...} }
// If "tool" is present → toolCall; otherwise → text response.
export function parseModelOutput(raw: string): LLMResponse {
  const parsed = extractJson(stripThinking(raw));

  if (parsed && typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.tool === "string") {
      return {
        toolCall: {
          tool: obj.tool,
          args: (obj.args as Record<string, unknown>) ?? {},
        },
      };
    }
    if (typeof obj.text === "string") {
      return { text: obj.text };
    }
  }

  // Fallback: treat entire output as plain text
  return { text: raw.trim() };
}
