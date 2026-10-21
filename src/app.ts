import {
  finishedWorkoutsByDate,
  formatDateKey,
  formatMonthTitle,
  formatWeekRange,
  monthCells,
  parseDateKey,
  shiftMonth,
  uniqueFinishedDates,
  weekDates,
  WEEKDAY_LETTERS,
} from "./calendar";
import {
  deleteWorkout,
  exportBackup,
  getMilestoneState,
  getSettings,
  getSyncConfig,
  getWorkout,
  importBackup,
  listWorkouts,
  mergeMilestones,
  requestPersistentStorage,
  saveMilestoneState,
  saveSettings,
  saveWorkout,
  validateBackup,
  type RestoreResult,
} from "./db";
import { profileById, PROFILES, resolveProfileId } from "./profiles";
import { milestoneCatalog, programFor } from "./programs";
import {
  formatLastSession,
  isLateFinish,
  lastSetAt,
  lastWeight,
  lastWorkingSets,
  newId,
  nextTargetWeight,
  suggestedDayId,
  suggestedFinishAt,
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
import {
  connectSheet,
  disconnectSheet,
  flushNow,
  onSyncChange,
  parseSetupHash,
  resendEverything,
  restoreFromSheet,
  scheduleSync,
  setupLink,
  startSyncLoop,
  syncState,
  type SyncState,
} from "./sync";
import type { Day, Exercise, Milestone, Program, Settings, SyncConfig, View, Workout } from "./types";
import "./styles.css";

const rootEl = document.querySelector<HTMLDivElement>("#app");
if (!rootEl) throw new Error("Missing #app");
const root = rootEl;

interface DraftSet {
  weight: number;
  reps: number;
}

let profileId = resolveProfileId();
let view: View = "today";
let settings: Settings;
let workouts: Workout[] = [];
let activeWorkout: Workout | null = null;
let drafts: Record<string, DraftSet> = {};
// Draft keys the user edited by hand; logging a set carries its weight only into untouched later sets.
let touchedDrafts = new Set<string>();
let rest: RestTimerState | null = null;
let wakeLock: WakeLockSentinel | null = null;
let lastTimerZero = false;
let timerHandle = 0;
const now = new Date();
let calendarYear = now.getFullYear();
let calendarMonth = now.getMonth();
let selectedCalendarDate = todayDate();
let milestones: Milestone[] = [];
// Explicit open/closed choices per exercise; without one, a card closes once every set is logged.
let collapsedOverride: Record<string, boolean> = {};
let syncConfig: SyncConfig | null = null;
let syncMessage = "";

function currentProgram(): Program {
  return programFor(profileId);
}

function days(): Day[] {
  return currentProgram().days;
}

function hasWeekToggle(): boolean {
  return days().some((day) => day.id === "legs-b");
}

function draftKey(exerciseId: string, setIndex: number): string {
  return `${exerciseId}:${setIndex}`;
}

function dayById(id: string): Day | undefined {
  return days().find((day) => day.id === id);
}

function exerciseById(id: string): Exercise | undefined {
  return days()
    .flatMap((day) => day.exercises)
    .find((exercise) => exercise.id === id);
}

function visible(): Day[] {
  return visibleDays(days(), settings.weekMode);
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
  settings = await getSettings(profileId);
  workouts = await listWorkouts(profileId);
  milestones = mergeMilestones(milestoneCatalog(profileId), await getMilestoneState(profileId));
  syncConfig = await getSyncConfig();
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
  collapsedOverride = {};
  touchedDrafts = new Set();
  await saveWorkout(workout);
  await saveSettings(profileId, settings);
  scheduleSync();
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
  for (let i = setIndex + 1; i < exercise.sets; i += 1) {
    const key = draftKey(exercise.id, i);
    const alreadyLogged = activeWorkout.sets.some((set) => set.exerciseId === exercise.id && set.setIndex === i);
    if (!alreadyLogged && !touchedDrafts.has(key) && drafts[key]) drafts[key].weight = draft.weight;
  }
  await saveWorkout(activeWorkout);
  scheduleSync();
  await startRest(exercise.restSeconds);
}

async function finishWorkout(): Promise<void> {
  if (!activeWorkout) return;
  const now = new Date().toISOString();
  const suggested = suggestedFinishAt(activeWorkout);
  let finishedAt = now;
  if (suggested && isLateFinish(activeWorkout, now)) {
    const useSuggested = confirm(
      `Your last set was at ${timeLabel(lastSetAt(activeWorkout) ?? suggested)}. Finish the workout at ${timeLabel(suggested)} instead of now?\n\nOK uses ${timeLabel(suggested)}. Cancel uses the current time.`,
    );
    if (useSuggested) finishedAt = suggested;
  }
  activeWorkout.finishedAt = finishedAt;
  await saveWorkout(activeWorkout);
  scheduleSync(0);
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
  scheduleSync();
  await clearActiveSession();
  view = "today";
  render();
}

async function removeHistoryWorkout(id: string): Promise<void> {
  if (!confirm("Delete this workout? It will be removed from history.")) return;
  const wasActive = settings.activeWorkoutId === id || activeWorkout?.id === id;
  await deleteWorkout(id);
  scheduleSync();
  if (wasActive) {
    await clearActiveSession();
  } else {
    workouts = await listWorkouts(profileId);
  }
  render();
}

function timeLabel(value: string | number): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function fixFinishTime(id: string): Promise<void> {
  const workout = workouts.find((item) => item.id === id);
  const suggested = workout ? suggestedFinishAt(workout) : null;
  if (!workout?.finishedAt || !suggested) return;
  const ok = confirm(
    `Change the end time from ${timeLabel(workout.finishedAt)} to ${timeLabel(suggested)}, two minutes after the last set? Sets are not changed.`,
  );
  if (!ok) return;
  workout.finishedAt = suggested;
  await saveWorkout(workout);
  scheduleSync();
  render();
}

function lastFinishedDayId(): string | null {
  const finished = workouts.find((workout) => workout.finishedAt);
  return finished?.dayId ?? null;
}

function setLines(workout: Workout): string {
  return [...workout.sets]
    .sort((a, b) => a.exerciseId.localeCompare(b.exerciseId) || a.setIndex - b.setIndex)
    .map((set) => {
      const exercise = exerciseById(set.exerciseId);
      const restLabel = set.restSeconds != null ? ` · rest ${formatClock(set.restSeconds)}` : "";
      return `<div class="muted">${exercise?.name ?? set.exerciseId}: ${set.weight} × ${set.reps}${restLabel}</div>`;
    })
    .join("");
}

function openCalendarDate(dateKey: string): void {
  selectedCalendarDate = dateKey;
  const parsed = parseDateKey(dateKey);
  calendarYear = parsed.getFullYear();
  calendarMonth = parsed.getMonth();
  view = "calendar";
  render();
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
  const suggested = suggestedDayId(days(), lastFinishedDayId(), settings.weekMode);
  const activeDay = activeWorkout ? dayById(activeWorkout.dayId) : null;
  const week = weekDates();
  const weekStart = formatDateKey(week[0]);
  const weekEnd = formatDateKey(week[6]);
  const trained = uniqueFinishedDates(workouts, weekStart, weekEnd);
  const trainedSet = new Set(trained);
  const today = todayDate();
  const dayWord = trained.length === 1 ? "day" : "days";
  return `
    <section class="card">
      <div class="week-head">
        <div>
          <div class="muted">This week</div>
          <h2>${formatWeekRange(week)}</h2>
          <div class="muted">${trained.length} ${dayWord} trained</div>
        </div>
        ${
          hasWeekToggle()
            ? `<div class="toggle">
                <button data-week="6day" class="${settings.weekMode === "6day" ? "active" : ""}">6 day</button>
                <button data-week="5day" class="${settings.weekMode === "5day" ? "active" : ""}">5 day</button>
              </div>`
            : ""
        }
      </div>
      <div class="week-strip">
        ${week
          .map((date, index) => {
            const key = formatDateKey(date);
            const classes = [
              "week-day",
              key === today ? "today" : "",
              trainedSet.has(key) ? "hit" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `
              <button class="${classes}" data-cal-date="${key}">
                <span class="week-dow">${WEEKDAY_LETTERS[index]}</span>
                <span class="week-num">${date.getDate()}</span>
              </button>`;
          })
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
    ${renderMilestones()}
  `;
}

function renderMilestones(): string {
  if (!milestones.length) return "";
  const done = milestones.filter((item) => item.done).length;
  return `
    <section class="card">
      <div class="muted">Goals · ${done} of ${milestones.length} hit</div>
      <div class="milestones">
        ${milestones
          .map(
            (item) => `
          <button class="milestone ${item.done ? "done-goal" : ""}" data-milestone="${item.id}" aria-pressed="${item.done}">
            <span class="milestone-check">${item.done ? "✓" : ""}</span>
            <span>
              <span class="milestone-target">${item.target}</span>
              <small class="muted">${item.lift}</small>
            </span>
          </button>`,
          )
          .join("")}
      </div>
    </section>
  `;
}

async function toggleMilestone(id: string): Promise<void> {
  milestones = milestones.map((item) => (item.id === id ? { ...item, done: !item.done } : item));
  const state = Object.fromEntries(milestones.map((item) => [item.id, item.done]));
  await saveMilestoneState(profileId, state);
  scheduleSync();
  render();
}

function loggedCount(exercise: Exercise): number {
  return activeWorkout?.sets.filter((set) => set.exerciseId === exercise.id).length ?? 0;
}

function isCollapsed(exercise: Exercise): boolean {
  return collapsedOverride[exercise.id] ?? loggedCount(exercise) >= exercise.sets;
}

function renderSetRow(exercise: Exercise, setIndex: number): string {
  const key = draftKey(exercise.id, setIndex);
  const draft = drafts[key] ?? { weight: 0, reps: exercise.repMin };
  const logged = activeWorkout?.sets.find(
    (set) => set.exerciseId === exercise.id && set.setIndex === setIndex,
  );
  return `
    <div class="set-row" data-exercise="${exercise.id}" data-set="${setIndex}">
      <div class="set-row-head">
        <div class="set-label">Set ${setIndex + 1}</div>
        <button class="done ${logged ? "complete" : ""}" data-complete="${exercise.id}" data-set="${setIndex}">
          ${logged ? "Logged" : "Done"}
        </button>
      </div>
      <div class="stepper-field">
        <span class="muted">Weight</span>
        <div class="stepper">
          <button data-step="weight" data-delta="${-exercise.incrementLb || -2.5}">-</button>
          <input inputmode="decimal" data-field="weight" value="${draft.weight}" />
          <button data-step="weight" data-delta="${exercise.incrementLb || 2.5}">+</button>
        </div>
      </div>
      <div class="stepper-field">
        <span class="muted">Reps</span>
        <div class="stepper">
          <button data-step="reps" data-delta="-1">-</button>
          <input inputmode="numeric" data-field="reps" value="${draft.reps}" />
          <button data-step="reps" data-delta="1">+</button>
        </div>
      </div>
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
      ${day.notes ? `<p class="muted day-notes">${day.notes}</p>` : ""}
    </section>
    ${day.exercises
      .map((exercise) => {
        const last = lastWorkingSets(workouts, exercise.id);
        const next = nextTargetWeight(exercise, workouts);
        const side = exercise.laterality === "per_side" ? " each side" : "";
        const count = loggedCount(exercise);
        const collapsed = isCollapsed(exercise);
        const today = activeWorkout?.sets
          .filter((set) => set.exerciseId === exercise.id)
          .sort((a, b) => a.setIndex - b.setIndex);
        return `
          <section class="card exercise ${collapsed ? "collapsed" : ""} ${count >= exercise.sets ? "all-logged" : ""}">
            <button class="exercise-head" data-toggle-exercise="${exercise.id}" aria-expanded="${!collapsed}">
              <span class="exercise-title">
                <h3>${exercise.name}</h3>
                <span class="muted">${count}/${exercise.sets} sets logged</span>
              </span>
              <span class="chevron" aria-hidden="true">›</span>
            </button>
            ${
              collapsed
                ? today?.length
                  ? `<div class="muted">Today: ${formatLastSession(today)}</div>`
                  : ""
                : `
            <div class="muted">${exercise.sets} × ${exercise.repMin}–${exercise.repMax}${side} · rest ${formatClock(exercise.restSeconds)}</div>
            <div class="muted">Last: ${formatLastSession(last)}</div>
            <div>Next: ${next == null ? "choose a starting weight" : `${next} lb`}</div>
            ${exercise.notes ? `<div class="muted">${exercise.notes}</div>` : ""}
            ${Array.from({ length: exercise.sets }, (_, i) => renderSetRow(exercise, i)).join("")}`
            }
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
      const lines = setLines(workout);
      return `
        <section class="card">
          <div class="row">
            <div>
              <div class="muted">${historyMeta(workout)}</div>
              <h3>${day?.name ?? workout.dayId}</h3>
            </div>
            <button class="danger" data-delete-workout="${workout.id}">Delete</button>
          </div>
          ${
            isLateFinish(workout)
              ? `<div class="late-finish">
                  <span class="muted">Ended long after the last set.</span>
                  <button data-fix-finish="${workout.id}">Fix end time</button>
                </div>`
              : ""
          }
          ${lines || `<div class="muted">No sets logged.</div>`}
        </section>
      `;
    })
    .join("");
}

