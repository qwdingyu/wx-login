# 项目：极简微信扫码登录 (wx_login) - PRD

## 1. 项目简介

### 1.1 项目目标

创建一个轻量级、独立的后端服务，仅用于实现微信公众号扫码登录功能。该服务将部署在 Cloudflare Workers 上，利用 Durable Objects 进行实时状态管理，并使用原生 HTML 和 JavaScript 构建前端页面，不依赖任何前端框架或 TypeScript。

### 1.2 核心功能

- 为第三方网站提供一个安全、高效的微信扫码登录弹窗。
- 实时将登录结果（成功或失败）从弹窗页传递回原网站。

---

## 2. 功能需求

### 2.1 用户流程

1.  **访客**在合作方网站（父窗口）点击“微信登录”。
2.  网站弹出一个新的浏览器窗口，加载我们的登录服务页面。
3.  登录页面显示一个动态生成的、有时效性的二维码。
4.  **访客**使用微信扫描该二维码。
5.  微信将扫码信息（包括用户身份 `OpenID`）发送给我们的后端服务。
6.  后端服务验证信息，并将登录成功的 `OpenID` 通过实时连接推送回登录页面。
7.  登录页面收到成功信息后，通过 `postMessage` 将 `OpenID` 发送给父窗口。
8.  登录页面提示成功，并自动关闭。
9.  父窗口收到 `OpenID`，完成登录流程。

### 2.2 技术实现

- **后端**: Cloudflare Worker (JavaScript)。
- **状态管理**: Cloudflare Durable Objects，用于存储二维码凭证与浏览器连接的映射关系。
- **实时通信**: Server-Sent Events (SSE)，用于从后端向登录页面推送登录结果。
- **前端**: 原生 HTML 和 JavaScript。

---

## 3. 详细实施步骤

### 步骤 1: 创建项目文件

在项目根目录下创建 `wx_login` 文件夹，并包含以下文件结构：

```
wx_login/
├─── public/
│    ├─── index.html  # 登录页面
│    └─── script.js   # 登录页面的 JS 逻辑
├─── src/
│    └─── index.js    # Cloudflare Worker 的所有后端逻辑
├─── package.json     # 项目依赖和脚本
└─── wrangler.toml    # Cloudflare 部署配置文件
```

### 步骤 2: 编写 `package.json`

该文件定义了项目依赖（主要是 wrangler 和 qrcode-svg）和部署脚本。

### 步骤 3: 编写 `wrangler.toml`

这是 Cloudflare 的部署配置文件，用于定义 Worker 名称、入口、Durable Object 绑定和环境变量。**注意：所有敏感信息（如 AppSecret）都应作为环境变量配置，而不是硬编码。**

### 步骤 4: 编写后端 `src/index.js`

这是整个项目的核心。它将包含三个主要部分：

1.  **HTTP 请求路由器 (`fetch`)**: 根据 URL (`/`, `/sse`, `/qrcode`) 分发请求。
2.  **微信消息处理器**: 处理微信服务器发送的扫码事件 Webhook。
3.  **Durable Object 类 (`WxLoginDurableObject`)**: 状态管理中心，处理 SSE 连接和登录验证。

### 步骤 5: 编写前端 `public/index.html` 和 `public/script.js`

创建极简的 HTML 页面用于展示二维码，并使用原生 JS 实现与后端的 SSE 通信和与父窗口的 `postMessage` 通信。

### 步骤 6: 安装和部署

1.  进入 `wx_login` 目录。
2.  运行 `npm install` 安装依赖。
3.  修改 `wrangler.toml` 中的环境变量为你自己的配置。
4.  运行 `npm run deploy` 将服务部署到 Cloudflare。
5.  在 Cloudflare Dashboard 或通过 `wrangler secret put` 命令设置你的 `AppSecret` 等敏感信息。
6.  根据 `readme.md` 的指引，配置微信公众号后台。

### 集成 wx_login

示例文件 demo.html 已成功创建在 wx_login 目录中。

如何使用这个 Demo

1.  部署 `wx_login` 服务：

    - 确保您已经按照之前的步骤，通过 npm run deploy 将 wx_login 项目部署到了 Cloudflare。
    - 部署成功后，您会得到一个 URL，例如 https://wx-login.your-account.workers.dev。

