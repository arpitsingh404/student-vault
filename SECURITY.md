# Security

Student Vault is local-first. Document bytes and vault state are encrypted on the device; no document data is uploaded by the app.

## Reporting a vulnerability

Do not open a public issue for a vulnerability involving secrets or user data. Contact the maintainer privately through the GitHub profile linked from this repository.

## What is protected

- AES-256-GCM for vault state and file bytes.
- PBKDF2-SHA256 (210,000 iterations) for PIN/recovery key derivation.
- PIN is never stored. Five failed PIN attempts trigger a 30-second lockout, then exponential backoff.
- Recovery-code attempts are throttled.
- Auto-lock and lock-on-reload/background.
- Strict Content Security Policy and HTML escaping for user content.
- File type and 25 MB size validation.
- AI provider key stays in the server environment; never in the APK or browser.

## Known limitations

- The app is local-first. There is no server-side document authorization, JWT session, OTP flow, refresh token or remote device-management service.
- Root detection and app-integrity attestation are not implemented in the debug APK; they require native release hardening and Play Integrity.
- The GitHub APK is debug-signed. Build with a release keystore for production.
- A six-digit PIN is a local access gate, not a replacement for the phone's screen lock.

## AI proxy

The optional AI proxy is in `server/ai-proxy.mjs`. Run it behind HTTPS and set `SV_API_TOKEN`; never commit `server/.env` or expose the provider key.
