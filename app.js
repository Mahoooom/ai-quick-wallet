/* ===========================
   app.js — AI 快记核心逻辑（含 Supabase 云同步）
=========================== */

// ─── 分类 Emoji 映射 ───────────────────────────────────────────────
const CATEGORY_ICONS = {
  餐饮: '🍜', 购物: '🛍️', 交通: '🚗', 娱乐: '🎬',
  医疗: '💊', 住房: '🏠', 教育: '📚', 旅行: '✈️',
  运动: '🏃', 通讯: '📱', 生活: '🧴', 社交: '🎁',
  工作: '💼', 宠物: '🐾', 其他: '💸',
};

function getCategoryIcon(category) {
  for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
    if (category && category.includes(key)) return icon;
  }
  return '💸';
}

// ─── Supabase 配置 ─────────────────────────────────────────────────
const SUPABASE_URL = 'https://lwmnxtwtgtrmfqdmssii.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vANRbmxn9LVuykPUDueXcQ_LWAuDc-f';
const SB_HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: { ...SB_HEADERS, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message || `云端请求失败 (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// 从云端加载
async function loadBillsCloud() {
  const rows = await sbFetch('/bills?order=created_at.desc&limit=500');
  return rows.filter(r => !isConfigBill(r)).map(r => ({
    id:       r.id,
    time:     r.created_at,
    item:     r.item,
    amount:   Number(r.amount),
    category: r.category,
    raw:      r.raw || '',
  }));
}

// 保存一条到云端
async function saveBillCloud(bill) {
  await sbFetch('/bills', {
    method: 'POST',
    body: JSON.stringify({
      id:         bill.id,
      item:       bill.item,
      amount:     bill.amount,
      category:   bill.category,
      raw:        bill.raw || '',
      created_at: bill.time,
    }),
  });
}

// 删除云端一条
async function deleteBillCloud(id) {
  await sbFetch(`/bills?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// 清空云端全部
async function clearBillsCloud() {
  await sbFetch(`/bills?user_id=eq.default&id=neq.${encodeURIComponent(CONFIG_BILL_ID)}`, { method: 'DELETE' });
}

// AI 配置云端同步（复用 bills 表，专用 id 存储，不显示在账单列表）
const CONFIG_BILL_ID = '__ai_config__';

async function loadConfigCloud() {
  const rows = await sbFetch(`/bills?id=eq.${encodeURIComponent(CONFIG_BILL_ID)}&select=raw`);
  if (!rows?.length || !rows[0].raw) return null;
  try {
    return normalizeConfig(JSON.parse(rows[0].raw));
  } catch {
    return null;
  }
}

async function saveConfigCloud(cfg) {
  const payload = {
    id:         CONFIG_BILL_ID,
    user_id:    'default',
    item:       '__config__',
    amount:     0,
    category:   '其他',
    raw:        JSON.stringify(normalizeConfig(cfg)),
    created_at: new Date().toISOString(),
  };

  const existing = await sbFetch(`/bills?id=eq.${encodeURIComponent(CONFIG_BILL_ID)}&select=id`);
  if (existing?.length) {
    await sbFetch(`/bills?id=eq.${encodeURIComponent(CONFIG_BILL_ID)}`, {
      method: 'PATCH',
      body: JSON.stringify({ raw: payload.raw, created_at: payload.created_at }),
    });
  } else {
    await sbFetch('/bills', { method: 'POST', body: JSON.stringify(payload) });
  }
}

// ─── 本地缓存（离线备用） ──────────────────────────────────────────
const STORAGE_KEY = 'ai_quick_wallet_v1';
const CONFIG_KEY  = 'ai_quick_wallet_config';
const IDB_NAME    = 'ai_quick_wallet';
const IDB_STORE   = 'kv';

let appConfig = null;

function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return {};
  return {
    provider:      cfg.provider      || 'deepseek',
    apiKey:        cfg.apiKey        || '',
    voiceProvider: cfg.voiceProvider || 'siliconflow',
    voiceApiKey:   cfg.voiceApiKey   || '',
    voiceBaseUrl:  cfg.voiceBaseUrl  || '',
    voiceModel:    cfg.voiceModel    || '',
    baseUrl:       cfg.baseUrl       || '',
    model:         cfg.model         || '',
  };
}