2.  修改 Demo 文件：

    - 打开 wx_login/demo.html 文件。
    - 找到第 45 行的 WX_LOGIN_SERVICE_URL 常量。
    - 将其值替换为您部署好的 Worker URL。

3.  运行 Demo：
    - 直接在浏览器中打开 demo.html 文件（或者通过一个简单的本地服务器 python -m http.server 来运行它）。
    - 点击 "点击这里，使用微信登录" 按钮。
    - 您应该能看到弹窗正常弹出，并显示二维码。
    - 扫码成功后，弹窗会自动关闭，并且 demo.html 页面上会显示您的微信用户 ID。

这个 Demo 清晰地展示了集成的三个核心步骤：

1.  通过 window.open 打开您的服务地址。
2.  通过 window.addEventListener('message', ...) 监听回调。
3.  处理从弹窗返回的数据，完成您自己网站的登录逻辑。

### durable 内部运行机制

这是一个非常好的问题，也是理解 Worker 和 Durable Object (DO) 如何协同工作的核心概念。

您的理解是正确的。`https://do/qrlogin` 是一个内部专用的、虚拟的 URL，专门用于在主 Worker 和 Durable Object 实例之间进行通信。 它并不是一个真实存在的、可以从公共互联网访问的地址。

让我为您详细拆解一下：

1. durableObject 是什么？

当您执行这行代码时：
const durableObject = env.WX_LOGIN_DO.get(doId);

变量 durableObject 得到的并不是 Durable Object 的实体本身，而是一个叫做 “存根 (stub)” 的特殊对象。您可以把这个“存根”想象成一个远程控制器或一个代理。它知道如何找到并与实际的 Durable
Object 实例通信，即使那个实例可能运行在另一个 Cloudflare 的数据中心。

2. durableObject.fetch() 方法

从 Worker “调用” Durable Object 的唯一方式，就是通过其 fetch() 方法。这个方法被设计得和您在浏览器中使用的标准 fetch API 一模一样，因此它需要接收一个 Request 对象作为参数。

3. https://do/qrlogin 的作用

当您创建 new Request('https://do/qrlogin', ...) 并将其传递给 durableObject.fetch() 时，会发生以下事情：

- 没有网络请求：这个请求永远不会离开 Cloudflare 的网络，它不会被发送到公共互联网上。
- 内部 RPC：Cloudflare 的运行时会拦截这个调用，并将其视为一个对 Durable Object 实例的内部远程过程调用 (RPC)。
- 内部路由：这个请求被直接传递到您代码中 WxLoginDurableObject 类内部的 fetch 处理器。

在 Durable Object 内部的 fetch 处理器中，代码正是通过这个 URL 来判断应该做什么：

```js
 // 这是 WxLoginDurableObject 类内部的 fetch 处理器
 async fetch(request) {
     const url = new URL(request.url); // 在这里, url.href 的值就是 "https://do/qrlogin"

     // 它使用 URL 的路径名来决定要运行哪个函数
     if (url.pathname === '/sse') {
         return this.handleSse(request);
     }
     if (url.pathname === '/qrlogin') { // <-- 正好匹配！
		const { ticket, uid } = await request.json();
		const result = await this.handleQrLogin(ticket, uid); // 于是，它运行登录逻辑
		return new Response(result);
	}
	// ...
 }
```

一个形象的比喻

把您的 Worker 想象成一个经理，Durable Object 是一个专职助理。

- 经理不能直接拍一下助理的肩膀，而是必须发送一份正式的、书面的备忘录。
- new Request(...) 就是这份备忘录。
- URL https://do/qrlogin 就好比是备忘录的主题行。主机名 do 只是一个惯例，表明这是内部备忘录，而路径 /qrlogin 则精确地告诉助理任务是什么（“处理一个二维码登录请求”）。
- durableObject.fetch() 就是发送备忘录这个动作。
- 助理收到备忘录，读取主题行 (/qrlogin)，执行相应的任务，然后写一份回复备忘录 (Response) 发回给经理。

总结一下：https://do/qrlogin 是一个内部通信的惯例。它的路径 (/qrlogin) 充当了一个“端点”，让您可以在 Durable Object 内部建立一个简单的路由系统，告诉它应该为来自其父 Worker
的特定请求执行哪一段逻辑。