function renderCalendar(): string {
  const today = todayDate();
  const week = weekDates();
  const weekCount = uniqueFinishedDates(workouts, formatDateKey(week[0]), formatDateKey(week[6])).length;
  const monthStart = formatDateKey(new Date(calendarYear, calendarMonth, 1));
  const monthEnd = formatDateKey(new Date(calendarYear, calendarMonth + 1, 0));
  const monthCount = uniqueFinishedDates(workouts, monthStart, monthEnd).length;
  const byDate = finishedWorkoutsByDate(workouts);
  const selected = byDate.get(selectedCalendarDate) ?? [];
  const weekWord = weekCount === 1 ? "day" : "days";
  const monthWord = monthCount === 1 ? "day" : "days";
  return `
    <section class="card">
      <div class="month-nav">
        <button data-cal-shift="-1" aria-label="Previous month">‹</button>
        <h2>${formatMonthTitle(calendarYear, calendarMonth)}</h2>
        <button data-cal-shift="1" aria-label="Next month">›</button>
      </div>
      <div class="muted cal-stats">${weekCount} ${weekWord} this week · ${monthCount} ${monthWord} this month</div>
      <div class="month-grid">
        ${WEEKDAY_LETTERS.map((letter) => `<div class="month-dow">${letter}</div>`).join("")}
        ${monthCells(calendarYear, calendarMonth)
          .map((date) => {
            if (!date) return `<div class="month-cell empty"></div>`;
            const key = formatDateKey(date);
            const hit = byDate.has(key);
            const classes = [
              "month-cell",
              hit ? "hit" : "",
              key === selectedCalendarDate ? "selected" : "",
              key === today ? "today" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `
              <button class="${classes}" data-month-date="${key}">
                <span>${date.getDate()}</span>
                ${hit ? `<span class="month-dot"></span>` : `<span class="month-dot spacer"></span>`}
              </button>`;
          })
          .join("")}
      </div>
    </section>
    <section class="card">
      ${
        selected.length
          ? selected
              .map((workout) => {
                const day = dayById(workout.dayId);
                const lines = setLines(workout);
                return `
                  <div class="cal-detail">
                    <div class="muted">${historyMeta(workout)}</div>
                    <h3>${day?.name ?? workout.dayId}</h3>
                    ${day?.focus ? `<div class="muted">${day.focus}</div>` : ""}
                    ${lines || `<div class="muted">No sets logged.</div>`}
                  </div>`;
              })
              .join("")
          : `<div class="muted">${selectedCalendarDate} · no finished workout</div>`
      }
    </section>
  `;
}

