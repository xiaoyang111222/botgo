// 模型层（独立版）：两种适配器，逻辑与服务器版一致，去掉 Node 环境依赖。
//  - openai：OpenAI 兼容接口（DeepSeek、OpenAI、EXAONE、OpenRouter、硅基流动、Ollama 等）
//  - anthropic：Claude 原生接口
// 内部消息统一用 OpenAI 风格。chatStream 返回 {content, tool_calls:[{id,name,args}], usage}，增量走 onText。
const CONNECT_MS = 75000;
const IDLE_MS = 75000;

function makeGuard(extSignal) {
  const ac = new AbortController();
  let timer = null, reason = null;
  const fail = (msg) => { if (!reason) { reason = new Error(msg); ac.abort(reason); } };
  if (extSignal) {
    if (extSignal.aborted) fail('已取消：' + (extSignal.reason?.message || '外部中止'));
    else extSignal.addEventListener('abort', () => fail('已取消：' + (extSignal.reason?.message || '外部中止')), { once: true });
  }
  return {
    signal: ac.signal,
    arm(ms, what) { clearTimeout(timer); timer = setTimeout(() => fail(what + ' ' + Math.round(ms / 1000) + ' 秒无响应，已中止'), ms); },
    clear() { clearTimeout(timer); timer = null; },
    wrap(e) { return reason || e; },
  };
}

async function readSSE(res, onData, guard) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    guard?.arm(IDLE_MS, '模型流式响应');
    let r;
    try { r = await reader.read(); } catch (e) { throw guard ? guard.wrap(e) : e; }
    const { done, value } = r;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const lines = chunk.split('\n').map(l => l.trim()).filter(l => l.startsWith('data:'));
      for (const l of lines) {
        const data = l.slice(5).trim();
        if (data && data !== '[DONE]') { try { onData(JSON.parse(data)); } catch {} }
      }
    }
  }
}

function toOpenAITools(tools) {
  return tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

async function guardedFetch(guard, url, init) {
  guard.arm(CONNECT_MS, '连接模型接口');
  let res;
  try { res = await fetch(url, { ...init, signal: guard.signal }); } catch (e) { guard.clear(); throw guard.wrap(e); }
  if (!res.ok) {
    guard.arm(IDLE_MS, '读取模型错误响应');
    let text = '';
    try { text = await res.text(); } catch (e) { guard.clear(); throw guard.wrap(e); }
    guard.clear();
    throw new Error('模型接口 ' + res.status + '：' + text.slice(0, 300));
  }
  return res;
}

function parseArgs(text) { try { return JSON.parse(text || '{}'); } catch { return {}; } }

async function chatOpenAI(provider, model, messages, tools, onText, signal) {
  const base = (provider.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const guard = makeGuard(signal);
  try {
    const res = await guardedFetch(guard, base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(provider.apiKey ? { authorization: 'Bearer ' + provider.apiKey } : {}) },
      body: JSON.stringify({ model, messages, tools: tools.length ? toOpenAITools(tools) : undefined, stream: true }),
    });
    let content = '', usage = null;
    const calls = new Map();
    await readSSE(res, (ev) => {
      if (ev.usage) usage = ev.usage;
      const delta = ev.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) { content += delta.content; onText(delta.content); }
      for (const tc of delta.tool_calls || []) {
        const cur = calls.get(tc.index) || { id: tc.id || '', name: '', argsText: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.argsText += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }, guard);
    return { content, usage, tool_calls: [...calls.values()].map(c => ({ id: c.id || 'call_' + c.name, name: c.name, args: parseArgs(c.argsText) })) };
  } finally { guard.clear(); }
}

function toAnthropic(messages) {
  let system = '';
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') { system += (system ? '\n' : '') + m.content; continue; }
    if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content) }] });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
  }
  return { system, messages: out };
}

