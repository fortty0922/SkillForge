import * as fs from "fs";
import * as path from "path";
import {
  AgentState,
  LLMMessage,
  VideoCandidate,
  TimestampEntry,
} from "../types";

// ── File loader (cache after first read) ──────────────────────────

const PROMPTS_DIR = path.join(__dirname, "../../prompts");
const cache: Record<string, string> = {};

function loadPrompt(name: string): string {
  if (!cache[name]) {
    cache[name] = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf-8").trim();
  }
  return cache[name];
}

// ── Template renderer ─────────────────────────────────────────────
// Replaces {{key}} placeholders with values. Missing keys become "".

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

// ── Compose system message: base + step prompt ────────────────────

function system(stepContent: string): LLMMessage {
  return {
    role: "system",
    content: `${loadPrompt("base")}\n\n${stepContent}`,
  };
}

// ── Prompt registry ────────────────────────────────────────────────

export function buildAssessMessages(
  state: AgentState,
  userInput: string
): LLMMessage[] {
  const knownConcepts = state.profile.masteredConcepts.length
    ? ` User already knows: ${state.profile.masteredConcepts.join(", ")}.`
    : "";

  return [
    system(render(loadPrompt("assess"), {
      skill: state.profile.skill,
      knownConcepts,
    })),
    { role: "user", content: userInput },
  ];
}

export function buildGenerateMessages(state: AgentState): LLMMessage[] {
  const { skill, level, masteredConcepts, preference } = state.profile;

  return [
    system(render(loadPrompt("generate"), {
      skill,
      level: level ?? "unknown",
      skipTopics: masteredConcepts.length
        ? ` Skip these already-mastered topics: ${masteredConcepts.join(", ")}.`
        : "",
      learningStyle: preference ? ` Learning style: ${preference}.` : "",
    })),
    { role: "user", content: "Generate the lecture now." },
  ];
}

export function buildChooseMessages(
  state: AgentState,
  userInput: string
): LLMMessage[] {
  const outline = state.content.lecture
    .map((ch) => `- ${ch.title}`)
    .join("\n");

  return [
    system(render(loadPrompt("choose"), {
      skill: state.profile.skill,
      level: state.profile.level ?? "unknown",
    })),
    {
      role: "user",
      content: `Curriculum outline:\n${outline}\n\nUser preference input: "${userInput}"`,
    },
  ];
}

export function buildAttach4aMessages(
  chapterTitle: string,
  state: AgentState
): LLMMessage[] {
  return [
    system(loadPrompt("attach-4a")),
    {
      role: "user",
      content:
        `Skill: "${state.profile.skill}" | Level: "${state.profile.level}"\n` +
        `Chapter title: "${chapterTitle}"`,
    },
  ];
}

export function buildAttach4bMessages(
  chapterTitle: string,
  candidates: VideoCandidate[],
  timestamps: TimestampEntry[]
): LLMMessage[] {
  const candidateList = candidates
    .map((c, i) => `${i}. [${c.videoId}] "${c.title}" by ${c.channelTitle}`)
    .join("\n");

  const tsInfo =
    timestamps.length > 0
      ? timestamps.map((t) => `  ${t.startTime}s–${t.endTime}s: ${t.label}`).join("\n")
      : "  (no chapter timestamps found)";

  return [
    system(loadPrompt("attach-4b")),
    {
      role: "user",
      content:
        `Chapter: "${chapterTitle}"\n\n` +
        `Candidates:\n${candidateList}\n\n` +
        `Timestamps from top candidate:\n${tsInfo}`,
    },
  ];
}
