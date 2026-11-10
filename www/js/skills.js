// Skill（独立版）：技能 = 一段结构化的操作说明（名字/用途/触发词/正文），存本机。
// 模型通过系统提示的技能目录知道有哪些技能，用 use_skill 工具按需读全文；
// 用户消息命中触发词时，agent 自动把正文注入本轮上下文。
import { readDoc, writeDoc, uid } from './db.js';

export function parseSkillMd(raw) {
  const text = String(raw || '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim(), hasFrontmatter: false };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim(), hasFrontmatter: true };
}

export function buildSkillMd({ name, description, triggers }, body) {
  const t = Array.isArray(triggers) ? triggers.join(', ') : String(triggers || '');
  return '---\nname: ' + name + '\ndescription: ' + (description || '') + '\ntriggers: ' + t + '\n---\n\n' + String(body || '').trim() + '\n';
}

const SEED = {
  dirName: 'web-summary',
  name: '网页总结',
  description: '抓取一个网页并给出三句话以内的要点总结',
  triggers: ['总结网页', '读一下这个网页', '网页总结'],
  body: '# 网页总结\n\n当用户给你一个网址并希望了解内容时：\n\n1. 用 web_fetch 工具抓取该网页正文。\n2. 用三句话以内总结核心内容：第一句说这页讲什么，第二句说关键信息或结论，第三句说值得注意的点（时效、立场、广告等）。\n3. 如果抓取失败，如实告诉用户失败原因，不要编造网页内容。\n4. 总结用中文，附上原链接。',
  enabled: true,
};

export function listSkills() {
  const j = readDoc('skills', null);
  if (!j || !Array.isArray(j.skills)) {
    writeDoc('skills', { skills: [{ ...SEED }] });
    return [{ ...SEED }];
  }
  return j.skills;
}
function saveSkills(skills) { writeDoc('skills', { skills }); }

export function findSkill(nameOrDir) {
  const key = String(nameOrDir || '').trim();
  if (!key) return null;
  return listSkills().find(s => s.dirName === key || s.name === key) || null;
}

export function createSkill(input) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('技能名不能为空');
  if (!String(input.body || '').trim()) throw new Error('技能正文不能为空');
  const skills = listSkills();
  let dirName = 'skill-' + uid().slice(0, 8);
  const s = {
    dirName,
    name,
    description: String(input.description || ''),
    triggers: Array.isArray(input.triggers) ? input.triggers : String(input.triggers || '').split(/[,，]/).map(x => x.trim()).filter(Boolean),
    body: String(input.body),
    enabled: input.enabled !== false,
  };
  skills.push(s);
  saveSkills(skills);
  return s;
}

export function updateSkill(dirName, input) {
  const skills = listSkills();
  const s = skills.find(x => x.dirName === dirName);
  if (!s) throw new Error('技能不存在');
  if (input.name !== undefined) s.name = String(input.name).trim() || s.name;
  if (input.description !== undefined) s.description = String(input.description);
  if (input.triggers !== undefined) s.triggers = Array.isArray(input.triggers) ? input.triggers : String(input.triggers).split(/[,，]/).map(x => x.trim()).filter(Boolean);
  if (input.body !== undefined) s.body = String(input.body);
  if (input.enabled !== undefined) s.enabled = Boolean(input.enabled);
  saveSkills(skills);
  return s;
}

export function deleteSkill(dirName) { saveSkills(listSkills().filter(s => s.dirName !== dirName)); }
export function setSkillEnabled(dirName, enabled) { updateSkill(dirName, { enabled }); }

export function skillsCatalog() {
  const skills = listSkills().filter(s => s.enabled);
  if (!skills.length) return '';
  const lines = skills.slice(0, 12).map(s =>
    '- ' + s.name + '：' + (s.description || '（无描述）') + (s.triggers.length ? '（触发词：' + s.triggers.join('、') + '）' : ''));
  return '可用技能（用户需求匹配某个技能时，先调用 use_skill 工具读取它的完整说明，再按说明执行）：\n' + lines.join('\n');
}

export function matchSkills(userText) {
  const text = String(userText || '').toLowerCase();
  if (text.trim().length < 2) return [];
  const hits = [];
  for (const s of listSkills()) {
    if (!s.enabled) continue;
    if (s.triggers.some(t => t && text.includes(t.toLowerCase()))) hits.push(s);
    if (hits.length >= 2) break;
  }
  return hits;
}
