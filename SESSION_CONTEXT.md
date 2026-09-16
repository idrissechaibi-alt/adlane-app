# Adlane-App Session Context — Final stabilization & OTA

## 📱 Project Overview
- **App Name:** Adlane (football betting tracker)
- **Repo:** https://github.com/idrissechaibi-alt/adlane-app
- **EAS Project ID:** `3092f538-6e10-4f4a-b55c-1b5257b584e0`
- **Tech Stack:** React Native 0.86.3, Expo SDK 57, SQLite, GitHub Sync.

---

## 🔧 Final Fixes Applied (Session Complete)

### 1. Dashboard Crash & Empty State
- **Fix:** Restored `LedgerSummary` calculations that were missing.
- **Improvement:** Added `seedDatabaseIfEmpty()` in `storage.ts` to automatically import historical bets from `historical.ts` into SQLite on the first run.
- **UI:** Added progress bars for ROI and P&L.

### 2. Morning Scan (Today's Matches)
- **Fix:** Updated `scheduler.ts` to use `new Date()` for match generation. The scan now shows matches for "Today".
- **Combinés:** They appear in the "Planning" screen when a slot reaches T-90 (90 mins before kickoff).

### 3. GitHub Sync Robustness
- **SHA Conflict Fix:** Added `Cache-Control: no-cache` and a timestamp parameter to GitHub API calls to force fetching the latest SHA before saving.
- **Connection Indicator:** Added a visual status light (Green = Connected, Red = Error) in the `GitSyncScreen`.

### 4. OTA Updates (Automation)
- **Workflow:** `.github/workflows/eas-build.yml` now triggers `eas update` instead of a full build.
- **Channels:** `eas.json` is configured with `production`, `preview`, and `development` channels.
- **Trigger:** Push to `main` branch publishes an update to `production` in ~2 mins.

---

## 📁 Key File Locations

| File | Path |
|------|------|
| **Session Context** | `C:\Users\morde\OneDrive\Desktop\adlane-app\SESSION_CONTEXT.md` |
| .gitignore | `C:\Users\morde\StudioProjects\adlane-app\.gitignore` |
| eas.json | `C:\Users\morde\StudioProjects\adlane-app\eas.json` |
| GitHub Workflow | `C:\Users\morde\StudioProjects\adlane-app\.github\workflows\eas-build.yml` |

---

## 🏃 How to Resume Tomorrow

1.  **Open Android Studio** and open this project.
2.  **Give me the content of this file** (`SESSION_CONTEXT.md`).
3.  **To see changes in your app**:
    - Push any small change to GitHub (`git push`).
    - Wait 3 minutes.
    - In the App: **Paramètres > Sauvegarde GitHub > Vérifier les mises à jour**.
    - The Dashboard crash is gone, and the "Voyant" is active.

---

## 🔑 Reminder: Secrets
Make sure **`EAS_TOKEN`** is set in GitHub Secrets.

---

## 🎯 Next Steps
- Verify the "Scouting" matches regrouping.
- Add real betting API integration for live matches.
