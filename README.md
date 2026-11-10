# Agent Shell 独立版：一个装在手机里、真正属于你自己的 AI 助手

## 一句话

不用注册、不用订阅、不用连任何人的服务器——下载装上，填入你自己的大模型 API key，它就是只为你一个人工作的 AI 助手。

> **商业授权：** 本项目采用 CC BY-NC 4.0，个人学习、个人使用可免费；**商业使用（付费产品、付费 App、机构收费服务等）需单独授权**，请通过 X 私信 [@hassanyehiaa](https://x.com/hassanyehiaa)、邮箱 [499749204@qq.com](mailto:499749204@qq.com) 或在本仓库 [提交 Issue](https://github.com/xiaoyang111222/botgo/issues) 联系，条款见文末「许可证 / License」。

## 界面一览

<p>
<img src="docs/images/showcase-guide.png" width="300" alt="开盒引导：一分钟上手">
<img src="docs/images/showcase-chat.png" width="300" alt="聊天界面：工具调用与长期记忆">
</p>

## 为什么做这个

现在市面上的 AI 助手 App，几乎都是同一个模式：你的对话先发到厂商的服务器，在那边转一圈再回来。这个模式有三个绕不开的问题：

- **数据不在自己手里**：聊了什么、记住了什么，都存在别人的服务器上，对方怎么用你说了不算。
- **花钱的方式不自由**：要么按月交订阅，要么被锁定在一家模型上，涨价、降智、封号都只能受着。
- **助手并不真正属于你**：服务一停、账号一封，你养出来的记忆和习惯全部清零。

Agent Shell 独立版的做法很直接：把助手本体搬进手机里运行。没有后端服务器，没有账号系统，没有云端数据库。它就是一个纯粹的本地 App，你的 key、你的数据、你的规则。

## 它能做什么

- **多家模型随便换**：内置 DeepSeek、EXAONE、OpenAI、Claude、OpenRouter、硅基流动等提供方预设，也支持任意 OpenAI 兼容接口。谁便宜用谁，谁聪明用谁，随时切换。
- **开盒引导，一分钟上手**：第一次打开有引导页，选提供方、粘贴 key、点「获取模型」拉到列表，通了就自动开始，不需要看任何文档。
- **多个 bot 各司其职**：可以建多个不同人设和专长的 bot，比如一个负责日常问答，一个负责研究查资料。bot 之间还能互相派活——主 bot 遇到专业问题，会把任务转给更合适的 bot 去做，再把结果带回来。
- **长期记忆，只存本机**：它会把该记的事记下来，下次对话接着用。所有记忆都在手机本地，不上传任何地方；设置里随时能导出成文件备份，换手机导回来就行。
- **能联网、能用技能**：需要查最新信息时它可以抓取网页内容；技能（Skill）机制让它能按你放进去的说明书做事，能力可以自己往上加。
- **报错说人话**：key 过期了、余额不足、模型名填错了、网络不通——它会直接告诉你大概是什么问题、该怎么处理，而不是甩一串英文错误代码。
- **贴身的提醒**：比如 EXAONE 的免费 key 只有 30 天有效期，它会帮你算还剩几天，快到期了提前提醒，不会等到聊不动了才发现。

## 下载

安卓安装包在 [Releases](https://github.com/xiaoyang111222/botgo/releases) 页，下载最新版 APK 直接安装即可（当前 v1.4.0）。从 v1.1.0 起所有正式版使用同一签名，可直接覆盖升级，不丢数据。

## 怎么用

1. 安装 APK，打开 App；
2. 在引导页选一个你有 key 的提供方（没有的话，EXAONE 目前有免费试用，DeepSeek 的价格也很低）；
3. 粘贴你的 API key，点「获取模型」确认连通；
4. 开始聊天。就这么多。

## 实现方式

- 助手本体是零依赖的 Web 技术实现（对话循环、工具调用、多 bot 协同、记忆系统全部在本地跑，代码在 www/js/），用 Capacitor 打包成安卓 App。
- 和模型的通信由手机直连提供方接口，不经过任何中间服务器。
- 数据存储在本机（localStorage，键前缀 ags1.），导入导出都是明文 JSON，格式公开，你的数据永远拿得回来。
- 工具集（手机版）：web_fetch（带内网字面 IP 拦截）、memory_save、use_skill、get_time、delegate_task（多 bot 派活，深度 1、240 秒超时）。没有命令执行与文件系统——手机 WebView 里不存在这两样，不假装有。

## 现在到哪一步了

当前版本 v1.4.0，已在真机完整跑通：开盒引导、多提供方配置、流式对话、工具调用、多 bot 派活、记忆存取、数据导入导出都可用。正式版签名和图标齐备，后续版本可直接覆盖升级。

v1.3.0 加了检查更新，v1.4.0 加了会话搜索与语音输入；接下来计划做的：本地定时任务。

## 开发与构建

在本机或任何有 JDK 21 + Android SDK 的机器上：

```
sh build-android.sh <工程目录> debug     # debug 包
sh build-android.sh <工程目录> release   # release 包（需自备签名，见 android-overrides/patch_release.py）
```

脚本流程：npm install → cap sync → 覆盖样式与图标（android-overrides/）→ gradle 打包。appId 为 `app.agentshell.solo`。

测试：`node test/smoke.mjs`（12 项：聊天/工具回合/记忆隔离/派活/技能触发/裁剪/IP 拦截/Anthropic/CRUD）。

图标 PNG 由 `android-overrides/gen_icons.py` 生成，未直接入库，构建前先跑一次生成到 `android-overrides/res/`。

已知限制：

- web_fetch 在浏览器层无法逐跳校验 DNS，只拦字面内网 IP 与 localhost；重定向由系统跟随。
- iOS 包未做（需要 Mac + Xcode + 签名），工程结构兼容 Capacitor，后续可加。

## 最后

AI 助手正在变成每个人的日常工具，但「日常工具」不等于要把自己的数据和习惯交给别人保管。Agent Shell 独立版想验证一件事：一个足够好用的个人 AI 助手，完全可以只跑在你自己的手机上。

你的 key，你的数据，你的助手。

## 许可证 / License

本项目采用 **CC BY-NC 4.0**（知识共享 署名—非商业性使用 4.0 国际许可协议）授权，全文见仓库根目录 [LICENSE](LICENSE) 文件，协议摘要见 [creativecommons.org/licenses/by-nc/4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans)。

- **个人使用免费**：个人学习、研究、日常使用无需授权，请保留署名。
- **商业使用需单独授权**：将本项目（或其衍生版本）用于付费产品、付费 App、机构收费服务等商业场景，须事先取得授权。联系：X 私信 [@hassanyehiaa](https://x.com/hassanyehiaa)、邮箱 [499749204@qq.com](mailto:499749204@qq.com)、或在本仓库 [提交 Issue](https://github.com/xiaoyang111222/botgo/issues)。
