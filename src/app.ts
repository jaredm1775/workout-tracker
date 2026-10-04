import program from "../data/jared/program.json";
import milestoneCatalog from "../data/jared/milestones.json";
import {
  deleteWorkout,
  exportBackup,
  getMilestoneState,
  getSettings,
  getWorkout,
  importBackup,
  listWorkouts,
  mergeMilestones,
  saveMilestoneState,
  saveSettings,
  saveWorkout,
  type BackupPayload,
} from "./db";
import { profileById, resolveProfileId } from "./profiles";
import {
  formatLastSession,
  lastWeight,
  lastWorkingSets,
  newId,
  nextTargetWeight,
  suggestedDayId,
  todayDate,
  visibleDays,
} from "./progression";
import {
  elapsedSeconds,
  formatClock,
  remainingSeconds,
  requestWakeLock,
  vibrateDone,
  type RestTimerState,
} from "./timer";
import type { Day, Exercise, Milestone, Settings, View, Workout } from "./types";
import "./styles.css";

const rootEl = document.querySelector<HTMLDivElement>("#app");
if (!rootEl) throw new Error("Missing #app");
const root = rootEl;

const days = program.days as Day[];
const catalog = milestoneCatalog as Milestone[];

interface DraftSet {
  weight: number;
  reps: number;
}

let profileId = resolveProfileId();
let profile = profileById(profileId);
let view: View = "today";
let settings: Settings;
let workouts: Workout[] = [];
let milestones: Milestone[] = [];
let activeWorkout: Workout | null = null;
let drafts: Record<string, DraftSet> = {};
let rest: RestTimerState | null = null;
let wakeLock: WakeLockSentinel | null = null;
let lastTimerZero = false;
let timerHandle = 0;

function draftKey(exerciseId: string, setIndex: number): string {
  return `${exerciseId}:${setIndex}`;
}

function dayById(id: string): Day | undefined {
  return days.find((day) => day.id === id);
}

function visible(): Day[] {
  return visibleDays(days, settings.weekMode);
}

function sessionElapsed(): number {
  if (!activeWorkout) return 0;
  return elapsedSeconds(Date.parse(activeWorkout.startedAt));
}

function updateClocks(): void {
  const sessionEl = root.querySelector("[data-session-clock]");
  if (sessionEl && activeWorkout) {
    sessionEl.textContent = formatClock(sessionElapsed());
  }
  if (!rest) return;
  const left = remainingSeconds(rest);
  if (left <= 0 && !lastTimerZero) {
    lastTimerZero = true;
    vibrateDone();
  }
  const restEl = root.querySelector("[data-rest-clock]");
  if (restEl) {
    restEl.textContent = formatClock(left);
    restEl.classList.toggle("over", left < 0);
  }
}

async function refresh(): Promise<void> {
  profileId = resolveProfileId();
  profile = profileById(profileId);
  settings = await getSettings(profileId);
  workouts = await listWorkouts(profileId);
  milestones = mergeMilestones(catalog, await getMilestoneState(profileId));
  if (settings.activeWorkoutId) {
    activeWorkout = (await getWorkout(profileId, settings.activeWorkoutId)) ?? null;
    if (!activeWorkout) {
      settings.activeWorkoutId = null;
      await saveSettings(profileId, settings);
    }
  } else {
    activeWorkout = null;
  }
  if (settings.restStartedAt && settings.restPrescribed != null) {
    rest = {
      startedAt: Date.parse(settings.restStartedAt),
      prescribed: settings.restPrescribed,
    };
  } else {
    rest = null;
  }
  seedDrafts();
}

function seedDrafts(): void {
  if (!activeWorkout) return;
  const day = dayById(activeWorkout.dayId);
  if (!day) return;
  for (const exercise of day.exercises) {
    const suggested = nextTargetWeight(exercise, workouts) ?? lastWeight(workouts, exercise.id) ?? 0;
    for (let i = 0; i < exercise.sets; i += 1) {
      const logged = activeWorkout.sets.find(
        (set) => set.exerciseId === exercise.id && set.setIndex === i,
      );
      drafts[draftKey(exercise.id, i)] = {
        weight: logged?.weight ?? suggested,
        reps: logged?.reps ?? exercise.repMin,
      };
    }
  }
}

