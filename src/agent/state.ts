import { AgentState } from "../types";

export function createInitialState(skill: string): AgentState {
  return {
    profile: {
      skill,
      level: null,
      masteredConcepts: [],
      preference: null,
    },
    planning: {
      currentStep: "assess",
      directionChosen: false,
      attachCursor: 0,
    },
    content: {
      lecture: [],
      videoMap: {},
      candidateCache: {},
    },
    control: {
      assessRetries: 0,
      searchRetries: {},
      degraded: [],
    },
  };
}
