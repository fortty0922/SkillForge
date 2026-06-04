import {
  AgentState,
  Preference,
  VideoAttachment,
  VideoCandidate,
  AssessResponse,
  ChooseResponse,
  Attach4aResponse,
  Attach4bResponse,
} from "../types";
import { ProviderFactory } from "../provider/factory";
import { searchYouTube } from "../tools/youtubeSearch";
import { parseTimestamps } from "../tools/metadataParser";

type SearchFn = (query: string, apiKey: string) => Promise<VideoCandidate[]>;
import {
  buildAssessMessages,
  buildGenerateMessages,
  buildChooseMessages,
  buildAttach4aMessages,
  buildAttach4bMessages,
} from "./prompts";

const MAX_ASSESS_RETRIES = 2;
const MAX_SEARCH_RETRIES = 2;

export interface AgentIO {
  getUserInput(prompt: string): Promise<string>;
  output(text: string): void;
}

export class AgentLoop {
  private state: AgentState;
  private factory: ProviderFactory;
  private io: AgentIO;
  private youtubeApiKey: string;
  private searchFn: SearchFn;

  constructor(
    state: AgentState,
    factory: ProviderFactory,
    io: AgentIO,
    youtubeApiKey = "",
    searchFn: SearchFn = searchYouTube
  ) {
    this.state = state;
    this.factory = factory;
    this.io = io;
    this.youtubeApiKey = youtubeApiKey;
    this.searchFn = searchFn;
  }

  async run(): Promise<AgentState> {
    while (this.state.planning.currentStep !== "done") {
      const step = this.state.planning.currentStep;
      this.io.output(`[step: ${step}]`);

      switch (step) {
        case "assess":    await this.stepAssess();    break;
        case "generate":  await this.stepGenerate();  break;
        case "choose":    await this.stepChoose();    break;
        case "attach":    await this.stepAttach();    break;
        case "synthesize":await this.stepSynthesize();break;
      }
    }
    return this.state;
  }

  // ── Step 1: assess ────────────────────────────────────────────────

  private async stepAssess(): Promise<void> {
    const s = this.state;
    const userInput = await this.io.getUserInput(
      `Tell me about your experience with "${s.profile.skill}".`
    );

    const provider = this.factory.forStep("assess");
    const response = await provider.chat(buildAssessMessages(s, userInput));
    const payload = safeParseJson<AssessResponse>(response.text ?? "");

    if (!payload) {
      this.handleAssessRetry("(Could not parse assessment response — retrying)");
      return;
    }

    // Obs1: needMoreProbing is the direct signal
    if (payload.needMoreProbing) {
      if (payload.nextQuestion) this.io.output(payload.nextQuestion);
      this.handleAssessRetry();
      return;
    }

    if (!payload.level) {
      this.handleAssessRetry("(Level still unclear — retrying)");
      return;
    }

    // Level is clear → advance
    s.profile.level = payload.level;
    s.profile.masteredConcepts = payload.masteredConcepts ?? [];
    s.planning.currentStep = "generate";
  }

  private handleAssessRetry(message?: string): void {
    const s = this.state;
    if (message) this.io.output(message);
    s.control.assessRetries += 1;
    if (s.control.assessRetries >= MAX_ASSESS_RETRIES) {
      this.io.output("(Max assessment retries reached — assuming beginner.)");
      s.profile.level = "none";
      s.planning.currentStep = "generate";
    }
  }

  // ── Step 2: generate ──────────────────────────────────────────────

  private async stepGenerate(): Promise<void> {
    const s = this.state;
    const provider = this.factory.forStep("generate");
    const response = await provider.chat(buildGenerateMessages(s));
    const payload = safeParseJson<{ chapters: { id: string; title: string; body: string }[] }>(
      response.text ?? ""
    );

    if (!payload?.chapters?.length) {
      throw new Error("generate: LLM returned no chapters");
    }

    s.content.lecture = payload.chapters;
    s.planning.currentStep = "choose";
  }

  // ── Step 3: choose ────────────────────────────────────────────────

  private async stepChoose(): Promise<void> {
    const s = this.state;

    // Ask user for initial preference hint
    const userInput = await this.io.getUserInput(
      "Lecture is ready! Do you prefer concept-first (theory first) or practice-first (hands-on examples)?"
    );

    const provider = this.factory.forStep("choose");
    const response = await provider.chat(buildChooseMessages(s, userInput));
    const payload = safeParseJson<ChooseResponse>(response.text ?? "");

    if (payload?.recommendation) this.io.output(payload.recommendation);

    // Derive preference: try user input first, then LLM options order
    const preference = resolvePreference(userInput, payload?.options);

    if (preference) {
      // Obs2: direction chosen → advance
      s.profile.preference = preference;
      s.planning.directionChosen = true;
      s.planning.currentStep = "attach";
    }
    // else stay on "choose" for another round
  }