function syncLabel(state: SyncState): string {
  if (state.status === "off") return "Sync off";
  if (state.status === "syncing") return "Syncing…";
  if (state.status === "error") return `Sync error · ${state.pending} waiting`;
  if (state.pending) return `${state.pending} waiting`;
  return "Synced";
}

function renderSyncBadge(): string {
  const state = syncState();
  return `<span class="sync-badge ${state.status}" data-sync-badge>${syncLabel(state)}</span>`;
}

function renderSync(): string {
  const state = syncState();
  const last = state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : "never";
  if (!syncConfig) {
    return `
      <section class="card">
        <h2>Live sync to Google Sheets</h2>
        <p class="muted">Every set you log is sent to your Google Sheet within seconds. Without signal, sets wait on the phone and go up when you are back online. Setup steps are at the top of <code>apps-script/Code.gs</code>.</p>
        <label class="field">
          <span class="muted">Web app URL</span>
          <input id="sync-url" type="url" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" />
        </label>
        <label class="field">
          <span class="muted">Sync password</span>
          <input id="sync-token" type="password" autocomplete="off" />
        </label>
        <button class="primary" data-action="sync-connect">Connect</button>
        ${syncMessage ? `<p class="sync-message">${syncMessage}</p>` : ""}
      </section>
    `;
  }
  return `
    <section class="card">
      <h2>Live sync to Google Sheets</h2>
      <div class="sync-status-row">${renderSyncBadge()}</div>
      <p class="muted" data-sync-detail>Last sync: ${last}${state.lastError ? ` · ${state.lastError}` : ""}</p>
      <button class="primary" data-action="sync-now">Sync now</button>
      <button data-action="sync-restore">Restore from Sheet</button>
      <button data-action="sync-link">Copy setup link for another phone</button>
      <button data-action="sync-resend">Resend all history</button>
      <button class="danger" data-action="sync-disconnect">Disconnect this phone</button>
      ${syncMessage ? `<p class="sync-message">${syncMessage}</p>` : ""}
    </section>
  `;
}

