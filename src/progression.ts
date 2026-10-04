import type { Day, Exercise, LoggedSet, Workout } from "./types";

export function workoutsForExercise(workouts: Workout[], exerciseId: string): Workout[] {
  return workouts.filter((workout) =>
    workout.sets.some((set) => set.exerciseId === exerciseId && workout.finishedAt),
  );
}

export function lastWorkingSets(workouts: Workout[], exerciseId: string): LoggedSet[] {
  for (const workout of workouts) {
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

export function nextTargetWeight(exercise: Exercise, workouts: Workout[]): number | null {
  const sets = lastWorkingSets(workouts, exercise.id);
  if (!sets.length) return null;
  const lastLoad = sets[sets.length - 1].weight;
  const hitTop =
    sets.length >= exercise.sets &&
    sets.every((set) => set.reps >= exercise.repMax && set.weight >= lastLoad);
  if (hitTop && exercise.incrementLb > 0) {
    return lastLoad + exercise.incrementLb;
  }
  return lastLoad;
}

export function formatLastSession(sets: LoggedSet[]): string {
  if (!sets.length) return "No history yet — set a starting weight today.";
  return sets.map((set) => `${set.weight} × ${set.reps}`).join(", ");
}

export function suggestedDayId(days: Day[], lastDayId: string | null, weekMode: "6day" | "5day"): string {
  const rotation = weekMode === "5day" ? days.filter((day) => day.id !== "legs-b") : days;
  if (!lastDayId) return rotation[0].id;
  const index = rotation.findIndex((day) => day.id === lastDayId);
  if (index === -1) return rotation[0].id;
  return rotation[(index + 1) % rotation.length].id;
}

export function visibleDays(days: Day[], weekMode: "6day" | "5day"): Day[] {
  return weekMode === "5day" ? days.filter((day) => day.id !== "legs-b") : days;
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
