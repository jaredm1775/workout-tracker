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
  // "topSet": add load once the first working set reaches repMax. Default "allSets".
  progression?: "allSets" | "topSet";
  // Swaps offered at the gym. Each logs under its own id; missing fields come from the parent.
  alternatives?: Alternative[];
}

export type Alternative = Partial<Omit<Exercise, "alternatives">> & { id: string; name: string };

// Names for exercises and days no longer in the program, so old history still reads well.
export interface Archive {
  days?: Array<{ id: string; name: string; focus?: string }>;
  exercises?: Array<{ id: string; name: string }>;
}

export interface Day {
  id: string;
  name: string;
  focus: string;
  notes?: string;
  exercises: Exercise[];
}

export interface Program {
  name: string;
  unit: "lb";
  days: Day[];
  // Shows a collapsible note field on each exercise during a workout.
  exerciseNotes?: boolean;
  archive?: Archive;
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
  profileId: string;
  dayId: string;
  date: string;
  startedAt: string;
  finishedAt?: string;
  sets: LoggedSet[];
  // Program exercise id -> alternative id chosen for this session.
  swaps?: Record<string, string>;
  // Exercise id (as logged) -> note.
  notes?: Record<string, string>;
}

export interface Milestone {
  id: string;
  lift: string;
  target: string;
  done: boolean;
}

export interface Settings {
  activeWorkoutId: string | null;
  restStartedAt: string | null;
  restPrescribed: number | null;
}

export type View = "today" | "workout" | "history" | "calendar" | "progress" | "backup";

export interface SyncConfig {
  url: string;
  token: string;
}

export type SyncOp =
  | { type: "workout"; workout: Workout }
  | { type: "delete"; profileId: string; workoutId: string }
  | { type: "milestones"; profileId: string; state: Record<string, boolean> };

export type SyncQueue = Record<string, { rev: string; op: SyncOp }>;