function renderBackup(): string {
  return `
    ${renderSync()}
    <section class="card">
      <h2>Backup file</h2>
      <p class="muted">Saves a JSON file of ${profileById(profileId).name}'s history to this phone, or loads one back. This is separate from the Sheet and does not upload anything. Do not commit that file to the public GitHub repo unless you want the numbers public.</p>
      <button class="primary" data-action="export">Export JSON</button>
      <button data-action="import">Import JSON</button>
      <input class="hidden" id="import-file" type="file" accept="application/json" />
    </section>
  `;
}

async function connectFromForm(): Promise<void> {
  const url = root.querySelector<HTMLInputElement>("#sync-url")?.value ?? "";
  const token = root.querySelector<HTMLInputElement>("#sync-token")?.value ?? "";
  syncMessage = "Connecting…";
  render();
  try {
    await afterConnect(await connectSheet({ url, token }), "Connected.");
  } catch (error) {
    syncMessage = error instanceof Error ? error.message : "Could not connect.";
  }
  render();
}

function restoredLabel(result: RestoreResult): string {
  if (!result.added) return "Nothing to restore; this phone already has everything in the Sheet.";
  return `Restored ${result.added} workout${result.added === 1 ? "" : "s"} from the Sheet.`;
}

async function afterConnect(result: RestoreResult | null, lead: string): Promise<void> {
  syncConfig = await getSyncConfig();
  await refresh();
  syncMessage = result?.added
    ? `${lead} ${restoredLabel(result)} Your history on this phone is being sent to the Sheet.`
    : `${lead} Your history on this phone is being sent to the Sheet.`;
}

