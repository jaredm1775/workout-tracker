# Workout Tracker

Phone-first workout logger. Jared’s push / pull / legs program and Wendy’s 4-day split live in this repo. Switch profiles in the header. Every set is saved on the phone first, then synced live to a Google Sheet when sync is connected. The Calendar tab shows weekly and monthly days trained, and Today lists strength goals you can tick off.

Live site (after GitHub Pages deploy): `https://<your-github-username>.github.io/workout-tracker/`

## Live sync to Google Sheets

Each set you log is sent to a Google Sheet within a few seconds. With no signal, changes wait on the phone and go up when it is back online. The **Data** button in the header shows the sync state.

One-time setup:

1. Create a Google Sheet, then **Extensions → Apps Script**. Replace `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs) and save.
2. Choose `setup` in the function menu and press **Run**. Approve access. The execution log prints your **sync password** and the Sheet gets `Workouts`, `Sets` and `Milestones` tabs.
3. **Deploy → New deployment → Web app**. Execute as **Me**, access **Anyone**. Copy the web app URL.
4. In the app: **Data → Live sync**, paste the URL and password, press **Connect**. All history on the phone is uploaded.
5. For the second phone, press **Copy setup link for another phone** and open that link on it. The link holds the password, so send it only to yourself.

After changing the script, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

The Sheet holds:

- `Workouts`: one row per session (day, start, finish, duration, set count, volume)
- `Sets`: one row per set (exercise, weight, reps, estimated 1RM, rest)
- `Milestones`: goal checklist state per profile

The phone stays the source of truth. Editing rows in the Sheet does not change the app, and the next sync of that workout overwrites its rows.

## Connect GitHub and publish

1. Install [GitHub CLI](https://cli.github.com/) if `gh` is not already on your PATH.
2. Log in: `gh auth login --hostname github.com --git-protocol https --web`
3. From this folder run `powershell -File scripts/publish.ps1`

That creates the public `workout-tracker` repo, pushes `main`, and turns on GitHub Pages.

## Use on your phone

1. Open the live URL on Wi‑Fi once.
2. **iPhone:** Share → Add to Home Screen.
3. **Android:** Chrome menu → Install app / Add to Home Screen.
4. After the first load, the app works offline in the gym.

## What stays private

GitHub hosts the app and the programs (`data/*/program.json`, `PROGRAM.md`). Lift history lives in IndexedDB on the phone and in your private Google Sheet. The sync URL and password are stored only on the phones, never in the repo. **Data → Export JSON** still makes a backup file; do not commit it unless you want the numbers public.

## Local development

```bash
npm install
npm run dev
npm test
```

## Edit the plan

- [`data/jared/program.json`](data/jared/program.json) — Jared’s days, exercises, rest, progression increments
- [`data/jared/milestones.json`](data/jared/milestones.json) — Jared’s goal checklist
- [`data/wendy/program.json`](data/wendy/program.json) — Wendy’s 4-day split
- [`PROGRAM.md`](PROGRAM.md) — readable version of Jared’s split

Push to `main` and GitHub Actions tests and republishes the site.
