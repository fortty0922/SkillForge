import {
  AgentState,
  LLMMessage,
  Preference,
  VideoAttachment,
  VideoCandidate,
  AssessResponse,
  ChooseResponse,
  Attach4aResponse,
  Attach4bResponse,
  ReflectResponse,
} from "../types";
import { ProviderFactory } from "../provider/factory";
import { searchYouTube } from "../tools/youtubeSearch";
import { parseTimestamps } from "../tools/metadataParser";
import {
  RAGStore,
  loadStore,
  saveStore,
  addCandidates,
  searchLocal,
} from "../tools/ragStore";

type SearchFn = (query: string, apiKey: string) => Promise<VideoCandidate[]>;
import {
  buildAssessMessages,
  buildGenerateMessages,
  buildChooseMessages,
  buildAttach4aMessages,
  buildAttach4bMessages,
  buildReflectMessages,
} from "./prompts";

const MAX_ASSESS_RETRIES = 2;
const MAX_SEARCH_RETRIES = 2;

export interface AgentIO {
  getUserInput(prompt: string): Promise<string>;
  output(text: string): void;
  startSpinner?(message: string): void;
  stopSpinner?(ok?: boolean): void;
  setProgress?(current: number, total: number, label: string): void;
}

export class AgentLoop {
  private state: AgentState;
  private factory: ProviderFactory;
  private io: AgentIO;
  private youtubeApiKey: string;
  private searchFn: SearchFn;
  private ragStore: RAGStore;
  private ragStorePath: string;
  private assessHistory: LLMMessage[] = [];
  private pendingAssessPrompt = "";

  constructor(
    state: AgentState,
    factory: ProviderFactory,
    io: AgentIO,
    youtubeApiKey = "",
    searchFn: SearchFn = searchYouTube,
    ragStorePath = "data/candidates.json"
  ) {
    this.state = state;
    this.factory = factory;
    this.io = io;
    this.youtubeApiKey = youtubeApiKey;
    this.searchFn = searchFn;
    this.ragStorePath = ragStorePath;
    this.ragStore = loadStore(ragStorePath);
  }

  async run(): Promise<AgentState> {
    while (this.state.planning.currentStep !== "done") {
      const step = this.state.planning.currentStep;
      this.io.output(`[step: ${step}] [model: ${this.factory.modelLabel(step)}]`);

      switch (step) {
        case "assess":    await this.stepAssess();    break;
        case "generate":  await this.stepGenerate();  break;
        case "choose":    await this.stepChoose();    break;
        case "attach":    await this.stepAttach();    break;
        case "synthesize":await this.stepSynthesize();break;
        case "reflect":   await this.stepReflect();   break;
      }
    }
    return this.state;
  }

  // ── Step 1: assess ────────────────────────────────────────────────