async function restoreNow(): Promise<void> {
  if (!confirm("Add any workouts from the Sheet that are missing on this phone? Nothing on this phone is changed or removed.")) {
    return;
  }
  syncMessage = "Restoring…";
  render();
  try {
    const result = await restoreFromSheet();
    await refresh();
    syncMessage = restoredLabel(result);
  } catch (error) {
    syncMessage = error instanceof Error ? error.message : "Could not restore.";
  }
  render();
}

async function connectFromSetupHash(): Promise<void> {
  const config = parseSetupHash(location.hash);
  if (!config) return;
  history.replaceState(null, "", `${location.pathname}${location.search}#${profileId}`);
  if (syncConfig?.url === config.url && syncConfig.token === config.token) return;
  if (!confirm("Connect this phone to the workout Google Sheet?")) return;
  try {
    await afterConnect(await connectSheet(config), "Connected from setup link.");
  } catch (error) {
    syncMessage = error instanceof Error ? error.message : "Could not connect.";
  }
  view = "backup";
  render();
}

function updateSyncIndicators(state: SyncState): void {
  root.querySelectorAll<HTMLElement>("[data-sync-badge]").forEach((el) => {
    el.className = `sync-badge ${state.status}`;
    el.textContent = syncLabel(state);
  });
  const detail = root.querySelector("[data-sync-detail]");
  if (detail) {
    const last = state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : "never";
    detail.textContent = `Last sync: ${last}${state.lastError ? ` · ${state.lastError}` : ""}`;
  }
}

