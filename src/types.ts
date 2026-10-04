export type WeekMode = "6day" | "5day";
export type Laterality = "bilateral" | "per_side";

export interface Exercise {
  id: string;
  name: string;
  sets: number;
  repMin: number;
  repMax: number;
  restSeconds: number;
  incrementLb: number;
  notes?: string;
  laterality?: Laterality;
}

export interface Day {
  id: string;
  name: string;
  focus: string;
  exercises: Exercise[];
}

export interface Program {
  name: string;
  unit: "lb";
  days: Day[];
}

export interface LoggedSet {
  exerciseId: string;
  setIndex: number;
  weight: number;
  reps: number;
  rir?: number;
  restSeconds?: number;
  completedAt: string;
}

export interface Workout {
  id: string;
  dayId: string;
  date: string;
  startedAt: string;
  finishedAt?: string;
  sets: LoggedSet[];
}

export interface Milestone {
  id: string;
  lift: string;
  target: string;
  done: boolean;
}

export interface Settings {
  weekMode: WeekMode;
  activeWorkoutId: string | null;
  restStartedAt: string | null;
  restPrescribed: number | null;
}

export type View = "today" | "workout" | "history" | "goals" | "backup";
