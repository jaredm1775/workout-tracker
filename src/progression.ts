import type { Alternative, Day, Exercise, LoggedSet, Workout } from "./types";

export function workoutsForExercise(workouts: Workout[], exerciseId: string): Workout[] {
  return workouts.filter((workout) =>
    workout.sets.some((set) => set.exerciseId === exerciseId && workout.finishedAt),
  );
}

// Only finished sessions count, so the workout in progress never feeds its own "Last" / "Next".
export function lastWorkingSets(workouts: Workout[], exerciseId: string): LoggedSet[] {
  for (const workout of workouts) {
    if (!workout.finishedAt) continue;
    const sets = workout.sets
      .filter((set) => set.exerciseId === exerciseId)
      .sort((a, b) => a.setIndex - b.setIndex);
    if (sets.length) return sets;
  }
  return [];
}

export function lastWeight(workouts: Workout[], exerciseId: string): number | null {
  const sets = lastWorkingSets(workouts, exerciseId);
  if (!sets.length) return null;
  return sets[sets.length - 1].weight;
}

// The most recent note left on this exercise in a finished session.
export function lastNote(workouts: Workout[], exerciseId: string): string | null {
  for (const workout of workouts) {
    if (!workout.finishedAt) continue;
    const note = workout.notes?.[exerciseId]?.trim();
    if (note) return note;
  }
  return null;
}

// An alternative as a full exercise: anything it leaves out comes from the program exercise.
export function asExercise(parent: Exercise, alternative: Alternative): Exercise {
  const { alternatives: _ignored, ...base } = parent;
  return { ...base, notes: undefined, ...alternative };
}

// The exercise to log for this program slot, honoring the session's swap if any.
export function swappedExercise(parent: Exercise, swaps: Record<string, string> | undefined): Exercise {
  const altId = swaps?.[parent.id];
  const alternative = altId ? parent.alternatives?.find((item) => item.id === altId) : undefined;
  return alternative ? asExercise(parent, alternative) : parent;
}

// Swaps to start a session with: each slot keeps whichever choice was logged the last time
// it was trained, so a swap sticks until you swap back.
export function carriedSwaps(day: Day, workouts: Workout[]): Record<string, string> | undefined {
  const swaps: Record<string, string> = {};
  for (const slot of day.exercises) {
    if (!slot.alternatives?.length) continue;
    const choices = new Set([slot.id, ...slot.alternatives.map((item) => item.id)]);
    for (const workout of workouts) {
      if (!workout.finishedAt) continue;
      const logged = workout.sets.find((set) => choices.has(set.exerciseId));
      if (!logged) continue;
      if (logged.exerciseId !== slot.id) swaps[slot.id] = logged.exerciseId;
      break;
    }
  }
  return Object.keys(swaps).length ? swaps : undefined;
}

export function nextTargetWeight(exercise: Exercise, workouts: Workout[]): number | null {
  const sets = lastWorkingSets(workouts, exercise.id);
  if (!sets.length) return null;
  if (exercise.progression === "topSet") {
    // Low-volume work to failure: later sets are back-offs, so only the first set has to hit the top.
    const top = sets[0];
    return top.reps >= exercise.repMax && exercise.incrementLb > 0 ? top.weight + exercise.incrementLb : top.weight;
  }
  const lastLoad = sets[sets.length - 1].weight;
  const hitTop =
    sets.length >= exercise.sets &&
    sets.every((set) => set.reps >= exercise.repMax && set.weight >= lastLoad);
  if (hitTop && exercise.incrementLb > 0) {
    return lastLoad + exercise.incrementLb;
  }
  return lastLoad;
}

// Epley estimate; a single rep is the 1RM itself.
export function estimatedOneRepMax(weight: number, reps: number): number {
  if (weight <= 0 || reps <= 0) return 0;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// A finish this long after the last logged set almost always means Finish was tapped late.
export const LATE_FINISH_MINUTES = 30;
const FINISH_AFTER_LAST_SET_MS = 2 * 60_000;

export function lastSetAt(workout: Workout): number | null {
  if (!workout.sets.length) return null;
  return Math.max(...workout.sets.map((set) => Date.parse(set.completedAt)));
}

// Two minutes after the last set, or null when there is nothing to anchor to.
export function suggestedFinishAt(workout: Workout): string | null {
  const last = lastSetAt(workout);
  return last == null ? null : new Date(last + FINISH_AFTER_LAST_SET_MS).toISOString();
}

export function isLateFinish(workout: Workout, finishedAt = workout.finishedAt): boolean {
  const last = lastSetAt(workout);
  if (last == null || !finishedAt) return false;
  return Date.parse(finishedAt) - last > LATE_FINISH_MINUTES * 60_000;
}

export function formatLastSession(sets: LoggedSet[]): string {
  if (!sets.length) return "No history yet — set a starting weight today.";
  return sets.map((set) => `${set.weight} × ${set.reps}`).join(", ");
}

export function suggestedDayId(days: Day[], lastDayId: string | null): string {
  if (!lastDayId) return days[0].id;
  const index = days.findIndex((day) => day.id === lastDayId);
  if (index === -1) return days[0].id;
  return days[(index + 1) % days.length].id;
}

export function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function todayDate(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}
