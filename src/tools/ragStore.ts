import * as fs from "fs";
import * as path from "path";
import { VideoCandidate } from "../types";

// ── Types ──────────────────────────────────────────────────────────

export interface StoredCandidate extends VideoCandidate {
  queries: string[]; // search terms that surfaced this video
}

export interface RAGStore {
  version: "1";
  entries: StoredCandidate[];
}

// ── Persistence ───────────────────────────────────────────────────

export function loadStore(storePath: string): RAGStore {
  if (!storePath) return empty();
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    return JSON.parse(raw) as RAGStore;
  } catch {
    return empty();
  }
}

export function saveStore(store: RAGStore, storePath: string): void {
  if (!storePath) return;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

// ── Mutations ─────────────────────────────────────────────────────

export function addCandidates(
  query: string,
  candidates: VideoCandidate[],
  store: RAGStore
): void {
  for (const candidate of candidates) {
    const existing = store.entries.find((e) => e.videoId === candidate.videoId);
    if (existing) {
      if (!existing.queries.includes(query)) {
        existing.queries.push(query);
      }
    } else {
      store.entries.push({ ...candidate, queries: [query] });
    }
  }
}

// ── Local search (keyword match) ──────────────────────────────────
// Score = number of query words found in title + description (case-insensitive).
// Returns up to 5 results sorted by score descending.

export function searchLocal(
  query: string,
  store: RAGStore,
  topK = 5
): VideoCandidate[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (words.length === 0) return [];

  const minScore = Math.max(1, Math.ceil(words.length / 2));

  const scored = store.entries
    .map((entry) => {
      const haystack = `${entry.title} ${entry.description}`.toLowerCase();
      const score = words.filter((w) => haystack.includes(w)).length;
      return { entry, score };
    })
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map(({ entry }) => ({
    videoId: entry.videoId,
    title: entry.title,
    description: entry.description,
    channelTitle: entry.channelTitle,
  }));
}

// ── Helpers ───────────────────────────────────────────────────────

function empty(): RAGStore {
  return { version: "1", entries: [] };
}