function isConfigBill(bill) {
  return bill?.id === CONFIG_BILL_ID;
}

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function loadBillsLocal() {
  try {
    return (JSON.parse(localStorage.getItem(STORAGE_KEY)) || []).filter(b => !isConfigBill(b));
  }
  catch { return []; }
}
function saveBillsLocal(b) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(b.filter(bill => !isConfigBill(bill))));
}
function loadConfig() {
  if (appConfig?.apiKey) return appConfig;
  try {
    const local = normalizeConfig(JSON.parse(localStorage.getItem(CONFIG_KEY)));
    if (local.apiKey) {
      appConfig = local;
      return local;
    }
  } catch {}
  return appConfig || {};
}
function saveConfig(cfg) {
  appConfig = normalizeConfig(cfg);
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(appConfig)); } catch {}
  idbSet(CONFIG_KEY, appConfig).catch(() => {});
}

async function loadConfigIDB() {
  try {
    const cfg = await idbGet(CONFIG_KEY);
    return cfg ? normalizeConfig(cfg) : null;
  } catch {
    return null;
  }
}

async function syncConfigFromCloud() {
  const cloudCfg = await loadConfigCloud();
  if (cloudCfg?.apiKey) {
    saveConfig(cloudCfg);
    return cloudCfg;
  }
  return null;
}

async function initConfig() {
  let cfg = loadConfig();

  if (!cfg.apiKey) {
    const idbCfg = await loadConfigIDB();
    if (idbCfg?.apiKey) {
      saveConfig(idbCfg);
      cfg = idbCfg;
    }
  }

  try {
    const cloudCfg = await syncConfigFromCloud();
    if (cloudCfg?.apiKey) cfg = cloudCfg;
  } catch (e) {
    console.warn('云端配置加载失败', e);
  }

  // 本地有配置但云端没有时，补上传到云端
  if (cfg.apiKey) {
    try {
      const cloudCfg = await loadConfigCloud();
      if (!cloudCfg?.apiKey) await saveConfigCloud(cfg);
    } catch (e) {
      console.warn('云端配置补传失败', e);
    }
  }

  return cfg;
}