function render(): void {
  const titles: Record<View, string> = {
    today: "Today",
    workout: "Workout",
    history: "History",
    calendar: "Calendar",
    backup: "Sync & backup",
  };
  root.innerHTML = `
    <header class="topbar">
      <div class="topbar-row">
        <div>
          <div class="brand">Workout <span>Tracker</span></div>
          <div class="muted">${titles[view]}</div>
        </div>
        <button data-view="backup" class="data-button ${view === "backup" ? "active-ghost" : ""}">
          Data ${renderSyncBadge()}
        </button>
      </div>
      <div class="toggle profile-toggle">
        ${PROFILES.map(
          (item) =>
            `<button data-profile="${item.id}" class="${item.id === profileId ? "active" : ""}">${item.name}</button>`,
        ).join("")}
      </div>
    </header>
    <nav class="nav">
      <button data-view="today" class="${view === "today" || view === "workout" ? "active" : ""}">Train</button>
      <button data-view="history" class="${view === "history" ? "active" : ""}">History</button>
      <button data-view="calendar" class="${view === "calendar" ? "active" : ""}">Calendar</button>
    </nav>
    ${
      view === "today"
        ? renderToday()
        : view === "workout"
          ? renderWorkout()
          : view === "history"
            ? renderHistory()
            : view === "calendar"
              ? renderCalendar()
              : renderBackup()
    }
  `;
  updateClocks();
}

