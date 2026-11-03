# Contributing

1. Fork the repository and create a branch.
2. Keep the local-first security model: never send vault data to a third party without explicit user configuration.
3. Do not commit `.env` files, API keys, vault exports, or signing keys.
4. Run `node --check ui/js/app.js`, `node --check ui/js/vault-core.js`, and the build script before opening a pull request.
5. Update `README.md` when behavior or security claims change.

Please keep security claims honest. If a feature needs a server or native Android code, document that requirement rather than showing a fake status in the app.