  private async stepAssess(): Promise<void> {
    const s = this.state;

    // Use LLM's follow-up question as prompt if available, else use default
    const prompt = this.pendingAssessPrompt ||
      `Tell me about your experience with "${s.profile.skill}".`;
    this.pendingAssessPrompt = "";

    const userInput = await this.io.getUserInput(prompt);

    const provider = this.factory.forStep("assess");
    this.io.startSpinner?.("Evaluating...");
    const response = await provider.chat(
      buildAssessMessages(s, userInput, this.assessHistory)
    );
    this.io.stopSpinner?.(true);
    const payload = safeParseJson<AssessResponse>(response.text ?? "");

    if (!payload) {
      this.handleAssessRetry("(Could not parse assessment response — retrying)");
      return;
    }

    const thought = payload.thought;
    if (thought) this.io.output(`  💭 ${thought}`);

    // Append this turn to history so next round has full context
    this.assessHistory.push(
      { role: "user",      content: userInput },
      { role: "assistant", content: response.text ?? "" }
    );

    // Obs1: needMoreProbing is the direct signal
    if (payload.needMoreProbing) {
      this.pendingAssessPrompt = payload.nextQuestion || "";
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
    if (payload.language) s.profile.language = payload.language;
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
    this.io.startSpinner?.("Generating lecture...");
    const response = await provider.chat(buildGenerateMessages(s));
    this.io.stopSpinner?.(true);
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
    this.io.startSpinner?.("Analyzing preference...");
    const response = await provider.chat(buildChooseMessages(s, userInput));
    this.io.stopSpinner?.(true);
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
    const ragFailed = new Set<string>();

    // Repair mode: only process chapters in repairQueue
    const repairIds = new Set(
      s.planning.repairQueue.filter((r) => r.type === "reattach").map((r) => r.id)
    );
    const isRepairMode = repairIds.size > 0;
    const chapters = isRepairMode
      ? s.content.lecture.filter((ch) => repairIds.has(ch.id))
      : s.content.lecture;
    let repairCursor = 0;

    const getNextChapter = () => {
      if (isRepairMode) {
        return repairCursor < chapters.length ? chapters[repairCursor] : null;
      }
      return s.planning.attachCursor < s.content.lecture.length
        ? s.content.lecture[s.planning.attachCursor]
        : null;
    };

    const advanceCursor = () => {
      if (isRepairMode) repairCursor += 1;
      else s.planning.attachCursor += 1;
    };

    while (getNextChapter() !== null) {
      const chapter = getNextChapter()!;
      const chapterId = chapter.id;
      const currentIdx = isRepairMode ? repairCursor : s.planning.attachCursor;
      this.io.setProgress?.(currentIdx + 1, chapters.length, chapter.title);

      // 4a: generate search query via LLM
      const provider = this.factory.forStep("attach");
      this.io.startSpinner?.("Generating query...");
      const queryResponse = await provider.chat(
        buildAttach4aMessages(chapter.title, s)
      );
      this.io.stopSpinner?.(true);
      const queryPayload = safeParseJson<Attach4aResponse>(queryResponse.text ?? "");
      const query = queryPayload?.query ?? `${s.profile.skill} ${chapter.title} tutorial`;
      this.io.output(`  [4a query] "${query}"`);

      // Check in-session cache first
      let candidates = s.content.candidateCache[query];

      if (!candidates) {
        // 1. Try local RAG store (skip if RAG already failed for this chapter)
        const local = ragFailed.has(chapterId) ? [] : searchLocal(query, this.ragStore);
        if (local.length > 0) {
          this.io.output(`  [rag] ${local.length} local result(s)`);
          candidates = local;
          s.content.candidateCache[query] = candidates;
        } else {
          // 2. Fall back to YouTube Search
          try {
            candidates = await this.searchFn(query, this.youtubeApiKey);
            this.io.output(`  [search] ${candidates.length} result(s) from YouTube`);
            // 3. Persist new results to RAG store
            if (candidates.length > 0) {
              addCandidates(query, candidates, this.ragStore);
              saveStore(this.ragStore, this.ragStorePath);
            }
            s.content.candidateCache[query] = candidates;
          } catch (err) {
            this.io.output(`  [search error] ${(err as Error).message}`);
            candidates = [];
          }
        }
      }

      if (candidates.length === 0) {
        this.handleAttachDegrade(chapterId);
        advanceCursor();
        continue;
      }

      // 4b: judge relevance — pass candidates first, timestamps derived after pick
      this.io.startSpinner?.("Judging relevance...");
      const judgeResponse = await provider.chat(
        buildAttach4bMessages(chapter.title, candidates, parseTimestamps(candidates[0].description), s.profile.language)
      );
      this.io.stopSpinner?.(true);
      const judgePayload = safeParseJson<Attach4bResponse>(judgeResponse.text ?? "");

      // Obs3: adequate is the direct signal
      if (!judgePayload?.adequate) {
        const retries = s.control.searchRetries[chapterId] ?? 0;
        if (retries < MAX_SEARCH_RETRIES) {
          s.control.searchRetries[chapterId] = retries + 1;
          ragFailed.add(chapterId);             // next retry skips RAG
          delete s.content.candidateCache[query];
          continue;
        }
        this.handleAttachDegrade(chapterId);
        advanceCursor();
        continue;
      }

      // Use chosenIndex to get real title and timestamps
      const chosenIndex = Math.max(
        0, Math.min(judgePayload.chosenIndex ?? 0, candidates.length - 1)
      );
      const chosenCandidate = candidates[chosenIndex];
      const chosenTimestamps = parseTimestamps(chosenCandidate.description);
      const ts = chosenTimestamps[0];

      const attachment: VideoAttachment = {
        videoId:   judgePayload.videoId || chosenCandidate.videoId,
        title:     chosenCandidate.title,
        startTime: ts?.startTime ?? judgePayload.startTime,
        endTime:   ts?.endTime   ?? judgePayload.endTime,
      };
      s.content.videoMap[chapterId] = attachment;
      advanceCursor();
    }

    // Clear repair queue after processing
    s.planning.repairQueue = [];
    s.planning.currentStep = "synthesize";
  }

  // ── Step 5: synthesize ────────────────────────────────────────────

  private async stepSynthesize(): Promise<void> {
    const s = this.state;
    const lang = s.profile.language;
    const lines: string[] = [
      `# ${localizeLabel("blueprint", lang)}: ${s.profile.skill}`,
      `${localizeLabel("level", lang)}: ${s.profile.level} | ${localizeLabel("style", lang)}: ${s.profile.preference ?? localizeLabel("default", lang)}`,
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
        lines.push(`_(${localizeLabel("noVideo", lang)})_`);
      }

      lines.push("");
    }

    this.io.output(lines.join("\n"));
    s.planning.currentStep = "reflect";
  }