// ─── 日期解析 ──────────────────────────────────────────────────────
function todayDateStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateStr(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  const match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

function resolveBillTime(dateStr) {
  const now = new Date();
  const parsed = parseDateStr(dateStr);
  if (!parsed) return now.toISOString();
  parsed.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  return parsed.toISOString();
}

function getDateKey(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function formatDateHeader(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const weekday = WEEKDAYS[date.getDay()];
  if (date.toDateString() === now.toDateString()) return `今天 · ${weekday}`;
  if (date.toDateString() === yesterday.toDateString()) return `昨天 · ${weekday}`;
  if (date.getFullYear() === now.getFullYear()) return `${m}月${d}日 · ${weekday}`;
  return `${y}年${m}月${d}日 · ${weekday}`;
}

function formatDateLabel(iso) {
  const dateKey = getDateKey(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (dateKey === todayDateStr()) return '今天';
  if (dateKey === getDateKey(yesterday.toISOString())) return '昨天';

  const [y, m, d] = dateKey.split('-').map(Number);
  if (y === now.getFullYear()) return `${m}月${d}日`;
  return `${y}年${m}月${d}日`;
}

// ─── AI API 调用 ────────────────────────────────────────────────────
async function callAI(text) {
  const config = loadConfig();
  if (!config.apiKey) throw new Error('请先点击「配置 AI 接口」填入 API Key');

  const PROVIDERS = {
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openai:   { baseUrl: 'https://api.openai.com/v1',   model: 'gpt-4o-mini'   },
    custom:   { baseUrl: config.baseUrl || '',           model: config.model || 'gpt-4o-mini' },
  };

  const provider = PROVIDERS[config.provider || 'deepseek'];
  if (!provider.baseUrl) throw new Error('自定义接口请填写 Base URL');

  const today = todayDateStr();
  const systemPrompt = `你是一个记账助手。用户输入一句消费描述，你必须提取出以下四个字段，并**只返回**一个 JSON 对象，不要任何多余文字：
{
  "item":     "消费物品或事件的简短名称（5字以内）",
  "amount":   数字（单位：元，只取正数），
  "category": "从以下分类中选一个最匹配的：餐饮、购物、交通、娱乐、医疗、住房、教育、旅行、运动、通讯、生活、社交、工作、宠物、其他",
  "date":     "消费日期，格式 YYYY-MM-DD。今天日期是 ${today}。若用户未提及日期或说的是今天，填 ${today}；若提到「昨天」「前天」「上周五」「3月5日」「2024-01-15」等，推算出对应日期"
}`;

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: text },
      ],
      temperature: 0,
      max_tokens: 160,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API 请求失败（${response.status}）`);
  }

  const data = await response.json();
  const raw  = data.choices?.[0]?.message?.content?.trim() || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI 返回格式异常，请重试');

  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.item || !parsed.amount || !parsed.category) {
    throw new Error('AI 未能识别出完整信息，请换一种说法');
  }

  const dateStr = parsed.date ? String(parsed.date).trim() : todayDateStr();

  return {
    item:     String(parsed.item).trim(),
    amount:   Number(parsed.amount),
    category: String(parsed.category).trim(),
    date:     parseDateStr(dateStr) ? dateStr : todayDateStr(),
  };
}

// ─── 账单渲染 ───────────────────────────────────────────────────────
let bills = [];
let pendingDeleteId = null;

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function renderBillItem(b) {
  return `
    <div class="bill-item" data-id="${b.id}">
      <div class="bill-category-icon">${getCategoryIcon(b.category)}</div>
      <div class="bill-info">
        <div class="bill-desc">${escHtml(b.item)}</div>
        <div class="bill-meta">${escHtml(b.category)} · ${formatTime(b.time)}</div>
      </div>
      <div class="bill-right">
        <div class="bill-amount">${Number(b.amount).toFixed(2)}</div>
        <button class="btn-delete" data-id="${b.id}" title="删除">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>`;
}

function renderBills() {
  const list  = document.getElementById('bill-list');
  const count = document.getElementById('list-count');
  count.textContent = `${bills.length} 笔`;

  if (!bills.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📝</div>
        <div class="empty-text">还没有记录，说一句话开始记账吧</div>
      </div>`;
    return;
  }

  const sorted = [...bills].sort((a, b) => new Date(b.time) - new Date(a.time));
  const groups = new Map();
  sorted.forEach(b => {
    const key = getDateKey(b.time);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  });

  list.innerHTML = [...groups.entries()].map(([dateKey, items]) => {
    const dayTotal = items.reduce((sum, b) => sum + b.amount, 0);
    return `
      <div class="bill-group">
        <div class="bill-group-header">
          <span class="bill-group-date">${formatDateHeader(dateKey)}</span>
          <span class="bill-group-total">¥${dayTotal.toFixed(2)}</span>
        </div>
        ${items.map(renderBillItem).join('')}
      </div>`;
  }).join('');

  list.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingDeleteId = btn.dataset.id;
      document.getElementById('modal-delete').style.display = 'flex';
    });
  });
}

