# Agent Shell 独立版（standalone）

「任何人下载就能开盒既用」的最终形态：agent 本体在手机本地运行，没有服务器。

- **本地运行**：对话循环、多 bot、长期记忆、技能全部在 App 内执行（www/js/，零依赖 ES 模块）。
- **自带 key**：用户在设置里选预设提供方（DeepSeek / EXAONE / OpenAI / Anthropic / OpenRouter / 硅基流动 / 自定义 OpenAI 兼容），填自己的 API key。模型流量由手机直连提供方（CapacitorHttp 原生通道，无跨域限制）。
- **数据只存本机**：配置、会话、记忆、技能都在 localStorage（键前缀 ags1.），设置页可导出 JSON 备份。
- **工具集（手机版）**：web_fetch（带内网字面 IP 拦截）、memory_save、use_skill、get_time、delegate_task（多 bot 派活，深度 1、240 秒超时）。没有命令执行与文件系统——手机 WebView 里不存在这两样，不假装有。
- **与服务器版的关系**：核心逻辑（providers / agent / bots / skills / trimHistory / SSRF 规则）从服务器版 v0.9.1 移植，改动点：存储层换 localStorage、记忆读取取尾部（修服务器版 M12 的只读开头问题）、去掉 MCP/Telegram/定时任务/推送。

## 构建（安卓 debug 包）

在本机或任何有 JDK21 + Android SDK 的机器上：

```
npm install
npx cap add android   # 首次
npx cap sync
cd android && ./gradlew assembleDebug --no-daemon
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

appId 为 app.agentshell.solo，与连接服务器用的壳包（app.agentshell.client）可以并存安装。

## 测试

```
node test/smoke.mjs   # 12 项：聊天/工具回合/记忆隔离/派活/技能触发/裁剪/IP 拦截/Anthropic/CRUD
```

## 已知限制

- web_fetch 在浏览器层无法逐跳校验 DNS（服务器版有），只拦字面内网 IP 与 localhost；重定向由系统跟随。
- 真机行为（CapacitorHttp 通道、WebView 流式读取）需装机实测，本地测试覆盖的是同一套核心逻辑（Node 环境）。
- iOS 包未做（需要 Mac + Xcode + 签名），工程结构兼容 Capacitor，后续可加。