async function persistRest(): Promise<void> {
  settings.restStartedAt = rest ? new Date(rest.startedAt).toISOString() : null;
  settings.restPrescribed = rest?.prescribed ?? null;
  await saveSettings(profileId, settings);
}

async function startRest(prescribed: number): Promise<void> {
  rest = { startedAt: Date.now(), prescribed };
  lastTimerZero = false;
  await persistRest();
  wakeLock = await requestWakeLock();
  render();
}

async function clearRest(): Promise<void> {
  rest = null;
  lastTimerZero = false;
  await persistRest();
  if (wakeLock) {
    await wakeLock.release().catch(() => undefined);
    wakeLock = null;
  }
}

function restForNextSet(): number | undefined {
  if (!settings.restStartedAt) return undefined;
  return elapsedSeconds(Date.parse(settings.restStartedAt));
}

async function startWorkout(dayId: string): Promise<void> {
  const workout: Workout = {
    id: newId(),
    profileId,
    dayId,
    date: todayDate(),
    startedAt: new Date().toISOString(),
    sets: [],
  };
  activeWorkout = workout;
  settings.activeWorkoutId = workout.id;
  await saveWorkout(workout);
  await saveSettings(profileId, settings);
  workouts = [workout, ...workouts.filter((item) => item.id !== workout.id)];
  seedDrafts();
  view = "workout";
  render();
}

async function resumeWorkout(): Promise<void> {
  if (!activeWorkout) return;
  view = "workout";
  render();
}

async function completeSet(exercise: Exercise, setIndex: number): Promise<void> {
  if (!activeWorkout) return;
  const draft = drafts[draftKey(exercise.id, setIndex)];
  const existing = activeWorkout.sets.find(
    (set) => set.exerciseId === exercise.id && set.setIndex === setIndex,
  );
  const logged = {
    exerciseId: exercise.id,
    setIndex,
    weight: draft.weight,
    reps: draft.reps,
    restSeconds: existing?.restSeconds ?? restForNextSet(),
    completedAt: new Date().toISOString(),
  };
  activeWorkout.sets = [
    ...activeWorkout.sets.filter((set) => !(set.exerciseId === exercise.id && set.setIndex === setIndex)),
    logged,
  ];
  await saveWorkout(activeWorkout);
  await startRest(exercise.restSeconds);
}

async function finishWorkout(): Promise<void> {
  if (!activeWorkout) return;
  activeWorkout.finishedAt = new Date().toISOString();
  await saveWorkout(activeWorkout);
  settings.activeWorkoutId = null;
  await saveSettings(profileId, settings);
  await clearRest();
  activeWorkout = null;
  view = "today";
  workouts = await listWorkouts(profileId);
  render();
}

async function clearActiveSession(): Promise<void> {
  settings.activeWorkoutId = null;
  await saveSettings(profileId, settings);
  await clearRest();
  activeWorkout = null;
  drafts = {};
  workouts = await listWorkouts(profileId);
}

async function cancelWorkout(): Promise<void> {
  if (!activeWorkout) return;
  if (!confirm("Discard this workout? It will not be saved.")) return;
  await deleteWorkout(activeWorkout.id);
  await clearActiveSession();
  view = "today";
  render();
}

async function removeHistoryWorkout(id: string): Promise<void> {
  if (!confirm("Delete this workout? It will be removed from history.")) return;
  const wasActive = settings.activeWorkoutId === id || activeWorkout?.id === id;
  await deleteWorkout(id);
  if (wasActive) {
    await clearActiveSession();
  } else {
    workouts = await listWorkouts(profileId);
  }
  render();
}

function lastFinishedDayId(): string | null {
  const finished = workouts.find((workout) => workout.finishedAt);
  return finished?.dayId ?? null;
}

function renderTimer(): string {
  if (!rest) return "";
  const left = remainingSeconds(rest);
  const clockClass = left < 0 ? "over" : "";
  return `
    <section class="timer-bar">
      <div class="muted">Rest</div>
      <div class="timer-clock ${clockClass}" data-rest-clock>${formatClock(left)}</div>
      <div class="muted">Target ${formatClock(rest.prescribed)}</div>
      <div class="timer-actions">
        <button data-action="rest-minus">-15s</button>
        <button data-action="rest-plus">+15s</button>
        <button data-action="rest-skip">Skip</button>
      </div>
    </section>
  `;
}

