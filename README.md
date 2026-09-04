# DSH Image Generator

一个轻量的 OpenAI 通用协议生图工具插件。API URL、API Key 和模型在 DSH 设置页配置，会话通过 `generate_image` 工具生成图片；插件不提供独立生图工作台。

API Key 由 DSH 凭据服务保存，不会发送到浏览器。工具调用配置地址下的 `images/generations`，支持兼容服务返回 `url` 或 `b64_json`，并把图片保存到当前会话工作目录。

工具支持传入 1–8 张当前会话工作目录内的 PNG/JPEG/WebP 参考图；有参考图时自动调用 `images/edits`，并保持参考图顺序。

## 兼容性

正式版 `0.2.0` 针对 DeepSeek Harness `0.1.2-rc.1` 构建并完成部署验证，需要 Node.js `22.19+` 或 `24+`。Agent、Code Runtime、Credentials、Settings 与 Tools 接口均对应 `0.1.2-rc.1`。

## 安装

```bash
dsh plugin --profile web add @lemoncat7/dsh-image-generator@0.2.0
```

## 开发

```bash
npm install
npm test
```