async function chatAnthropic(provider, model, messages, tools, onText, signal) {
  const base = (provider.baseURL || 'https://api.anthropic.com').replace(/\/$/, '');
  const { system, messages: am } = toAnthropic(messages);
  const guard = makeGuard(signal);
  try {
    const res = await guardedFetch(guard, base + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01',
        // 浏览器直连 Anthropic 需要显式声明（App 内由原生 HTTP 层发出时无此限制，带上无害）
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model, system: system || undefined, messages: am, max_tokens: 4096, stream: true,
        tools: tools.length ? tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) : undefined,
      }),
    });
    let content = '', usage = null;
    const blocks = new Map();
    await readSSE(res, (ev) => {
      if (ev.type === 'content_block_start') blocks.set(ev.index, { ...ev.content_block, argsText: '' });
      else if (ev.type === 'content_block_delta') {
        const b = blocks.get(ev.index); if (!b) return;
        if (ev.delta?.type === 'text_delta') { content += ev.delta.text; onText(ev.delta.text); }
        if (ev.delta?.type === 'input_json_delta') b.argsText += ev.delta.partial_json || '';
      } else if (ev.type === 'message_delta' && ev.usage) usage = ev.usage;
      else if (ev.type === 'message_start' && ev.message?.usage) usage = ev.message.usage;
    }, guard);
    const tool_calls = [...blocks.values()].filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, args: parseArgs(b.argsText) }));
    return { content, tool_calls, usage };
  } finally { guard.clear(); }
}

export async function chatStream(provider, model, messages, tools, onText, signal) {
  if (provider.type === 'anthropic') return chatAnthropic(provider, model, messages, tools, onText, signal);
  return chatOpenAI(provider, model, messages, tools, onText, signal);
}

// 拉模型列表（设置页「获取模型/测试连接」用）
export async function listModels(provider) {
  if (provider.type === 'anthropic') return provider.models || [];
  const base = (provider.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const signal = AbortSignal.timeout(30000);
  const res = await fetch(base + '/models', { headers: provider.apiKey ? { authorization: 'Bearer ' + provider.apiKey } : {}, signal });
  if (!res.ok) throw new Error('拉模型列表失败 ' + res.status);
  const j = await res.json();
  return (j.data || []).map(m => m.id);
}

// 把模型接口的报错翻译成人话（设置页与聊天页共用）
export function friendlyError(e, provider) {
  const msg = String(e?.message || e || '');
  const name = provider?.name || '模型接口';
  const m = msg.match(/模型接口 (\d{3})/) || msg.match(/\b(401|403|404|402|429|500|502|503)\b/);
  const status = m ? Number(m[1]) : 0;
  const raw = '（原始信息：' + msg.slice(0, 160) + '）';
  if (status === 401 || status === 403) return name + ' 拒绝了请求（' + status + '）：多半是 API key 不对或已过期。去「设置」检查 key；EXAONE 的 key 只有 30 天有效，过期要重新签发。' + raw;
  if (status === 404) return name + ' 找不到这个模型或接口（404）：检查「设置」里的接口地址和模型名对不对。' + raw;
  if (status === 402 || /insufficient|quota|balance|余额/i.test(msg)) return name + ' 余额或额度不足：去提供方那边充值，或换一个 key。' + raw;
  if (status === 429) return '请求太频繁或额度用满（429）：等一会儿再试，或换个提供方。' + raw;
  if (status >= 500) return name + ' 那边服务器出错（' + status + '），不是你这边的问题，过会儿再试。' + raw;
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return '网络连不上 ' + name + '：检查手机网络（或代理）后重试。' + raw;
  if (/无响应|已中止|超时|timeout|timed out/i.test(msg)) return msg + '。可以重试；有些模型思考较慢，首呼几十秒也正常。';
  return msg;
}

// 提供方预设（开盒引导用；模型列表可再用「获取模型」刷新）
export const PRESETS = [
  { name: 'DeepSeek', type: 'openai', baseURL: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], keyHint: '在 platform.deepseek.com 注册后创建 API key' },
  { name: 'EXAONE（LG，免费试用）', type: 'openai', baseURL: 'https://api.exaone.ai/v1', models: ['k-exaone_v2.5'], keyHint: '在 docs.exaone.ai 注册后于 My Page 创建 key（30 天有效）' },
  { name: 'OpenAI', type: 'openai', baseURL: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], keyHint: '在 platform.openai.com 创建 API key' },
  { name: 'Anthropic Claude', type: 'anthropic', baseURL: 'https://api.anthropic.com', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'], keyHint: '在 console.anthropic.com 创建 API key' },
  { name: 'OpenRouter', type: 'openai', baseURL: 'https://openrouter.ai/api/v1', models: [], keyHint: '在 openrouter.ai 创建 key，可用「获取模型」拉全量列表' },
  { name: '硅基流动', type: 'openai', baseURL: 'https://api.siliconflow.cn/v1', models: [], keyHint: '在 siliconflow.cn 创建 key，可用「获取模型」拉全量列表' },
  { name: '自定义（OpenAI 兼容）', type: 'openai', baseURL: '', models: [], keyHint: '填任何 OpenAI 兼容接口的地址与 key' },
];
