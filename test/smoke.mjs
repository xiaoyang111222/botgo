// 独立版核心冒烟测试：localStorage 垫片 + 本地 mock 模型服务（OpenAI SSE / Anthropic SSE）。
// 覆盖：纯聊天、工具回合（get_time / memory_save）、记忆按 bot 隔离、派活与护栏、
//      技能触发注入、trimHistory、isBlockedIp、web_fetch 字面内网 IP 拦截。
import http from 'node:http';
import assert from 'node:assert';

// localStorage 垫片（必须在 import 核心模块前装好）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

// ---------- mock 模型服务 ----------
function sseOpenAI(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write('data: ' + JSON.stringify(e) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}
const oaiText = (text) => [
  { choices: [{ delta: { content: text.slice(0, 3) } }] },
  { choices: [{ delta: { content: text.slice(3) } }], usage: { total_tokens: 42 } },
];
const oaiTool = (name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/anthropic/v1/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const evs = [
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic 你好' } },
        { type: 'message_delta', usage: { output_tokens: 3 } },
      ];
      for (const e of evs) res.write('data: ' + JSON.stringify(e) + '\n\n');
      return res.end();
    }
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
    const j = JSON.parse(body);
    const msgs = j.messages || [];
    const last = msgs[msgs.length - 1];
    const systemText = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n');
    if (last?.role === 'tool') return sseOpenAI(res, oaiText('最终回复：已收到工具结果。'));
    if (systemText.includes('严谨的研究员')) return sseOpenAI(res, oaiText('研究员的调研结论：已核实。'));
    const userText = String(last?.content || '');
    if (userText.includes('派给不存在')) return sseOpenAI(res, oaiTool('delegate_task', { bot: '不存在的bot', task: '随便' }));
    if (userText.includes('派活')) return sseOpenAI(res, oaiTool('delegate_task', { bot: '研究员', task: '核实一件事' }));
    if (userText.includes('记一下')) return sseOpenAI(res, oaiTool('memory_save', { text: '用户喜欢喝茶' }));
    if (userText.includes('时间')) return sseOpenAI(res, oaiTool('get_time', {}));
    return sseOpenAI(res, oaiText('你好，我是助手'));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT + '/v1';

const { runAgent, trimHistory } = await import('../www/js/agent.js');
const bots = await import('../www/js/bots.js');
const tools = await import('../www/js/tools.js');
const providers = await import('../www/js/providers.js');

const cfg = {
  providers: [{ id: 'p1', name: 'mock', type: 'openai', baseURL: BASE, apiKey: 'test', models: ['mock-model'] }],
  defaultProvider: 'p1', defaultModel: 'mock-model', maxSteps: 12,
};
const provider = cfg.providers[0];
const results = [];
const t = (name, fn) => { try { fn(); results.push('✅ ' + name); } catch (e) { results.push('❌ ' + name + '：' + e.message); } };
async function run(userText, botId) {
  const bot = bots.getBot(botId || 'default');
  const session = { id: 's-' + Math.random(), botId: bot.id, title: '', messages: [] };
  let text = '';
  const events = [];
  await runAgent({ cfg, provider, model: 'mock-model', session, userText, bot, emit: (ev) => { events.push(ev); if (ev.type === 'text') text += ev.delta; } });
  return { session, text, events };
}

// 1. 纯聊天
{
  const { session, text } = await run('你好');
  t('纯聊天往返', () => { assert.equal(text, '你好，我是助手'); assert.equal(session.messages.length, 2); });
}
// 2. 工具回合 get_time
{
  const { session, text, events } = await run('现在什么时间');
  t('工具回合 get_time', () => {
    assert.ok(events.some(e => e.type === 'tool_call' && e.name === 'get_time'));
    assert.ok(session.messages.some(m => m.role === 'tool'));
    assert.ok(text.includes('最终回复'));
  });
}
// 3. memory_save + 按 bot 隔离
{
  await run('记一下：我喜欢喝茶');
  const memDefault = bots.loadBotMemory('default');
  const memResearch = bots.loadBotMemory(bots.listBots().find(b => b.name === '研究员').id);
  t('记忆写入默认 bot', () => assert.ok(memDefault.includes('用户喜欢喝茶')));
  t('记忆按 bot 隔离', () => assert.ok(!memResearch.includes('用户喜欢喝茶')));
}
// 4. 派活给研究员
{
  const { session, text } = await run('派活给研究员核实');
  t('delegate_task 派活', () => {
    const toolMsg = session.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg && toolMsg.content.includes('研究员的调研结论'), 'tool 结果应含研究员结论，实际：' + (toolMsg?.content || '无'));
    assert.ok(text.includes('最终回复'));
  });
}
// 5. 派给不存在的 bot → 友好报错不断流
{
  const { session } = await run('派给不存在的bot');
  t('delegate 未知 bot 报错', () => {
    const toolMsg = session.messages.find(m => m.role === 'tool');
    assert.ok(toolMsg && toolMsg.content.includes('没找到 bot'));
  });
}
// 6. 技能触发注入（总结网页 → 系统注入 + 模型应调用 web_fetch……本用例只验注入：mock 对任意未知输入回纯文本，改验 systemPrompt 路径）
//    直接验 matchSkills 与目录
{
  const skills = await import('../www/js/skills.js');
  t('技能触发匹配', () => {
    const hits = skills.matchSkills('帮我总结网页 https://example.com');
    assert.ok(hits.some(s => s.name === '网页总结'));
    assert.ok(skills.skillsCatalog().includes('网页总结'));
  });
}
// 7. trimHistory
t('trimHistory 裁剪', () => {
  const h = [{ role: 'user', content: '头' }];
  for (let i = 0; i < 30; i++) h.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(500) });
  const out = trimHistory(h, 2000);
  assert.ok(out.length < h.length && out[0].content.includes('省略'));
  assert.notEqual(out[1].role, 'tool');
});
// 8. isBlockedIp
t('isBlockedIp 规则', () => {
  assert.equal(tools.isBlockedIp('127.0.0.1'), true);
  assert.equal(tools.isBlockedIp('169.254.169.254'), true);
  assert.equal(tools.isBlockedIp('192.168.1.1'), true);
  assert.equal(tools.isBlockedIp('10.0.0.5'), true);
  assert.equal(tools.isBlockedIp('100.64.0.1'), true);
  assert.equal(tools.isBlockedIp('::1'), true);
  assert.equal(tools.isBlockedIp('8.8.8.8'), false);
  assert.equal(tools.isBlockedIp('172.15.0.1'), false);
  assert.equal(tools.isBlockedIp('1.1.1.1'), false);
});
// 9. web_fetch 字面内网拦截
{
  let threw = '';
  try { await tools.fetchPublicPage('http://127.0.0.1:' + PORT + '/v1'); } catch (e) { threw = e.message; }
  t('web_fetch 拦回环地址', () => assert.ok(threw.includes('已拦截'), '实际：' + threw));
}
// 10. Anthropic 适配
{
  let text = '';
  const r = await providers.chatStream({ type: 'anthropic', baseURL: 'http://127.0.0.1:' + PORT + '/anthropic', apiKey: 'k' }, 'claude-x', [{ role: 'user', content: 'hi' }], [], (d) => (text += d));
  t('Anthropic 流式', () => { assert.equal(text, 'Anthropic 你好'); assert.equal(r.content, 'Anthropic 你好'); });
}
// 11. bots CRUD 校验
t('bots CRUD', () => {
  const b = bots.createBot({ name: '测试bot', description: '测试' });
  assert.ok(b.id);
  assert.throws(() => bots.createBot({ name: '测试bot' }), /同名/);
  assert.throws(() => bots.deleteBot('default'), /不能删/);
  bots.deleteBot(b.id);
});

console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('❌'));
console.log(failed.length ? '\n失败 ' + failed.length + ' 项' : '\n全部通过（' + results.length + ' 项）');
server.close();
process.exit(failed.length ? 1 : 0);
