import type {
  MemoryRecallInput,
  RecallResult,
} from "../../../src/index.js";

const defaultSearch: MemoryRecallInput = { query: "인증" };
const explicitSearch: MemoryRecallInput = {
  mode: "search",
  query: "인증 정책",
  terms: ["인증", "정책"],
  depth: 3,
  limit: 50,
  detail: "full",
};
const overview: MemoryRecallInput = { mode: "overview", detail: "brief" };
const emptyResult: RecallResult = {
  answers: [],
  entry: "none",
  more_available: false,
};

void defaultSearch;
void explicitSearch;
void overview;
void emptyResult;

const invalidOverview: MemoryRecallInput = {
  mode: "overview",
  // @ts-expect-error overview has no query field
  query: "must not compile",
};
const invalidRawAnswer: RecallResult = {
  answers: [
    {
      kind: "raw",
      event_id: `ev_${"0".repeat(26)}`,
      text: "raw",
      created_at: "2026-08-22T12:34:56Z",
      recorded_at: "2026-08-22T12:34:56Z",
      provenance: "observed",
      // @ts-expect-error raw answers cannot carry claim support
      support: {
        count: 1,
        strongest: "observed",
        last_seen: "2026-08-22T12:34:56Z",
      },
    },
  ],
  entry: "fts",
  more_available: false,
};

void invalidOverview;
void invalidRawAnswer;
