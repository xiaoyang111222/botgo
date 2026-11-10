// 存储层：全部数据只存本机 localStorage，不经过任何服务器。
// 文档按 key 分开存 JSON：config / bots / sessions / sessions.index / memory.<botId> / skills
const PREFIX = 'ags1.';

export function readDoc(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch { return fallback; }
}

export function writeDoc(key, value) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}

export function removeDoc(key) {
  localStorage.removeItem(PREFIX + key);
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------- 配置 ----------
export function loadConfig() {
  const cfg = readDoc('config', null);
  if (cfg && Array.isArray(cfg.providers)) return { maxSteps: 12, ...cfg };
  return { providers: [], defaultProvider: '', defaultModel: '', maxSteps: 12 };
}
export function saveConfig(cfg) { writeDoc('config', cfg); }

// ---------- 会话 ----------
// 索引：[{id, title, botId, updatedAt}]；正文单独存 sessions.<id> = {id, botId, messages}
export function listSessionIndex() { return readDoc('sessions.index', []); }
function saveSessionIndex(idx) { writeDoc('sessions.index', idx); }

export function createSession(botId) {
  const s = { id: uid(), botId: botId || 'default', title: '', messages: [] };
  writeDoc('sessions.' + s.id, s);
  const idx = listSessionIndex();
  idx.unshift({ id: s.id, title: '', botId: s.botId, updatedAt: Date.now() });
  saveSessionIndex(idx);
  return s;
}

export function loadSession(id) { return readDoc('sessions.' + id, null); }

export function saveSession(s) {
  writeDoc('sessions.' + s.id, s);
  const idx = listSessionIndex();
  const ent = idx.find(e => e.id === s.id);
  const title = s.title || (s.messages.find(m => m.role === 'user')?.content || '').slice(0, 30) || '新会话';
  if (ent) { ent.title = title; ent.botId = s.botId; ent.updatedAt = Date.now(); }
  else idx.unshift({ id: s.id, title, botId: s.botId, updatedAt: Date.now() });
  idx.sort((a, b) => b.updatedAt - a.updatedAt);
  saveSessionIndex(idx);
}

export function deleteSession(id) {
  removeDoc('sessions.' + id);
  saveSessionIndex(listSessionIndex().filter(e => e.id !== id));
}

// ---------- 导入全部数据（覆盖式恢复：先清掉现有 ags1.* 再写入） ----------
export function importAll(data) {
  if (!data || typeof data !== 'object') throw new Error('备份文件格式不对');
  if (!data.config || !Array.isArray(data.config.providers)) throw new Error('备份里缺少提供方配置，不像 Agent Shell 的备份文件');
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) keys.push(k); }
  for (const k of keys) localStorage.removeItem(k);
  let n = 0;
  for (const [k, v] of Object.entries(data)) { writeDoc(k, v); n++; }
  return n;
}

// ---------- 存储用量（localStorage 按字符计，中文约 1 字符≈2 字节，上限按保守的 5M 字符估） ----------
export function storageUsage() {
  let chars = 0, keys = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) { chars += k.length + (localStorage.getItem(k) || '').length; keys++; }
  }
  return { chars, keys, quotaChars: 5 * 1024 * 1024 };
}

// ---------- 导出全部数据（备份/迁移） ----------
export function exportAll() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) { try { out[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k)); } catch {} }
  }
  return out;
}