function renderToday(): string {
  const suggested = suggestedDayId(days, lastFinishedDayId(), settings.weekMode);
  const activeDay = activeWorkout ? dayById(activeWorkout.dayId) : null;
  const weekHits = new Set(
    workouts
      .filter((workout) => workout.finishedAt && Date.now() - Date.parse(workout.startedAt) < 8 * 86400000)
      .map((workout) => workout.dayId),
  );
  return `
    <section class="card">
      <div class="row">
        <div>
          <div class="muted">This week</div>
          <h2>${settings.weekMode === "5day" ? "5-day PPL" : "6-day PPL"}</h2>
        </div>
        <div class="toggle">
          <button data-week="6day" class="${settings.weekMode === "6day" ? "active" : ""}">6 day</button>
          <button data-week="5day" class="${settings.weekMode === "5day" ? "active" : ""}">5 day</button>
        </div>
      </div>
      <div class="week-dots">
        ${visible()
          .map((day) => `<span class="dot ${weekHits.has(day.id) ? "hit" : ""}">${day.name}</span>`)
          .join("")}
      </div>
    </section>
    ${
      activeDay
        ? `<section class="card">
            <div class="muted">In progress</div>
            <h2>${activeDay.name}</h2>
            <button class="primary" data-action="resume">Resume workout</button>
          </section>`
        : ""
    }
    <section class="card">
      <div class="muted">Start a day</div>
      <div class="day-grid">
        ${visible()
          .map(
            (day) => `
          <button class="chip ${day.id === suggested ? "suggested" : ""}" data-start="${day.id}">
            ${day.name}
            <small>${day.focus}${day.id === suggested ? " · next" : ""}</small>
          </button>`,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderSetRow(exercise: Exercise, setIndex: number): string {
  const key = draftKey(exercise.id, setIndex);
  const draft = drafts[key] ?? { weight: 0, reps: exercise.repMin };
  const logged = activeWorkout?.sets.find(
    (set) => set.exerciseId === exercise.id && set.setIndex === setIndex,
  );
  return `
    <div class="set-row" data-exercise="${exercise.id}" data-set="${setIndex}">
      <div class="muted">${setIndex + 1}</div>
      <div class="stepper">
        <button data-step="weight" data-delta="${-exercise.incrementLb || -2.5}">-</button>
        <input inputmode="decimal" data-field="weight" value="${draft.weight}" />
        <button data-step="weight" data-delta="${exercise.incrementLb || 2.5}">+</button>
      </div>
      <div class="stepper">
        <button data-step="reps" data-delta="-1">-</button>
        <input inputmode="numeric" data-field="reps" value="${draft.reps}" />
        <button data-step="reps" data-delta="1">+</button>
      </div>
      <button class="done ${logged ? "complete" : ""}" data-complete="${exercise.id}" data-set="${setIndex}">
        ${logged ? "Logged" : "Done"}
      </button>
    </div>
  `;
}

function renderWorkout(): string {
  if (!activeWorkout) return `<section class="card">No active workout.</section>`;
  const day = dayById(activeWorkout.dayId);
  if (!day) return `<section class="card">Unknown day.</section>`;
  return `
    <div class="workout-sticky">
      <section class="session-bar">
        <div class="muted">Session</div>
        <div class="session-clock" data-session-clock>${formatClock(sessionElapsed())}</div>
      </section>
      ${renderTimer()}
    </div>
    <section class="card">
      <div class="row">
        <div>
          <div class="muted">${day.focus}</div>
          <h2>${day.name}</h2>
        </div>
        <div class="row-actions">
          <button class="danger" data-action="cancel">Cancel</button>
          <button data-action="finish">Finish</button>
        </div>
      </div>
    </section>
    ${day.exercises
      .map((exercise) => {
        const last = lastWorkingSets(workouts, exercise.id);
        const next = nextTargetWeight(exercise, workouts);
        return `
          <section class="card exercise">
            <h3>${exercise.name}</h3>
            <div class="muted">${exercise.sets} × ${exercise.repMin}–${exercise.repMax} · rest ${formatClock(exercise.restSeconds)}</div>
            <div class="muted">Last: ${formatLastSession(last)}</div>
            <div>Next: ${next == null ? "choose a starting weight" : `${next} lb`}</div>
            ${exercise.notes ? `<div class="muted">${exercise.notes}</div>` : ""}
            ${Array.from({ length: exercise.sets }, (_, i) => renderSetRow(exercise, i)).join("")}
          </section>
        `;
      })
      .join("")}
  `;
}

function historyMeta(workout: Workout): string {
  if (!workout.finishedAt) return `${workout.date} · in progress`;
  const duration = formatClock(elapsedSeconds(Date.parse(workout.startedAt), Date.parse(workout.finishedAt)));
  return `${workout.date} · ${duration}`;
}

function renderHistory(): string {
  if (!workouts.length) {
    return `<section class="card">No workouts yet. Log a session and it will show up here.</section>`;
  }
  return workouts
    .map((workout) => {
      const day = dayById(workout.dayId);
      const setLines = workout.sets
        .sort((a, b) => a.exerciseId.localeCompare(b.exerciseId) || a.setIndex - b.setIndex)
        .map((set) => {
          const exercise = days.flatMap((item) => item.exercises).find((item) => item.id === set.exerciseId);
          const restLabel = set.restSeconds != null ? ` · rest ${formatClock(set.restSeconds)}` : "";
          return `<div class="muted">${exercise?.name ?? set.exerciseId}: ${set.weight} × ${set.reps}${restLabel}</div>`;
        })
        .join("");
      return `
        <section class="card">
          <div class="row">
            <div>
              <div class="muted">${historyMeta(workout)}</div>
              <h3>${day?.name ?? workout.dayId}</h3>
            </div>
            <button class="danger" data-delete-workout="${workout.id}">Delete</button>
          </div>
          ${setLines || `<div class="muted">No sets logged.</div>`}
        </section>
      `;
    })
    .join("");
}

function renderGoals(): string {
  return `
    <section class="card">
      <h2>Should be able to</h2>
      <p class="muted">Check these off when you hit them in a working set, not a gym-max.</p>
    </section>
    ${milestones
      .map(
        (item) => `
      <button class="card goal" data-goal="${item.id}">
        <input type="checkbox" ${item.done ? "checked" : ""} />
        <div>
          <strong>${item.lift}</strong>
          <div class="muted">${item.target}</div>
        </div>
      </button>`,
      )
      .join("")}
  `;
}

function renderBackup(): string {
  return `
    <section class="card">
      <h2>Backup</h2>
      <p class="muted">Your lifts stay on this phone. Export a JSON file if you want a copy for Cursor or a new device. Do not commit that file to the public GitHub repo unless you want the numbers public.</p>
      <button class="primary" data-action="export">Export JSON</button>
      <button data-action="import">Import JSON</button>
      <input class="hidden" id="import-file" type="file" accept="application/json" />
    </section>
  `;
}

function render(): void {
  const titles: Record<View, string> = {
    today: "Today",
    workout: "Workout",
    history: "History",
    goals: "Goals",
    backup: "Backup",
  };
  root.innerHTML = `
    <header class="topbar">
      <div class="brand">Workout <span>Tracker</span></div>
      <div class="muted">${profile.name} · ${titles[view]}</div>
    </header>
    <nav class="nav">
      <button data-view="today" class="${view === "today" || view === "workout" ? "active" : ""}">Train</button>
      <button data-view="history" class="${view === "history" ? "active" : ""}">History</button>
      <button data-view="goals" class="${view === "goals" ? "active" : ""}">Goals</button>
      <button data-view="backup" class="${view === "backup" ? "active" : ""}">Backup</button>
    </nav>
    ${
      view === "today"
        ? renderToday()
        : view === "workout"
          ? renderWorkout()
          : view === "history"
            ? renderHistory()
            : view === "goals"
              ? renderGoals()
              : renderBackup()
    }
  `;
  updateClocks();
}

function bind(): void {
  root.addEventListener("click", async (event) => {
    const target = (event.target as HTMLElement).closest("button, [data-goal]");
    if (!(target instanceof HTMLElement)) return;

    const nextView = target.dataset.view as View | undefined;
    if (nextView) {
      view = nextView === "today" && activeWorkout ? "workout" : nextView;
      render();
      return;
    }

    if (target.dataset.week) {
      settings.weekMode = target.dataset.week === "5day" ? "5day" : "6day";
      await saveSettings(profileId, settings);
      render();
      return;
    }

    if (target.dataset.start) {
      await startWorkout(target.dataset.start);
      return;
    }

    if (target.dataset.action === "resume") {
      await resumeWorkout();
      return;
    }

    if (target.dataset.action === "finish") {
      await finishWorkout();
      return;
    }

    if (target.dataset.action === "cancel") {
      await cancelWorkout();
      return;
    }

    if (target.dataset.deleteWorkout) {
      await removeHistoryWorkout(target.dataset.deleteWorkout);
      return;
    }

    if (target.dataset.action === "rest-minus" && rest) {
      rest.prescribed = Math.max(15, rest.prescribed - 15);
      await persistRest();
      render();
      return;
    }

    if (target.dataset.action === "rest-plus" && rest) {
      rest.prescribed += 15;
      await persistRest();
      render();
      return;
    }

    if (target.dataset.action === "rest-skip") {
      await clearRest();
      render();
      return;
    }

    if (target.dataset.complete && target.dataset.set) {
      const day = activeWorkout ? dayById(activeWorkout.dayId) : undefined;
      const exercise = day?.exercises.find((item) => item.id === target.dataset.complete);
      if (exercise) await completeSet(exercise, Number(target.dataset.set));
      return;
    }

    if (target.dataset.step && target.dataset.delta) {
      const row = target.closest(".set-row");
      if (!(row instanceof HTMLElement) || !row.dataset.exercise || row.dataset.set == null) return;
      const key = draftKey(row.dataset.exercise, Number(row.dataset.set));
      const draft = drafts[key];
      const delta = Number(target.dataset.delta);
      if (target.dataset.step === "weight") {
        draft.weight = Math.max(0, Math.round((draft.weight + delta) * 2) / 2);
      } else {
        draft.reps = Math.max(0, draft.reps + delta);
      }
      render();
      return;
    }

    if (target.dataset.goal) {
      const state = Object.fromEntries(milestones.map((item) => [item.id, item.done]));
      state[target.dataset.goal] = !state[target.dataset.goal];
      await saveMilestoneState(profileId, state);
      milestones = mergeMilestones(catalog, state);
      render();
      return;
    }

    if (target.dataset.action === "export") {
      const payload = await exportBackup(profileId);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `workout-backup-${todayDate()}.json`;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (target.dataset.action === "import") {
      root.querySelector<HTMLInputElement>("#import-file")?.click();
    }
  });

  root.addEventListener("change", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id === "import-file" && target.files?.[0]) {
      try {
        const text = await target.files[0].text();
        const payload = JSON.parse(text) as BackupPayload;
        await importBackup(payload);
        await refresh();
        view = "history";
        render();
      } catch {
        window.alert("That file is not a valid Workout Tracker backup.");
      }
      return;
    }
    const row = target.closest(".set-row");
    if (!(row instanceof HTMLElement) || !row.dataset.exercise || row.dataset.set == null) return;
    const key = draftKey(row.dataset.exercise, Number(row.dataset.set));
    const value = Number(target.value);
    if (target.dataset.field === "weight") drafts[key].weight = Number.isFinite(value) ? value : 0;
    if (target.dataset.field === "reps") drafts[key].reps = Number.isFinite(value) ? value : 0;
  });
}

export async function startApp(): Promise<void> {
  await refresh();
  if (settings.activeWorkoutId) view = "workout";
  bind();
  render();
  window.clearInterval(timerHandle);
  timerHandle = window.setInterval(() => {
    if (view === "workout") updateClocks();
  }, 1000);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && view === "workout") updateClocks();
  });
  window.addEventListener("pageshow", () => {
    if (view === "workout") updateClocks();
  });
}