function updateStats() {
  const now   = new Date();
  const today = now.toDateString();
  const ym    = `${now.getFullYear()}-${now.getMonth()}`;

  let todaySum = 0, monthSum = 0;
  bills.forEach(b => {
    const d = new Date(b.time);
    if (d.toDateString() === today) todaySum += b.amount;
    if (`${d.getFullYear()}-${d.getMonth()}` === ym) monthSum += b.amount;
  });

  document.getElementById('stat-today').textContent  = `¥${todaySum.toFixed(2)}`;
  document.getElementById('stat-month').textContent  = `¥${monthSum.toFixed(2)}`;
  document.getElementById('stat-count').textContent  = bills.length;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// 云端同步状态指示
function setSyncStatus(status) {
  // status: 'syncing' | 'ok' | 'offline'
  const el = document.getElementById('sync-status');
  if (!el) return;
  const map = { syncing: '⏳ 同步中', ok: '☁️ 已同步', offline: '📴 本地模式' };
  el.textContent = map[status] || '';
}

// ─── Toast ─────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, duration = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

// ─── 主流程：记一笔 ────────────────────────────────────────────────
const BTN_SUBMIT_HTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> 记一笔`;

async function submitBill() {
  const inputEl = document.getElementById('input-text');
  const text    = inputEl.value.trim();
  if (!text) { showToast('请先输入消费内容 😊'); return; }

  const btn = document.getElementById('btn-submit');
  btn.innerHTML = '<span class="spinner"></span> AI 识别中…';
  btn.classList.add('loading');

  try {
    const result = await callAI(text);
    const bill = {
      id:       Date.now().toString(),
      time:     resolveBillTime(result.date),
      item:     result.item,
      amount:   result.amount,
      category: result.category,
      raw:      text,
    };

    bills.unshift(bill);
    saveBillsLocal(bills);
    renderBills();
    updateStats();
    inputEl.value = '';
    const dateHint = result.date !== todayDateStr() ? ` · ${formatDateLabel(bill.time)}` : '';
    showToast(`✅ 已入账：${result.category} ¥${result.amount}${dateHint}`);

    setSyncStatus('syncing');
    try {
      await saveBillCloud(bill);
      setSyncStatus('ok');
    } catch (e) {
      setSyncStatus('offline');
      console.warn('云端同步失败，已保存本地', e);
    }

  } catch (err) {
    showToast(`❌ ${err.message}`, 3500);
  } finally {
    btn.innerHTML = BTN_SUBMIT_HTML;
    btn.classList.remove('loading');
  }
}

// ─── 语音输入（长按说话 · 上滑取消 · 松开转文字） ─────────────────
const VOICE_LONG_PRESS_MS = 350;
const VOICE_CANCEL_SLIDE_PX = 60;

const voice = {
  active: false,
  cancelled: false,
  suppressClick: false,
  longPressTimer: null,
  startY: 0,
  mode: null, // 'speech' | 'recorder'
  recognition: null,
  mediaRecorder: null,
  mediaStream: null,
  audioChunks: [],
  transcript: '',
  pointerId: null,
};

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function canUseWebSpeech() {
  return !isIOS() && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function getSupportedAudioMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/mpeg'];
  for (const type of types) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function getVoiceApiKey() {
  const cfg = loadConfig();
  if (cfg.voiceApiKey) return cfg.voiceApiKey;
  if (cfg.provider === 'openai' && cfg.apiKey) return cfg.apiKey;
  return '';
}

async function transcribeAudio(blob) {
  const cfg = loadConfig();
  const apiKey = getVoiceApiKey();
  if (!apiKey) {
    throw new Error('请在配置中填写「语音 API Key」');
  }

  const { baseUrl, model } = getVoiceEndpointConfig(cfg);
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;

  const ext = blob.type.includes('mp4') ? 'mp4'
    : blob.type.includes('webm') ? 'webm'
    : blob.type.includes('aac') ? 'aac'
    : 'm4a';

  const form = new FormData();
  form.append('file', blob, `voice.${ext}`);
  form.append('model', model);
  form.append('language', 'zh');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `语音识别失败（${res.status}）`);
  }

  const data = await res.json();
  return String(data.text || '').trim();
}

function getPointerY(e) {
  if (e.touches?.length) return e.touches[0].clientY;
  if (e.changedTouches?.length) return e.changedTouches[0].clientY;
  return e.clientY;
}

function setVoiceCancelState(cancelled) {
  voice.cancelled = cancelled;
  const overlay = document.getElementById('voice-overlay');
  const hint = document.getElementById('voice-hint');
  if (!overlay || !hint) return;
  overlay.classList.toggle('cancel-ready', cancelled);
  hint.textContent = cancelled ? '松开 取消' : '松开 转文字';
}

function updateVoicePreview(text) {
  const el = document.getElementById('voice-preview');
  if (el) el.textContent = text;
}

function showVoiceOverlay() {
  const overlay = document.getElementById('voice-overlay');
  const preview = document.getElementById('voice-preview');
  const hint = document.getElementById('voice-hint');
  if (preview) preview.textContent = '';
  if (hint) hint.textContent = '松开 转文字';
  overlay?.classList.remove('cancel-ready');
  overlay?.removeAttribute('hidden');
  document.getElementById('btn-submit')?.classList.add('recording');
}

function hideVoiceOverlay() {
  document.getElementById('voice-overlay')?.setAttribute('hidden', '');
  document.getElementById('voice-overlay')?.classList.remove('cancel-ready');
  document.getElementById('btn-submit')?.classList.remove('recording');
}

function startWebSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  voice.mode = 'speech';
  voice.transcript = '';

  const recognition = new SR();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let text = '';
    for (let i = 0; i < event.results.length; i++) {
      text += event.results[i][0].transcript;
    }
    voice.transcript = text.trim();
    if (!voice.cancelled) updateVoicePreview(voice.transcript);
  };

  recognition.onerror = (event) => {
    if (event.error === 'aborted' || event.error === 'no-speech') return;
    console.warn('语音识别错误', event.error);
  };

  voice.recognition = recognition;
  showVoiceOverlay();

  try {
    recognition.start();
    return true;
  } catch (err) {
    voice.mode = null;
    voice.active = false;
    hideVoiceOverlay();
    return false;
  }
}

async function startMediaRecorder() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('当前浏览器不支持录音', 3000);
    return false;
  }
  if (!getVoiceApiKey()) {
    showToast('请先配置 OpenAI 语音 API Key', 3500);
    return false;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voice.mediaStream = stream;
    voice.audioChunks = [];
    voice.mode = 'recorder';

    const mimeType = getSupportedAudioMimeType();
    const mr = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) voice.audioChunks.push(e.data);
    };

    mr.start(250);
    voice.mediaRecorder = mr;
    showVoiceOverlay();
    updateVoicePreview('正在录音…');
    return true;
  } catch (err) {
    voice.active = false;
    voice.mode = null;
    hideVoiceOverlay();
    showToast('无法访问麦克风，请检查权限', 3000);
    return false;
  }
}

async function startVoiceInput() {
  voice.active = true;
  voice.cancelled = false;
  voice.transcript = '';

  if (canUseWebSpeech()) {
    if (startWebSpeech()) return true;
  }

  if (typeof MediaRecorder !== 'undefined') {
    return startMediaRecorder();
  }

  voice.active = false;
  showToast('当前浏览器不支持语音识别', 3000);
  return false;
}

function stopRecorderAndGetBlob(mr, stream) {
  return new Promise((resolve) => {
    if (!mr) {
      stream?.getTracks().forEach(t => t.stop());
      resolve(null);
      return;
    }

    const finalize = () => {
      stream?.getTracks().forEach(t => t.stop());
      const type = mr.mimeType || 'audio/mp4';
      resolve(new Blob(voice.audioChunks, { type }));
      voice.audioChunks = [];
    };

    if (mr.state === 'inactive') {
      finalize();
      return;
    }

    mr.onstop = finalize;
    try { mr.stop(); } catch { finalize(); }
  });
}

async function finishMediaRecorderInput(shouldApply) {
  const mr = voice.mediaRecorder;
  const stream = voice.mediaStream;
  const inputEl = document.getElementById('input-text');

  voice.active = false;
  voice.mode = null;
  voice.mediaRecorder = null;
  voice.mediaStream = null;

  if (!shouldApply) {
    hideVoiceOverlay();
    await stopRecorderAndGetBlob(mr, stream);
    voice.cancelled = false;
    updateVoicePreview('');
    showToast('已取消');
    return;
  }

  const hint = document.getElementById('voice-hint');
  if (hint) hint.textContent = '识别中…';
  updateVoicePreview('');

  const blob = await stopRecorderAndGetBlob(mr, stream);
  hideVoiceOverlay();
  voice.cancelled = false;

  if (!blob || blob.size < 800) {
    showToast('录音太短，请重试');
    return;
  }

  showToast('正在识别语音…', 4000);
  try {
    const text = await transcribeAudio(blob);
    if (!text) {
      showToast('未识别到内容');
      return;
    }
    inputEl.value = text;
    inputEl.focus();
    showToast('✅ 已转为文字');
  } catch (err) {
    showToast(`❌ ${err.message}`, 3500);
  }
}

function finishWebSpeechInput() {
  if (!voice.active) return;

  const shouldApply = !voice.cancelled;
  const rec = voice.recognition;
  const inputEl = document.getElementById('input-text');

  voice.active = false;
  voice.mode = null;
  voice.recognition = null;
  hideVoiceOverlay();

  const applyTranscript = () => {
    const text = voice.transcript.trim();
    voice.transcript = '';
    voice.cancelled = false;
    updateVoicePreview('');

    if (!shouldApply) {
      showToast('已取消');
      return;
    }
    if (!text) {
      showToast('未识别到内容');
      return;
    }
    inputEl.value = text;
    inputEl.focus();
    showToast('✅ 已转为文字');
  };

  if (!rec) {
    applyTranscript();
    return;
  }

  if (!shouldApply) {
    rec.onend = () => {
      voice.transcript = '';
      voice.cancelled = false;
      showToast('已取消');
    };
    try { rec.abort(); } catch { try { rec.stop(); } catch { applyTranscript(); } }
    return;
  }

  rec.onend = applyTranscript;
  try { rec.stop(); } catch {
    applyTranscript();
  }
}

async function finishVoiceInput() {
  if (!voice.active) return;

  if (voice.mode === 'recorder') {
    await finishMediaRecorderInput(!voice.cancelled);
    setTimeout(() => { voice.suppressClick = false; }, 400);
    return;
  }

  finishWebSpeechInput();
}

function clearVoiceLongPress() {
  clearTimeout(voice.longPressTimer);
  voice.longPressTimer = null;
}

function bindVoiceGlobalPointer() {
  document.addEventListener('pointermove', onVoicePointerMove);
  document.addEventListener('pointerup', onVoiceGlobalPointerUp);
  document.addEventListener('pointercancel', onVoiceGlobalPointerUp);
}

function unbindVoiceGlobalPointer() {
  document.removeEventListener('pointermove', onVoicePointerMove);
  document.removeEventListener('pointerup', onVoiceGlobalPointerUp);
  document.removeEventListener('pointercancel', onVoiceGlobalPointerUp);
}

function onVoiceGlobalPointerUp(e) {
  onVoicePointerUp(e);
  unbindVoiceGlobalPointer();
}

function onVoicePointerDown(e, bindGlobal = true) {
  const btn = document.getElementById('btn-submit');
  if (btn.classList.contains('loading')) return;

  voice.pointerId = e.pointerId ?? 'touch';
  voice.startY = getPointerY(e);
  voice.cancelled = false;
  voice.suppressClick = false;

  clearVoiceLongPress();
  if (bindGlobal) bindVoiceGlobalPointer();
  voice.longPressTimer = setTimeout(() => {
    voice.suppressClick = true;
    startVoiceInput().then(ok => {
      if (!ok) voice.suppressClick = false;
    });
  }, VOICE_LONG_PRESS_MS);
}

function onVoicePointerMove(e) {
  if (!voice.active && !voice.longPressTimer) return;
  if (voice.pointerId != null && e.pointerId != null && e.pointerId !== voice.pointerId) return;

  const slideUp = voice.startY - getPointerY(e);
  if (voice.active) {
    setVoiceCancelState(slideUp >= VOICE_CANCEL_SLIDE_PX);
  }
}

function onVoicePointerUp(e) {
  if (voice.pointerId != null && e.pointerId != null && e.pointerId !== voice.pointerId) return;

  clearVoiceLongPress();
  unbindVoiceGlobalPointer();

  if (voice.active) {
    e.preventDefault?.();
    finishVoiceInput();
    if (voice.mode !== 'recorder') {
      setTimeout(() => { voice.suppressClick = false; }, 400);
    }
  }

  voice.pointerId = null;
}

function initVoiceInput() {
  const btn = document.getElementById('btn-submit');
  if (!btn) return;

  btn.addEventListener('click', (e) => {
    if (voice.suppressClick || voice.active) {
      e.preventDefault();
      return;
    }
    submitBill();
  });

  btn.addEventListener('contextmenu', e => e.preventDefault());

  if (window.PointerEvent) {
    btn.addEventListener('pointerdown', e => onVoicePointerDown(e, true));
  } else {
    btn.addEventListener('touchstart', (e) => {
      onVoicePointerDown(e, false);
      const move = (ev) => onVoicePointerMove(ev);
      const up = (ev) => {
        onVoicePointerUp(ev);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('touchend', up);
        document.removeEventListener('touchcancel', up);
      };
      document.addEventListener('touchmove', move, { passive: true });
      document.addEventListener('touchend', up);
      document.addEventListener('touchcancel', up);
    }, { passive: true });
    btn.addEventListener('mousedown', e => onVoicePointerDown(e, true));
  }
}

initVoiceInput();

// Enter 快捷提交（桌面端）
document.getElementById('input-text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('btn-submit').click();
  }
});

// ─── 统计面板切换 ──────────────────────────────────────────────────
document.getElementById('btn-stats').addEventListener('click', () => {
  const s = document.getElementById('stats-section');
  const visible = s.style.display !== 'none';
  s.style.display = visible ? 'none' : 'block';
  if (!visible) updateStats();
});

// ─── 清空全部 ──────────────────────────────────────────────────────
document.getElementById('btn-clear-all').addEventListener('click', async () => {
  if (!bills.length) { showToast('已经没有记录了'); return; }
  if (confirm(`确定清空全部 ${bills.length} 条记录？云端数据也会同步删除，不可撤销。`)) {
    bills = [];
    saveBillsLocal(bills);
    renderBills();
    updateStats();
    showToast('已清空');
    try {
      await clearBillsCloud();
    } catch(e) {
      console.warn('云端清空失败', e);
    }
  }
});

// ─── 删除单条 ──────────────────────────────────────────────────────
document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
  if (pendingDeleteId) {
    const id = pendingDeleteId;
    bills = bills.filter(b => b.id !== id);
    saveBillsLocal(bills);
    renderBills();
    updateStats();
    pendingDeleteId = null;
    showToast('已删除');
    try {
      await deleteBillCloud(id);
    } catch(e) {
      console.warn('云端删除失败', e);
    }
  }
  document.getElementById('modal-delete').style.display = 'none';
});

document.getElementById('btn-cancel-delete').addEventListener('click', () => {
  pendingDeleteId = null;
  document.getElementById('modal-delete').style.display = 'none';
});

// ─── 配置弹窗 ──────────────────────────────────────────────────────
const VOICE_PROVIDERS = {
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall' },
  openai:      { baseUrl: 'https://api.openai.com/v1',    model: 'whisper-1' },
  custom:      { baseUrl: '', model: '' },
};

function getVoiceEndpointConfig(cfg) {
  const vp = cfg.voiceProvider || 'siliconflow';
  const preset = VOICE_PROVIDERS[vp] || VOICE_PROVIDERS.siliconflow;
  return {
    baseUrl: vp === 'custom' ? (cfg.voiceBaseUrl || preset.baseUrl) : preset.baseUrl,
    model:   vp === 'custom' ? (cfg.voiceModel   || preset.model)   : preset.model,
  };
}

function toggleVoiceCustomFields() {
  const isCustom = document.getElementById('config-voice-provider')?.value === 'custom';
  const urlEl   = document.getElementById('group-voice-custom-url');
  const modelEl = document.getElementById('group-voice-custom-model');
  if (urlEl)   urlEl.style.display   = isCustom ? 'flex' : 'none';
  if (modelEl) modelEl.style.display = isCustom ? 'flex' : 'none';
}

function openConfig() {
  const cfg = loadConfig();
  document.getElementById('config-provider').value       = cfg.provider      || 'deepseek';
  document.getElementById('config-apikey').value         = cfg.apiKey        || '';
  document.getElementById('config-voice-provider').value = cfg.voiceProvider || 'siliconflow';
  document.getElementById('config-voice-apikey').value   = cfg.voiceApiKey   || '';
  const vuEl = document.getElementById('config-voice-base-url');
  const vmEl = document.getElementById('config-voice-model');
  if (vuEl) vuEl.value = cfg.voiceBaseUrl || '';
  if (vmEl) vmEl.value = cfg.voiceModel   || '';
  document.getElementById('config-base-url').value = cfg.baseUrl || '';
  document.getElementById('config-model').value    = cfg.model   || '';
  toggleCustomFields();
  toggleVoiceCustomFields();
  document.getElementById('modal-config').style.display = 'flex';
}

function toggleCustomFields() {
  const isCustom = document.getElementById('config-provider').value === 'custom';
  document.getElementById('group-custom-url').style.display   = isCustom ? 'flex' : 'none';
  document.getElementById('group-custom-model').style.display = isCustom ? 'flex' : 'none';
}

document.getElementById('btn-config').addEventListener('click', openConfig);
document.getElementById('config-provider').addEventListener('change', toggleCustomFields);
document.getElementById('config-voice-provider')?.addEventListener('change', toggleVoiceCustomFields);

document.getElementById('btn-save-config').addEventListener('click', async () => {
  const cfg = {
    provider:      document.getElementById('config-provider').value,
    apiKey:        document.getElementById('config-apikey').value.trim(),
    voiceProvider: document.getElementById('config-voice-provider').value,
    voiceApiKey:   document.getElementById('config-voice-apikey').value.trim(),
    voiceBaseUrl:  document.getElementById('config-voice-base-url')?.value.trim() || '',
    voiceModel:    document.getElementById('config-voice-model')?.value.trim() || '',
    baseUrl:       document.getElementById('config-base-url').value.trim(),
    model:         document.getElementById('config-model').value.trim(),
  };
  if (!cfg.apiKey) { showToast('请填入 API Key'); return; }
  saveConfig(cfg);
  document.getElementById('modal-config').style.display = 'none';
  showToast('✅ 配置已保存');

  try {
    await saveConfigCloud(cfg);
  } catch (e) {
    console.warn('云端配置保存失败', e);
    showToast('⚠️ 已保存本地，云端同步失败', 3000);
  }
});

document.getElementById('btn-close-config').addEventListener('click', () => {
  document.getElementById('modal-config').style.display = 'none';
});
document.getElementById('btn-cancel-config').addEventListener('click', () => {
  document.getElementById('modal-config').style.display = 'none';
});

// ─── 点击弹窗背景关闭 ─────────────────────────────────────────────
['modal-config', 'modal-delete'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) {
      e.target.style.display = 'none';
      pendingDeleteId = null;
    }
  });
});

// ─── 初始化：优先从云端加载 ───────────────────────────────────────
async function init() {
  // 先用本地缓存快速渲染，避免白屏
  bills = loadBillsLocal();
  renderBills();
  updateStats();

  // 加载 AI 配置（本地 + IndexedDB + 云端）
  await initConfig();

  // 再从云端拉最新账单
  setSyncStatus('syncing');
  try {
    const cloudBills = await loadBillsCloud();
    bills = cloudBills;
    saveBillsLocal(bills);
    renderBills();
    updateStats();
    setSyncStatus('ok');
  } catch(e) {
    setSyncStatus('offline');
    console.warn('云端加载失败，使用本地数据', e);
  }

  // 首次使用引导
  if (!loadConfig().apiKey) {
    setTimeout(() => showToast('👋 先点「配置 AI 接口」填入 API Key', 3500), 800);
  }
}

init();
