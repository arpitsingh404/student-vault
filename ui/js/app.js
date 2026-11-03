/* Student Vault application controller.
 * Local-first encrypted vault: data is decrypted only after PIN/passkey unlock.
 */
(function () {
  'use strict';

  const C = window.VaultCore;
  const $ = (id) => document.getElementById(id);
  const $$ = (selector, root) => Array.prototype.slice.call((root || document).querySelectorAll(selector));
  const STATUSES = ['Applied', 'Shortlisted', 'Interview', 'Offer', 'Rejected'];
  const STATUS_PILL = { Offer: 'ok', Interview: 'info', Shortlisted: 'warn', Rejected: 'danger', Applied: 'info' };
  const STORAGE_DISPLAY_BYTES = 400 * 1024 * 1024;

  let masterRaw = null;
  let masterKey = null;
  let STATE = null;
  let saveQueue = Promise.resolve();
  let savingTimer = null;
  let lastActive = 0;
  let pinBuffer = '';
  let unlockBusy = false;
  let currentScreen = 'home';
  let selectedDay = C.todayISO();
  let jobFilter = 'All';
  let currentDocId = null;
  let currentReminderId = null;
  let currentJobId = null;
  let currentJobStatus = 'Applied';
  let currentRecoveryCode = '';
  let confirmCallback = null;
  let convertSource = null;
  let convertTitle = '';
  let convertFmt = 'png';
  let viewerUrl = '';
  let selectedBackupFile = null;
  let importFromSetup = false;
  let chatBusy = false;
  let nativeShell = false;
  let aiDownUntil = 0;
  let lastChatSent = 0;
  let chatSendTimes = [];
  let pdfPasswordResolver = null;
  let recoveryPaneHtml = '';
  let pendingRecoveryRaw = null;
  let pendingRecoveryAuth = null;

  /* ---------- small utilities ---------- */
  function first(name) {
    return String(name || 'Student').trim().split(/\s+/)[0] || 'Student';
  }

  function toast(message) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function showSaving(on) {
    const el = $('saveState');
    if (!el) return;
    el.classList.toggle('show', !!on);
    clearTimeout(savingTimer);
    if (on) savingTimer = setTimeout(() => el.classList.remove('show'), 900);
  }

  function fullDate(iso) {
    return C.prettyDate(iso);
  }

  function relativeTime(timestamp) {
    if (!timestamp) return 'never';
    const mins = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return new Date(timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }

  function firstName() {
    return first((STATE && STATE.profile && STATE.profile.name) || (C.getPublic() && C.getPublic().name));
  }

  function profile() {
    return (STATE && STATE.profile) || C.getPublic() || { name: 'Student', course: '', university: '', email: '' };
  }

  function initialsFor(name) {
    return C.initials(name);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setHtml(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value;
  }

  function toggle(id, on, display) {
    const el = $(id);
    if (el) el.style.display = on ? (display || 'flex') : 'none';
  }

  function on(id, event, handler) {
    const el = $(id);
    if (el) el.addEventListener(event, handler);
  }

  function escape(value) {
    return C.escapeHtml(value);
  }

  async function pickSaveFile(name, mime, description, extension) {
    if (typeof window.showSaveFilePicker !== 'function') return null;
    try {
      return await window.showSaveFilePicker({
        suggestedName: name,
        types: [{
          description: description || 'Student Vault file',
          accept: { [mime || 'application/octet-stream']: [extension || '.bin'] }
        }]
      });
    } catch (error) {
      if (error && error.name === 'AbortError') return 'cancelled';
      console.warn('Save picker unavailable', error);
      return null;
    }
  }

  async function writeSaveHandle(handle, blob) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || '');
        resolve(result.includes(',') ? result.split(',').pop() : result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function saveOrShare(blob, name) {
    if (!blob) return false;
    if (window.NativeVault && typeof window.NativeVault.saveFile === 'function') {
      try {
        const base64 = await blobToBase64(blob);
        const result = window.NativeVault.saveFile(name || 'student-vault-file', base64, blob.type || 'application/octet-stream');
        if (String(result || '').startsWith('ok')) return true;
        toast('Could not save the file to Downloads.');
        return false;
      } catch (error) {
        console.error('Native save failed', error);
        toast('Could not save the file.');
        return false;
      }
    }
    const file = new File([blob], name || 'student-vault-file', { type: blob.type || 'application/octet-stream' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name || 'Student Vault file' });
        return true;
      } catch (error) {
        if (error && error.name === 'AbortError') return false;
      }
    }
    C.downloadBlob(blob, name);
    return true;
  }

  function today() {
    return C.todayISO();
  }

  function deviceId() {
    let id = localStorage.getItem('sv.device.v1');
    if (!id) {
      id = 'dev_' + C.b64encode(C.randomBytes(8)).replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
      localStorage.setItem('sv.device.v1', id);
    }
    return id;
  }

  function lastUnlockAt() {
    return Number(localStorage.getItem('sv.lastUnlock.v1') || 0);
  }

  function markUnlock() {
    localStorage.setItem('sv.lastUnlock.v1', String(Date.now()));
  }

  function readRecoveryFail() {
    try { return JSON.parse(localStorage.getItem('sv.recoveryFail.v2') || '{"count":0,"until":0}'); }
    catch (_) { return { count: 0, until: 0 }; }
  }

  function recordRecoveryFail() {
    const fail = readRecoveryFail();
    const count = (fail.count || 0) + 1;
    const until = count >= 5 ? Date.now() + Math.min(300000, 60000 * Math.pow(2, Math.floor(count / 5) - 1)) : 0;
    localStorage.setItem('sv.recoveryFail.v2', JSON.stringify({ count, until }));
  }

  function resetRecoveryFail() {
    localStorage.removeItem('sv.recoveryFail.v2');
  }

  function isDone(r) {
    return !!r.done;
  }

  function dueCount(date) {
    if (!STATE) return 0;
    return STATE.reminders.filter((r) => !r.done && r.due === date).length;
  }

  function openCount() {
    return STATE ? STATE.reminders.filter((r) => !r.done).length : 0;
  }

  function storageBytes() {
    return STATE ? STATE.documents.reduce((sum, doc) => sum + (Number(doc.size) || 0), 0) : 0;
  }

  /* ---------- public profile / headings ---------- */
  function getAvatarUrl() {
    const pub = C.getPublic() || {};
    return pub.avatar || '';
  }

  function effectiveAiEndpoint() {
    if (Date.now() < aiDownUntil) return '';
    const raw = STATE && STATE.settings ? STATE.settings.aiEndpoint : '';
    const endpoint = C.safeHttpUrl(raw);
    if (!endpoint) return '';
    // A loopback proxy on the PC is not reachable from the phone WebView.
    if (nativeShell && /^http:\/\//i.test(endpoint)) return '';
    return endpoint.replace(/\/+$/, '');
  }

  function applyAvatar(elementId, initials, avatarUrl) {
    const el = $(elementId);
    if (!el) return;
    if (avatarUrl) {
      el.classList.add('avatar-photo');
      el.style.backgroundImage = 'url("' + avatarUrl + '")';
      el.textContent = '';
      el.setAttribute('aria-label', 'Profile photo');
    } else {
      el.classList.remove('avatar-photo');
      el.style.backgroundImage = '';
      el.textContent = initials;
      el.removeAttribute('aria-label');
    }
  }

  function applyPublic(p) {
    const data = p || C.getPublic() || { name: 'Student' };
    const stored = C.getPublic() || {};
    const avatar = data.avatar || stored.avatar || '';
    const ini = initialsFor(data.name);
    const full = data.name || 'Student';
    const meta = [data.course, data.university].filter(Boolean).join(' · ');
    ['topAvatar', 'drawerAvatar', 'profileAvatar', 'lockAvatar', 'setupAvatar', 'pinAvatar'].forEach((id) => applyAvatar(id, ini, avatar));
    setText('profileName', full);
    setText('profileMeta', meta || 'Add your course and university');
    setText('profileEmail', data.email || '');
    setText('drawerName', full);
    setText('drawerMeta', meta || 'Local encrypted vault');
    setText('lockSub', full + ' · your vault is locked');
    if (STATE) {
      setText('drawerMeta', meta || 'Local encrypted vault');
      setText('drawerName', full);
    }
  }

  function syncPublicFromState() {
    if (!STATE) return;
    const p = STATE.profile || {};
    const current = C.getPublic() || {};
    const pub = {
      name: p.name || 'Student',
      course: p.course || '',
      university: p.university || '',
      initials: initialsFor(p.name),
      avatar: current.avatar || '',
      createdAt: p.createdAt || Date.now()
    };
    C.setPublic(pub);
    applyPublic(pub);
  }

  function renderAvatarPreview() {
    const initials = initialsFor(profile().name);
    applyAvatar('avatarPreview', initials, getAvatarUrl());
    const remove = $('removeAvatarBtn');
    if (remove) remove.style.display = getAvatarUrl() ? 'block' : 'none';
  }

  function titleFor(screen) {
    const p = profile();
    const name = p.name || 'Student';
    const headings = {
      home: ['Hello, ' + first(name), 'Your vault'],
      vault: ['Your vault', 'Documents'],
      reminders: ['Stay on track', 'Reminders'],
      jobs: ['Career', 'Applications'],
      chat: ['Assistant', 'Student Vault'],
      profile: ['Signed in as', name]
    };
    return headings[screen] || headings.home;
  }

  /* ---------- navigation ---------- */
  function movePill(button) {
    const pill = $('tabPill');
    const bar = $('tabbar');
    if (!pill || !bar || !button) return;
    const barRect = bar.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    pill.style.left = (rect.left - barRect.left + 4) + 'px';
    pill.style.width = (rect.width - 8) + 'px';
  }

  function go(screen) {
    currentScreen = screen;
    $$('.screen').forEach((el) => el.classList.toggle('active', el.dataset.screen === screen));
    $$('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === screen));
    const main = document.querySelector('main');
    if (main) {
      main.classList.toggle('chat-mode', screen === 'chat');
      main.scrollTop = 0;
    }
    const [hello, title] = titleFor(screen);
    setText('helloText', hello);
    setText('helloName', title);
    const fab = $('fab');
    if (fab) fab.style.display = (screen === 'vault' || screen === 'reminders') ? 'grid' : 'none';
    const active = $$('.tab').find((el) => el.dataset.tab === screen);
    if (active) movePill(active);
    renderScreen(screen);
  }

  function renderScreen(screen) {
    if (screen === 'home') renderHome();
    if (screen === 'vault') renderVault();
    if (screen === 'reminders') renderReminders();
    if (screen === 'jobs') renderJobs();
    if (screen === 'chat') renderChat();
    if (screen === 'profile') renderAccount();
  }

  function openDrawer() {
    $$('.drawer-item[data-drawer]').forEach((el) => {
      el.classList.toggle('active', el.dataset.drawer === currentScreen);
    });
    $('drawer').classList.add('show');
    $('drawerBackdrop').classList.add('show');
  }

  function closeDrawer() {
    $('drawer').classList.remove('show');
    $('drawerBackdrop').classList.remove('show');
  }

  /* ---------- sheets ---------- */
  function openSheet(id) {
    $$('.sheet').forEach((sheet) => sheet.classList.remove('show'));
    const sheet = $(id);
    if (!sheet) return;
    sheet.classList.add('show');
    $('backdrop').classList.add('show');
  }

  function closeSheets() {
    $$('.sheet').forEach((sheet) => sheet.classList.remove('show'));
    $('backdrop').classList.remove('show');
  }

  function confirmAction(title, text, buttonLabel, callback, danger) {
    confirmCallback = callback;
    setText('confirmTitle', title);
    setText('confirmText', text);
    const ok = $('confirmOk');
    ok.textContent = buttonLabel || 'Confirm';
    ok.className = 'sheet-btn ' + (danger === false ? 'primary' : 'btn-danger');
    openSheet('confirmSheet');
  }

  /* ---------- persistence ---------- */
  async function saveNow() {
    if (!masterKey || !STATE) return;
    showSaving(true);
    const packed = await C.encryptJSON(masterKey, STATE);
    await C.dbPut('kv', { k: 'state', v: packed });
  }

  function persist() {
    if (!masterKey || !STATE) return Promise.resolve();
    saveQueue = saveQueue.then(saveNow).catch((error) => {
      console.error('Vault save failed', error);
      toast('Could not save changes. Storage may be full.');
    });
    return saveQueue;
  }

  function normalizeState(raw) {
    const base = raw && typeof raw === 'object' ? raw : {};
    const pub = C.getPublic() || {};
    const p = base.profile || {};
    const settings = base.settings || {};
    const state = {
      version: 2,
      createdAt: base.createdAt || Date.now(),
      profile: {
        name: p.name || pub.name || 'Student',
        email: p.email || pub.email || '',
        course: p.course || pub.course || '',
        university: p.university || pub.university || '',
        createdAt: p.createdAt || pub.createdAt || Date.now()
      },
      settings: {
        notifications: settings.notifications !== false,
        autoLockMinutes: typeof settings.autoLockMinutes === 'number' ? settings.autoLockMinutes : 5,
        theme: settings.theme || localStorage.getItem('sv-theme') || 'light',
        aiEndpoint: settings.aiEndpoint || '',
        aiToken: settings.aiToken || ''
      },
      documents: Array.isArray(base.documents) ? base.documents : [],
      reminders: Array.isArray(base.reminders) ? base.reminders : [],
      jobs: Array.isArray(base.jobs) ? base.jobs : [],
      chats: Array.isArray(base.chats) ? base.chats : [],
      activity: Array.isArray(base.activity) ? base.activity : [],
      lastBackupAt: base.lastBackupAt || null
    };
    if (!state.chats.length) state.chats = [greetingMessage(state)];
    return state;
  }

  function greetingMessage(state) {
    const name = first((state && state.profile && state.profile.name) || C.getPublic() && C.getPublic().name);
    return {
      id: C.uid('msg'),
      role: 'assistant',
      text: 'Hi ' + name + ' — I am your Student Vault assistant. I can answer from your encrypted documents, reminders, applications and storage data.',
      at: Date.now()
    };
  }

  async function loadStateForMaster() {
    const record = await C.dbGet('kv', 'state');
    if (!record || !record.v) return null;
    return C.decryptJSON(masterKey, record.v);
  }

  function logActivity(text, detail) {
    if (!STATE) return;
    STATE.activity.unshift({
      id: C.uid('act'),
      text: text,
      detail: detail || '',
      at: Date.now()
    });
    STATE.activity = STATE.activity.slice(0, 30);
  }

  /* ---------- lock / unlock ---------- */
  function showPane(name) {
    const panes = { setup: 'setupPane', bio: 'bioPane', pin: 'pinPane', recovery: 'recoveryPane' };
    if (name === 'recovery' && $('recoveryPane').dataset.reset === '1' && recoveryPaneHtml) {
      $('recoveryPane').innerHTML = recoveryPaneHtml;
      delete $('recoveryPane').dataset.reset;
      pendingRecoveryRaw = null;
      pendingRecoveryAuth = null;
    }
    Object.keys(panes).forEach((key) => {
      const el = $(panes[key]);
      if (el) el.style.display = key === name ? 'flex' : 'none';
    });
    $('lockScreen').classList.add('show');
    $('authErr').textContent = '';
    $('pinErr').textContent = '';
    if (name === 'pin') {
      pinBuffer = '';
      renderPinDots();
      updateLockLabels();
    }
  }

  function updateLockLabels() {
    const p = C.getPublic();
    if (p) applyPublic(p);
    const hasPasskey = !!C.getPasskey();
    const supported = passkeySupported();
    if (hasPasskey && supported) {
      $('passkeyLabel').textContent = 'Unlock with passkey';
      $('passkeySub').textContent = 'Device biometrics or screen lock';
      $('useBioBtn').style.display = 'block';
    } else {
      $('passkeyLabel').textContent = 'Passkey not set up';
      $('passkeySub').textContent = 'Use your PIN or add a passkey in Account';
      $('useBioBtn').style.display = 'none';
    }
  }

  function refreshGate() {
    const auth = C.getAuth();
    const pub = C.getPublic();
    if (pub) applyPublic(pub);
    if (!auth) {
      showPane('setup');
      return;
    }
    if (C.getPasskey() && passkeySupported()) showPane('bio');
    else showPane('pin');
  }

  function renderPinDots() {
    $$('#pinDots i').forEach((dot, index) => dot.classList.toggle('on', index < pinBuffer.length));
  }

  async function unlockWithPin(pin) {
    if (unlockBusy) return false;
    unlockBusy = true;
    const keypad = $('keypad');
    if (keypad) keypad.style.pointerEvents = 'none';
    $('pinErr').textContent = '';
    try {
      const auth = C.getAuth();
      if (!auth) throw new Error('Vault is not set up.');
      const fail = readFailState();
      if (fail.until > Date.now()) {
        const seconds = Math.ceil((fail.until - Date.now()) / 1000);
        throw new Error('Too many attempts. Try again in ' + seconds + 's.');
      }
      const kek = await C.deriveKek(pin, auth.salt);
      const raw = await C.unwrapMasterRaw(auth.wrappedMaster, kek);
      masterKey = await C.importAesKey(raw);
      const loaded = await loadStateForMaster();
      if (!loaded) {
        masterRaw = raw;
        STATE = normalizeState(null);
        syncPublicFromState();
        await saveNow();
      } else {
        masterRaw = raw;
        STATE = normalizeState(loaded);
        syncPublicFromState();
      }
      resetFailState();
      unlockBusy = false;
      if (keypad) keypad.style.pointerEvents = '';
      onUnlocked('PIN');
      return true;
    } catch (error) {
      recordFail();
      $('pinErr').textContent = error && error.name === 'OperationError'
        ? 'Incorrect PIN. Try again.'
        : (error.message || 'Unable to unlock.');
      pinBuffer = '';
      renderPinDots();
      unlockBusy = false;
      if (keypad) keypad.style.pointerEvents = '';
      return false;
    }
  }

  function onUnlocked(method) {
    resetFailState();
    resetRecoveryFail();
    markUnlock();
    $('lockScreen').classList.remove('show');
    $$('.sheet').forEach((sheet) => sheet.classList.remove('show'));
    $('backdrop').classList.remove('show');
    applyTheme(STATE.settings.theme === 'dark');
    applyPublic(STATE.profile);
    lastActive = Date.now();
    go('home');
    renderAll();
    toast('Vault unlocked with ' + method);
    const due = STATE.reminders.filter((r) => !r.done && r.due <= today()).length;
    if (STATE.settings.notifications && due) {
      setTimeout(() => toast(due + (due === 1 ? ' reminder is due' : ' reminders are due')), 500);
    }
  }

  function lockNow() {
    STATE = null;
    masterKey = null;
    masterRaw = null;
    pinBuffer = '';
    unlockBusy = false;
    chatBusy = false;
    currentDocId = currentReminderId = currentJobId = null;
    currentRecoveryCode = '';
    selectedBackupFile = null;
    pendingRecoveryRaw = null;
    pendingRecoveryAuth = null;
    lastActive = 0;
    closeSheets();
    closeViewer();
    closeDrawer();
    ['chatMessages', 'vaultList', 'recentList', 'todayList', 'upcomingList', 'completedList', 'jobsList', 'activityList', 'homeReminders'].forEach((id) => {
      const el = $(id);
      if (el) el.innerHTML = '';
    });
    refreshGate();
  }

  function readFailState() {
    try {
      return JSON.parse(localStorage.getItem('sv.fail.v2') || '{"count":0,"until":0}');
    } catch (_) {
      return { count: 0, until: 0 };
    }
  }

  function recordFail() {
    const fail = readFailState();
    const count = (fail.count || 0) + 1;
    const until = count >= 5 ? Date.now() + Math.min(300000, 30000 * Math.pow(2, Math.floor(count / 5) - 1)) : 0;
    localStorage.setItem('sv.fail.v2', JSON.stringify({ count, until }));
  }

  function resetFailState() {
    localStorage.removeItem('sv.fail.v2');
  }

  /* ---------- setup / recovery ---------- */
  async function createVault() {
    const name = $('setupName').value.trim();
    const email = $('setupEmail') ? $('setupEmail').value.trim() : '';
    const course = $('setupCourse') ? $('setupCourse').value.trim() : '';
    const university = $('setupUni') ? $('setupUni').value.trim() : '';
    const pin = $('setupPin').value;
    const pin2 = $('setupPin2').value;
    const error = $('setupErr');
    error.textContent = '';
    if (!name) { error.textContent = 'Enter your name.'; return; }
    if (!C.isValidEmail(email)) { error.textContent = 'Enter a valid email or leave it blank.'; return; }
    if (!/^\d{6}$/.test(pin)) { error.textContent = 'Create a 6-digit PIN.'; return; }
    if (pin !== pin2) { error.textContent = 'The PINs do not match.'; return; }

    const button = $('createVaultBtn');
    button.disabled = true;
    button.textContent = 'Creating encrypted vault…';
    try {
      const salt = C.b64encode(C.randomBytes(16));
      const recoverySalt = C.b64encode(C.randomBytes(16));
      const raw = C.newMasterRaw();
      const kek = await C.deriveKek(pin, salt);
      const wrappedMaster = await C.wrapMasterRaw(raw, kek);
      const recoveryCode = C.randomRecoveryCode();
      const recoveryKey = await C.deriveRecoveryKey(recoveryCode, recoverySalt);
      const recoveryWrapped = await C.wrapMasterRaw(raw, recoveryKey);
      const auth = {
        version: 2,
        salt: salt,
        wrappedMaster: wrappedMaster,
        recoverySalt: recoverySalt,
        recoveryWrapped: recoveryWrapped,
        createdAt: Date.now()
      };
      const pub = {
        name: name,
        course: course,
        university: university,
        initials: initialsFor(name),
        createdAt: Date.now()
      };
      const key = await C.importAesKey(raw);
      const initial = normalizeState({
        profile: pub,
        settings: {
          notifications: true,
          autoLockMinutes: 5,
          theme: 'light',
          aiEndpoint: '',
          aiToken: ''
        },
        chats: [greetingMessage({ profile: pub })],
        documents: [],
        reminders: [],
        jobs: [],
        activity: []
      });
      const packed = await C.encryptJSON(key, initial);

      // Persist state before publishing auth metadata, so a failure cannot leave a half-created vault.
      await C.dbClear('files');
      await C.dbPut('kv', { k: 'state', v: packed });
      C.clearAuth();
      C.setAuth(auth);
      C.setPublic(pub);
      masterRaw = raw;
      masterKey = key;
      STATE = initial;
      currentRecoveryCode = recoveryCode;
      lastActive = Date.now();
      markUnlock();
      $('lockScreen').classList.remove('show');
      applyTheme(STATE.settings.theme === 'dark');
      applyPublic(pub);
      go('home');
      renderAll();
      setText('recoveryCode', recoveryCode);
      openSheet('recoverySheet');
      toast('Vault created. Save your recovery code.');
      button.textContent = 'Create encrypted vault';
    } catch (err) {
      console.error(err);
      error.textContent = err.message || 'Could not create the vault. Check available storage and try again.';
      button.textContent = 'Create encrypted vault';
    } finally {
      button.disabled = false;
    }
  }

  function beginRecovery() {
    const code = $('recoveryInput').value;
    const error = $('recoveryErr');
    error.textContent = '';
    if (!code.trim()) { error.textContent = 'Enter your recovery code.'; return; }
    const auth = C.getAuth();
    if (!auth || !auth.recoveryWrapped) { error.textContent = 'No recovery key is stored on this device.'; return; }
    const recoveryFail = readRecoveryFail();
    if (recoveryFail.until > Date.now()) {
      error.textContent = 'Too many recovery attempts. Try again in ' + Math.ceil((recoveryFail.until - Date.now()) / 1000) + 's.';
      return;
    }
    (async () => {
      const button = $('recoverBtn');
      button.disabled = true;
      button.textContent = 'Checking…';
      try {
        const key = await C.deriveRecoveryKey(code, auth.recoverySalt);
        const raw = await C.unwrapMasterRaw(auth.recoveryWrapped, key);
        resetRecoveryFail();
        renderRecoveryReset(raw, auth);
      } catch (err) {
        recordRecoveryFail();
        error.textContent = 'That recovery code is not valid for this vault.';
      } finally {
        button.disabled = false;
        button.textContent = 'Recover vault';
      }
    })();
  }

  function renderRecoveryReset(raw, auth) {
    const pane = $('recoveryPane');
    pendingRecoveryRaw = raw;
    pendingRecoveryAuth = auth;
    pane.dataset.reset = '1';
    pane.innerHTML = '<div class="bio-avatar" style="margin-top:8px"><span>RC</span></div>' +
      '<h3>Set a new PIN</h3>' +
      '<p class="login-sub">Your recovery code was accepted. Choose a new 6-digit PIN.</p>' +
      '<div class="field"><label>New PIN</label><input id="resetPin" type="password" inputmode="numeric" maxlength="6" class="pin-input" /></div>' +
      '<div class="field"><label>Confirm PIN</label><input id="resetPin2" type="password" inputmode="numeric" maxlength="6" class="pin-input" /></div>' +
      '<div class="error-text" id="resetErr"></div>' +
      '<button class="sheet-btn primary" style="width:100%;padding:14px" id="resetPinBtn">Set PIN and unlock</button>' +
      '<button class="login-link" id="backToPinBtn">Back to PIN</button>';
  }

  async function finishRecoveryReset() {
    const pin = $('resetPin').value;
    const pin2 = $('resetPin2').value;
    const err = $('resetErr');
    if (!/^\d{6}$/.test(pin)) { err.textContent = 'Use exactly 6 digits.'; return; }
    if (pin !== pin2) { err.textContent = 'The PINs do not match.'; return; }
    if (!pendingRecoveryRaw || !pendingRecoveryAuth) { err.textContent = 'Recovery session expired. Start again.'; return; }
    const button = $('resetPinBtn');
    button.disabled = true;
    button.textContent = 'Updating…';
    try {
      const newSalt = C.b64encode(C.randomBytes(16));
      const kek = await C.deriveKek(pin, newSalt);
      const wrapped = await C.wrapMasterRaw(pendingRecoveryRaw, kek);
      C.setAuth(Object.assign({}, pendingRecoveryAuth, { salt: newSalt, wrappedMaster: wrapped }));
      masterRaw = pendingRecoveryRaw;
      masterKey = await C.importAesKey(pendingRecoveryRaw);
      const loaded = await loadStateForMaster();
      STATE = normalizeState(loaded);
      syncPublicFromState();
      onUnlocked('recovery code');
    } catch (e) {
      err.textContent = 'Could not reset the PIN. Try again.';
      button.disabled = false;
      button.textContent = 'Set PIN and unlock';
    }
  }

  /* ---------- PIN input ---------- */
  function handlePinKey(key) {
    if (unlockBusy) return;
    if (key === 'del') pinBuffer = pinBuffer.slice(0, -1);
    else if (/^\d$/.test(key) && pinBuffer.length < 6) pinBuffer += key;
    renderPinDots();
    $('pinErr').textContent = '';
    if (pinBuffer.length === 6) {
      const candidate = pinBuffer;
      $('pinErr').textContent = '';
      $('pinHint').textContent = 'Unlocking…';
      unlockWithPin(candidate).then((ok) => {
        $('pinHint').textContent = 'Your PIN never leaves this device';
        if (!ok) {
          pinBuffer = '';
          renderPinDots();
        }
      });
    }
  }

  /* ---------- passkeys (WebAuthn PRF) ---------- */
  function passkeySupported() {
    return !!(window.isSecureContext && window.PublicKeyCredential && navigator.credentials && !/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname));
  }

  function randomChallenge() {
    return C.randomBytes(32);
  }

  async function registerPasskey() {
    if (!passkeySupported()) throw new Error('Passkeys require HTTPS or localhost in a supported browser.');
    if (!masterRaw) throw new Error('Unlock the vault first.');
    const name = profile().name || 'Student';
    const userId = C.randomBytes(16);
    const prfSalt = C.randomBytes(32);
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomChallenge(),
        rp: { name: 'Student Vault' },
        user: { id: userId, name: profile().email || 'student@localhost', displayName: name },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000,
        attestation: 'none',
        extensions: { prf: { eval: { first: prfSalt } } }
      }
    });
    if (!cred) throw new Error('Passkey setup was cancelled.');
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomChallenge(),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: cred.rawId }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } }
      }
    });
    const extension = assertion && assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {};
    const secret = extension && extension.prf && extension.prf.results && extension.prf.results.first;
    if (!secret) throw new Error('This authenticator does not expose a PRF secret. Use your PIN.');
    const key = await C.importAesKey(new Uint8Array(secret));
    const wrapped = await C.wrapMasterRaw(masterRaw, key);
    C.setPasskey({
      id: C.b64encode(cred.rawId),
      prfSalt: C.b64encode(prfSalt),
      wrappedMaster: wrapped,
      createdAt: Date.now()
    });
  }

  async function unlockWithPasskey() {
    if (!passkeySupported()) {
      $('authErr').textContent = 'Passkeys are not available in this build. Use your PIN.';
      return;
    }
    const record = C.getPasskey();
    if (!record) {
      $('authErr').textContent = 'Set up a passkey in Account first.';
      return;
    }
    const button = $('passkeyBtn');
    button.disabled = true;
    $('authErr').textContent = '';
    try {
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: randomChallenge(),
          rpId: location.hostname,
          allowCredentials: [{ type: 'public-key', id: C.b64decode(record.id) }],
          userVerification: 'required',
          timeout: 60000,
          extensions: { prf: { eval: { first: C.b64decode(record.prfSalt) } } }
        }
      });
      const extension = assertion && assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {};
      const secret = extension && extension.prf && extension.prf.results && extension.prf.results.first;
      if (!secret) throw new Error('No PRF secret returned. Use your PIN.');
      const key = await C.importAesKey(new Uint8Array(secret));
      const raw = await C.unwrapMasterRaw(record.wrappedMaster, key);
      masterRaw = raw;
      masterKey = await C.importAesKey(raw);
      const loaded = await loadStateForMaster();
      STATE = normalizeState(loaded);
      syncPublicFromState();
      onUnlocked('passkey');
    } catch (error) {
      $('authErr').textContent = error.message || 'Passkey verification failed. Use your PIN.';
    } finally {
      button.disabled = false;
    }
  }

  /* ---------- profile / theme ---------- */
  function applyTheme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('sv-theme', dark ? 'dark' : 'light'); } catch (_) { /* ignore */ }
    const toggleEl = $('themeToggle');
    if (toggleEl) toggleEl.checked = !!dark;
  }

  function openProfileSheet() {
    const p = profile();
    $('profileNameInput').value = p.name || '';
    $('profileEmailInput').value = p.email || '';
    $('profileCourseInput').value = p.course || '';
    $('profileUniInput').value = p.university || '';
    renderAvatarPreview();
    openSheet('profileSheet');
  }

  async function saveProfile() {
    const name = $('profileNameInput').value.trim();
    const email = $('profileEmailInput').value.trim();
    const course = $('profileCourseInput').value.trim();
    const university = $('profileUniInput').value.trim();
    if (!name) { toast('Enter your name.'); return; }
    if (!C.isValidEmail(email)) { toast('Enter a valid email or leave it blank.'); return; }
    STATE.profile.name = name;
    STATE.profile.email = email;
    STATE.profile.course = course;
    STATE.profile.university = university;
    STATE.profile.createdAt = STATE.profile.createdAt || Date.now();
    syncPublicFromState();
    await persist();
    closeSheets();
    renderAll();
    toast('Profile updated');
  }

  function makeAvatar(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//i.test(file.type || '')) { reject(new Error('Choose a JPG, PNG or WEBP image.')); return; }
      if (file.size > 10 * 1024 * 1024) { reject(new Error('Photo must be 10 MB or smaller.')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const size = 384;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext('2d');
          context.fillStyle = '#F3EEFF';
          context.fillRect(0, 0, size, size);
          const scale = Math.max(size / img.width, size / img.height);
          const width = img.width * scale;
          const height = img.height * scale;
          context.drawImage(img, (size - width) / 2, (size - height) / 2, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
          URL.revokeObjectURL(url);
          resolve(dataUrl);
        } catch (error) {
          URL.revokeObjectURL(url);
          reject(error);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  async function selectAvatar(file) {
    try {
      const dataUrl = await makeAvatar(file);
      const pub = C.getPublic() || {};
      pub.avatar = dataUrl;
      pub.initials = initialsFor(profile().name);
      C.setPublic(pub);
      applyPublic(profile());
      renderAvatarPreview();
      renderAccount();
      toast('Profile photo updated');
    } catch (error) {
      toast(error.message || 'Could not use that photo.');
    } finally {
      const input = $('avatarFile');
      if (input) input.value = '';
    }
  }

  function removeAvatar() {
    const pub = C.getPublic() || {};
    delete pub.avatar;
    C.setPublic(pub);
    applyPublic(profile());
    renderAvatarPreview();
    renderAccount();
    toast('Profile photo removed');
  }

  /* ---------- home ---------- */
  function renderHome() {
    if (!STATE) return;
    const docs = STATE.documents;
    const pending = STATE.reminders.filter((r) => !r.done);
    const jobsActive = STATE.jobs.filter((j) => j.status !== 'Rejected' && j.status !== 'Offer');
    setText('statDocs', docs.length);
    setText('statBytes', C.fmtBytes(storageBytes()));
    setText('statRem', pending.length);
    setText('statJobs', jobsActive.length);
    setText('securityPct', '100%');
    const ring = $('securityRing');
    if (ring) ring.style.strokeDashoffset = '0';
    setText('backupNote', STATE.lastBackupAt ? 'backup\n' + relativeTime(STATE.lastBackupAt) : 'local\nvault');
    setHtml('backupNote', STATE.lastBackupAt
      ? 'backup<br>' + escape(relativeTime(STATE.lastBackupAt))
      : 'local<br>vault');
    renderRecent();
    renderActivity();
    renderHomeReminders();
    const due = pending.filter((r) => r.due <= today()).length;
    const banner = $('dueBanner');
    if (banner) {
      banner.classList.toggle('show', STATE.settings.notifications && due > 0);
      if (due > 0) setText('dueBannerText', due + (due === 1 ? ' reminder is due or overdue' : ' reminders are due or overdue'));
    }
    setText('vaultCount', docs.length + (docs.length === 1 ? ' file' : ' files'));
  }

  function renderRecent() {
    if (!STATE) return;
    const docs = STATE.documents.slice(0, 4);
    const el = $('recentList');
    if (!el) return;
    if (!docs.length) {
      el.innerHTML = '<div class="empty-state compact"><b>No documents yet</b>Add a marksheet, certificate or ID card.</div>';
      return;
    }
    el.innerHTML = docs.map(docRow).join('');
    bindDocRows(el);
  }

  function renderActivity() {
    if (!STATE) return;
    const list = STATE.activity || [];
    setText('activityCount', list.length ? list.length + ' recent' : '');
    const el = $('activityList');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<div class="empty-state" style="border:0;background:transparent"><b>No activity yet</b>Your vault changes will appear here.</div>';
      return;
    }
    el.innerHTML = list.slice(0, 6).map((item) =>
      '<div class="activity-row"><span class="dot"></span><div><b>' + escape(item.text) + '</b><span>' + escape(item.detail || '') + ' · ' + escape(relativeTime(item.at)) + '</span></div></div>'
    ).join('');
  }

  function renderHomeReminders() {
    if (!STATE) return;
    const el = $('homeReminders');
    if (!el) return;
    const pending = STATE.reminders
      .filter((reminder) => !reminder.done)
      .sort((a, b) => String(a.due).localeCompare(String(b.due)))
      .slice(0, 3);
    if (!pending.length) {
      el.innerHTML = '<div class="empty-state compact"><b>No open reminders</b>Add a deadline from Quick actions.</div>';
      return;
    }
    el.innerHTML = pending.map((reminder) =>
      '<div class="item" data-home-reminder="' + escape(reminder.id) + '" role="button" tabindex="0">' +
      '<div class="thumb" data-tone="' + (reminder.due <= today() ? '3' : '1') + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg></div>' +
      '<div class="meta"><b>' + escape(reminder.title) + '</b><span>' + escape(fullDate(reminder.due)) + ' · ' + escape(reminder.cat || 'Personal') + (reminder.due <= today() ? ' · Due' : '') + '</span></div>' +
      '<span class="chev">›</span></div>'
    ).join('');
    $$('[data-home-reminder]', el).forEach((item) => item.addEventListener('click', () => go('reminders')));
  }

  /* ---------- documents ---------- */
  function docTypeLabel(doc) {
    if (doc.type === 'pdf') return 'PDF';
    if (doc.type === 'img') return 'IMG';
    if (doc.type === 'text') return 'TXT';
    return 'DOC';
  }

  function docRow(doc) {
    const tone = Math.abs(String(doc.id).split('').reduce((n, ch) => n + ch.charCodeAt(0), 0)) % 4;
    return '<div class="swipe" data-doc-wrap="' + escape(doc.id) + '">' +
      '<div class="swipe-actions"><button data-del-doc="' + escape(doc.id) + '" aria-label="Delete document">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>Delete</button></div>' +
      '<div class="item" data-doc="' + escape(doc.id) + '" role="button" tabindex="0">' +
      '<div class="thumb" data-tone="' + tone + '">' + docTypeLabel(doc) + '</div>' +
      '<div class="meta"><b>' + escape(doc.name) + '</b><span>' + escape(doc.cat || 'Documents') + ' · ' + escape(C.fmtBytes(doc.size)) + '</span></div>' +
      '<span class="chev">›</span></div></div>';
  }

  function bindDocRows(root) {
    $$('.swipe', root).forEach((swipe) => {
      const item = swipe.querySelector('.item');
      let startX = 0;
      let startY = 0;
      let dragging = false;
      let moved = false;
      item.addEventListener('pointerdown', (event) => {
        startX = event.clientX;
        startY = event.clientY;
        dragging = true;
        moved = false;
        item.style.transition = 'none';
      });
      item.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) moved = true;
        if (!moved) return;
        const base = swipe.classList.contains('open') ? -92 : 0;
        const shift = Math.max(-92, Math.min(0, base + dx));
        item.style.transform = 'translateX(' + shift + 'px)';
        event.preventDefault();
      });
      item.addEventListener('pointerup', (event) => {
        if (!dragging) return;
        dragging = false;
        item.style.transition = '';
        item.style.transform = '';
        if (moved) {
          const dx = event.clientX - startX;
          swipe.classList.toggle('open', swipe.classList.contains('open') ? dx > 30 : dx < -30);
        }
      });
      item.addEventListener('pointercancel', () => {
        dragging = false;
        swipe.classList.remove('open');
        item.style.transform = '';
      });
      item.addEventListener('click', (event) => {
        if (moved) { event.stopPropagation(); return; }
        openDocSheet(item.dataset.doc);
      });
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDocSheet(item.dataset.doc); }
      });
      const del = swipe.querySelector('[data-del-doc]');
      if (del) del.addEventListener('click', (event) => {
        event.stopPropagation();
        askDeleteDoc(del.dataset.delDoc);
      });
    });
  }

  function renderVault() {
    if (!STATE) return;
    const query = ($('vaultSearch').value || '').trim().toLowerCase();
    const category = ($('#vaultChips .chip.active') || {}).dataset ? $('#vaultChips .chip.active').dataset.cat : 'All';
    const filtered = STATE.documents.filter((doc) => {
      const matchesCategory = category === 'All' || doc.cat === category;
      const haystack = [doc.name, doc.cat, doc.notes, doc.text].join(' ').toLowerCase();
      return matchesCategory && (!query || haystack.includes(query));
    });
    const list = $('vaultList');
    if (list) {
      list.innerHTML = filtered.map(docRow).join('');
      bindDocRows(list);
    }
    toggle('vaultEmpty', filtered.length === 0, 'block');
    setText('vaultCount', filtered.length + (filtered.length === 1 ? ' file' : ' files'));
  }

  function openDocSheet(id) {
    const doc = STATE && STATE.documents.find((item) => item.id === id);
    if (!doc) return;
    currentDocId = id;
    setText('docTitle', doc.name);
    setText('docMeta', [doc.cat || 'Documents', C.fmtBytes(doc.size), 'Added ' + fullDate(doc.createdAt)].join(' · '));
    setText('docNotes', doc.notes || 'No notes added.');
    openSheet('docSheet');
  }

  async function getDocBytes(doc) {
    const record = await C.getFileRecord(doc.id);
    if (!record || !record.data) throw new Error('The encrypted file is missing from this device.');
    return C.decryptBytes(masterKey, record.data);
  }

  function askPdfPassword(message) {
    return new Promise((resolve) => {
      if (pdfPasswordResolver) pdfPasswordResolver(null);
      pdfPasswordResolver = resolve;
      setText('pdfPasswordText', message || 'This PDF is password-protected.');
      $('pdfPasswordInput').value = '';
      $('pdfPasswordErr').textContent = '';
      $('pdfPasswordModal').classList.add('show');
      $('pdfPasswordModal').setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => $('pdfPasswordInput').focus());
    });
  }

  function finishPdfPassword(value) {
    const resolve = pdfPasswordResolver;
    pdfPasswordResolver = null;
    $('pdfPasswordModal').classList.remove('show');
    $('pdfPasswordModal').setAttribute('aria-hidden', 'true');
    $('pdfPasswordInput').value = '';
    if (resolve) resolve(value);
  }

  async function loadPdfDocument(bytes) {
    let password = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const params = { data: bytes.slice() };
        if (password) params.password = password;
        return await pdfjsLib.getDocument(params).promise;
      } catch (error) {
        const needsPassword = error && (
          error.name === 'PasswordException' ||
          error.code === 1 ||
          error.code === 2 ||
          /password/i.test(error.message || '')
        );
        if (!needsPassword) throw error;
        password = await askPdfPassword(attempt === 0
          ? 'This PDF is password-protected. Enter the document password.'
          : 'Incorrect password. Try again, or cancel to close the document.');
        if (password === null) throw new Error('Password required to open this PDF.');
      }
    }
    throw new Error('Too many password attempts.');
  }

  async function openDocViewer(doc) {
    if (!doc) return;
    closeSheets();
    $('viewer').classList.add('show');
    setText('viewerTitle', doc.name);
    setHtml('viewerBody', '<div class="viewer-note"><span class="spinner"></span> Decrypting file…</div>');
    try {
      const bytes = await getDocBytes(doc);
      const mime = doc.mime || (doc.type === 'pdf' ? 'application/pdf' : doc.type === 'img' ? 'image/jpeg' : 'text/plain');
      const blob = new Blob([bytes], { type: mime });
      if (viewerUrl) URL.revokeObjectURL(viewerUrl);
      viewerUrl = URL.createObjectURL(blob);
      $('viewerDownload').href = viewerUrl;
      $('viewerDownload').download = doc.name;

      if (doc.type === 'pdf' && window.pdfjsLib) {
        const pdf = await loadPdfDocument(bytes);
        const body = $('viewerBody');
        body.innerHTML = '';
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const scale = Math.min(2.2, (window.innerWidth * 2) / page.getViewport({ scale: 1 }).width);
          const viewport = page.getViewport({ scale: Math.max(1, scale) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          body.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
        }
        if (!pdf.numPages) body.innerHTML = '<div class="viewer-note">This PDF has no pages.</div>';
      } else if (doc.type === 'img') {
        const img = document.createElement('img');
        img.src = viewerUrl;
        img.alt = doc.name;
        const body = $('viewerBody');
        body.innerHTML = '';
        body.appendChild(img);
      } else if (doc.type === 'text') {
        const text = new TextDecoder().decode(bytes);
        const pre = document.createElement('pre');
        pre.style.cssText = 'white-space:pre-wrap;color:#d9deea;font:12px/1.6 ui-monospace,Consolas,monospace;padding:8px 12px;max-width:860px;width:100%';
        pre.textContent = text;
        const body = $('viewerBody');
        body.innerHTML = '';
        body.appendChild(pre);
      } else {
        setHtml('viewerBody', '<div class="viewer-note">Preview is not available for this file type.<br>Use Download to open it in another app.</div>');
      }
    } catch (error) {
      setHtml('viewerBody', '<div class="viewer-note">Could not open this file.<br>' + escape(error.message || 'Unknown error') + '</div>');
    }
  }

  function closeViewer() {
    if ($('pdfPasswordModal').classList.contains('show')) finishPdfPassword(null);
    $('viewer').classList.remove('show');
    setHtml('viewerBody', '');
    if (viewerUrl) {
      URL.revokeObjectURL(viewerUrl);
      viewerUrl = '';
    }
  }

  async function downloadDoc(doc) {
    try {
      const bytes = await getDocBytes(doc);
      const mime = doc.mime || 'application/octet-stream';
      const saved = await saveOrShare(new Blob([bytes], { type: mime }), doc.name);
      if (saved) toast('File ready to save');
    } catch (error) {
      toast(error.message || 'Could not download the file.');
    }
  }

  function askDeleteDoc(id) {
    const doc = STATE && STATE.documents.find((item) => item.id === id);
    if (!doc) return;
    confirmAction('Delete document?', '"' + doc.name + '" and its encrypted file will be removed permanently.', 'Delete', async () => {
      try {
        await C.deleteFileRecord(id);
        STATE.documents = STATE.documents.filter((item) => item.id !== id);
        logActivity('Document deleted', doc.name);
        await persist();
        closeSheets();
        renderAll();
        toast('Document deleted');
      } catch (error) {
        toast('Could not delete the document.');
      }
    });
  }

  async function extractPdfText(bytes) {
    if (!window.pdfjsLib) return '';
    try {
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const pages = Math.min(pdf.numPages, 20);
      const chunks = [];
      for (let p = 1; p <= pages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        chunks.push(content.items.map((item) => item.str).join(' '));
        if (chunks.join(' ').length > 30000) break;
      }
      return chunks.join('\n').replace(/\s+/g, ' ').trim().slice(0, 30000);
    } catch (_) {
      return '';
    }
  }

  async function addDocument() {
    const file = $('docFile').files && $('docFile').files[0];
    const validation = C.validateFile(file);
    if (!validation.ok) { toast(validation.error); return; }
    const nameInput = $('newDocName').value.trim();
    const category = $('newDocCat').value;
    const notes = $('newDocNotes').value.trim();
    const button = $('addDocBtn');
    button.disabled = true;
    button.textContent = 'Encrypting…';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const byteLength = bytes.byteLength;
      const id = C.uid('doc');
      const name = nameInput || file.name;
      const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      const mime = file.type || (ext === '.pdf' ? 'application/pdf' : ext === '.txt' ? 'text/plain' : 'application/octet-stream');
      const packed = await C.encryptBytes(masterKey, bytes);
      await C.putFileRecord(id, packed);
      const text = validation.type === 'pdf' ? await extractPdfText(bytes) : '';
      STATE.documents.unshift({
        id: id,
        name: name,
        cat: category,
        notes: notes,
        mime: mime,
        type: validation.type,
        size: byteLength,
        createdAt: today(),
        text: text
      });
      logActivity('Document added', name);
      await persist();
      $('docFile').value = '';
      $('newDocName').value = '';
      $('newDocNotes').value = '';
      setText('docFileName', '');
      toggle('docFileName', false);
      closeSheets();
      renderAll();
      go('vault');
      toast('Document encrypted and saved');
    } catch (error) {
      console.error(error);
      toast(error.message || 'Could not save the document.');
    } finally {
      button.disabled = false;
      button.textContent = 'Add to vault';
    }
  }

  function openDocEdit() {
    const doc = STATE && STATE.documents.find((item) => item.id === currentDocId);
    if (!doc) return;
    $('editDocName').value = doc.name;
    $('editDocCat').value = doc.cat || 'Documents';
    $('editDocNotes').value = doc.notes || '';
    openSheet('docEditSheet');
  }

  async function saveDocEdit() {
    const doc = STATE && STATE.documents.find((item) => item.id === currentDocId);
    if (!doc) return;
    const name = $('editDocName').value.trim();
    if (!name) { toast('Enter a document name.'); return; }
    doc.name = name;
    doc.cat = $('editDocCat').value;
    doc.notes = $('editDocNotes').value.trim();
    logActivity('Document updated', name);
    await persist();
    closeSheets();
    renderAll();
    toast('Document updated');
  }

  /* ---------- reminders ---------- */
  function buildWeek() {
    const strip = $('weekStrip');
    if (!strip) return;
    const dows = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const now = new Date(selectedDay + 'T12:00:00');
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    strip.innerHTML = Array.from({ length: 7 }).map((_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const iso = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
      const active = iso === selectedDay;
      const due = STATE ? STATE.reminders.filter((r) => !r.done && r.due === iso).length : 0;
      return '<div class="day ' + (active ? 'active' : '') + '" data-day="' + iso + '" role="button" tabindex="0">' +
        '<span>' + dows[index] + '</span><b>' + date.getDate() + '</b>' +
        (due ? '<i style="width:4px;height:4px;border-radius:50%;background:' + (active ? '#fff' : '#6C4EF6') + ';display:block"></i>' : '') +
        '</div>';
    }).join('');
    $$('.day', strip).forEach((day) => day.addEventListener('click', () => {
      selectedDay = day.dataset.day;
      buildWeek();
      renderReminders();
    }));
  }

  function reminderRow(r) {
    const overdue = !r.done && r.due < today();
    return '<div class="item" data-reminder="' + escape(r.id) + '" role="button" tabindex="0">' +
      '<div class="check ' + (r.done ? 'done' : '') + '" data-check-reminder="' + escape(r.id) + '" aria-label="Toggle reminder">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></div>' +
      '<div class="meta"><b class="' + (r.done ? 'done-text' : '') + '">' + escape(r.title) + '</b>' +
      '<span>' + escape(fullDate(r.due)) + ' · ' + escape(r.cat || 'Personal') + (overdue ? ' · Overdue' : '') + '</span></div>' +
      '<span class="chev">›</span></div>';
  }

  function bindReminderRows(root) {
    $$('.item[data-reminder]', root).forEach((item) => {
      item.addEventListener('click', () => openReminderSheet(item.dataset.reminder));
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openReminderSheet(item.dataset.reminder); }
      });
    });
    $$('[data-check-reminder]', root).forEach((check) => {
      check.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleReminder(check.dataset.checkReminder);
      });
    });
  }

  function renderReminders() {
    if (!STATE) return;
    const all = STATE.reminders;
    const done = all.filter((r) => r.done);
    const open = all.filter((r) => !r.done);
    const selectedDate = selectedDay;
    const todayForView = selectedDate === today();
    let active = all.filter((r) => !r.done && (todayForView ? r.due <= selectedDate : r.due === selectedDate));
    active.sort((a, b) => String(a.due).localeCompare(String(b.due)));
    const upcoming = open.filter((r) => r.due > selectedDate).sort((a, b) => String(a.due).localeCompare(String(b.due)));
    const completed = done.sort((a, b) => String(b.due).localeCompare(String(a.due)));

    setText('dayHeading', todayForView ? 'Today' : fullDate(selectedDate));
    setText('todayDue', active.length + ' due');
    $('todayDue').style.display = active.length ? '' : 'none';
    const todayEl = $('todayList');
    todayEl.innerHTML = active.length ? active.map(reminderRow).join('') : '<div class="empty-state"><b>Nothing due</b>' + (todayForView ? 'You are clear for today.' : 'No reminders on this date.') + '</div>';
    bindReminderRows(todayEl);

    const upcomingEl = $('upcomingList');
    upcomingEl.innerHTML = upcoming.length ? upcoming.map(reminderRow).join('') : '<div class="empty-state"><b>No upcoming reminders</b>Use the + button to add a deadline.</div>';
    bindReminderRows(upcomingEl);

    const completedEl = $('completedList');
    completedEl.innerHTML = completed.length ? completed.map(reminderRow).join('') : '';
    bindReminderRows(completedEl);
    toggle('completedSection', completed.length > 0, 'block');

    const total = all.length;
    const doneCount = done.length;
    setText('remProgressText', doneCount + ' of ' + total + ' done');
    $('remProgressBar').style.width = (total ? Math.round((doneCount / total) * 100) : 0) + '%';
    setText('remCount', open.length + ' open');
    buildWeek();
  }

  function openReminderSheet(id) {
    currentReminderId = id || null;
    const reminder = id ? STATE.reminders.find((r) => r.id === id) : null;
    setText('remSheetTitle', reminder ? 'Edit reminder' : 'New reminder');
    $('remTitle').value = reminder ? reminder.title : '';
    $('remDate').value = reminder ? reminder.due : today();
    $('remCat').value = reminder ? (reminder.cat || 'Personal') : 'Exam';
    $('remNotes').value = reminder ? (reminder.notes || '') : '';
    $('deleteRemBtn').style.display = reminder ? 'block' : 'none';
    openSheet('reminderSheet');
  }

  async function saveReminder() {
    const title = $('remTitle').value.trim();
    const due = $('remDate').value;
    const cat = $('remCat').value;
    const notes = $('remNotes').value.trim();
    if (!title) { toast('Enter a reminder title.'); return; }
    if (!due) { toast('Choose a due date.'); return; }
    if (currentReminderId) {
      const reminder = STATE.reminders.find((r) => r.id === currentReminderId);
      if (reminder) {
        reminder.title = title;
        reminder.due = due;
        reminder.cat = cat;
        reminder.notes = notes;
        logActivity('Reminder updated', title);
      }
    } else {
      STATE.reminders.push({
        id: C.uid('rem'),
        title: title,
        due: due,
        cat: cat,
        notes: notes,
        done: false,
        createdAt: today()
      });
      logActivity('Reminder added', title + ' · ' + fullDate(due));
    }
    await persist();
    closeSheets();
    renderAll();
    go('reminders');
    toast('Reminder saved');
  }

  async function toggleReminder(id) {
    const reminder = STATE.reminders.find((r) => r.id === id);
    if (!reminder) return;
    reminder.done = !reminder.done;
    if (reminder.done) logActivity('Reminder completed', reminder.title);
    await persist();
    renderAll();
    toast(reminder.done ? 'Reminder completed' : 'Reminder reopened');
  }

  function askDeleteReminder() {
    const reminder = STATE.reminders.find((r) => r.id === currentReminderId);
    if (!reminder) return;
    confirmAction('Delete reminder?', '"' + reminder.title + '" will be removed.', 'Delete', async () => {
      STATE.reminders = STATE.reminders.filter((r) => r.id !== reminder.id);
      logActivity('Reminder deleted', reminder.title);
      await persist();
      closeSheets();
      renderAll();
      toast('Reminder deleted');
    });
  }

  /* ---------- jobs ---------- */
  function jobRow(job) {
    const initials = escape(String(job.company || '?').slice(0, 2).toUpperCase());
    const link = C.safeHttpUrl(job.link);
    const tags = [];
    if (job.location) tags.push(escape(job.location));
    if (job.interview) tags.push('Interview ' + escape(fullDate(job.interview)));
    return '<div class="job" data-job="' + escape(job.id) + '" role="button" tabindex="0">' +
      '<div class="top"><div><div class="logo">' + initials + '</div><div><h4>' + escape(job.company) + '</h4><p>' + escape(job.role) + '</p></div></div>' +
      '<span class="pill ' + (STATUS_PILL[job.status] || 'info') + '">' + escape(job.status || 'Applied') + '</span></div>' +
      (tags.length ? '<div class="job-tags">' + tags.map((tag) => '<span>' + tag + '</span>').join('') + '</div>' : '') +
      (job.notes ? '<div class="job-note">' + escape(job.notes) + '</div>' : '') +
      '<div class="foot"><span class="date">Applied ' + escape(fullDate(job.applied)) + '</span>' +
      (link ? '<button class="btn-ghost" data-job-link="' + escape(link) + '">Open link</button>' : '<span class="date"></span>') +
      '</div></div>';
  }

  function renderJobs() {
    if (!STATE) return;
    const list = $('jobsList');
    if (!list) return;
    const filtered = jobFilter === 'All' ? STATE.jobs : STATE.jobs.filter((job) => job.status === jobFilter);
    setText('jobCount', STATE.jobs.length + (STATE.jobs.length === 1 ? ' total' : ' total'));
    if (!filtered.length) {
      list.innerHTML = '';
      toggle('jobsEmpty', true, 'block');
      setText('jobsEmpty', '');
      $('jobsEmpty').innerHTML = '<b>No applications' + (jobFilter === 'All' ? ' yet' : ' in ' + escape(jobFilter)) + '</b>' +
        (jobFilter === 'All' ? 'Add a job to start tracking interviews and offers.' : 'Change the filter or add a new application.');
    } else {
      toggle('jobsEmpty', false);
      list.innerHTML = filtered.map(jobRow).join('');
    }
    $$('.job[data-job]', list).forEach((card) => {
      card.addEventListener('click', () => openJobSheet(card.dataset.job));
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openJobSheet(card.dataset.job); }
      });
    });
    $$('[data-job-link]', list).forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        openExternal(button.dataset.jobLink);
      });
    });
  }

  function openExternal(url) {
    const safe = C.safeHttpUrl(url);
    if (!safe) { toast('This link is not valid.'); return; }
    const link = document.createElement('a');
    link.href = safe;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function openJobSheet(id) {
    currentJobId = id || null;
    const job = id ? STATE.jobs.find((item) => item.id === id) : null;
    setText('jobSheetTitle', job ? 'Edit application' : 'Add application');
    $('jobCompanyInput').value = job ? job.company : '';
    $('jobRoleInput').value = job ? job.role : '';
    $('jobAppliedInput').value = job ? (job.applied || today()) : today();
    $('jobInterviewInput').value = job ? (job.interview || '') : '';
    $('jobLocationInput').value = job ? (job.location || '') : '';
    $('jobLinkInput').value = job ? (job.link || '') : '';
    $('jobNotesInput').value = job ? (job.notes || '') : '';
    currentJobStatus = job ? (job.status || 'Applied') : 'Applied';
    updateJobStatusChips();
    $('deleteJobBtn').style.display = job ? 'flex' : 'none';
    const hasLink = job && C.safeHttpUrl(job.link);
    $('jobLinkBtn').style.display = hasLink ? 'flex' : 'none';
    if (hasLink) $('jobLinkBtn').dataset.url = job.link;
    openSheet('jobSheet');
  }

  function updateJobStatusChips() {
    $$('#jobStatusRow .status-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.status === currentJobStatus));
  }

  async function saveJob() {
    const company = $('jobCompanyInput').value.trim();
    const role = $('jobRoleInput').value.trim();
    const applied = $('jobAppliedInput').value || today();
    const interview = $('jobInterviewInput').value;
    const location = $('jobLocationInput').value.trim();
    const link = $('jobLinkInput').value.trim();
    const notes = $('jobNotesInput').value.trim();
    if (!company) { toast('Enter the company name.'); return; }
    if (!role) { toast('Enter the job role.'); return; }
    if (link && !C.safeHttpUrl(link)) { toast('Enter a valid http(s) job link.'); return; }
    const data = {
      company: company,
      role: role,
      status: currentJobStatus,
      applied: applied,
      interview: interview,
      location: location,
      link: link,
      notes: notes
    };
    if (currentJobId) {
      const job = STATE.jobs.find((item) => item.id === currentJobId);
      if (job) Object.assign(job, data);
      logActivity('Application updated', company + ' · ' + currentJobStatus);
    } else {
      STATE.jobs.unshift(Object.assign({ id: C.uid('job'), createdAt: Date.now() }, data));
      logActivity('Application added', company + ' · ' + role);
    }
    await persist();
    jobFilter = 'All';
    $$('#jobChips .chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.status === 'All'));
    closeSheets();
    renderAll();
    go('jobs');
    toast('Application saved');
  }

  function askDeleteJob() {
    const job = STATE.jobs.find((item) => item.id === currentJobId);
    if (!job) return;
    confirmAction('Delete application?', '"' + job.company + ' — ' + job.role + '" will be removed.', 'Delete', async () => {
      STATE.jobs = STATE.jobs.filter((item) => item.id !== job.id);
      logActivity('Application deleted', job.company);
      await persist();
      closeSheets();
      renderAll();
      toast('Application deleted');
    });
  }

  /* ---------- chat ---------- */
  function scrollChatToBottom() {
    const wrap = $('chatWrap');
    if (!wrap) return;
    const run = () => { wrap.scrollTop = wrap.scrollHeight; };
    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
  }

  function renderChat() {
    if (!STATE) return;
    const messages = STATE.chats || [];
    setHtml('chatMessages', messages.map((message) => {
      const mine = message.role === 'user';
      const safe = escape(message.text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
      return '<div class="bubble ' + (mine ? 'me' : 'bot') + '">' + safe + '<small>' + escape(new Date(message.at || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })) + '</small></div>';
    }).join(''));
    const status = $('chatStatus');
    if (status) {
      const configured = !!effectiveAiEndpoint();
      status.className = 'chat-status' + (configured ? '' : ' local');
      status.innerHTML = '<i></i><span>' + (configured ? 'AI server configured' : 'On-device assistant') + '</span>';
    }
    scrollChatToBottom();
  }

  function typingBubble() {
    const el = document.createElement('div');
    el.className = 'bubble bot typing';
    el.innerHTML = '<i></i><i></i><i></i>';
    const messages = $('chatMessages');
    if (messages) messages.appendChild(el);
    scrollChatToBottom();
    return el;
  }

  function localAnswer(question) {
    const q = String(question || '').toLowerCase();
    const docs = STATE.documents;
    const reminders = STATE.reminders;
    const jobs = STATE.jobs;
    const pending = reminders.filter((r) => !r.done);
    if (/^(hi|hello|hey|namaste)\b/.test(q) && q.length < 24) {
      return 'Hi ' + firstName() + '. I can check your documents, reminders, job applications, storage and vault file. What would you like to look at?';
    }
    if (/\b(study plan|study schedule|timetable|prepare|plan my study)\b/.test(q)) {
      const next = pending.slice().sort((a, b) => String(a.due).localeCompare(String(b.due))).slice(0, 4);
      const activeJobs = jobs.filter((job) => job.status !== 'Rejected' && job.status !== 'Offer');
      return 'A simple plan from your current vault:' +
        (next.length ? ' ' + next.map((reminder, index) => (index + 1) + ') ' + reminder.title + ' — ' + fullDate(reminder.due)).join('; ') + '.' : ' No open reminders right now.') +
        (activeJobs.length ? ' Keep ' + activeJobs.length + ' active application' + (activeJobs.length === 1 ? '' : 's') + ' moving this week.' : ' Add a job application when you start applying.') +
        ' I can only build a plan from data already in your vault.';
    }
    if (/\b(help|what can|capabil|commands)\b/.test(q)) {
      return 'I can answer from your encrypted vault data: document names and categories, extracted PDF text, pending and upcoming reminders, job application status, storage usage and backup state. For open-ended AI answers, connect your own AI server in Account. Nothing is sent anywhere while you use the on-device assistant.';
    }
    if (/\b(storage|space|size|how much)\b/.test(q)) {
      return 'You are using ' + C.fmtBytes(storageBytes()) + ' across ' + docs.length + (docs.length === 1 ? ' document' : ' documents') + '. Files are encrypted on this device; storage usage is calculated from their original size.';
    }
    if (/\b(backup|restore|export)\b/.test(q)) {
      return STATE.lastBackupAt
        ? 'Your last encrypted backup was exported ' + relativeTime(STATE.lastBackupAt) + '. Open Account → Backup & restore to create a new one.'
        : 'No encrypted backup has been exported yet. Open Account → Backup & restore and save the .svault file somewhere safe.';
    }
    if (/\b(summar|summary|explain|read this|read my)\b/.test(q) && docs.length) {
      const named = docs.find((doc) => q.includes(String(doc.name).toLowerCase()));
      const list = named ? [named] : docs.slice(0, 3);
      const parts = list.map((doc) => {
        if (doc.text) return doc.name + ': ' + doc.text.slice(0, 700) + (doc.text.length > 700 ? '…' : '');
        return doc.name + ': no extractable text in this file; open it in the vault viewer to read it.';
      });
      return 'From your encrypted vault — ' + parts.join(' | ').slice(0, 1800);
    }
    if (/\b(document|documents|file|files|pdf|marksheet|certificate)\b/.test(q)) {
      if (!docs.length) return 'Your vault has no documents yet. Add a PDF, image or TXT file from the Vault tab.';
      const named = docs.find((doc) => q.includes(String(doc.name).toLowerCase()));
      if (named) {
        const excerpt = named.text ? ' Extracted text starts: “' + named.text.slice(0, 500) + '”' : ' This file has no extractable text; you can open it in the viewer.';
        return named.name + ' is in ' + (named.cat || 'Documents') + ', ' + C.fmtBytes(named.size) + ', added ' + fullDate(named.createdAt) + '.' + (named.notes ? ' Notes: ' + named.notes + '.' : '') + excerpt;
      }
      return 'You have ' + docs.length + ' document' + (docs.length === 1 ? '' : 's') + ': ' + docs.slice(0, 8).map((doc) => doc.name + ' (' + (doc.cat || 'Documents') + ')').join(', ') + (docs.length > 8 ? ' and ' + (docs.length - 8) + ' more.' : '.');
    }
    if (/\b(reminder|reminders|due|deadline|exam|fee)\b/.test(q)) {
      if (!pending.length) return 'You have no open reminders. Add one from the Reminders tab or the quick actions on Home.';
      const dueToday = pending.filter((r) => r.due <= today());
      return 'You have ' + pending.length + ' open reminder' + (pending.length === 1 ? '' : 's') + '. ' +
        (dueToday.length ? dueToday.length + ' due today or overdue: ' + dueToday.slice(0, 5).map((r) => r.title + ' (' + fullDate(r.due) + ')').join('; ') + '. ' : '') +
        'Next: ' + pending.slice().sort((a, b) => String(a.due).localeCompare(String(b.due))).slice(0, 5).map((r) => r.title + ' on ' + fullDate(r.due)).join('; ') + '.';
    }
    if (/\b(job|jobs|application|applications|interview|offer|career)\b/.test(q)) {
      if (!jobs.length) return 'You are not tracking any job applications yet. Add one from the Jobs tab.';
      const counts = STATUSES.map((status) => status + ': ' + jobs.filter((job) => job.status === status).length).filter((line) => !line.endsWith(': 0'));
      return 'You are tracking ' + jobs.length + ' application' + (jobs.length === 1 ? '' : 's') + ' (' + counts.join(', ') + '). ' +
        jobs.slice(0, 5).map((job) => job.company + ' — ' + job.role + ' [' + (job.status || 'Applied') + ']').join('; ') + '.';
    }
    if (/\b(find|search|look for|which document|summar)\b/.test(q) && docs.length) {
      const terms = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 2 && !['find', 'search', 'which', 'document', 'documents', 'summar', 'summarise', 'summarize', 'about'].includes(word));
      const matches = docs.filter((doc) => terms.some((term) => (doc.name + ' ' + doc.notes + ' ' + (doc.text || '')).toLowerCase().includes(term)));
      if (matches.length) {
        return 'I found ' + matches.length + ' matching document' + (matches.length === 1 ? '' : 's') + ': ' + matches.slice(0, 5).map((doc) => doc.name + (doc.text ? ' — “' + doc.text.slice(0, 220) + '…”' : '')).join('; ');
      }
    }
    return 'I can answer from your vault data — documents, reminders, job applications, storage and backups. Try “Which reminders are due?” or “Summarise my documents”. For open-ended questions, connect your own AI server in Account.';
  }

  async function callAiServer(question) {
    const endpoint = effectiveAiEndpoint();
    if (!endpoint) throw new Error('AI server is not configured.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (STATE.settings.aiToken) headers.Authorization = 'Bearer ' + STATE.settings.aiToken;
      const response = await fetch(endpoint.replace(/\/+$/, '') + '/api/chat', {
        method: 'POST',
        headers: headers,
        signal: controller.signal,
        body: JSON.stringify({
          message: question,
          context: {
            profile: { name: STATE.profile.name, course: STATE.profile.course, university: STATE.profile.university },
            documents: STATE.documents.slice(0, 8).map((doc) => ({ name: doc.name, category: doc.cat, notes: doc.notes, text: (doc.text || '').slice(0, 3000) })),
            reminders: STATE.reminders.slice(0, 30).map((r) => ({ title: r.title, due: r.due, done: r.done, category: r.cat })),
            jobs: STATE.jobs.slice(0, 30).map((job) => ({ company: job.company, role: job.role, status: job.status, interview: job.interview, notes: job.notes }))
          }
        })
      });
      if (!response.ok) throw new Error('AI server returned ' + response.status + '.');
      const data = await response.json();
      if (!data || typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('AI server returned an empty reply.');
      return data.reply.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendChat(text) {
    if (!STATE || chatBusy) return;
    const question = (text == null ? $('chatText').value : text).trim();
    if (!question) return;
    if (question.length > 2000) { toast('Message is too long.'); return; }
    const now = Date.now();
    chatSendTimes = chatSendTimes.filter((time) => now - time < 60000);
    if (chatSendTimes.length >= 20) { toast('Chat rate limit: wait a minute.'); return; }
    if (now - lastChatSent < 1000) { toast('Wait a moment before sending again.'); return; }
    lastChatSent = now;
    chatSendTimes.push(now);
    chatBusy = true;
    if ($('sendBtn')) $('sendBtn').disabled = true;
    $('chatText').value = '';
    STATE.chats.push({ id: C.uid('msg'), role: 'user', text: question, at: Date.now() });
    await persist();
    renderChat();
    const typing = typingBubble();
    let reply = '';
    let usedAi = false;
    try {
      if (effectiveAiEndpoint()) {
        try {
          reply = await callAiServer(question);
          usedAi = true;
        } catch (error) {
          console.error('AI request failed', error);
          aiDownUntil = Date.now() + 60000;
          toast('AI server unavailable. Switched to on-device answers.');
          reply = localAnswer(question);
        }
      } else {
        reply = localAnswer(question);
      }
    } catch (error) {
      reply = 'I could not answer that right now. Try again from your vault data.';
    }
    typing.remove();
    STATE.chats.push({ id: C.uid('msg'), role: 'assistant', text: reply, at: Date.now() });
    STATE.chats = STATE.chats.slice(-100);
    await persist();
    renderChat();
    if (!usedAi) {
      const status = $('chatStatus');
      if (status && !effectiveAiEndpoint()) {
        status.className = 'chat-status local';
        status.innerHTML = '<i></i><span>On-device assistant</span>';
      }
    }
    chatBusy = false;
    if ($('sendBtn')) $('sendBtn').disabled = false;
    $('chatText').focus();
  }

  async function clearChat() {
    STATE.chats = [greetingMessage(STATE)];
    await persist();
    renderChat();
    toast('Assistant history cleared');
  }

  /* ---------- account ---------- */
  function renderAccount() {
    if (!STATE) return;
    applyPublic(STATE.profile);
    const used = storageBytes();
    setText('storageUsed', C.fmtBytes(used) + ' used');
    $('storageBar').style.width = Math.min(100, (used / STORAGE_DISPLAY_BYTES) * 100) + '%';
    $('notifToggle').checked = !!STATE.settings.notifications;
    $('autoLockSelect').value = String(STATE.settings.autoLockMinutes);
    $('themeToggle').checked = STATE.settings.theme === 'dark';
    const aiConfigured = !!effectiveAiEndpoint();
    const hasAiUrl = !!C.safeHttpUrl(STATE.settings.aiEndpoint);
    setText('aiState', aiConfigured ? 'Configured' : hasAiUrl ? 'Not reachable' : 'Local');
    $('aiState').className = 'pill ' + (aiConfigured ? 'ok' : 'info');
    setText('backupState', STATE.lastBackupAt ? 'Saved ' + relativeTime(STATE.lastBackupAt) : 'Save a copy you control');
    const pass = C.getPasskey();
    if (!passkeySupported()) {
      setText('passkeyState', 'Unavailable');
      $('passkeyState').className = 'pill info';
    } else if (pass) {
      setText('passkeyState', 'Registered');
      $('passkeyState').className = 'pill ok';
    } else {
      setText('passkeyState', 'Not set');
      $('passkeyState').className = 'pill info';
    }
    setText('backupStatus', STATE.lastBackupAt
      ? 'Vault file last saved ' + relativeTime(STATE.lastBackupAt) + '. It contains no readable data without your PIN.'
      : 'No vault file has been saved yet. Save one now and keep it in Files or another safe place.');
    setText('deviceState', 'On-device');
    setText('securityState', 'View');
    $('securityState').className = 'pill info';
  }

  function renderSecurity() {
    const auto = Number(STATE.settings.autoLockMinutes) || 0;
    const rows = [
      ['Brute-force protection', 'PIN: 5 wrong attempts trigger a 30s lockout, then exponential backoff up to 5 min.', 'Active', 'ok'],
      ['Recovery abuse protection', 'Recovery-code attempts are throttled after 5 failures.', 'Active', 'ok'],
      ['Rate limiting', 'Chat: 20 messages/min client-side; AI proxy also limits 20/min per IP.', 'Active', 'ok'],
      ['Session expiry', auto ? 'Auto-lock after ' + auto + ' min; reload and background always relock.' : 'Auto-lock is currently off.', auto ? 'Active' : 'Off', auto ? 'ok' : 'warn'],
      ['Device management', 'This device only · ' + deviceId().slice(0, 12) + '… · last unlock ' + (lastUnlockAt() ? relativeTime(lastUnlockAt()) : 'not recorded'), 'Local', 'info'],
      ['Encryption', 'AES-256-GCM at rest; PBKDF2-SHA256 210,000 iterations; PIN never stored.', 'Active', 'ok'],
      ['API key protection', 'AI provider key stays in the server environment; the APK only stores a server URL/token.', 'Active', 'ok'],
      ['SSL/TLS', 'HTTPS is required for remote AI on the phone; the local vault itself makes no network requests.', 'Conditional', 'info'],
      ['OTP protection', 'No OTP flow is used. PIN + recovery code is the local model.', 'Not used', 'info'],
      ['JWT authentication', 'No server accounts or JWT sessions exist in this local-first build.', 'Not used', 'info'],
      ['Refresh token', 'No server session to refresh.', 'Not used', 'info'],
      ['Root detection', 'Requires a native Android build and device-integrity checks.', 'Unavailable', 'warn'],
      ['App integrity', 'This is a debug APK. Use a release keystore and Play Integrity for production.', 'Unavailable', 'warn']
    ];
    setHtml('securityList', rows.map((row) =>
      '<div class="security-item"><div><b>' + row[0] + '</b><span class="sec-detail">' + row[1] + '</span></div><span class="pill ' + row[3] + '">' + row[2] + '</span></div>'
    ).join(''));
    setText('securityDevice', 'Device ID: ' + deviceId() + ' · Platform: ' + (nativeShell ? 'Android app' : navigator.platform || 'Browser') + ' · Last unlock: ' + (lastUnlockAt() ? new Date(lastUnlockAt()).toLocaleString('en-IN') : 'not recorded'));
  }

  function openSecuritySheet() {
    if (!STATE) return;
    renderSecurity();
    openSheet('securitySheet');
  }

  /* ---------- PIN change / recovery / passkey account actions ---------- */
  function openPinSheet() {
    $('currentPin').value = '';
    $('newPin').value = '';
    $('confirmPin').value = '';
    $('pinChangeErr').textContent = '';
    openSheet('pinSheet');
  }

  async function changePin() {
    const current = $('currentPin').value;
    const next = $('newPin').value;
    const confirm = $('confirmPin').value;
    const error = $('pinChangeErr');
    error.textContent = '';
    if (!/^\d{6}$/.test(current)) { error.textContent = 'Enter your current 6-digit PIN.'; return; }
    if (!/^\d{6}$/.test(next)) { error.textContent = 'The new PIN must be 6 digits.'; return; }
    if (next !== confirm) { error.textContent = 'The new PINs do not match.'; return; }
    const auth = C.getAuth();
    if (!auth) { error.textContent = 'Vault is locked.'; return; }
    const button = $('savePinBtn');
    button.disabled = true;
    button.textContent = 'Updating…';
    try {
      const oldKey = await C.deriveKek(current, auth.salt);
      const raw = await C.unwrapMasterRaw(auth.wrappedMaster, oldKey);
      const newSalt = C.b64encode(C.randomBytes(16));
      const newKey = await C.deriveKek(next, newSalt);
      const wrapped = await C.wrapMasterRaw(raw, newKey);
      C.setAuth(Object.assign({}, auth, { salt: newSalt, wrappedMaster: wrapped }));
      masterRaw = raw;
      masterKey = await C.importAesKey(raw);
      closeSheets();
      toast('PIN updated');
    } catch (e) {
      error.textContent = 'Current PIN is incorrect.';
    } finally {
      button.disabled = false;
      button.textContent = 'Update PIN';
    }
  }

  function openRecoverySheet() {
    currentRecoveryCode = '';
    setText('recoveryCode', 'Not displayed again for security. Generate a new code if you need a copy.');
    openSheet('recoverySheet');
  }

  async function regenerateRecovery() {
    confirmAction('Generate a new recovery code?', 'The previous recovery code will stop working immediately.', 'Generate', async () => {
      const salt = C.b64encode(C.randomBytes(16));
      const code = C.randomRecoveryCode();
      const key = await C.deriveRecoveryKey(code, salt);
      const wrapped = await C.wrapMasterRaw(masterRaw, key);
      const auth = C.getAuth();
      C.setAuth(Object.assign({}, auth, { recoverySalt: salt, recoveryWrapped: wrapped }));
      currentRecoveryCode = code;
      setText('recoveryCode', code);
      openSheet('recoverySheet');
      toast('New recovery code created');
    });
  }

  async function copyRecovery() {
    if (!currentRecoveryCode) { toast('Generate a new code first.'); return; }
    try {
      await navigator.clipboard.writeText(currentRecoveryCode);
      toast('Recovery code copied');
    } catch (_) {
      toast('Clipboard unavailable. Select the code manually.');
    }
  }

  function downloadRecovery() {
    if (!currentRecoveryCode) { toast('Generate a new code first.'); return; }
    const text = 'Student Vault recovery code\n\n' + currentRecoveryCode + '\n\nKeep this offline. It can restore your encrypted vault if you forget your PIN.\n';
    saveOrShare(new Blob([text], { type: 'text/plain' }), 'student-vault-recovery.txt');
  }

  async function togglePasskey() {
    if (!passkeySupported()) {
      toast('Passkeys need HTTPS/localhost and a supported authenticator. Use your PIN.');
      return;
    }
    if (C.getPasskey()) {
      confirmAction('Remove passkey?', 'You will still be able to unlock with your PIN.', 'Remove', async () => {
        C.clearPasskey();
        renderAccount();
        toast('Passkey removed');
      });
      return;
    }
    try {
      await registerPasskey();
      renderAccount();
      toast('Passkey registered');
    } catch (error) {
      toast(error.message || 'Passkey setup failed.');
    }
  }

  /* ---------- backup ---------- */
  function openBackupSheet() {
    selectedBackupFile = null;
    $('importBackupInput').value = '';
    $('importBackupBtn').disabled = true;
    setText('backupStatus', STATE.lastBackupAt
      ? 'Vault file last saved ' + relativeTime(STATE.lastBackupAt) + '. It contains no readable data without your PIN.'
      : 'No vault file has been saved yet. Save one now and keep it in Files or another safe place.');
    openSheet('backupSheet');
  }

  async function exportBackup() {
    const fileName = 'student-vault-' + today() + '.svault';
    const saveHandle = (window.NativeVault && typeof window.NativeVault.saveFile === 'function')
      ? null
      : await pickSaveFile(fileName, 'application/json', 'Student Vault encrypted backup', '.svault');
    if (saveHandle === 'cancelled') return;
    await persist();
    const stateRecord = await C.dbGet('kv', 'state');
    const files = await C.getAllFileRecords();
    if (!stateRecord) { toast('Vault state is missing.'); return; }
    const auth = C.getAuth();
    const payload = {
      format: 'studentvault-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      auth: auth,
      public: C.getPublic(),
      state: C.b64encode(stateRecord.v),
      files: files.map((file) => ({
        id: file.id,
        data: C.b64encode(file.data)
      }))
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    if (saveHandle) {
      await writeSaveHandle(saveHandle, blob);
    } else {
      const saved = await saveOrShare(blob, fileName);
      if (!saved) return;
    }
    STATE.lastBackupAt = Date.now();
    logActivity('Encrypted backup exported', C.fmtBytes(blob.size));
    await persist();
    renderAccount();
    toast('Encrypted vault file saved');
  }

  function selectBackupFile(file) {
    selectedBackupFile = file || null;
    $('importBackupBtn').disabled = !selectedBackupFile;
    if (selectedBackupFile) setText('backupStatus', 'Selected: ' + selectedBackupFile.name + ' (' + C.fmtBytes(selectedBackupFile.size) + ')');
  }

  async function restoreBackup(file, skipConfirm) {
    if (!file) { toast('Choose a backup file.'); return; }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.format !== 'studentvault-backup' || !data.auth || !data.state) throw new Error('Not a Student Vault backup.');
      if (!data.auth.wrappedMaster || !data.auth.salt) throw new Error('Backup is missing authentication data.');
      const proceed = skipConfirm ? true : await new Promise((resolve) => {
        confirmAction('Restore this backup?', 'Current vault data on this device will be replaced. The backup stays encrypted and will require its PIN.', 'Restore', () => resolve(true));
      });
      if (!proceed) return;
      await C.dbClear('kv');
      await C.dbClear('files');
      await C.dbPut('kv', { k: 'state', v: C.b64decode(data.state) });
      for (const fileRecord of (data.files || [])) {
        await C.dbPut('files', {
          id: fileRecord.id,
          data: C.b64decode(fileRecord.data)
        });
      }
      C.clearAuth();
      C.setAuth(data.auth);
      if (data.public) C.setPublic(data.public);
      C.clearPasskey();
      location.reload();
    } catch (error) {
      console.error(error);
      toast(error.message || 'Could not restore this backup.');
    }
  }

  /* ---------- AI settings ---------- */
  function openAiSheet() {
    if (!STATE) return;
    $('aiEndpoint').value = STATE.settings.aiEndpoint || '';
    $('aiToken').value = '';
    $('aiToken').placeholder = STATE.settings.aiToken ? 'Stored token retained if left blank' : 'Bearer token configured on your server';
    $('aiTestResult').textContent = '';
    openSheet('aiSheet');
  }

  async function saveAiSettings() {
    const endpoint = $('aiEndpoint').value.trim();
    const token = $('aiToken').value.trim();
    if (endpoint && !C.safeHttpUrl(endpoint)) { $('aiTestResult').textContent = 'Enter a valid http(s) server URL, or leave it blank for on-device mode.'; return; }
    STATE.settings.aiEndpoint = endpoint ? C.safeHttpUrl(endpoint).replace(/\/+$/, '') : '';
    if (!STATE.settings.aiEndpoint) STATE.settings.aiToken = '';
    else if (token) STATE.settings.aiToken = token;
    aiDownUntil = 0;
    await persist();
    closeSheets();
    renderAll();
    toast(STATE.settings.aiEndpoint ? 'AI server saved' : 'Using on-device assistant');
  }

  async function testAiConnection() {
    const endpoint = C.safeHttpUrl($('aiEndpoint').value.trim());
    const token = $('aiToken').value.trim() || (STATE && STATE.settings.aiToken) || '';
    const result = $('aiTestResult');
    if (!endpoint) { result.textContent = 'Enter a server URL first.'; return; }
    if (nativeShell && /^http:\/\//i.test(endpoint)) {
      result.textContent = 'The phone needs an HTTPS server URL. Local HTTP/localhost works only on the PC; use on-device mode otherwise.';
      return;
    }
    result.textContent = 'Checking…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const headers = token ? { Authorization: 'Bearer ' + token } : {};
      const response = await fetch(endpoint.replace(/\/+$/, '') + '/api/health', { headers: headers, signal: controller.signal });
      if (!response.ok) throw new Error('Server returned ' + response.status + '.');
      aiDownUntil = 0;
      result.textContent = 'Connected. The server is reachable.';
    } catch (error) {
      result.textContent = 'Could not reach the server: ' + (error.message || 'network error');
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- convert ---------- */
  async function openConvert() {
    const doc = STATE && STATE.documents.find((item) => item.id === currentDocId);
    if (!doc) return;
    try {
      const bytes = await getDocBytes(doc);
      convertSource = { bytes: bytes, type: doc.type, name: doc.name, mime: doc.mime };
      convertTitle = doc.name;
      setText('convertSub', doc.name);
      toggle('convertResult', false);
      closeSheets();
      openSheet('convertSheet');
    } catch (error) {
      toast(error.message || 'Could not read the document.');
    }
  }

  function imageToCanvas(bytes, mime) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = (error) => { URL.revokeObjectURL(url); reject(error); };
      img.src = url;
    });
  }

  async function renderPdfFirstPage(bytes) {
    const pdf = await loadPdfDocument(bytes);
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
    return canvas;
  }

  async function convertDocument() {
    if (!convertSource) return;
    const button = $('convertBtn');
    button.disabled = true;
    button.textContent = 'Converting…';
    try {
      const canvas = convertSource.type === 'pdf' ? await renderPdfFirstPage(convertSource.bytes) : await imageToCanvas(convertSource.bytes, convertSource.mime);
      const quality = Number($('convertQuality').value) / 100;
      const mime = convertFmt === 'jpg' ? 'image/jpeg' : 'image/png';
      const dataUrl = canvas.toDataURL(mime, quality);
      $('convertPreview').src = dataUrl;
      $('convertDownload').href = dataUrl;
      $('convertDownload').download = convertTitle.replace(/\.[^.]+$/, '') + '.' + (convertFmt === 'jpg' ? 'jpg' : 'png');
      toggle('convertResult', true, 'block');
      toast('Converted to ' + convertFmt.toUpperCase());
    } catch (error) {
      toast('Could not convert this file.');
    } finally {
      button.disabled = false;
      button.textContent = 'Convert page 1';
    }
  }

  /* ---------- render all ---------- */
  function refreshTopbar() {
    const [hello] = titleFor(currentScreen);
    setText('helloText', hello);
  }

  function renderAll() {
    if (!STATE) return;
    applyPublic(STATE.profile);
    refreshTopbar();
    renderHome();
    renderVault();
    renderReminders();
    renderJobs();
    renderChat();
    renderAccount();
    refreshTopbar();
  }

  /* ---------- auto-lock ---------- */
  function autoLockCheck() {
    if (!STATE || !masterKey) return;
    const minutes = Number(STATE.settings.autoLockMinutes);
    if (!minutes) return;
    if (Date.now() - lastActive > minutes * 60000) lockNow();
  }

  /* ---------- init ---------- */
  function bindEvents() {
    $$('.tab').forEach((tab) => tab.addEventListener('click', () => go(tab.dataset.tab)));
    $$('[data-go]').forEach((el) => el.addEventListener('click', (event) => {
      event.preventDefault();
      go(el.dataset.go);
    }));
    $$('[data-action]').forEach((el) => el.addEventListener('click', () => {
      const action = el.dataset.action;
      if (action === 'new-doc') openSheet('addDocSheet');
      if (action === 'new-reminder') openReminderSheet(null);
      if (action === 'new-job') openJobSheet(null);
    }));
    $$('[data-drawer]').forEach((el) => el.addEventListener('click', () => {
      closeDrawer();
      go(el.dataset.drawer);
    }));
    on('menuBtn', 'click', openDrawer);
    on('drawerBackdrop', 'click', closeDrawer);
    on('drawerHead', 'click', () => { closeDrawer(); go('profile'); });
    on('drawerLock', 'click', () => lockNow());
    on('drawerAbout', 'click', () => toast('Student Vault 2.0 · AES-256-GCM local vault'));
    on('deviceSecurity', 'click', () => toast('Encrypted with AES-256-GCM. The key exists only after unlock.'));
    on('backdrop', 'click', closeSheets);
    on('fab', 'click', () => {
      if (currentScreen === 'vault') openSheet('addDocSheet');
      else if (currentScreen === 'reminders') openReminderSheet(null);
      else openJobSheet(null);
    });

    $$('#homeChips .chip').forEach((chip) => chip.addEventListener('click', () => {
      $$('#homeChips .chip').forEach((item) => item.classList.remove('active'));
      chip.classList.add('active');
      $$('#vaultChips .chip').forEach((item) => item.classList.toggle('active', item.dataset.cat === chip.dataset.cat));
      renderVault();
      go('vault');
    }));
    $$('#vaultChips .chip').forEach((chip) => chip.addEventListener('click', () => {
      $$('#vaultChips .chip').forEach((item) => item.classList.remove('active'));
      chip.classList.add('active');
      renderVault();
    }));
    on('vaultSearch', 'input', renderVault);

    on('docFile', 'change', () => {
      const file = $('docFile').files && $('docFile').files[0];
      if (!file) { toggle('docFileName', false); return; }
      toggle('docFileName', true, 'block');
      setText('docFileName', file.name + ' · ' + C.fmtBytes(file.size));
      if (!$('newDocName').value.trim()) $('newDocName').value = file.name.replace(/\.[^.]+$/, '');
    });
    on('addDocBtn', 'click', addDocument);
    $$('[data-doc-action]').forEach((button) => button.addEventListener('click', () => {
      const doc = STATE && STATE.documents.find((item) => item.id === currentDocId);
      if (!doc) return;
      const action = button.dataset.docAction;
      if (action === 'open') openDocViewer(doc);
      if (action === 'download') downloadDoc(doc);
      if (action === 'rename') openDocEdit();
      if (action === 'delete') askDeleteDoc(doc.id);
      if (action === 'convert') openConvert();
    }));
    on('saveDocBtn', 'click', saveDocEdit);

    on('saveRemBtn', 'click', saveReminder);
    on('deleteRemBtn', 'click', askDeleteReminder);

    $$('#jobChips .chip').forEach((chip) => chip.addEventListener('click', () => {
      $$('#jobChips .chip').forEach((item) => item.classList.remove('active'));
      chip.classList.add('active');
      jobFilter = chip.dataset.status;
      renderJobs();
    }));
    $$('#jobStatusRow .status-chip').forEach((chip) => chip.addEventListener('click', () => {
      currentJobStatus = chip.dataset.status;
      updateJobStatusChips();
    }));
    on('saveJobBtn', 'click', saveJob);
    on('deleteJobBtn', 'click', askDeleteJob);
    on('jobLinkBtn', 'click', () => openExternal($('jobLinkInput').value.trim() || $('jobLinkBtn').dataset.url || ''));

    on('sendBtn', 'click', () => sendChat());
    on('chatText', 'keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); sendChat(); } });
    $$('#chatSuggestions [data-ask]').forEach((button) => button.addEventListener('click', () => sendChat(button.dataset.ask)));
    on('clearChatRow', 'click', () => confirmAction('Clear assistant history?', 'Your vault documents and reminders will stay intact.', 'Clear history', clearChat));

    on('editProfileRow', 'click', openProfileSheet);
    on('chooseAvatarBtn', 'click', () => { const input = $('avatarFile'); if (input) input.click(); });
    on('avatarFile', 'change', () => {
      const file = $('avatarFile').files && $('avatarFile').files[0];
      if (file) selectAvatar(file);
    });
    on('removeAvatarBtn', 'click', removeAvatar);
    on('saveProfileBtn', 'click', saveProfile);
    on('serverRow', 'click', openAiSheet);
    on('saveAiBtn', 'click', saveAiSettings);
    on('testAiBtn', 'click', testAiConnection);
    on('clearAiBtn', 'click', async () => {
      STATE.settings.aiEndpoint = '';
      STATE.settings.aiToken = '';
      await persist();
      closeSheets();
      renderAll();
      toast('Using on-device assistant');
    });
    on('notifToggle', 'change', async (event) => {
      STATE.settings.notifications = event.target.checked;
      await persist();
      renderHome();
      toast(event.target.checked ? 'In-app reminders on' : 'In-app reminders off');
    });
    on('autoLockSelect', 'change', async (event) => {
      STATE.settings.autoLockMinutes = Number(event.target.value);
      await persist();
      toast(event.target.value === '0' ? 'Auto-lock disabled' : 'Auto-lock set to ' + event.target.value + ' min');
    });
    on('themeToggle', 'change', async (event) => {
      STATE.settings.theme = event.target.checked ? 'dark' : 'light';
      localStorage.setItem('sv-theme', STATE.settings.theme);
      applyTheme(event.target.checked);
      await persist();
    });
    on('passkeyRow', 'click', togglePasskey);
    on('changePinRow', 'click', openPinSheet);
    on('recoveryRow', 'click', openRecoverySheet);
    on('backupRow', 'click', openBackupSheet);
    on('securityCenterRow', 'click', openSecuritySheet);
    on('securityLockBtn', 'click', lockNow);
    on('aboutRow', 'click', () => toast('Student Vault 2.0 · encrypted local vault'));
    on('clearDataRow', 'click', () => confirmAction('Erase all data?', 'Every document, reminder, application and key on this device will be deleted. This cannot be undone.', 'Erase everything', async () => {
      C.clearAuth();
      await C.dbClear('kv');
      await C.dbClear('files');
      C.clearPasskey();
      localStorage.removeItem('sv-theme');
      location.reload();
    }));
    on('lockBtn', 'click', lockNow);

    on('savePinBtn', 'click', changePin);
    on('saveVaultAfterSetupBtn', 'click', exportBackup);
    on('regenRecoveryBtn', 'click', regenerateRecovery);
    on('recoveryDoneBtn', 'click', closeSheets);
    on('copyRecoveryBtn', 'click', copyRecovery);
    on('downloadRecoveryBtn', 'click', downloadRecovery);
    on('exportBackupBtn', 'click', exportBackup);
    on('importBackupInput', 'change', () => {
      const file = $('importBackupInput').files && $('importBackupInput').files[0];
      selectBackupFile(file);
      if (importFromSetup && file) {
        importFromSetup = false;
        restoreBackup(file, true);
      } else if (!file) {
        importFromSetup = false;
      }
    });
    on('importBackupBtn', 'click', () => restoreBackup(selectedBackupFile, false));

    on('confirmCancel', 'click', () => { confirmCallback = null; closeSheets(); });
    on('confirmOk', 'click', async () => {
      const callback = confirmCallback;
      confirmCallback = null;
      closeSheets();
      if (callback) await callback();
    });

    on('viewerClose', 'click', closeViewer);
    on('viewerDownload', 'click', () => { /* native download is handled by the link */ });
    on('pdfPasswordCancel', 'click', () => finishPdfPassword(null));
    on('pdfPasswordUnlock', 'click', () => {
      const value = $('pdfPasswordInput').value;
      if (!value) { $('pdfPasswordErr').textContent = 'Enter the document password.'; return; }
      finishPdfPassword(value);
    });
    on('pdfPasswordInput', 'keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); $('pdfPasswordUnlock').click(); }
    });

    $$('#convertFormat button').forEach((button) => button.addEventListener('click', () => {
      $$('#convertFormat button').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      convertFmt = button.dataset.fmt;
      toggle('qualityField', convertFmt === 'jpg', 'block');
    }));
    on('convertQuality', 'input', (event) => setText('qualityVal', event.target.value));
    on('convertBtn', 'click', convertDocument);

    $$('#keypad button[data-key]').forEach((button) => button.addEventListener('click', () => handlePinKey(button.dataset.key)));
    on('passkeyBtn', 'click', unlockWithPasskey);
    on('usePinBtn', 'click', () => showPane('pin'));
    on('useBioBtn', 'click', () => showPane('bio'));
    on('forgotPinBtn', 'click', () => {
      $('recoveryInput').value = '';
      $('recoveryErr').textContent = '';
      showPane('recovery');
    });
    $('recoveryPane').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.id === 'recoverBtn') beginRecovery();
      if (button.id === 'backToPinBtn') showPane('pin');
      if (button.id === 'resetPinBtn') finishRecoveryReset();
    });
    on('createVaultBtn', 'click', createVault);
    on('restoreOnSetupBtn', 'click', () => {
      importFromSetup = true;
      $('importBackupInput').click();
    });

    on('dueBanner', 'click', () => go('reminders'));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSheets();
        closeViewer();
        closeDrawer();
      }
    });
    document.addEventListener('pointerdown', () => { if (STATE) lastActive = Date.now(); }, true);
    document.addEventListener('keydown', () => { if (STATE) lastActive = Date.now(); }, true);
    document.addEventListener('visibilitychange', () => {
      if (!STATE || !masterKey) return;
      const minutes = Number(STATE.settings.autoLockMinutes);
      if (document.hidden) {
        lastActive = Date.now();
      } else if (minutes && Date.now() - lastActive > minutes * 60000) {
        lockNow();
      }
    });
    window.addEventListener('resize', () => movePill($$('.tab').find((tab) => tab.classList.contains('active'))));
    setInterval(autoLockCheck, 15000);
  }

  function improveA11y() {
    $$('.field').forEach((field, index) => {
      const label = field.querySelector('label');
      const control = field.querySelector('input, select, textarea');
      if (!label || !control) return;
      if (!control.id) control.id = 'field_' + index;
      if (!label.htmlFor) label.htmlFor = control.id;
    });
    const search = $('vaultSearch');
    if (search && !search.getAttribute('aria-label')) search.setAttribute('aria-label', 'Search vault');
    const chat = $('chatText');
    if (chat && !chat.getAttribute('aria-label')) chat.setAttribute('aria-label', 'Message Student Vault');
    $$('.switch input').forEach((input) => {
      if (input.getAttribute('aria-label')) return;
      const row = input.closest('.setting');
      const text = row ? row.querySelector('.grow') : null;
      input.setAttribute('aria-label', text ? text.textContent.trim() : 'Toggle setting');
    });
  }

  function tickClock() {
    const now = new Date();
    setText('clock', String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'));
  }

  function init() {
    if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    nativeShell = /Android/i.test(navigator.userAgent) &&
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || !!window.Capacitor);
    if (nativeShell) {
      document.documentElement.classList.add('native-shell');
      document.documentElement.style.setProperty('--sat', '42px');
    }
    const savedTheme = localStorage.getItem('sv-theme');
    applyTheme(!!C.getAuth() && savedTheme === 'dark');
    recoveryPaneHtml = $('recoveryPane').innerHTML;
    bindEvents();
    improveA11y();
    tickClock();
    setInterval(tickClock, 30000);
    refreshGate();
    setInterval(() => {
      if (STATE) buildWeek();
    }, 60000);
    setTimeout(() => movePill($$('.tab').find((tab) => tab.classList.contains('active'))), 120);
  }

  init();
})();
