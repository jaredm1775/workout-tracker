import jaredMilestones from "../data/jared/milestones.json";
import jaredProgram from "../data/jared/program.json";
import wendyProgram from "../data/wendy/program.json";
import { asExercise } from "./progression";
import type { Day, Exercise, Milestone, Program } from "./types";

export const PROGRAMS: Record<string, Program> = {
  jared: jaredProgram as Program,
  wendy: wendyProgram as Program,
};

const MILESTONES: Record<string, Milestone[]> = {
  jared: jaredMilestones as Milestone[],
};

export function programFor(profileId: string): Program {
  return PROGRAMS[profileId] ?? PROGRAMS.jared;
}

export function milestoneCatalog(profileId: string): Milestone[] {
  return MILESTONES[profileId] ?? [];
}

export function findDay(profileId: string, dayId: string): Day | undefined {
  return programFor(profileId).days.find((day) => day.id === dayId);
}

export function findExercise(profileId: string, exerciseId: string): Exercise | undefined {
  for (const exercise of programFor(profileId).days.flatMap((day) => day.exercises)) {
    if (exercise.id === exerciseId) return exercise;
    const alternative = exercise.alternatives?.find((item) => item.id === exerciseId);
    if (alternative) return asExercise(exercise, alternative);
  }
  return undefined;
}

// Display names that also cover alternatives and retired days and exercises.
export function exerciseName(profileId: string, exerciseId: string): string {
  return (
    findExercise(profileId, exerciseId)?.name ??
    programFor(profileId).archive?.exercises?.find((item) => item.id === exerciseId)?.name ??
    exerciseId
  );
}

export function dayLabel(profileId: string, dayId: string): { name: string; focus: string } {
  const day = findDay(profileId, dayId) ?? programFor(profileId).archive?.days?.find((item) => item.id === dayId);
  return { name: day?.name ?? dayId, focus: day?.focus ?? "" };
}
