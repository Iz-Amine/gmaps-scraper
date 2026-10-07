/**
 * GMaps Scraper - Popup Script
 * Opens a long-lived port to background.js for live progress updates.
 */

// ─── Elements ──────────────────────────────────────────────────────
const btnStart    = document.getElementById('btnStart');
const btnStop     = document.getElementById('btnStop');
const btnSettings = document.getElementById('btnSettings');
const btnSave     = document.getElementById('btnSaveSettings');
const settingsPanel = document.getElementById('settings-panel');
const statusDot   = document.getElementById('statusDot');
const progressWrap = document.getElementById('progressWrap');
const logBox      = document.getElementById('logBox');

const statFound  = document.getElementById('statFound');
const statSent   = document.getElementById('statSent');
const statStatus = document.getElementById('statStatus');

const cfgApiUrl  = document.getElementById('cfgApiUrl');
const cfgApiKey  = document.getElementById('cfgApiKey');
const cfgProject = document.getElementById('cfgProjectName');
const cfgMaxResults = document.getElementById('cfgMaxResults');

// ─── State ─────────────────────────────────────────────────────────
let isScraping = false;
let port = null;

// ─── Background port ───────────────────────────────────────────────
function connectPort() {
  port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener(handleBgMessage);
  port.onDisconnect.addListener(() => { port = null; });
}

function handleBgMessage(msg) {
  if (msg.action === 'SCRAPE_PROGRESS') {
    statFound.textContent = msg.count;
    log(msg.message || `Scraped ${msg.count} listings…`, 'info');
  }

  if (msg.action === 'SCRAPE_DONE') {
    isScraping = false;
    setScrapingUI(false);
    statFound.textContent = msg.total;
    if (msg.error) {
      log(`Error: ${msg.error}`, 'err');
    } else if (msg.stopped) {
      log(`Stopped. ${msg.total} listings collected.`, 'info');
    } else {
      log(`✓ Done! ${msg.total} listings found. Sending to API…`, 'ok');
    }
  }

  if (msg.action === 'API_RESULT') {
    if (msg.ok) {
      statSent.textContent   = '✓';
      statStatus.textContent = msg.status;
      log(`✓ API accepted ${msg.response?.inserted || '?'} records.`, 'ok');
    } else {
      statSent.textContent   = '✗';
      statStatus.textContent = msg.status || 'ERR';
      log(`✗ API error: ${msg.error}`, 'err');
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────
function log(text, cls = '') {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = text;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function setScrapingUI(active) {
  isScraping = active;
  btnStart.style.display    = active ? 'none' : '';
  btnStop.style.display     = active ? ''     : 'none';
  progressWrap.style.display = active ? ''    : 'none';
  statusDot.classList.toggle('active', active);
}

// ─── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectPort();
  loadSettings();
  checkIfOnMaps();
});

function checkIfOnMaps() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url || '';
    if (!url.includes('google.com/maps')) {
      btnStart.disabled = true;
      btnStart.style.opacity = '0.4';
      log('⚠ Navigate to Google Maps first.', 'err');
    }
  });
}

function loadSettings() {
  chrome.storage.local.get(['apiUrl', 'apiKey', 'projectName', 'maxResults'], (cfg) => {
    cfgApiUrl.value     = cfg.apiUrl      || '';
    cfgApiKey.value     = cfg.apiKey      || '';
    cfgProject.value    = cfg.projectName || '';
    cfgMaxResults.value = cfg.maxResults  || '';
  });
}

// ─── Events ────────────────────────────────────────────────────────
btnStart.addEventListener('click', () => {
  if (isScraping) return;
  logBox.innerHTML = '';
  statFound.textContent  = '0';
  statSent.textContent   = '—';
  statStatus.textContent = '—';
  setScrapingUI(true);

  const maxResults = cfgMaxResults.value ? Number(cfgMaxResults.value) : null;
  chrome.storage.local.set({ maxResults: cfgMaxResults.value });

  log(maxResults ? `Starting scrape (max ${maxResults})…` : 'Starting scrape…', 'info');
  chrome.runtime.sendMessage({ action: 'TRIGGER_SCRAPE', maxResults }, (resp) => {
    if (!resp?.ok) {
      setScrapingUI(false);
      log(`✗ ${resp?.error || 'Could not start'}`, 'err');
    }
  });
});

btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'TRIGGER_STOP' });
  log('Stop requested…', 'info');
});

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('open');
});

btnSave.addEventListener('click', () => {
  chrome.storage.local.set({
    apiUrl:      cfgApiUrl.value.trim(),
    apiKey:      cfgApiKey.value.trim(),
    projectName: cfgProject.value.trim(),
  }, () => {
    log('✓ Settings saved.', 'ok');
    settingsPanel.classList.remove('open');
  });
});
