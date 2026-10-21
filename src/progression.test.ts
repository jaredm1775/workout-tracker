import { describe, expect, it } from "vitest";
import { estimatedOneRepMax, lastWorkingSets, nextTargetWeight, suggestedDayId } from "./progression";
import type { Exercise, LoggedSet, Workout } from "./types";

const bench: Exercise = {
  id: "bench-press",
  name: "Barbell bench press",
  sets: 3,
  repMin: 5,
  repMax: 8,
  restSeconds: 180,
  incrementLb: 5,
};

function sets(weight: number, reps: number[]): LoggedSet[] {
  return reps.map((rep, setIndex) => ({
    exerciseId: bench.id,
    setIndex,
    weight,
    reps: rep,
    completedAt: "2026-10-01T10:00:00.000Z",
  }));
}

function workout(id: string, startedAt: string, logged: LoggedSet[], finished = true): Workout {
  return {
    id,
    profileId: "jared",
    dayId: "push-a",
    date: startedAt.slice(0, 10),
    startedAt,
    finishedAt: finished ? startedAt : undefined,
    sets: logged,
  };
}

describe("lastWorkingSets", () => {
  it("ignores the workout in progress", () => {
    const history = [
      workout("today", "2026-10-20T10:00:00.000Z", sets(150, [8]), false),
      workout("prev", "2026-10-17T10:00:00.000Z", sets(145, [8, 7, 6])),
    ];
    expect(lastWorkingSets(history, bench.id).map((set) => set.weight)).toEqual([145, 145, 145]);
  });
});

describe("nextTargetWeight", () => {
  it("adds the increment when every set hit the top of the range", () => {
    expect(nextTargetWeight(bench, [workout("a", "2026-10-17T10:00:00.000Z", sets(145, [8, 8, 8]))])).toBe(150);
  });

  it("holds the weight when a set fell short", () => {
    expect(nextTargetWeight(bench, [workout("a", "2026-10-17T10:00:00.000Z", sets(145, [8, 8, 6]))])).toBe(145);
  });

  it("is not moved by sets logged earlier in today's session", () => {
    const history = [
      workout("today", "2026-10-20T10:00:00.000Z", sets(150, [8, 8, 8]), false),
      workout("prev", "2026-10-17T10:00:00.000Z", sets(145, [8, 8, 6])),
    ];
    expect(nextTargetWeight(bench, history)).toBe(145);
  });

  it("returns null with no finished history", () => {
    expect(nextTargetWeight(bench, [])).toBeNull();
  });
});

describe("estimatedOneRepMax", () => {
  it("uses Epley and passes singles through", () => {
    expect(estimatedOneRepMax(200, 1)).toBe(200);
    expect(estimatedOneRepMax(150, 10)).toBe(200);
    expect(estimatedOneRepMax(0, 5)).toBe(0);
  });
});

describe("suggestedDayId", () => {
  const days = [
    { id: "push-a", name: "", focus: "", exercises: [] },
    { id: "legs-b", name: "", focus: "", exercises: [] },
    { id: "pull-a", name: "", focus: "", exercises: [] },
  ];

  it("rotates and skips legs-b in 5 day mode", () => {
    expect(suggestedDayId(days, "push-a", "6day")).toBe("legs-b");
    expect(suggestedDayId(days, "push-a", "5day")).toBe("pull-a");
    expect(suggestedDayId(days, null, "6day")).toBe("push-a");
  });
});
