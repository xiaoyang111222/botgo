// 内置工具（独立版）：手机本地能成立的工具集——抓网页、长期记忆、技能、时间。
// 没有命令执行和文件系统（手机 WebView 里没有这两样东西，不假装有）。
import { appendBotMemory } from './bots.js';
import { findSkill, listSkills } from './skills.js';

const CAP = 8000;
const clip = (s) => { s = String(s ?? ''); return s.length > CAP ? s.slice(0, CAP) + '\n…（已截断，共 ' + s.length + ' 字）' : s; };

// ---------- web_fetch 的内网拦截（字面 IP 校验，与服务器版同一套规则） ----------
// 说明：浏览器 fetch 自动跟随重定向、也不暴露 DNS 解析结果，所以这里只能拦「网址里直接写内网 IP」
// 和解析后主机名一眼可辨的情况；服务器版的逐跳 DNS 校验在手机上做不到，就如实做到这一层。
function blockedV4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function parseV6(input) {
  let ip = String(input).split('%')[0];
  const m = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const o = m[2].split('.').map(Number); ip = m[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16); }
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  let groups;
  if (parts.length === 1) groups = head;
  else {
    const tail = parts[1] ? parts[1].split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const nums = groups.map(g => parseInt(g, 16));
  return nums.some(n => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : nums;
}
const v4From = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
function blockedV6(ip) {
  const g = parseV6(ip);
  if (!g) return true;
  if (g.every(x => x === 0)) return true;
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blockedV4(v4From(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return blockedV4(v4From(g[6], g[7]));
  if (g[0] === 0x2002) return blockedV4(v4From(g[1], g[2]));
  if (g[0] === 0x2001 && g[1] === 0) return true;
  return false;
}
function ipFamily(ip) {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) && ip.split('.').every(o => Number(o) >= 0 && Number(o) <= 255)) return 4;
  if (ip.includes(':') && parseV6(ip)) return 6;
  return 0;
}
export function isBlockedIp(ip) {
  const fam = ipFamily(String(ip));
  if (fam === 4) return blockedV4(String(ip).split('.').map(Number));
  if (fam === 6) return blockedV6(String(ip));
  return true;
}

const FETCH_MAX_BYTES = 512 * 1024;
export async function fetchPublicPage(urlStr, { maxBytes = FETCH_MAX_BYTES, timeoutMs = 20000 } = {}) {
  const u = new URL(urlStr);
  if (!/^https?:$/.test(u.protocol)) throw new Error('只允许 http/https');
  if (u.username || u.password) throw new Error('不支持带账号密码的地址');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (ipFamily(host) && isBlockedIp(host)) throw new Error('目标地址 ' + host + ' 属于内网/回环/链路本地/元数据地址，已拦截');
  if (host === 'localhost') throw new Error('目标地址 localhost 已拦截');
  const res = await fetch(u.href, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' } });
  const reader = res.body?.getReader();
  const chunks = []; let total = 0, truncated = false;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > maxBytes) { chunks.push(value.subarray(0, maxBytes - total)); truncated = true; try { await reader.cancel(); } catch {} break; }
      chunks.push(value); total += value.length;
    }
  }
  const body = new TextDecoder().decode(concatBytes(chunks));
  return { status: res.status, body, truncated };
}
function concatBytes(chunks) {
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export const TOOLS = [
  {
    name: 'web_fetch',
    description: '抓取一个网页的正文文本（http/https）。',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async run({ url }) {
      const res = await fetchPublicPage(String(url));
      if (res.status < 200 || res.status >= 300) throw new Error('抓取失败 ' + res.status);
      const text = res.body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return clip(text) + (res.truncated ? '\n（页面超过 ' + (FETCH_MAX_BYTES / 1024) + 'KB，已截断）' : '');
    },
  },
  {
    name: 'memory_save',
    description: '把一条值得长期记住的事实（用户偏好、决定、重要信息）写入长期记忆。',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async run({ text }, ctx) { return appendBotMemory(ctx?.botId || 'default', text); },
  },
  {
    name: 'use_skill',
    description: '读取一个技能（Skill）的完整说明。系统提示的「可用技能」目录里列了技能名与用途；当用户需求匹配某个技能时，先调用本工具拿到说明，再按说明执行。参数 name 传技能名。',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '技能名' } }, required: ['name'] },
    async run({ name }) {
      const s = findSkill(name);
      if (!s) {
        const all = listSkills().filter(x => x.enabled).map(x => x.name).join('、');
        return '没找到技能「' + name + '」。当前可用技能：' + (all || '（无）');
      }
      if (!s.enabled) return '技能「' + s.name + '」已停用。';
      return '技能「' + s.name + '」说明：\n\n' + s.body;
    },
  },
  {
    name: 'get_time',
    description: '获取当前日期时间（设备时区）。',
    parameters: { type: 'object', properties: {} },
    async run() { return new Date().toString(); },
  },
];

export function toolByName(name) { return TOOLS.find(t => t.name === name); }
export function toolSchemas() { return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })); }
