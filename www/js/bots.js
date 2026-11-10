// Bot 档案（独立版）：名册存本机；记忆按 bot 分开存，读取取尾部 8000 字（新记忆在末尾）。
import { readDoc, writeDoc, uid } from './db.js';

export const DEFAULT_BOT_ID = 'default';

const DEFAULT_BOT = {
  id: DEFAULT_BOT_ID, name: '小助手', description: '默认的个人助手，什么都先问它',
  persona: '', providerId: '', model: '', enabled: true, builtin: true,
  createdAt: '2026-11-09T00:00:00.000Z',
};
const SEED_BOT = {
  name: '研究员', description: '查资料、做调研、核实出处',
  persona: '你是一名严谨的研究员：先查证再下结论，重要事实给出信息来源，区分事实和推测，不确定的明说不确定。',
  providerId: '', model: '', enabled: true,
};

export function loadBots() {
  const j = readDoc('bots', null);
  if (!j || !Array.isArray(j.bots)) {
    const bots = [{ ...DEFAULT_BOT }, { id: uid(), ...SEED_BOT, createdAt: new Date().toISOString() }];
    writeDoc('bots', { bots });
    return bots;
  }
  if (!j.bots.some(b => b.id === DEFAULT_BOT_ID)) {
    const bots = [{ ...DEFAULT_BOT }, ...j.bots];
    writeDoc('bots', { bots });
    return bots;
  }
  return j.bots;
}
function saveBots(bots) { writeDoc('bots', { bots }); }

export function listBots() { return loadBots(); }
export function getBot(id) { return id ? loadBots().find(b => b.id === id) || null : null; }
export function findBot(nameOrId) {
  const key = String(nameOrId || '').trim();
  if (!key) return null;
  const bots = loadBots();
  return bots.find(b => b.id === key) || bots.find(b => b.name === key) || null;
}

function cleanBotInput(input, cur = {}) {
  const name = input.name !== undefined ? String(input.name).trim().slice(0, 24) : (cur.name || '');
  if (!name) throw new Error('bot 名字不能为空');
  return {
    name,
    description: input.description !== undefined ? String(input.description).trim().slice(0, 80) : (cur.description || ''),
    persona: input.persona !== undefined ? String(input.persona).slice(0, 4000) : (cur.persona || ''),
    providerId: input.providerId !== undefined ? String(input.providerId) : (cur.providerId || ''),
    model: input.model !== undefined ? String(input.model).trim() : (cur.model || ''),
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : (cur.enabled !== false),
  };
}

export function createBot(input) {
  const fields = cleanBotInput(input);
  const bots = loadBots();
  if (bots.some(b => b.name === fields.name)) throw new Error('已有同名 bot：' + fields.name);
  const bot = { id: uid(), ...fields, createdAt: new Date().toISOString() };
  bots.push(bot);
  saveBots(bots);
  return bot;
}

export function updateBot(id, input) {
  const bots = loadBots();
  const bot = bots.find(b => b.id === id);
  if (!bot) throw new Error('bot 不存在');
  const fields = cleanBotInput(input, bot);
  if (bots.some(b => b.id !== id && b.name === fields.name)) throw new Error('已有同名 bot：' + fields.name);
  Object.assign(bot, fields);
  saveBots(bots);
  return bot;
}

export function deleteBot(id) {
  if (id === DEFAULT_BOT_ID) throw new Error('默认 bot 不能删（可以改它的名字和人设）');
  saveBots(loadBots().filter(b => b.id !== id));
}

// ---------- 按 bot 分开的长期记忆 ----------
export function loadBotMemory(botId) {
  const text = readDoc('memory.' + (botId || DEFAULT_BOT_ID), '');
  return typeof text === 'string' ? text.slice(-8000) : '';
}
export function appendBotMemory(botId, text) {
  const id = botId || DEFAULT_BOT_ID;
  let cur = readDoc('memory.' + id, '');
  if (typeof cur !== 'string') cur = '';
  if (!cur) { const bot = getBot(id); cur = '# ' + (bot?.name || 'bot') + ' 的长期记忆\n'; }
  const line = '\n- [' + new Date().toISOString().slice(0, 10) + '] ' + String(text).replace(/\s+/g, ' ').slice(0, 500);
  writeDoc('memory.' + id, cur + line);
  return '已记入长期记忆。';
}
export function setBotMemory(botId, text) { writeDoc('memory.' + (botId || DEFAULT_BOT_ID), String(text)); }

// 给系统提示的团队名册（不含自己、只列启用的）
export function rosterText(selfId) {
  const others = loadBots().filter(b => b.enabled && b.id !== selfId);
  if (!others.length) return '';
  const lines = others.map(b => '- ' + b.name + '：' + (b.description || '（无专长描述）'));
  return '你的团队成员（用 delegate_task 工具把子任务交给他们，参数 bot 填名字）：\n' + lines.join('\n');
}
