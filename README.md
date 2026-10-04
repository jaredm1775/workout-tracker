# Workout Tracker

Phone-first workout logger. Jared’s push / pull / legs program and Wendy’s 4-day split live in this repo. Switch profiles in the header. Weights, reps, and rest times stay on the phone until you export a backup. The Calendar tab shows weekly and monthly days trained.

Live site (after GitHub Pages deploy): `https://<your-github-username>.github.io/workout-tracker/`

## Connect GitHub and publish

The tracker is its own git repo in this folder. It does not publish the rest of `cursor_workspace`.

1. Install [GitHub CLI](https://cli.github.com/) if `gh` is not already on your PATH.
2. Log in: `gh auth login --hostname github.com --git-protocol https --web`
3. From this folder run `powershell -File scripts/publish.ps1`

That creates the public `workout-tracker` repo, pushes `main`, and turns on GitHub Pages. The first deploy takes a minute. Then open:

`https://<your-github-username>.github.io/workout-tracker/`

## Use on your phone

1. Open the live URL on Wi‑Fi once.
2. **iPhone:** Share → Add to Home Screen.
3. **Android:** Chrome menu → Install app / Add to Home Screen.
4. After the first load, the app works offline in the gym.

## What stays private

GitHub hosts the app and the programs (`data/jared/program.json`, `data/wendy/program.json`, `PROGRAM.md`). IndexedDB on your phone holds each profile’s lift history. Use **Backup → Export JSON** if you want a file for Cursor. Do not commit that export unless you want the numbers public.

## Local development

```bash
npm install
npm run dev
```

## Edit the plan in Cursor

- [`data/jared/program.json`](data/jared/program.json) — Jared’s days, exercises, rest, progression increments
- [`data/wendy/program.json`](data/wendy/program.json) — Wendy’s 4-day split
- [`PROGRAM.md`](PROGRAM.md) — readable version of Jared’s split

Push to `main` and GitHub Actions republishes the site.
