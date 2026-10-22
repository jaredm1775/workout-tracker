import { describe, expect, it } from "vitest";
import {
  estimatedOneRepMax,
  isLateFinish,
  lastNote,
  lastWorkingSets,
  nextTargetWeight,
  suggestedDayId,
  suggestedFinishAt,
  swappedExercise,
} from "./progression";
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

  describe("top-set progression", () => {
    const failure: Exercise = { ...bench, sets: 2, repMax: 9, progression: "topSet" };

    it("adds the increment when only the first set hit the top", () => {
      expect(nextTargetWeight(failure, [workout("a", "2026-10-17T10:00:00.000Z", sets(145, [9, 7]))])).toBe(150);
    });

    it("holds the first set's weight when it fell short, ignoring a lighter back-off", () => {
      const logged = [...sets(145, [8]), { ...sets(130, [9])[0], setIndex: 1 }];
      expect(nextTargetWeight(failure, [workout("a", "2026-10-17T10:00:00.000Z", logged)])).toBe(145);
    });
  });
});

describe("lastNote", () => {
  it("returns the latest non-empty note from a finished session", () => {
    const history = [
      { ...workout("today", "2026-10-20T10:00:00.000Z", [], false), notes: { [bench.id]: "in progress" } },
      { ...workout("mid", "2026-10-18T10:00:00.000Z", []), notes: { [bench.id]: "  " } },
      { ...workout("old", "2026-10-15T10:00:00.000Z", []), notes: { [bench.id]: "seat 4" } },
    ];
    expect(lastNote(history, bench.id)).toBe("seat 4");
    expect(lastNote(history, "other")).toBeNull();
  });
});

describe("swappedExercise", () => {
  const slot: Exercise = {
    ...bench,
    id: "incline-smith-press",
    name: "Incline Smith press",
    notes: "Set the stoppers.",
    alternatives: [{ id: "incline-db-press", name: "Incline dumbbell press", restSeconds: 120 }],
  };

  it("keeps the program exercise without a swap", () => {
    expect(swappedExercise(slot, undefined)).toBe(slot);
    expect(swappedExercise(slot, { [slot.id]: "missing" })).toBe(slot);
  });

  it("logs the alternative under its own id and inherits targets", () => {
    const swapped = swappedExercise(slot, { [slot.id]: "incline-db-press" });
    expect(swapped).toMatchObject({ id: "incline-db-press", name: "Incline dumbbell press", sets: 3, repMax: 8, restSeconds: 120 });
    expect(swapped.notes).toBeUndefined();
    expect(swapped.alternatives).toBeUndefined();
  });
});

describe("estimatedOneRepMax", () => {
  it("uses Epley and passes singles through", () => {
    expect(estimatedOneRepMax(200, 1)).toBe(200);
    expect(estimatedOneRepMax(150, 10)).toBe(200);
    expect(estimatedOneRepMax(0, 5)).toBe(0);
  });
});

describe("finish time", () => {
  const session: Workout = {
    id: "late",
    profileId: "wendy",
    dayId: "quads-glutes",
    date: "2026-10-20",
    startedAt: "2026-10-20T23:01:13.391Z",
    finishedAt: "2026-10-21T02:38:43.069Z",
    sets: [
      { exerciseId: "step-up", setIndex: 1, weight: 20, reps: 10, completedAt: "2026-10-20T23:47:35.008Z" },
      { exerciseId: "step-up", setIndex: 0, weight: 20, reps: 8, completedAt: "2026-10-20T23:43:03.854Z" },
    ],
  };

  it("suggests two minutes after the latest set", () => {
    expect(suggestedFinishAt(session)).toBe("2026-10-20T23:49:35.008Z");
    expect(suggestedFinishAt({ ...session, sets: [] })).toBeNull();
  });

  it("flags a finish more than 30 minutes after the last set", () => {
    expect(isLateFinish(session)).toBe(true);
    expect(isLateFinish(session, "2026-10-21T00:17:00.000Z")).toBe(false);
    expect(isLateFinish({ ...session, sets: [] })).toBe(false);
    expect(isLateFinish({ ...session, finishedAt: undefined })).toBe(false);
  });
});

describe("suggestedDayId", () => {
  const days = [
    { id: "push-a", name: "", focus: "", exercises: [] },
    { id: "pull-a", name: "", focus: "", exercises: [] },
    { id: "legs-a", name: "", focus: "", exercises: [] },
  ];

  it("rotates through every day and restarts after a retired one", () => {
    expect(suggestedDayId(days, "push-a")).toBe("pull-a");
    expect(suggestedDayId(days, "legs-a")).toBe("push-a");
    expect(suggestedDayId(days, null)).toBe("push-a");
    expect(suggestedDayId(days, "legs-b")).toBe("push-a");
  });
});
