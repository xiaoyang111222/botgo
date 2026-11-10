// 界面层：聊天 / 会话 / 设置（提供方）/ Bots / 技能，全部操作本机数据。
import { loadConfig, saveConfig, listSessionIndex, createSession, loadSession, saveSession, deleteSession, exportAll, importAll, storageUsage, readDoc, uid } from './db.js';
import { listBots, getBot, createBot, updateBot, deleteBot, loadBotMemory, setBotMemory, DEFAULT_BOT_ID } from './bots.js';
import { listSkills, createSkill, updateSkill, deleteSkill } from './skills.js';
import { listModels, PRESETS, friendlyError } from './providers.js';
import { runAgent, setOnStepSave } from './agent.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

const APP_VERSION = '1.4.0';
const UPDATE_API = 'https://api.github.com/repos/xiaoyang111222/botgo/releases/latest';

let cfg = loadConfig();
let session = null;
let running = null; // AbortController
setOnStepSave((s) => { if (session && s.id === session.id) saveSession(s); });

// ---------- 通用 ----------
function toast(text) {
  const d = el('div', 'msg notice', text);
  $('#messages').appendChild(d); scrollDown();
  setTimeout(() => d.remove(), 4200);
}
function scrollDown() { const v = $('#chatView'); v.scrollTop = v.scrollHeight; }
function openSheet(id) { $(id).classList.add('open'); }
function closeSheets() { document.querySelectorAll('.sheet').forEach(s => s.classList.remove('open')); }
document.querySelectorAll('.closeSheet').forEach(b => b.addEventListener('click', closeSheets));

// ---------- 顶栏 / 当前 bot ----------
function currentBot() { return getBot(session?.botId) || getBot(DEFAULT_BOT_ID); }
function resolveProviderModel(bot) {
  const provider = cfg.providers.find(x => x.id === (bot?.providerId || cfg.defaultProvider)) || cfg.providers[0] || null;
  if (!provider) return { provider: null, model: '' };
  const model = bot?.model || (provider.id === cfg.defaultProvider ? cfg.defaultModel : '') || provider.models?.[0] || cfg.defaultModel || '';
  return { provider, model };
}
function refreshTopbar() {
  const bot = currentBot();
  $('#curBotName').textContent = bot ? bot.name : '小助手';
  const { provider, model } = resolveProviderModel(bot);
  $('#curModelLabel').textContent = provider ? (provider.name + ' · ' + (model || '未选模型')) : '未配置模型，点右上角 ⋯ 进设置';
  $('#onboard').classList.toggle('hidden', cfg.providers.length > 0);
}

