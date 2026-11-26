---
layout: default
title: FigmaMCP — 简体中文
description: 让 Claude Code 或 Codex 读取并编辑你在 Figma 桌面版里打开的文件。免费，本地运行，没有调用次数限制。
permalink: /zh/
lang: zh-CN
---

# FigmaMCP

**语言：** [English](https://figmamcp.dev/) · 简体中文

让 Claude Code 或 Codex 读取并编辑你已经在 Figma 桌面版里打开的文件。FigmaMCP 免费，在你自己的 Mac 上本地运行，通过 Figma 的插件 API 工作，所以没有调用次数需要盯着。

**[下载 Mac 版](https://figmamcp.dev/download)**

目前只支持 macOS，需要 Figma 桌面版（不能在浏览器里运行）。

## 它能做什么

用日常语言告诉 AI 你想要什么。它先读取打开文件的结构，再直接在这个文件里改，你可以看着改动发生。

- **读取：** 页面、画框、图层、文字、组件、变量和样式。
- **编辑：** 创建和修改画框、文字、形状、组件和实例、自动布局、填充、描边和效果。
- **批量处理：** 一次请求里重命名、改样式或改写很多图层，例如把所有提到旧产品名的文字图层一起改掉。
- **有边界：** 每次编辑都必须准确指明目标图层；批量编辑里只要有一项无效，就一项都不会改；插件里的一个开关可以让文件变成只读。

## 你需要什么

- 一台 Mac。
- Figma 桌面版。
- Claude Code 或 Codex。

## 安装

1. **下载并打开 App。** 点上面的“下载 Mac 版”，打开下载的文件。
2. **按清单操作。** App 会检查 Figma、Claude Code 和 Codex，然后安装插件并连接你的 AI。点“Add to Figma”。如果 Figma 正在运行而且还没有这个插件，它会重启一次。你也可以允许“辅助功能”权限，这样 FigmaMCP 能替你的 AI 打开插件。
3. **重启 Claude Code 或 Codex。** 如果它们已经在运行，重启一次才能加载新工具。
4. **提出修改。** 打开一个 Figma 文件，让 AI 去改。例如：“把所有叫 Frame 12 的图层按它们的标题重命名。”

不需要终端，也不需要 Figma API 令牌，更不用手动改配置文件。

## 遇到问题

- 文件必须在 Figma 桌面版里打开。
- 如果没有允许“辅助功能”权限，请在每个文件里手动打开一次插件（Plugins → Development → FigmaMCP），并在 AI 编辑期间保持它打开。
- 插件里有一个开关“AI can edit this file”。关闭时，AI 只能读取，不能编辑。
- 仍然不行？请到[发布页提交问题](https://github.com/MrCoder/figmamcp-releases/issues)。

## 常见问题

**需要 Figma API 令牌吗？** 不需要。FigmaMCP 通过插件 API 和你 Mac 上的 Figma 桌面版通信，没有令牌需要创建或粘贴。

**为什么 Figma 会重启？** FigmaMCP 要在 Figma 关闭时添加插件，Figma 再次启动后插件才会出现。只有 Figma 正在运行且插件缺失时，App 才会帮你重启一次。

**为什么插件不在 Figma Community 里？** FigmaMCP 不通过 Figma Community 分发。你不用手动安装：Mac App 会把它注册到 Figma，之后它出现在 Plugins → Development 里。

**支持哪些 AI？** Claude Code 和 Codex 是经过测试的目标，Mac App 会替你连接它们。

**支持 Windows 或 Linux 吗？** 暂时不支持。

**AI 会毁掉我的文件吗？** 改动只会发生在已打开插件、并且“AI can edit this file”开关为开的文件里。它仍然是一个编辑工具：请像检查同事的工作一样检查结果，也可以随时用 Figma 的版本历史还原。

## 隐私

FigmaMCP 本身不会把文件内容发送到任何地方。但你的 AI 会读取 FigmaMCP 返回的内容，并按它自己的模型服务商的条款发送给对方，请据此选择你的 AI。

网站和插件会统计使用情况：网站使用 Google Analytics，插件每次打开发送一个事件，只带插件版本号，不带文件名、文件密钥或设计内容。完整说明见[隐私页](https://figmamcp.dev/privacy)。

## 致谢

FigmaMCP 派生自 Neo Product LLC 的 [figma-edit-mcp](https://github.com/neozhehan/figma-edit-mcp)，最早由 [sonnylazuardi](https://github.com/sonnylazuardi) 编写。

FigmaMCP 不隶属于 Figma, Inc.，也未获其认可。Figma 是 Figma, Inc. 的商标。
