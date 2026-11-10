// Agent 循环（独立版）：组装上下文 → 调模型（流式）→ 工具调用 → 回喂结果，直到最终回复或步数用尽。
// 与服务器版同一套逻辑，去掉 MCP 与审批（本版工具集都是只读/本地类，无需审批）。
import { chatStream } from './providers.js';
import { toolByName, toolSchemas } from './tools.js';
import { skillsCatalog, matchSkills } from './skills.js';
import { getBot, findBot, loadBotMemory, rosterText, DEFAULT_BOT_ID } from './bots.js';

// 每步保存回调（由 app 层注入，避免循环引用）
let onStepSave = null;
export function setOnStepSave(fn) { onStepSave = fn; }

export function systemPrompt(bot, depth = 0) {
  const memory = loadBotMemory(bot.id);
  const catalog = skillsCatalog();
  const roster = depth === 0 ? rosterText(bot.id) : '';
  return [
    '你是一个个人 AI 助手，运行在用户自己的手机里（独立版，全部数据只存在本机）。你能调用工具：抓取网页、保存长期记忆、读取技能说明、查看时间；还能把子任务交给团队里的其他 bot。',
    bot.persona ? '\n# 你的角色\n你叫「' + bot.name + '」。' + bot.persona : '',
    '你没有命令执行和文件系统能力；做不到的事如实说，不要假装执行过。',
    '原则：能动手就别只给建议；工具结果要核对后再下结论。',
    '回答用用户使用的语言，简洁清楚。',
    roster ? '\n' + roster + '\n把独立子任务交给专长的成员，比自己样样都做更好。' : '',
    catalog ? '\n' + catalog : '',
    memory ? '\n# 长期记忆\n' + memory : '',
  ].join('\n');
}

export const DELEGATE_SCHEMA = {
  name: 'delegate_task',
  description: '把一个独立子任务交给团队里的另一个 bot：它会用自己的人设、模型和记忆独立完成，把最终结果交回来。参数 bot 填对方名字，task 写清要它做什么、交回什么。适合让专长的成员处理它擅长的部分；对方不能再继续转交。',
  parameters: {
    type: 'object',
    properties: {
      bot: { type: 'string', description: '目标 bot 的名字（见系统提示里的团队名册）' },
      task: { type: 'string', description: '子任务说明：做什么、期望交回什么结果' },
    },
    required: ['bot', 'task'],
  },
};
const DELEGATE_TIMEOUT_MS = 240000;

async function runDelegate({ cfg, callerBot, args, emit }) {
  const target = findBot(args?.bot);
  if (!target) {
    const names = rosterText(callerBot.id);
    return '没找到 bot「' + String(args?.bot || '') + '」。' + (names ? '当前团队成员：\n' + names : '团队里暂时没有其他成员。');
  }
  if (target.id === callerBot.id) return '不能把任务交给自己。';
  if (!target.enabled) return '「' + target.name + '」已停用，换个成员或自己做。';
  const provider = cfg.providers.find(x => x.id === (target.providerId || cfg.defaultProvider)) || cfg.providers[0];
  if (!provider) return '还没配置任何模型提供方，派活失败。';
  const model = target.model || provider.models?.[0] || cfg.defaultModel;
  emit({ type: 'notice', text: '🤝 已把子任务交给「' + target.name + '」，等它完成…' });
  const subSession = { id: 'delegate-' + Date.now(), title: '', messages: [] };
  let text = '';
  const collect = (ev) => { if (ev.type === 'text') text += ev.delta; };
  const userText = '这是「' + callerBot.name + '」转交给你的子任务，请独立完成并把完整结果作为回复交回（不要反问转交方）：\n\n' + String(args?.task || '');
  let timer;
  try {
    await Promise.race([
      runAgent({ cfg, provider, model, session: subSession, userText, emit: collect, bot: target, depth: 1 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), DELEGATE_TIMEOUT_MS); }),
    ]);
  } catch (e) {
    if (e.message === 'timeout') return '「' + target.name + '」处理超时（240 秒），建议把子任务拆小一点再派。';
    return '「' + target.name + '」执行子任务时出错：' + e.message;
  } finally { clearTimeout(timer); }
  emit({ type: 'notice', text: '🤝「' + target.name + '」已完成子任务' });
  if (!text.trim()) {
    const last = [...subSession.messages].reverse().find(m => m.role === 'assistant' && m.content);
    text = last?.content || '';
  }
  return text.trim() ? '「' + target.name + '」的回复：\n' + text.trim() : '「' + target.name + '」没有产出文字结果。';
}

