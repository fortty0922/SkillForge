// ── Core enumerations ──────────────────────────────────────────────

export type Level = "none" | "some" | "advanced" | null;
export type Step = "assess" | "generate" | "choose" | "attach" | "synthesize" | "done";
export type Preference = "concept-first" | "practice-first" | null;

// ── Content structures ─────────────────────────────────────────────

export interface Chapter {
  id: string;
  title: string;
  body: string;
}

export interface VideoAttachment {
  videoId: string;
  title: string;
  startTime: number; // seconds
  endTime: number;   // seconds
}

export interface VideoCandidate {
  videoId: string;
  title: string;
  description: string;
  channelTitle: string;
}

export interface TimestampEntry {
  startTime: number;
  endTime: number;
  label: string;
}

// ── Agent State ────────────────────────────────────────────────────

export interface AgentState {
  profile: {
    skill: string;
    level: Level;
    masteredConcepts: string[];
    preference: Preference;
  };
  planning: {
    currentStep: Step;
    directionChosen: boolean;
    attachCursor: number; // index into lecture array
  };
  content: {
    lecture: Chapter[];
    videoMap: Record<string, VideoAttachment>;
    candidateCache: Record<string, VideoCandidate[]>;
  };
  control: {
    assessRetries: number;
    searchRetries: Record<string, number>; // key = chapter id
    degraded: string[];                    // chapter ids that fell back
  };
}

// ── LLM Provider abstraction ───────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolCallIntent {
  tool: string;
  args: Record<string, unknown>;
}

export interface LLMResponse {
  text?: string;
  toolCall?: ToolCallIntent;
}

export interface LLMProvider {
  chat(messages: LLMMessage[]): Promise<LLMResponse>;
}

// ── Model routing ──────────────────────────────────────────────────

export type ModelName = "ollama" | "gemini";

export type StepModelPolicy = Record<Step, ModelName>;

// ── Step response contracts (align with State structure) ───────────

export interface AssessResponse {
  level: Level;
  masteredConcepts: string[];
  needMoreProbing: boolean;  // Obs1 signal
  nextQuestion: string;      // question to show user when needMoreProbing=true
}

export interface GenerateResponse {
  chapters: Chapter[];
}

export interface ChooseOption {
  key: Preference;
  label: string;
}

export interface ChooseResponse {
  options: ChooseOption[];
  recommendation: string;  // recommendation text shown to user
}

export interface Attach4aResponse {
  query: string;  // search query for YouTube
}

export interface Attach4bResponse {
  chosen: string;    // candidate title chosen
  videoId: string;
  startTime: number;
  endTime: number;
  adequate: boolean; // Obs3 signal — false triggers retry
}