function bind(): void {
  root.addEventListener("click", async (event) => {
    const target = (event.target as HTMLElement).closest("button");
    if (!(target instanceof HTMLElement)) return;

    if (target.dataset.profile) {
      if (target.dataset.profile === profileId) return;
      location.hash = target.dataset.profile;
      return;
    }

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

    if (target.dataset.calDate) {
      openCalendarDate(target.dataset.calDate);
      return;
    }

    if (target.dataset.calShift) {
      const next = shiftMonth(calendarYear, calendarMonth, Number(target.dataset.calShift));
      calendarYear = next.year;
      calendarMonth = next.month;
      render();
      return;
    }

    if (target.dataset.monthDate) {
      selectedCalendarDate = target.dataset.monthDate;
      render();
      return;
    }

    if (target.dataset.start) {
      await startWorkout(target.dataset.start);
      return;
    }

    if (target.dataset.milestone) {
      await toggleMilestone(target.dataset.milestone);
      return;
    }

    if (target.dataset.toggleExercise) {
      const exercise = exerciseById(target.dataset.toggleExercise);
      if (exercise) collapsedOverride[exercise.id] = !isCollapsed(exercise);
      render();
      return;
    }

    if (target.dataset.action === "sync-connect") {
      await connectFromForm();
      return;
    }

    if (target.dataset.action === "sync-now") {
      syncMessage = "";
      await flushNow();
      render();
      return;
    }

    if (target.dataset.action === "sync-restore") {
      await restoreNow();
      return;
    }

    if (target.dataset.action === "sync-resend") {
      syncMessage = "Resending every workout on this phone…";
      render();
      await resendEverything();
      syncMessage = "";
      render();
      return;
    }

    if (target.dataset.action === "sync-link" && syncConfig) {
      const link = setupLink(syncConfig, profileId);
      try {
        await navigator.clipboard.writeText(link);
        syncMessage = "Setup link copied. Open it on the other phone. It contains the sync password, so only send it to yourself.";
      } catch {
        window.prompt("Copy this setup link:", link);
        syncMessage = "";
      }
      render();
      return;
    }

    if (target.dataset.action === "sync-disconnect") {
      if (!confirm("Stop syncing this phone? Data already in the Sheet stays there.")) return;
      await disconnectSheet();
      syncConfig = null;
      syncMessage = "";
      render();
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

    if (target.dataset.fixFinish) {
      await fixFinishTime(target.dataset.fixFinish);
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
      const field = target.dataset.step === "weight" ? "weight" : "reps";
      touchedDrafts.add(key);
      if (field === "weight") {
        draft.weight = Math.max(0, Math.round((draft.weight + delta) * 2) / 2);
      } else {
        draft.reps = Math.max(0, draft.reps + delta);
      }
      // Update just this input; a full render would jump the page and drop focus.
      const input = row.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
      if (input) input.value = String(draft[field]);
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
        let payload;
        try {
          payload = validateBackup(JSON.parse(text));
        } catch {
          window.alert("That file is not a valid Workout Tracker backup.");
          return;
        }
        const name = profileById(payload.profileId).name;
        const ok = confirm(
          `Replace all of ${name}'s history on this phone with the ${payload.workouts.length} workouts in this file? This cannot be undone.`,
        );
        if (!ok) return;
        await importBackup(payload);
        scheduleSync(0);
        await refresh();
        view = "history";
        render();
      } finally {
        target.value = "";
      }
      return;
    }
    const row = target.closest(".set-row");
    if (!(row instanceof HTMLElement) || !row.dataset.exercise || row.dataset.set == null) return;
    const key = draftKey(row.dataset.exercise, Number(row.dataset.set));
    const value = Number(target.value);
    touchedDrafts.add(key);
    if (target.dataset.field === "weight") drafts[key].weight = Number.isFinite(value) ? value : 0;
    if (target.dataset.field === "reps") drafts[key].reps = Number.isFinite(value) ? value : 0;
  });
}

async function onHashChange(): Promise<void> {
  if (parseSetupHash(location.hash)) {
    await connectFromSetupHash();
  }
  const next = resolveProfileId();
  if (next === profileId) return;
  view = "today";
  drafts = {};
  rest = null;
  lastTimerZero = false;
  await refresh();
  if (settings.activeWorkoutId) view = "workout";
  render();
}

export async function startApp(): Promise<void> {
  await refresh();
  if (settings.activeWorkoutId) view = "workout";
  bind();
  render();
  void requestPersistentStorage();
  onSyncChange(updateSyncIndicators);
  startSyncLoop();
  await connectFromSetupHash();
  window.addEventListener("hashchange", () => {
    void onHashChange();
  });
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
