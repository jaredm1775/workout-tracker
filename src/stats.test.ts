import { describe, expect, it } from "vitest";
import { dayStreak, exerciseSummaries, liftSeries, maxRestDays, weeklyBuckets } from "./stats";
import type { Workout } from "./types";

function day(date: string, sets: Array<[number, number]> = [[100, 5]], finished = true): Workout {
  return {
    id: `w-${date}`,
    profileId: "jared",
    dayId: "push-a",
    date,
    startedAt: `${date}T10:00:00.000Z`,
    finishedAt: finished ? `${date}T11:00:00.000Z` : undefined,
    sets: sets.map(([weight, reps], setIndex) => ({
      exerciseId: "bench-press",
      setIndex,
      weight,
      reps,
      completedAt: `${date}T10:1${setIndex}:00.000Z`,
    })),
  };
}

describe("maxRestDays", () => {
  it("allows two rest days in a row for 4-6 day plans and more for lighter ones", () => {
    expect(maxRestDays(6)).toBe(2);
    expect(maxRestDays(4)).toBe(2);
    expect(maxRestDays(2)).toBe(3);
  });
});

describe("dayStreak", () => {
  // Mon Oct 12 .. Tue Oct 20: trained Mon Tue Thu Fri, rested Wed Sat Sun, trained Mon.
  const history = ["2026-10-12", "2026-10-13", "2026-10-15", "2026-10-16", "2026-10-19"].map((d) => day(d));

  it("counts rest days inside the streak", () => {
    const streak = dayStreak(history, 4, "2026-10-19");
    expect(streak).toMatchObject({ days: 8, workouts: 5, restDays: 3, trainBy: "2026-10-22" });
  });

  it("keeps the streak alive through allowed rest days, including an untrained today", () => {
    expect(dayStreak(history, 4, "2026-10-21").days).toBe(10);
    expect(dayStreak(history, 4, "2026-10-21").trainBy).toBe("2026-10-22");
  });

  it("breaks after too many rest days in a row but remembers the best", () => {
    const streak = dayStreak(history, 4, "2026-10-23");
    expect(streak.days).toBe(0);
    expect(streak.trainBy).toBeNull();
    // A finished run counts from its first workout to its last.
    expect(streak.best).toBe(8);
  });

  it("starts a new run after a long gap", () => {
    const streak = dayStreak([...history, day("2026-10-25"), day("2026-10-26")], 4, "2026-10-26");
    expect(streak).toMatchObject({ days: 2, workouts: 2, restDays: 0 });
    expect(streak.best).toBe(8);
  });

  it("ignores unfinished and future workouts", () => {
    expect(dayStreak([day("2026-10-19", undefined, false)], 4, "2026-10-19").days).toBe(0);
    expect(dayStreak([day("2026-10-30")], 4, "2026-10-19").days).toBe(0);
  });
});

describe("weeklyBuckets", () => {
  it("groups finished workouts into Sunday-start weeks, oldest first", () => {
    const buckets = weeklyBuckets(
      [day("2026-10-12", [[100, 10]]), day("2026-10-13"), day("2026-10-19"), day("2026-10-20", undefined, false)],
      3,
      "2026-10-20",
    );
    expect(buckets.map((b) => b.start)).toEqual(["2026-10-04", "2026-10-11", "2026-10-18"]);
    expect(buckets.map((b) => b.days)).toEqual([0, 2, 1]);
    expect(buckets[1].volume).toBe(1500);
  });
});

describe("liftSeries", () => {
  it("takes the best estimated 1RM and heaviest set per session", () => {
    const series = liftSeries([day("2026-10-15", [[100, 10], [120, 3]]), day("2026-10-12", [[95, 8]])], "bench-press");
    expect(series.map((p) => p.date)).toEqual(["2026-10-12", "2026-10-15"]);
    expect(series[1]).toMatchObject({ e1rm: 133.3, e1rmSet: "100 × 10", topWeight: 120, topSet: "120 × 3" });
  });

  it("summarises exercises by sessions with their best", () => {
    const [summary] = exerciseSummaries([day("2026-10-12", [[95, 8]]), day("2026-10-15", [[100, 10]])]);
    expect(summary).toMatchObject({ exerciseId: "bench-press", sessions: 2 });
    expect(summary.best.date).toBe("2026-10-15");
  });
});
