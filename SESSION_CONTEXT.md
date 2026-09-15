# Adlane-App Session Context — Session Complete

## 📱 Project Overview
- **App Name:** Adlane (football betting tracker)
- **Repo:** https://github.com/idrissechaibi-alt/adlane-app
- **EAS Project ID:** `3092f538-6e10-4f4a-b55c-1b5257b584e0`
- **EAS Dashboard:** https://expo.dev/accounts/adlane300/projects/adlane-app/builds
- **Tech Stack:** React Native 0.86.3, Expo SDK 57, TypeScript

---

## 🔧 Issues Fixed During This Session

### 1. `.gitignore` Blocking `src/data/historical.ts`
**Problem:** The pattern `data/` in `.gitignore` was blocking `src/data/` from being uploaded to EAS (EAS uses `.gitignore` for file filtering).

**Solution:** Changed `data/` to `/data/` and added `!src/data/` exclusion.
```gitignore
# Local app data and GitHub credentials must never be committed
app-adlane-data/
/data/
!src/data/
.tools/
*.sqlite
```

### 2. GitHub Actions YAML Syntax Errors
**Problem:** Workflow file had incorrect indentation.

**Solution:** Recreated `.github/workflows/eas-build.yml` with proper 2-space indentation:
```yaml
name: EAS Build
on:
  push:
    branches:
      - main
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm install -g eas-cli
      - uses: expo/expo-github-action@v9
        with:
          eas-version: latest
          token: ${{ secrets.EAS_TOKEN }}
      - run: eas build --platform android --profile preview --non-interactive
```

### 3. Node.js 24 Incompatibility
**Problem:** Metro bundler doesn't support Node.js 24.

**Solution:** Installed Node.js 20 portable at:
`C:\Users\morde\OneDrive\Desktop\adlane-app\.tools\node20\node-v20.20.2-win-x64`

### 4. Invalid `eas.json` Cache Configuration
**Problem:** `build.cache.enabled` is not a valid EAS config option.

**Solution:** Removed cache configuration from `eas.json`:
```json
{
  "cli": {
    "version": ">= 5.2.0"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "android": {
        "buildType": "apk"
      }
    },
    "production": {}
  }
}
```

### 5. Module Resolution Error (Critical Fix)
**Problem:** EAS build failed with:
```
Unable to resolve module ../data/historical from .../src/screens/DashboardScreen.tsx
```

**Root Cause:** `.tools/` folder was in `.gitignore` but also contained Node.js 20, causing file inclusion issues during EAS upload.

**Solution:** Added `.tools/` to `.gitignore` AND committed `.gitignore` fix that allows `src/data/`.

---

## 📁 Key File Locations

| File | Path |
|------|------|
| Project Root | `C:\Users\morde\OneDrive\Desktop\adlane-app` |
| .gitignore | `C:\Users\morde\OneDrive\Desktop\adlane-app\.gitignore` |
| eas.json | `C:\Users\morde\OneDrive\Desktop\adlane-app\eas.json` |
| GitHub Workflow | `C:\Users\morde\OneDrive\Desktop\adlane-app\.github\workflows\eas-build.yml` |
| Package.json | `C:\Users\morde\OneDrive\Desktop\adlane-app\package.json` |
| Current Build ID | `3092f538-6e10-4f4a-b55c-1b5257b584e0` |

---

## 🔑 Secrets Needed for GitHub Actions

The workflow requires:
1. **`EAS_TOKEN`** — EAS authentication token
   - Get from: https://expo.dev/settings/access-tokens
   - Add to: https://github.com/idrissechaibi-alt/adlane-app/settings/secrets/actions

---

## 🏃 How to Build

### Local Build (with Node.js 20)
```bash
cd "C:\Users\morde\OneDrive\Desktop\adlane-app"
$env:PATH = "C:\Users\morde\OneDrive\Desktop\adlane-app\.tools\node20\node-v20.20.2-win-x64;$env:PATH"
eas build --platform android --profile preview
```

### GitHub Actions (Automatic)
Push to `main` branch → triggers EAS Build automatically.

---

## 📊 Current Build Status

| Item | Status |
|------|--------|
| Latest Build ID | `3092f538-6e10-4f4a-b55c-1b5257b584e0` |
| Build Status | Check at https://expo.dev/accounts/adlane300/projects/adlane-app/builds/3092f538-6e10-4f4a-b55c-1b5257b584e0 |
| GitHub Actions | https://github.com/idrissechaibi-alt/adlane-app/actions |

---

## 📝 Git Commit History (Session)

| Commit | Message |
|--------|---------|
| `129101b` | Fix: Remove invalid cache config from eas.json |
| `f0bc490` | Fix: Allow src/data/ in .gitignore + clean workflow |
| `bdab525` | Revert custom metro config (use Expo default) |
| `3fe4781` | Disable EAS cache to force fresh Metro bundle |
| `1968440` | Add metro.config.js for proper module resolution |

---

## 🔮 For New Session on Another Computer

1. **Clone the repo:**
   ```bash
   git clone https://github.com/idrissechaibi-alt/adlane-app.git
   cd adlane-app
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **For local build with EAS:**
   - Install EAS CLI: `npm install -g eas-cli`
   - Login: `eas login`
   - Build: `eas build --platform android --profile preview`

4. **For GitHub Actions:**
   - Make sure `EAS_TOKEN` secret is set in GitHub repo settings
   - Push to main → build triggers automatically

---

## 🎯 Key Lessons Learned

1. **EAS uses `.gitignore` for file filtering** — any files you want uploaded must NOT be excluded
2. **Node.js 24 breaks Metro bundler** — use Node.js 20 for React Native projects
3. **Invalid YAML indentation breaks GitHub Actions** — use 2-space indentation consistently
4. **EAS JSON config has restrictions** — `cache.enabled` is NOT valid in eas.json

---

## 📞 Useful Links

- **EAS Dashboard:** https://expo.dev/accounts/adlane300/projects/adlane-app
- **GitHub Repo:** https://github.com/idrissechaibi-alt/adlane-app
- **EAS Build Status:** https://expo.dev/accounts/adlane300/projects/adlane-app/builds/3092f538-6e10-4f4a-b55c-1b5257b584e0
- **Expo Access Tokens:** https://expo.dev/settings/access-tokens
- **GitHub Actions:** https://github.com/idrissechaibi-alt/adlane-app/actions