// ---------- 历史长度控制（与服务器版一致） ----------
const msgSize = (m) => String(m.content ?? '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + 20;
const HISTORY_MAX_CHARS = 100000;

export function trimHistory(history, maxChars = HISTORY_MAX_CHARS) {
  const sizes = history.map(msgSize);
  if (history.length <= 2 || sizes.reduce((a, b) => a + b, 0) <= maxChars) return history;
  let lastUser = -1;
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === 'user') { lastUser = i; break; }
  const mustKeepFrom = Math.max(lastUser, 1);
  let used = sizes[0], start = history.length;
  for (let i = history.length - 1; i >= 1; i--) {
    if (i < mustKeepFrom && used + sizes[i] > maxChars) break;
    used += sizes[i]; start = i;
  }
  while (start < history.length && history[start].role === 'tool') start++;
  if (start <= 1) return history;
  const note = '\n\n（为控制长度，此处省略了中间 ' + (start - 1) + ' 条较早的历史消息）';
  const head = { ...history[0], content: String(history[0].content ?? '') + note };
  return [head, ...history.slice(start)];
}

export function trimMessagesTail(messages, n) {
  if (!Array.isArray(messages) || messages.length <= n) return messages;
  let start = messages.length - n;
  while (start < messages.length && messages[start].role !== 'user') start++;
  if (start >= messages.length) {
    start = messages.length - 1;
    while (start > 0 && messages[start].role !== 'user') start--;
  }
  return messages.slice(start);
}

export async function runAgent(params) {
  const timeoutMs = Number(params.timeoutMs) || 20 * 60 * 1000;
  const ac = new AbortController();
  // 与 UI 的停止按钮联动：外部 signal 进来就一并中止
  if (params.signal) {
    if (params.signal.aborted) ac.abort(params.signal.reason);
    else params.signal.addEventListener('abort', () => ac.abort(params.signal.reason), { once: true });
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Agent 运行超过 ' + Math.round(timeoutMs / 1000) + ' 秒总超时，已中止');
      ac.abort(err); reject(err);
    }, timeoutMs);
  });
  const inner = runAgentInner(params, ac.signal);
  inner.catch(() => {});
  try { return await Promise.race([inner, timeout]); }
  finally { clearTimeout(timer); }
}

async function runAgentInner({ cfg, provider, model, session, userText, emit, bot, depth = 0 }, signal) {
  const checkAbort = () => { if (signal.aborted) throw signal.reason; };
  bot = bot || getBot(DEFAULT_BOT_ID);
  const history = session.messages.map(m => ({ ...m }));
  history.push({ role: 'user', content: userText });
  const schemas = [...toolSchemas(), ...(depth === 0 ? [DELEGATE_SCHEMA] : [])];
  const matched = matchSkills(userText);
  const skillMsg = matched.length
    ? { role: 'system', content: matched.map(s => '以下是技能「' + s.name + '」的说明，请严格按其执行本轮任务：\n\n' + s.body).join('\n\n') }
    : null;

  for (let step = 0; step < (cfg.maxSteps || 12); step++) {
    checkAbort();
    const messages = [{ role: 'system', content: systemPrompt(bot, depth) }, ...(skillMsg ? [skillMsg] : []), ...trimHistory(history)];
    const result = await chatStream(provider, model, messages, schemas, (delta) => { emit({ type: 'text', delta }); }, signal);
    checkAbort();

    const assistantMsg = { role: 'assistant', content: result.content || '' };
    if (result.tool_calls?.length) assistantMsg.tool_calls = result.tool_calls;
    history.push(assistantMsg);
    emit({ type: 'usage', usage: result.usage || null });

    if (!result.tool_calls?.length) {
      session.messages = history;
      return { done: true };
    }

    for (const call of result.tool_calls) {
      checkAbort();
      const tool = toolByName(call.name);
      const isDelegate = call.name === DELEGATE_SCHEMA.name && depth === 0;
      emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
      let output;
      if (isDelegate) {
        try { output = await runDelegate({ cfg, callerBot: bot, args: call.args || {}, emit }); }
        catch (e) { output = '派活失败：' + e.message; }
      } else if (!tool) {
        output = '未知工具：' + call.name;
      } else {
        try { output = await tool.run(call.args || {}, { botId: bot.id }); }
        catch (e) { output = '工具执行出错：' + e.message; }
      }
      emit({ type: 'tool_result', id: call.id, name: call.name, output: String(output).slice(0, 2000) });
      history.push({ role: 'tool', tool_call_id: call.id, content: String(output) });
    }
    session.messages = history;
    if (onStepSave) onStepSave(session);
  }
  session.messages = history;
  emit({ type: 'notice', text: '已达到最大步数 ' + (cfg.maxSteps || 12) + '，先停下。' });
  return { done: true };
}
