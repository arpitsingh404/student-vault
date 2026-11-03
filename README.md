# Student Vault 2.0

Student Vault is a mobile-first, local-first student productivity app built from the supplied Capacitor APK. The original purple/lavender glass UI is preserved, but the prototype's demo data, plaintext PIN, fake passkey and in-memory CRUD have been replaced with a real encrypted vault.

Open-source project under the MIT License. No account server, no cloud document store, and no telemetry are included. Download the signed debug APK from GitHub Releases, or run the web app locally.

## What is implemented

### Secure local vault
- 6-digit PIN setup, change and recovery.
- Random 256-bit AES-GCM master key; the PIN and recovery code only wrap that key.
- PBKDF2-SHA256 (210,000 iterations) key derivation.
- Encrypted state in IndexedDB; document bytes encrypted individually before storage.
- No plaintext PIN, document name or document content in local storage.
- PIN attempt throttling, auto-lock, lock-on-reload, clear-on-lock.
- Optional WebAuthn passkey with PRF-derived key wrapping where the device/browser supports it. Unsupported devices honestly show "Unavailable" and use the PIN.
- Recovery code generation, regeneration, copy and text export.
- Encrypted vault-file export/restore (`.svault`); the file contains only wrapped keys and encrypted blobs and can live in Files or another safe location.
- Strict CSP, escaped user content, validated URLs and validated file types/sizes.

### Screens and features
- **Home**: real document count, encrypted bytes, open reminders, active applications, due banner, recent files, recent activity and upcoming reminders.
- **Vault**: PDF, PNG, JPG, WEBP, GIF and TXT upload; category filters; search across names, metadata and extracted PDF text; encrypted preview; download/share; rename; metadata; delete.
- **Reminders**: week calendar with due dots, create/edit/delete, categories, notes, Today/Upcoming/Completed, completion tracking and progress.
- **Jobs**: create/edit/delete applications with company, role, applied date, interview date, location, link, notes and status; filter by Applied/Shortlisted/Interview/Offer/Rejected.
- **Assistant**: persisted chat history, suggested prompts and a real on-device data assistant. It answers from the actual vault. Optional AI server support keeps provider keys off the phone.
- **Account**: profile editing, profile-photo upload/remove (shown on the lock screen, top bar and account), actual storage usage, AES status, in-app reminder preference, auto-lock selector, dark mode, passkey management, PIN change, recovery, vault-file save/restore, clear chat, erase all data and lock.
- **Lock screen**: first-run setup, PIN keypad, optional passkey and recovery-code reset.

## Install

1. Download `StudentVault.apk` from GitHub Releases.
2. Install it on Android (allow install from the file manager if prompted).
3. Create a 6-digit PIN, save the recovery code and save the encrypted `.svault` file.

> The release APK is debug-signed for sideloading. For Play Store distribution, build with a release keystore and increment `versionCode`.

## Architecture

```
ui/
  index.html          app shell and all seven screens
  styles.css          preserved design system + functional additions
  js/vault-core.js    WebCrypto, IndexedDB, auth metadata, validation
  js/app.js           application state, screens, CRUD, chat, settings
  vendor/             PDF.js
server/
  ai-proxy.mjs        optional AI proxy; provider key stays server-side
scripts/
  pack_apk.py         replaces Capacitor web assets in the base APK
  build-apk.ps1       zipalign + sign + verify
```

### Data model
- `localStorage.sv.auth.v2`: salt, wrapped master key, wrapped recovery key, recovery salt. No PIN.
- `localStorage.sv.public.v2`: display name/course/university for the lock screen. Email is kept inside the encrypted state.
- IndexedDB `studentvault/kv/state`: AES-GCM encrypted JSON state.
- IndexedDB `studentvault/files`: AES-GCM encrypted file blobs, keyed by random IDs.

## Run the web build

```powershell
cd ui
python -m http.server 4322 --bind 127.0.0.1
```

Open `http://127.0.0.1:4322/` or `http://localhost:4322/`. Create a vault with a 6-digit PIN. **Save the recovery code shown after creation.**

## Build the APK

The prebuilt APK is published in GitHub Releases. To rebuild the Android wrapper locally, place the supplied `StudentVault-debug.apk` base shell next to the build script (it is not committed because it is a binary build artifact). The script replaces its `assets/public` payload, zipaligns it, and signs it with the Android debug key.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-apk.ps1
```

Output: `StudentVault.apk`.

For a production release, use your own release keystore and increment `versionCode`. The included APK uses the debug key, which is not suitable for Play Store distribution.

## Vault file and ownership

The internal database is private to the app installation. It is encrypted and never uploaded. Use **Account > Vault file** to save one portable `.svault` file that the user controls. Keep it in Files or another safe place. Uninstalling the app removes the internal database; the `.svault` file can restore it. The file is encrypted and cannot be read without the vault PIN.

## Optional AI assistant

The on-device assistant is fully functional without any server. For open-ended LLM answers, use a server-side proxy. The key never goes into the APK or the browser.

1. Create `server/.env` from `server/.env.example`.
2. Put a **new** DeepSeek key in `server/.env` (never paste it into chat or commit it).
3. Start the proxy:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-ai.ps1
```

DeepSeek defaults are already set in the script/example: `https://api.deepseek.com/v1` and `deepseek-chat`. Set `SV_API_TOKEN` to a long random app token.

Then open **Account > AI assistant**, enter the server URL and app token, and test the connection. If the server is missing or unreachable, the app quickly falls back to on-device vault-data answers (10 second timeout, 60 second cooldown) instead of hanging or inventing a response. A plain HTTP or localhost AI URL is rejected on the phone; use HTTPS or on-device mode.

Profile photos are compressed to a 384 px JPEG thumbnail in the public profile so the lock screen can show them before unlock. Document files and vault state remain encrypted.

## Security model and honest limitations

- The vault is **local-first**. Document bytes and app state are encrypted at rest on the device. There is no cloud document store configured in this build, so there is no server-side document authorization to claim.
- The lock screen is a local access gate, not a replacement for a locked device. Use the Android screen lock as well.
- A 6-digit PIN protected by 210k PBKDF2 is appropriate for a local app but is not a substitute for a high-entropy passphrase against an offline attacker with the device.
- Passkeys require HTTPS/localhost plus a WebAuthn PRF-capable authenticator. Availability varies; the app never pretends a passkey works when it does not.
- Notifications are **in-app reminders** only. Android background notifications would require a native plugin and a new native build; the UI does not claim them.
- Downloads use the browser file download on the web build and the Android share sheet where available. A native "save to Downloads" plugin is not included.
- The AI proxy is included for deployment, but no provider key is bundled. This is deliberate.

## Verification performed

- Setup, lock, wrong PIN, correct PIN, reload persistence.
- PIN change and unlock with the new PIN.
- Recovery-code reset and unlock.
- Document upload (187 KB PDF), encrypted bytes verified, PDF preview rendered, rename, search/filter, delete.
- Reminder add, edit, complete, delete, calendar view, due banner.
- Job add, edit status, filter, link, delete.
- Local assistant answers from real vault data; AI proxy health and 503 fallback tested.
- Chat persistence, profile edit, dark mode, storage stats, vault-file export and vault-file restore.
- Lighthouse on lock screen and home: 100 accessibility, 100 best practices, 100 SEO.
- CSP and encrypted-at-rest inspection; APK zip/signature verification.
