import jaredMilestones from "../data/jared/milestones.json";
import jaredProgram from "../data/jared/program.json";
import wendyProgram from "../data/wendy/program.json";
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
  return programFor(profileId)
    .days.flatMap((day) => day.exercises)
    .find((exercise) => exercise.id === exerciseId);
}
