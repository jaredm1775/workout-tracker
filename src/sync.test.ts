import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ackSyncEntries, deleteWorkout, getSyncQueue, importBackup, saveWorkout } from "./db";
import { opToWire, parseSetupHash, workoutToWire } from "./sync";
import type { Workout } from "./types";

function sample(id: string, finished = true): Workout {
  return {
    id,
    profileId: "jared",
    dayId: "push-a",
    date: "2026-10-20",
    startedAt: "2026-10-20T10:00:00.000Z",
    finishedAt: finished ? "2026-10-20T11:00:00.000Z" : undefined,
    sets: [
      { exerciseId: "bench-press", setIndex: 1, weight: 150, reps: 6, completedAt: "2026-10-20T10:10:00.000Z" },
      { exerciseId: "bench-press", setIndex: 0, weight: 150, reps: 8, restSeconds: 170, completedAt: "2026-10-20T10:05:00.000Z" },
    ],
  };
}

describe("workoutToWire", () => {
  it("flattens a workout into named, ordered rows", () => {
    const wire = workoutToWire(sample("w1"), "2026-10-20T12:00:00.000Z");
    expect(wire.workout).toMatchObject({
      workoutId: "w1",
      day: "Push A",
      durationMin: 60,
      sets: 2,
      volumeLb: 2100,
    });
    expect(wire.sets.map((row) => row.set)).toEqual([1, 2]);
    expect(wire.sets[0]).toMatchObject({ exercise: "Barbell bench press", e1rm: 190, restSec: 170 });
    expect(wire.sets[1].restSec).toBe("");
  });

  it("leaves duration blank while the workout is in progress", () => {
    expect(workoutToWire(sample("w2", false)).workout.durationMin).toBe("");
  });

  it("expands milestone state against the catalog", () => {
    const wire = opToWire({ type: "milestones", profileId: "jared", state: { "bench-185x5": true } });
    expect(wire.type).toBe("milestones");
    if (wire.type !== "milestones") return;
    expect(wire.rows.find((row) => row.milestoneId === "bench-185x5")?.done).toBe(true);
    expect(wire.rows.find((row) => row.milestoneId === "bench-225x5")?.done).toBe(false);
  });
});

describe("sync queue", () => {
  it("keeps only the latest change per workout and survives a stale ack", async () => {
    await saveWorkout(sample("q1", false));
    const first = (await getSyncQueue())["workout:q1"];
    await saveWorkout(sample("q1"));
    const second = (await getSyncQueue())["workout:q1"];
    expect(second.rev).not.toBe(first.rev);

    // An upload of the older version finishing late must not drop the newer change.
    await ackSyncEntries([{ key: "workout:q1", rev: first.rev }]);
    expect((await getSyncQueue())["workout:q1"]?.rev).toBe(second.rev);

    await ackSyncEntries([{ key: "workout:q1", rev: second.rev }]);
    expect((await getSyncQueue())["workout:q1"]).toBeUndefined();
  });

  it("queues a delete with the workout's profile", async () => {
    await saveWorkout({ ...sample("q2"), profileId: "wendy" });
    await deleteWorkout("q2");
    expect((await getSyncQueue())["workout:q2"].op).toEqual({ type: "delete", profileId: "wendy", workoutId: "q2" });
  });

  it("queues deletes for workouts an import removes", async () => {
    await saveWorkout(sample("old"));
    await importBackup({
      exportedAt: "2026-10-20T00:00:00.000Z",
      profileId: "jared",
      weekMode: "6day",
      workouts: [sample("new")],
      milestones: {},
    });
    const queue = await getSyncQueue();
    expect(queue["workout:old"].op.type).toBe("delete");
    expect(queue["workout:new"].op.type).toBe("workout");
    expect(queue["milestones:jared"].op.type).toBe("milestones");
  });
});

describe("parseSetupHash", () => {
  it("reads a config from the fragment and rejects junk", () => {
    const config = { url: "https://script.google.com/macros/s/abc/exec", token: "secret" };
    const encoded = btoa(JSON.stringify(config)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(parseSetupHash(`#jared/sync=${encoded}`)).toEqual(config);
    expect(parseSetupHash("#jared")).toBeNull();
    expect(parseSetupHash("#jared/sync=!!!")).toBeNull();
  });
});