// ---------- Markdown 轻量渲染（先转义再变换，防注入） ----------
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function mdInline(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function renderMarkdown(text) {
  const lines = String(text).split('\n');
  const out = [];
  let inCode = false; const codeBuf = [];
  const flushCode = () => { out.push('<pre class="code">' + escHtml(codeBuf.join('\n')) + '</pre>'); codeBuf.length = 0; };
  for (const line of lines) {
    if (/^```/.test(line.trim())) { if (inCode) { flushCode(); inCode = false; } else inCode = true; continue; }
    if (inCode) { codeBuf.push(line); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push('<div class="mdh">' + mdInline(escHtml(h[2])) + '</div>'); continue; }
    const li = line.match(/^\s*(?:[-*•]|\d+[.、])\s+(.*)$/);
    if (li) { out.push('<div class="mdli">• ' + mdInline(escHtml(li[1])) + '</div>'); continue; }
    if (!line.trim()) { out.push('<div class="mdsp"></div>'); continue; }
    out.push('<div>' + mdInline(escHtml(line)) + '</div>');
  }
  if (inCode) flushCode();
  return out.join('');
}

// ---------- 聊天渲染 ----------
function chipFor(name, argsText, output) {
  const c = el('div', 'toolchip');
  c.appendChild(el('span', 'tname', '🔧 ' + name));
  if (argsText) c.appendChild(el('span', '', ' ' + argsText));
  if (output !== undefined) { const p = el('pre', '', output); c.appendChild(p); }
  return c;
}
function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  if (!session) return;
  for (const m of session.messages) {
    if (m.role === 'user') box.appendChild(el('div', 'msg user', m.content));
    else if (m.role === 'assistant') {
      if (m.content) { const b = el('div', 'msg assistant'); b.innerHTML = renderMarkdown(m.content); box.appendChild(b); }
      for (const tc of m.tool_calls || []) box.appendChild(chipFor(tc.name, JSON.stringify(tc.args || {}).slice(0, 160)));
    } else if (m.role === 'tool') {
      box.appendChild(chipFor('结果', '', String(m.content).slice(0, 600)));
    }
  }
  scrollDown();
}

// ---------- 发送 ----------
async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || running || !session) return;
  const bot = currentBot();
  const { provider, model } = resolveProviderModel(bot);
  if (!provider || !provider.apiKey) {
    toast('还没配置可用的模型提供方：先去设置里填一个 API key。');
    openSheet('#settingsSheet');
    return;
  }
  if (!model) { toast('这个提供方还没选模型：去设置里给它填模型，或点「获取模型」。'); openSheet('#settingsSheet'); return; }
  input.value = '';
  $('#messages').appendChild(el('div', 'msg user', text));
  scrollDown();
  const ac = new AbortController();
  running = ac;
  $('#sendBtn').classList.add('hidden');
  $('#stopBtn').classList.remove('hidden');
  let liveBubble = null;
  const emit = (ev) => {
    if (ev.type === 'text') {
      if (!liveBubble) { liveBubble = el('div', 'msg assistant', ''); $('#messages').appendChild(liveBubble); }
      liveBubble.textContent += ev.delta; scrollDown();
    } else if (ev.type === 'tool_call') {
      liveBubble = null;
      $('#messages').appendChild(chipFor(ev.name, JSON.stringify(ev.args || {}).slice(0, 160)));
      scrollDown();
    } else if (ev.type === 'tool_result') {
      $('#messages').appendChild(chipFor(ev.name + ' 结果', '', String(ev.output).slice(0, 600)));
      scrollDown();
    } else if (ev.type === 'notice') {
      $('#messages').appendChild(el('div', 'msg notice', ev.text)); scrollDown();
    }
  };
  try {
    await runAgent({ cfg, provider, model, session, userText: text, emit, bot, signal: ac.signal });
  } catch (e) {
    $('#messages').appendChild(el('div', 'msg notice', '⚠️ ' + friendlyError(e, provider)));
  } finally {
    running = null;
    $('#sendBtn').classList.remove('hidden');
    $('#stopBtn').classList.add('hidden');
    saveSession(session);
    renderMessages();
    renderSessions();
    refreshTopbar();
  }
}
$('#sendBtn').addEventListener('click', send);
$('#stopBtn').addEventListener('click', () => running?.abort(new Error('用户停止了本轮')));
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

// ---------- 语音输入（录音 → 转写接口 → 填输入框） ----------
let mediaRecorder = null, audioChunks = [], recording = false;
function updateMicBtn() { const b = $('#micBtn'); b.textContent = recording ? '⏹' : '🎤'; b.classList.toggle('danger', recording); b.title = recording ? '结束录音' : '语音输入'; }
async function transcribe(blob) {
  const stt = cfg.stt || {};
  toast('转写中…');
  try {
    const fd = new FormData();
    fd.append('file', blob, 'audio.webm');
    fd.append('model', stt.model || 'whisper-1');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000);
    const res = await fetch((stt.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/audio/transcriptions', {
      method: 'POST', headers: { authorization: 'Bearer ' + stt.apiKey }, body: fd, signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error('模型接口 ' + res.status);
    const j = await res.json();
    const text = String(j.text || '').trim();
    if (!text) { toast('没听清，再试一次'); return; }
    const inp = $('#input');
    inp.value = (inp.value ? inp.value.replace(/\s+$/, '') + ' ' : '') + text;
    inp.focus();
  } catch (e) { toast('转写失败：' + friendlyError(e, { name: '转写接口' })); }
}
async function toggleRecord() {
  if (recording) { mediaRecorder?.stop(); return; }
  if (!cfg.stt?.apiKey) { toast('先在设置 → 语音输入里填转写接口的 key'); openSheet('#settingsSheet'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast('拿不到麦克风：请在系统设置里允许本应用录音后重试'); return; }
  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => { if (e.data?.size) audioChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach(tr => tr.stop());
    recording = false; updateMicBtn();
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (blob.size) transcribe(blob);
  };
  mediaRecorder.start();
  recording = true; updateMicBtn();
  toast('录音中，再点 ⏹ 结束');
}
$('#micBtn').addEventListener('click', toggleRecord);

// ---------- 会话抽屉 ----------
function sessionMatches(s, q) {
  if ((s.title || '').toLowerCase().includes(q)) return true;
  const bot = getBot(s.botId);
  if (bot && bot.name.toLowerCase().includes(q)) return true;
  const full = loadSession(s.id);
  if (!full) return false;
  return (full.messages || []).some(m => typeof m.content === 'string' && m.content.toLowerCase().includes(q));
}
function renderSessions() {
  const list = $('#sessList');
  list.innerHTML = '';
  const q = ($('#sessSearch').value || '').trim().toLowerCase();
  const idx = listSessionIndex().filter(s => !q || sessionMatches(s, q));
  if (!idx.length) list.appendChild(el('div', 'small', q ? '没有匹配的会话' : '还没有会话'));
  for (const s of idx) {
    const row = el('div', 'sess' + (session && s.id === session.id ? ' cur' : ''));
    row.appendChild(el('span', 't', s.title || '新会话'));
    const bot = getBot(s.botId);
    if (bot) row.appendChild(el('span', 'tag', bot.name));
    const ren = el('button', 'ghost', '✏️');
    ren.title = '会话改名';
    ren.addEventListener('click', (e) => {
      e.stopPropagation();
      const sObj = loadSession(s.id);
      if (!sObj) return;
      const name = prompt('会话改名：', sObj.title || s.title || '');
      if (name === null) return;
      sObj.title = name.trim();
      saveSession(sObj);
      if (session && session.id === s.id) session = sObj;
      renderSessions();
    });
    row.appendChild(ren);
    const del = el('button', 'ghost', '🗑');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('删除这个会话？')) return;
      deleteSession(s.id);
      if (session && session.id === s.id) session = ensureSession();
      renderSessions(); renderMessages(); refreshTopbar();
    });
    row.appendChild(del);
    row.addEventListener('click', () => {
      session = loadSession(s.id) || session;
      closeDrawer(); renderSessions(); renderMessages(); refreshTopbar();
    });
    list.appendChild(row);
  }
}
function ensureSession() {
  const idx = listSessionIndex();
  if (idx.length) { const s = loadSession(idx[0].id); if (s) return s; }
  return createSession(DEFAULT_BOT_ID);
}
function newSession(botId) {
  session = createSession(botId || currentBot()?.id || DEFAULT_BOT_ID);
  saveSession(session);
  renderSessions(); renderMessages(); refreshTopbar();
}
$('#sessSearch').addEventListener('input', renderSessions);
function openDrawer() { $('#drawer').classList.add('open'); $('#scrim').classList.remove('hidden'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.add('hidden'); }
$('#menuBtn').addEventListener('click', openDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#drawerNew').addEventListener('click', () => {
  if (session && session.messages.length === 0) { toast('当前已经是空白新会话'); closeDrawer(); return; }
  newSession(); closeDrawer();
});

// ---------- 弹出菜单（bot 切换 / ＋ / ⋯ 共用一个元素） ----------
function hideMenu() { $('#botMenu').classList.add('hidden'); }
function showMenu(kind, build, style) {
  const menu = $('#botMenu');
  menu.innerHTML = '';
  menu.dataset.kind = kind;
  build(menu);
  menu.style.left = style.left || 'auto';
  menu.style.right = style.right || 'auto';
  menu.style.top = style.top || '60px';
  menu.classList.remove('hidden');
}
function menuOpen(kind) {
  const menu = $('#botMenu');
  return !menu.classList.contains('hidden') && menu.dataset.kind === kind;
}
function menuItem(menu, label, fn) {
  const btn = el('button', '', label);
  btn.addEventListener('click', () => { hideMenu(); fn(); });
  menu.appendChild(btn);
  return btn;
}
// 点菜单和三个入口按钮以外的地方才关菜单（旧版漏排除了 ⋯ 和 ＋，菜单点开瞬间被自己关掉）
document.addEventListener('click', (e) => {
  const menu = $('#botMenu');
  if (menu.classList.contains('hidden')) return;
  if (menu.contains(e.target) || $('#botSwitch').contains(e.target) || $('#moreBtn').contains(e.target) || $('#newBtn').contains(e.target)) return;
  hideMenu();
});

$('#botSwitch').addEventListener('click', () => {
  if (menuOpen('bot')) { hideMenu(); return; }
  const r = $('#botSwitch').getBoundingClientRect();
  showMenu('bot', (m) => {
    for (const b of listBots()) {
      menuItem(m, (b.enabled ? '' : '（停用）') + b.name + (session && session.botId === b.id ? ' ✓' : ''), () => {
        if (!b.enabled) { toast('这个 bot 已停用，先在 Bots 页启用。'); return; }
        if (session && session.botId === b.id) return;
        if (session && session.messages.length === 0) { session.botId = b.id; saveSession(session); }
        else newSession(b.id);
        renderSessions(); renderMessages(); refreshTopbar();
      });
    }
    menuItem(m, '✏️ 编辑当前 bot（改名/人设）', () => { renderBots(); openSheet('#botsSheet'); fillBotForm(currentBot()); });
  }, { left: Math.min(r.left, innerWidth - 200) + 'px', top: (r.bottom + 6) + 'px' });
});

// ＋：弹选择菜单——选 bot 开新会话，或去添加新 bot（旧版是闷头新建，看不见反馈）
$('#newBtn').addEventListener('click', () => {
  if (menuOpen('new')) { hideMenu(); return; }
  const r = $('#newBtn').getBoundingClientRect();
  showMenu('new', (m) => {
    const label = el('div', 'small', '新建会话，选一个 bot：');
    label.style.padding = '6px 10px 2px';
    m.appendChild(label);
    for (const b of listBots().filter(x => x.enabled)) {
      menuItem(m, '💬 用「' + b.name + '」开新会话', () => {
        if (session && session.botId === b.id && session.messages.length === 0) { toast('当前已经是空白新会话了'); return; }
        newSession(b.id);
        toast('已新建会话（' + b.name + '）');
      });
    }
    menuItem(m, '🤖 添加新 bot…', () => { renderBots(); openSheet('#botsSheet'); });
  }, { right: '10px', top: (r.bottom + 6) + 'px' });
});

// ---------- ⋯ 菜单 ----------
$('#moreBtn').addEventListener('click', () => {
  if (menuOpen('more')) { hideMenu(); return; }
  showMenu('more', (m) => {
    menuItem(m, '⚙ 设置 · 模型提供方', () => openSheet('#settingsSheet'));
    menuItem(m, '🤖 团队 · Bots 与记忆', () => { renderBots(); openSheet('#botsSheet'); });
    menuItem(m, '🧩 技能 · Skills', () => { renderSkills(); openSheet('#skillsSheet'); });
  }, { right: '10px', top: 'calc(60px + env(safe-area-inset-top))' });
});
$('#onboardGo').addEventListener('click', () => openSheet('#settingsSheet'));

// ---------- 设置：提供方 ----------
let editingProviderId = null;
function providerById(id) { return cfg.providers.find(p => p.id === id); }
function renderProviders() {
  const list = $('#providerList');
  list.innerHTML = '';
  if (!cfg.providers.length) list.appendChild(el('div', 'small', '还没有提供方，用下方表单添加第一个。'));
  for (const p of cfg.providers) {
    const item = el('div', 'item');
    const head = el('div', 'head');
    head.appendChild(el('b', '', p.name));
    if (p.id === cfg.defaultProvider) head.appendChild(el('span', 'tag', '默认'));
    head.appendChild(el('span', 'tag off', p.type === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'));
    item.appendChild(head);
    item.appendChild(el('div', 'small', p.baseURL + ' · 模型：' + (p.models?.join(', ') || '（无）') + ' · key：' + (p.apiKey ? '已填' : '未填')));
    if (p.apiKey && p.keyUpdatedAt) {
      const days = Math.floor((Date.now() - p.keyUpdatedAt) / 86400000);
      let note = 'key 是 ' + days + ' 天前填的';
      if (/exaone\.ai/.test(p.baseURL || '')) {
        const left = 30 - days;
        note += left > 0 ? '；EXAONE 的 key 30 天有效，约剩 ' + left + ' 天' : '；⚠️ EXAONE 的 key 可能已过期（30 天有效），聊不动时先重新签发';
        if (left <= 7 && left > 0) note += '，⚠️ 快到期了，记得提前重新签发';
      }
      item.appendChild(el('div', 'small', note));
    }
    const row = el('div', 'rowbtns');
    const edit = el('button', '', '编辑');
    edit.addEventListener('click', () => fillProviderForm(p));
    const def = el('button', '', '设为默认');
    def.addEventListener('click', () => { cfg.defaultProvider = p.id; cfg.defaultModel = p.models?.[0] || ''; saveConfig(cfg); renderProviders(); renderGlobalDefaults(); refreshTopbar(); });
    const del = el('button', 'danger', '删除');
    del.addEventListener('click', () => {
      if (!confirm('删除提供方「' + p.name + '」？')) return;
      cfg.providers = cfg.providers.filter(x => x.id !== p.id);
      if (cfg.defaultProvider === p.id) { cfg.defaultProvider = cfg.providers[0]?.id || ''; cfg.defaultModel = cfg.providers[0]?.models?.[0] || ''; }
      saveConfig(cfg); renderProviders(); renderGlobalDefaults(); refreshTopbar();
    });
    row.append(edit, def, del);
    item.appendChild(row);
    list.appendChild(item);
  }
  refreshStorageInfo();
}
function fillProviderForm(p) {
  editingProviderId = p.id;
  $('#provFormTitle').textContent = '编辑提供方：' + p.name;
  $('#pfName').value = p.name; $('#pfType').value = p.type; $('#pfBase').value = p.baseURL;
  $('#pfKey').value = p.apiKey || ''; $('#pfModels').value = (p.models || []).join(', ');
  $('#pfCancel').classList.remove('hidden');
  $('#pfMsg').textContent = '';
}
function resetProviderForm() {
  editingProviderId = null;
  $('#provFormTitle').textContent = '添加提供方';
  $('#pfName').value = ''; $('#pfBase').value = ''; $('#pfKey').value = ''; $('#pfModels').value = '';
  $('#pfCancel').classList.add('hidden');
}
$('#pfPreset').addEventListener('change', () => {
  const pr = PRESETS[Number($('#pfPreset').value)];
  if (!pr) return;
  $('#pfName').value = pr.name.replace(/（.*?）/, '');
  $('#pfType').value = pr.type;
  $('#pfBase').value = pr.baseURL;
  $('#pfModels').value = pr.models.join(', ');
  $('#pfKeyHint').textContent = pr.keyHint || '';
});
$('#pfFetchModels').addEventListener('click', async () => {
  const tmp = { type: $('#pfType').value, baseURL: $('#pfBase').value.trim(), apiKey: $('#pfKey').value.trim(), models: [] };
  $('#pfMsg').textContent = '正在拉取模型列表…';
  try {
    const models = await listModels(tmp);
    if (!models.length) { $('#pfMsg').textContent = '接口连通，但没返回模型列表（Anthropic 类型请手动填模型名）。'; return; }
    $('#pfModels').value = models.join(', ');
    $('#pfMsg').textContent = '✅ 连通成功，共 ' + models.length + ' 个模型，已填入上方。';
  } catch (e) { $('#pfMsg').textContent = '❌ ' + friendlyError(e, tmp); }
});
$('#pfSave').addEventListener('click', () => {
  const name = $('#pfName').value.trim();
  const baseURL = $('#pfBase').value.trim();
  if (!name) { $('#pfMsg').textContent = '名称不能为空'; return; }
  if (!baseURL) { $('#pfMsg').textContent = '接口地址不能为空'; return; }
  const models = $('#pfModels').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const data = { name, type: $('#pfType').value, baseURL, apiKey: $('#pfKey').value.trim(), models };
  const prev = editingProviderId ? providerById(editingProviderId) : null;
  if (data.apiKey && data.apiKey !== prev?.apiKey) data.keyUpdatedAt = Date.now();
  else if (prev?.keyUpdatedAt) data.keyUpdatedAt = prev.keyUpdatedAt;
  if (editingProviderId) Object.assign(providerById(editingProviderId), data);
  else {
    const p = { id: uid(), ...data };
    cfg.providers.push(p);
    if (cfg.providers.length === 1) { cfg.defaultProvider = p.id; cfg.defaultModel = models[0] || ''; }
  }
  saveConfig(cfg);
  resetProviderForm();
  renderProviders(); renderGlobalDefaults(); refreshTopbar();
  toast('提供方已保存');
});
$('#pfCancel').addEventListener('click', resetProviderForm);

function renderGlobalDefaults() {
  const dp = $('#defProvider');
  dp.innerHTML = '';
  for (const p of cfg.providers) { const o = el('option', '', p.name); o.value = p.id; dp.appendChild(o); }
  dp.value = cfg.defaultProvider || '';
  const dm = $('#defModel');
  dm.innerHTML = '';
  const prov = providerById(cfg.defaultProvider) || cfg.providers[0];
  for (const m of prov?.models || []) { const o = el('option', '', m); o.value = m; dm.appendChild(o); }
  dm.value = cfg.defaultModel || '';
  $('#maxSteps').value = cfg.maxSteps || 12;
  $('#sttBase').value = cfg.stt?.baseURL || '';
  $('#sttKey').value = cfg.stt?.apiKey || '';
  $('#sttModel').value = cfg.stt?.model || '';
  renderBotProviderOptions();
}
for (const [sel, key] of [['#sttBase', 'baseURL'], ['#sttKey', 'apiKey'], ['#sttModel', 'model']]) {
  $(sel).addEventListener('change', () => { cfg.stt = cfg.stt || {}; cfg.stt[key] = $(sel).value.trim(); saveConfig(cfg); });
}
$('#defProvider').addEventListener('change', () => {
  cfg.defaultProvider = $('#defProvider').value;
  const prov = providerById(cfg.defaultProvider);
  cfg.defaultModel = prov?.models?.[0] || '';
  saveConfig(cfg); renderProviders(); renderGlobalDefaults(); refreshTopbar();
});
$('#defModel').addEventListener('change', () => { cfg.defaultModel = $('#defModel').value; saveConfig(cfg); refreshTopbar(); });
$('#maxSteps').addEventListener('change', () => {
  const n = Math.min(Math.max(Number($('#maxSteps').value) || 12, 1), 40);
  cfg.maxSteps = n; $('#maxSteps').value = n; saveConfig(cfg);
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async () => {
  const f = $('#importFile').files?.[0];
  $('#importFile').value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!confirm('导入会覆盖当前全部数据（配置、会话、记忆、bot、技能），确定继续？')) return;
    const n = importAll(data);
    alert('导入成功（' + n + ' 项数据），应用将重新加载。');
    location.reload();
  } catch (e) { alert('导入失败：' + e.message); }
});
$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(exportAll(), null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'agent-shell-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

// ---------- 检查更新（查 GitHub Releases） ----------
let updateUrl = '';
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
async function checkUpdate(manual) {
  const msg = $('#updateMsg'); const go = $('#updateGo');
  if (manual) { msg.textContent = '正在检查…'; go.classList.add('hidden'); }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(UPDATE_API, { headers: { accept: 'application/vnd.github+json' }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    if (latest && cmpVer(latest, APP_VERSION) > 0) {
      updateUrl = j.html_url || '';
      msg.textContent = '发现新版 v' + latest + '（当前 v' + APP_VERSION + '），点「去下载」打开下载页，装好直接覆盖升级。';
      go.classList.remove('hidden');
    } else {
      msg.textContent = '当前版本 v' + APP_VERSION + (manual ? '，已是最新版。' : '');
    }
  } catch (e) {
    if (manual) msg.textContent = '检查失败（当前 v' + APP_VERSION + '）：网络不通或 GitHub 暂时不可用，稍后再试。';
  }
}
$('#updateBtn').addEventListener('click', () => checkUpdate(true));
$('#updateGo').addEventListener('click', () => { if (updateUrl) window.open(updateUrl, '_blank'); });

function refreshStorageInfo() {
  const u = storageUsage();
  const kb = Math.round(u.chars / 1024);
  const pct = Math.min(100, Math.round((u.chars / u.quotaChars) * 100));
  let text = '本机数据约 ' + kb + ' KB（上限估算 5 MB，已用约 ' + pct + '%）。';
  if (pct >= 80) text += ' ⚠️ 快满了：建议导出备份后删掉不用的旧会话。';
  $('#storageInfo').textContent = text;
}

// ---------- Bots 页 ----------
let editingBotId = null;
function renderBotProviderOptions() {
  const sel = $('#bfProvider');
  const cur = sel.value;
  sel.innerHTML = '';
  const o0 = el('option', '', '（用全局默认）'); o0.value = ''; sel.appendChild(o0);
  for (const p of cfg.providers) { const o = el('option', '', p.name); o.value = p.id; sel.appendChild(o); }
  sel.value = cur || '';
  const mb = $('#memBot');
  const curM = mb.value;
  mb.innerHTML = '';
  for (const b of listBots()) { const o = el('option', '', b.name); o.value = b.id; mb.appendChild(o); }
  mb.value = curM || DEFAULT_BOT_ID;
  loadMemoryEditor();
}
function fillBotForm(b) {
  if (!b) return;
  editingBotId = b.id;
  $('#botFormTitle').textContent = '编辑 bot：' + b.name;
  $('#bfName').value = b.name; $('#bfDesc').value = b.description || ''; $('#bfPersona').value = b.persona || '';
  renderBotProviderOptions();
  $('#bfProvider').value = b.providerId || ''; $('#bfModel').value = b.model || ''; $('#bfEnabled').checked = b.enabled !== false;
  $('#bfCancel').classList.remove('hidden');
}
function renderBots() {
  const list = $('#botList');
  list.innerHTML = '';
  for (const b of listBots()) {
    const item = el('div', 'item');
    const head = el('div', 'head');
    head.appendChild(el('b', '', b.name));
    if (b.id === DEFAULT_BOT_ID) head.appendChild(el('span', 'tag', '默认'));
    if (!b.enabled) head.appendChild(el('span', 'tag off', '已停用'));
    item.appendChild(head);
    item.appendChild(el('div', 'small', (b.description || '') + (b.model ? ' · 模型：' + b.model : '')));
    const row = el('div', 'rowbtns');
    const edit = el('button', '', '编辑');
    edit.addEventListener('click', () => fillBotForm(b));
    row.appendChild(edit);
    if (b.id !== DEFAULT_BOT_ID) {
      const del = el('button', 'danger', '删除');
      del.addEventListener('click', () => { if (confirm('删除 bot「' + b.name + '」？它的记忆会保留在数据里。')) { try { deleteBot(b.id); renderBots(); renderBotProviderOptions(); refreshTopbar(); } catch (e) { alert(e.message); } } });
      row.appendChild(del);
    }
    item.appendChild(row);
    list.appendChild(item);
  }
  renderBotProviderOptions();
}
$('#bfSave').addEventListener('click', () => {
  const data = {
    name: $('#bfName').value, description: $('#bfDesc').value, persona: $('#bfPersona').value,
    providerId: $('#bfProvider').value, model: $('#bfModel').value, enabled: $('#bfEnabled').checked,
  };
  try {
    if (editingBotId) updateBot(editingBotId, data); else createBot(data);
    editingBotId = null;
    $('#botFormTitle').textContent = '添加 bot';
    $('#bfName').value = ''; $('#bfDesc').value = ''; $('#bfPersona').value = ''; $('#bfModel').value = '';
    $('#bfCancel').classList.add('hidden');
    renderBots(); refreshTopbar();
  } catch (e) { alert(e.message); }
});
$('#bfCancel').addEventListener('click', () => { editingBotId = null; $('#botFormTitle').textContent = '添加 bot'; $('#bfCancel').classList.add('hidden'); });
function loadMemoryEditor() {
  const id = $('#memBot').value || DEFAULT_BOT_ID;
  const raw = readDoc('memory.' + id, '');
  $('#memText').value = typeof raw === 'string' ? raw : (loadBotMemory(id) || '');
}
$('#memBot').addEventListener('change', loadMemoryEditor);
$('#memSave').addEventListener('click', () => { setBotMemory($('#memBot').value || DEFAULT_BOT_ID, $('#memText').value); toast('记忆已保存'); });

// ---------- 技能页 ----------
let editingSkillDir = null;
function renderSkills() {
  const list = $('#skillList');
  list.innerHTML = '';
  for (const s of listSkills()) {
    const item = el('div', 'item');
    const head = el('div', 'head');
    head.appendChild(el('b', '', s.name));
    if (!s.enabled) head.appendChild(el('span', 'tag off', '已停用'));
    item.appendChild(head);
    item.appendChild(el('div', 'small', (s.description || '') + (s.triggers?.length ? ' · 触发词：' + s.triggers.join('、') : '')));
    const row = el('div', 'rowbtns');
    const edit = el('button', '', '编辑');
    edit.addEventListener('click', () => {
      editingSkillDir = s.dirName;
      $('#skillFormTitle').textContent = '编辑技能：' + s.name;
      $('#sfName').value = s.name; $('#sfDesc').value = s.description || ''; $('#sfTriggers').value = (s.triggers || []).join(', ');
      $('#sfBody').value = s.body || ''; $('#sfEnabled').checked = s.enabled !== false;
      $('#sfCancel').classList.remove('hidden');
    });
    const del = el('button', 'danger', '删除');
    del.addEventListener('click', () => { if (confirm('删除技能「' + s.name + '」？')) { deleteSkill(s.dirName); renderSkills(); } });
    row.append(edit, del);
    item.appendChild(row);
    list.appendChild(item);
  }
}
$('#sfSave').addEventListener('click', () => {
  const data = { name: $('#sfName').value, description: $('#sfDesc').value, triggers: $('#sfTriggers').value, body: $('#sfBody').value, enabled: $('#sfEnabled').checked };
  try {
    if (editingSkillDir) updateSkill(editingSkillDir, data); else createSkill(data);
    editingSkillDir = null;
    $('#skillFormTitle').textContent = '添加技能';
    $('#sfName').value = ''; $('#sfDesc').value = ''; $('#sfTriggers').value = ''; $('#sfBody').value = '';
    $('#sfCancel').classList.add('hidden');
    renderSkills();
  } catch (e) { alert(e.message); }
});
$('#sfCancel').addEventListener('click', () => { editingSkillDir = null; $('#skillFormTitle').textContent = '添加技能'; $('#sfCancel').classList.add('hidden'); });

// ---------- 初始化 ----------
(function init() {
  const presetSel = $('#pfPreset');
  PRESETS.forEach((p, i) => { const o = el('option', '', p.name); o.value = i; presetSel.appendChild(o); });
  presetSel.dispatchEvent(new Event('change'));
  listBots(); listSkills(); // 首次播种
  session = ensureSession();
  renderProviders();
  renderGlobalDefaults();
  renderBots();
  renderSkills();
  renderSessions();
  renderMessages();
  refreshTopbar();
  $('#updateMsg').textContent = '当前版本 v' + APP_VERSION;
  checkUpdate(false);
})();
