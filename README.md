# DSH Image Generator


一个轻量的 OpenAI 通用协议生图工具插件。API URL、API Key 和模型在 DSH 设置页配置，会话通过 `generate_image` 生成图片；插件不提供独立生图工作台。

API Key 由 DSH 凭据服务保存，不会发送到浏览器。工具调用配置地址下的 `images/generations`，支持兼容服务返回 `url` 或 `b64_json`，并把图片保存到当前会话工作目录。

工具支持传入 1–8 张当前会话工作目录内的 PNG/JPEG/WebP 参考图；有参考图时自动调用 `images/edits`，并保持参考图顺序。

当前插件版本 **0.3.8**，见[发布说明](docs/releases/0.3.8.md)。

## 兼容性

当前版本 **0.3.10**，支持 DeepSeek Harness **0.2.2-rc.1 / 0.2.2-rc.2**，需要 Node.js **>=24.9.0**。rc2 隔离验证结果见[兼容说明](docs/compatibility-0.2.2-rc.2.md)。本版制品包含上述兼容声明。

## 安装

```bash
dsh plugin --profile web add @lemoncat7/dsh-image-generator@latest
```

## 开发

### 桌面端请求兼容

DSH 桌面端验证 `dsh-app://app` 后，转发到本地服务时会删除 `Origin` 和 `sec-fetch-site`。设置页保存、测试请求携带 `x-dsh-image-generator-request: 1`；无 Origin 的写请求仅在连接来自回环地址、Host 为回环地址且没有 Fetch Metadata 来源标记时接受。该自定义头用于防跨站请求，不是身份凭据；宿主仍负责桌面转发 Cookie 的认证。插件不开放跨站 CORS，也不信任 `X-Forwarded-*` 提供的来源。

更新时需同时更新后端与前端包，并重新加载桌面设置页；只替换 `lib/http.js` 不足以完成修复。

```bash
npm install
npm test
```

## 版本记录

历史变更见 [GitHub Releases](https://github.com/lemoncat7/dsh-image-generator/releases)，维护约定见[发布文档](docs/releases/README.md)。

## 0.3.8 生图诊断

每次实际请求在当前工作目录 `.image-generation/attempts/` 保存诊断记录，错误和成功返回附带路径；按需读取，不加入长期记忆。详见 [版本说明](docs/releases/0.3.8.md)。


## DSH 0.2.2 兼容性

当前版本 **0.3.10**，支持 DeepSeek Harness **0.2.2-rc.1 / 0.2.2-rc.2**，需要 Node.js **>=24.9.0**。rc2 隔离验证结果见[兼容说明](docs/compatibility-0.2.2-rc.2.md)。本版制品包含上述兼容声明。