  // ── Step 6: reflect ───────────────────────────────────────────────

  private async stepReflect(): Promise<void> {
    const s = this.state;
    const provider = this.factory.forStep("reflect");
    this.io.startSpinner?.("Evaluating blueprint quality...");
    const response = await provider.chat(buildReflectMessages(s));
    this.io.stopSpinner?.(true);
    const payload = safeParseJson<ReflectResponse>(response.text ?? "");

    if (!payload) {
      // Parse failure → approve and continue
      s.planning.currentStep = "done";
      return;
    }

    const thought = payload.thought;
    if (thought) this.io.output(`  💭 ${thought}`);
    if (payload.feedback) this.io.output(`[reflect] ${payload.feedback}`);
    if (payload.issues.length > 0) {
      this.io.output(payload.issues.map((i) => `  • ${i}`).join("\n"));
    }

    if (payload.action === "repair" && s.control.reflectRetries < 1) {
      // Targeted repair: only fix specific chapters
      s.control.reflectRetries += 1;
      s.planning.repairQueue = payload.chaptersToFix ?? [];
      s.planning.reflectFeedback = payload.feedback;

      for (const fix of s.planning.repairQueue) {
        if (fix.type === "reattach") {
          delete s.content.videoMap[fix.id];
          s.control.degraded = s.control.degraded.filter((id) => id !== fix.id);
          s.control.searchRetries[fix.id] = 0;
        }
      }

      const hasRewrites = s.planning.repairQueue.some((r) => r.type === "rewrite");
      s.planning.currentStep = hasRewrites ? "generate" : "attach";

    } else if (payload.action === "regenerate" && s.control.reflectRetries < 1) {
      // Full regeneration as last resort
      s.control.reflectRetries += 1;
      s.planning.reflectFeedback = payload.feedback;
      s.planning.repairQueue = [];
      s.content.lecture = [];
      s.content.videoMap = {};
      s.control.degraded = [];
      s.control.searchRetries = {};
      s.planning.attachCursor = 0;
      s.planning.directionChosen = false;
      s.planning.currentStep = "generate";

    } else {
      s.planning.repairQueue = [];
      s.planning.currentStep = "done";
    }
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

const LABELS: Record<string, Record<string, string>> = {
  blueprint: { "Traditional Chinese": "學習藍圖", "Simplified Chinese": "学习蓝图", "Japanese": "学習ブループリント" },
  level:     { "Traditional Chinese": "程度",     "Simplified Chinese": "程度",     "Japanese": "レベル" },
  style:     { "Traditional Chinese": "風格",     "Simplified Chinese": "风格",     "Japanese": "スタイル" },
  default:   { "Traditional Chinese": "預設",     "Simplified Chinese": "默认",     "Japanese": "デフォルト" },
  noVideo:   {
    "Traditional Chinese": "此章節未找到合適影片",
    "Simplified Chinese":  "此章节未找到合适视频",
    "Japanese":            "この章に適した動画が見つかりませんでした",
  },
};

function localizeLabel(key: string, language: string): string {
  return LABELS[key]?.[language] ?? LABELS[key]?.["English"] ?? key;
}
