import { parseTimestamps } from "../tools/metadataParser";

const description = `
Learn TypeScript from scratch!

0:00 Introduction
2:30 Setting up the environment
8:15 Basic types
15:00 - Interfaces and types
22:45 Functions
(30:00) Classes
`;

const result = parseTimestamps(description);

console.log("=== Metadata Parser Test ===");
result.forEach((e) => {
  console.log(`[${e.startTime}s → ${e.endTime}s] ${e.label}`);
});

const allCorrect =
  result.length === 6 &&
  result[0].startTime === 0 &&
  result[1].startTime === 150 &&   // 2:30
  result[2].startTime === 495 &&   // 8:15
  result[5].startTime === 1800;    // 30:00

console.log(allCorrect ? "\nPASS" : "\nFAIL");
process.exit(allCorrect ? 0 : 1);