  // ── Step 4: attach (4a: generate query → 4b: judge adequacy) ─────

  private async stepAttach(): Promise<void> {
    const s = this.state;
    const chapters = s.content.lecture;

    while (s.planning.attachCursor < chapters.length) {
      const chapter = chapters[s.planning.attachCursor];
      const chapterId = chapter.id;

      this.io.output(`  attaching video for: "${chapter.title}"`);

      // 4a: generate search query via LLM
      const provider = this.factory.forStep("attach");
      const queryResponse = await provider.chat(
        buildAttach4aMessages(chapter.title, s)
      );
      const queryPayload = safeParseJson<Attach4aResponse>(queryResponse.text ?? "");
      const query = queryPayload?.query ?? `${s.profile.skill} ${chapter.title} tutorial`;

      // Check candidate cache
      let candidates = s.content.candidateCache[query];

      if (!candidates) {
        try {
          candidates = await this.searchFn(query, this.youtubeApiKey);
          s.content.candidateCache[query] = candidates;
        } catch {
          candidates = [];
        }
      }

      if (candidates.length === 0) {
        this.handleAttachDegrade(chapterId);
        s.planning.attachCursor += 1;
        continue;
      }

      // Parse timestamps from top candidate's description
      const topCandidate = candidates[0];
      const timestamps = parseTimestamps(topCandidate.description);

      // 4b: judge relevance and pick best segment
      const judgeResponse = await provider.chat(
        buildAttach4bMessages(chapter.title, candidates, timestamps)
      );
      const judgePayload = safeParseJson<Attach4bResponse>(judgeResponse.text ?? "");

      // Obs3: adequate is the direct signal
      if (!judgePayload?.adequate) {
        const retries = s.control.searchRetries[chapterId] ?? 0;
        if (retries < MAX_SEARCH_RETRIES) {
          s.control.searchRetries[chapterId] = retries + 1;
          delete s.content.candidateCache[query]; // force re-search
          continue; // retry same chapter
        }
        this.handleAttachDegrade(chapterId);
        s.planning.attachCursor += 1;
        continue;
      }

      const attachment: VideoAttachment = {
        videoId:   judgePayload.videoId,
        title:     judgePayload.chosen,
        startTime: judgePayload.startTime,
        endTime:   judgePayload.endTime,
      };
      s.content.videoMap[chapterId] = attachment;
      s.planning.attachCursor += 1;
    }

    s.planning.currentStep = "synthesize";
  }

  // ── Step 5: synthesize ────────────────────────────────────────────

  private async stepSynthesize(): Promise<void> {
    const s = this.state;
    const lines: string[] = [
      `# Learning Blueprint: ${s.profile.skill}`,
      `Level: ${s.profile.level} | Style: ${s.profile.preference ?? "default"}`,
      "",
    ];

    for (const chapter of s.content.lecture) {
      lines.push(`## ${chapter.title}`);
      lines.push(chapter.body);

      const video = s.content.videoMap[chapter.id];
      if (video) {
        const ts =
          video.startTime > 0
            ? ` (${formatTime(video.startTime)} – ${formatTime(video.endTime)})`
            : "";
        lines.push(
          `🎬 [${video.title}](https://youtu.be/${video.videoId}${
            video.startTime > 0 ? `?t=${video.startTime}` : ""
          })${ts}`
        );
      } else if (s.control.degraded.includes(chapter.id)) {
        lines.push("_(no suitable video found for this chapter)_");
      }

      lines.push("");
    }

    this.io.output(lines.join("\n"));
    s.planning.currentStep = "done";
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private handleAttachDegrade(chapterId: string): void {
    this.io.output(`  (no adequate video for chapter ${chapterId} — degraded)`);
    this.state.control.degraded.push(chapterId);
  }
}

// ── Module-level helpers ──────────────────────────────────────────

function safeParseJson<T>(text: string): T | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) return parsed as T;
  } catch {}
  return null;
}

function resolvePreference(
  userInput: string,
  options?: { key: Preference; label: string }[]
): Preference {
  const lower = userInput.toLowerCase();

  if (lower.includes("concept") || lower === "1") return "concept-first";
  if (lower.includes("practice") || lower === "2") return "practice-first";

  // Fall back to LLM's first option as recommendation
  if (options?.[0]?.key) return options[0].key;

  return null;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
