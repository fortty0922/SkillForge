import { TimestampEntry } from "../types";

// Matches common chapter formats in YouTube descriptions:
//   0:00 Title
//   0:00:00 Title
//   (0:00) Title
//   00:00 - Title
const TIMESTAMP_RE =
  /\(?(\d{1,2}:\d{2}(?::\d{2})?)\)?\s*[-–]?\s*(.+)/g;

function toSeconds(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  // HH:MM:SS
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function parseTimestamps(description: string): TimestampEntry[] {
  const entries: { startTime: number; label: string }[] = [];

  for (const match of description.matchAll(TIMESTAMP_RE)) {
    const [, time, label] = match;
    entries.push({ startTime: toSeconds(time), label: label.trim() });
  }

  // Compute endTime = next chapter's startTime (last chapter gets +300s as estimate)
  return entries.map((entry, i) => ({
    startTime: entry.startTime,
    endTime: i + 1 < entries.length ? entries[i + 1].startTime : entry.startTime + 300,
    label: entry.label,
  }));
}
