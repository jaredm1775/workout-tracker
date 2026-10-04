# PPL Tracker

Phone-first push / pull / legs logger. The written program lives in this repo. Your weights, reps, and rest times stay on the phone until you export a backup.

Live site (after GitHub Pages deploy): https://\<your-github-username\>.github.io/ppl-tracker/

## Use on your phone

1. Open the live URL on Wi‑Fi once.
2. **iPhone:** Share → Add to Home Screen.
3. **Android:** Chrome menu → Install app / Add to Home Screen.
4. After the first load, the app works offline in the gym.

## What stays private

GitHub hosts the app and the program (`data/program.json`, `PROGRAM.md`). IndexedDB on your phone holds the lift history. Use **Backup → Export JSON** if you want a file for Cursor. Do not commit that export unless you want the numbers public.

## Local development

```bash
npm install
npm run dev
```

## Edit the plan in Cursor

- [`data/program.json`](data/program.json) — days, exercises, rest, progression increments
- [`data/milestones.json`](data/milestones.json) — “should be able to” checklist
- [`PROGRAM.md`](PROGRAM.md) — readable version of the split

Push to `main` and GitHub Actions republishes the site.
