import { XMLParser } from 'fast-xml-parser';
import QRCode from 'qrcode-svg';

// --- Frontend HTML & JS ---
// For simplicity, we embed the frontend code directly.
// In a larger project, you would serve these from the /public directory.

const loginPageHtml = `
<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>微信扫码登录</title>
    <style>
        body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: sans-serif; background-color: #f0f2f5; }
        .container { text-align: center; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        #qrcode { width: 200px; height: 200px; margin: 20px 0; }
        #status { font-size: 16px; color: #333; }
    </style>
</head>
<body>
    <div class="container">
        <h2>微信扫码登录</h2>
        <img id="qrcode" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="QR Code">
        <p id="status">正在生成二维码...</p>
    </div>
    <script>
        const qrcodeImg = document.getElementById('qrcode');
        const statusText = document.getElementById('status');

        // 1. 验证是否由 window.open 打开
        if (!window.opener) {
            statusText.textContent = "请通过正确方式打开登录页面。";
        } else {
            // 2. 建立 SSE 连接
            const sse = new EventSource("/sse");

            sse.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                switch (msg.code) {
                    case 100: // 收到 ticket
                        qrcodeImg.src = '/qrcode?ticket=' + msg.data;
                        statusText.textContent = "请使用微信扫描二维码";
                        break;
                    case 200: // 登录成功
                        statusText.textContent = "登录成功！";
                        // 3. 将 uid 发送回父窗口
                        window.opener.postMessage({ type: 'wx-login-success', uid: msg.data }, '*');
                        sse.close();
                        setTimeout(() => window.close(), 1500);
                        break;
                    case 408: // 二维码过期
                        statusText.textContent = msg.data;
                        qrcodeImg.style.filter = 'grayscale(1)';
                        sse.close();
                        break;
                }
            };

            sse.onerror = () => {
                statusText.textContent = "连接失败，请刷新重试。";
                sse.close();
            };

            window.addEventListener("beforeunload", () => {
                if (window.opener) {
                    window.opener.postMessage({ type: 'wx-login-cancel' }, '*');
                }
            });
        }
    </script>
</body>
</html>
`;

// --- Durable Object Class ---
// Manages state for SSE connections and login tickets.
export class WxLoginDurableObject {
	constructor(state, env) {
		this.env = env;
		this.clients = new Map(); // key: ticket, value: SSE writer
	}

	// Handles incoming requests routed to the DO.
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === '/sse') return this.handleSse(request);
		if (url.pathname === '/qrlogin') {
			const { ticket, uid } = await request.json();
			const result = await this.handleQrLogin(ticket, uid);
			return new Response(result);
		}
		return new Response('Not Found in DO', { status: 404 });
	}

	async handleSse(request) {
		const ticket = this.env.TicketPrefix + crypto.randomUUID();
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		this.clients.set(ticket, writer);

		const timeout = setTimeout(() => {
			this.closeConnection(ticket, { code: 408, data: '二维码已过期' });
		}, this.env.AuthExpireSecs * 1000);

		request.signal.addEventListener('abort', () => {
			clearTimeout(timeout);
			this.clients.delete(ticket);
		});

		this.writeToSse(writer, { code: 100, data: ticket });

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	}

	async handleQrLogin(ticket, uid) {
		const writer = this.clients.get(ticket);
		if (!writer) {
			return '二维码已过期或不存在。';
		}
		await this.writeToSse(writer, { code: 200, data: uid });
		this.closeConnection(ticket);
		return `登录成功！`;
	}

	async writeToSse(writer, data) {
		try {
			const message = `data: ${JSON.stringify(data)}`;
			await writer.write(new TextEncoder().encode(message));
		} catch (e) {}
	}

	closeConnection(ticket, finalMessage) {
		const writer = this.clients.get(ticket);
		if (writer) {
			if (finalMessage) {
				this.writeToSse(writer, finalMessage);
			}
			try {
				writer.close();
			} catch (e) {}
			this.clients.delete(ticket);
		}
	}
}

// --- Main Worker Fetch Handler ---
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const path = url.pathname;

		// Route to the Durable Object instance for SSE and login logic.
		const doId = env.WX_LOGIN_DO.idFromName('wx-login-instance');
		const durableObject = env.WX_LOGIN_DO.get(doId);

		// 1. WeChat Server Webhook (GET for validation, POST for events)
		if (path === '/') {
			if (request.method === 'GET') {
				return new Response(url.searchParams.get('echostr'));
			}
			if (request.method === 'POST') {
				const text = await request.text();
				const parser = new XMLParser();
				const xml = parser.parse(text).xml;

				if (xml.MsgType === 'event' && xml.Event === 'SCAN' && xml.EventKey) {
					const ticket = xml.EventKey;
					const uid = xml.FromUserName;
					const replyMsg = await durableObject.fetch(
						new Request(`https://do/qrlogin`, {
							method: 'POST',
							body: JSON.stringify({ ticket, uid }),
						})
					);
					const replyText = await replyMsg.text();
					return new Response(
						`<xml>
							<ToUserName>${uid}</ToUserName>
							<FromUserName>${xml.ToUserName}</FromUserName>
							<CreateTime>${Date.now()}</CreateTime>
							<MsgType>text</MsgType>
							<Content>${replyText}</Content>
						</xml>`
					);
				}
				return new Response(''); // Acknowledge other events
			}
		}

		// 2. Frontend requests SSE connection
		if (path === '/sse') {
			return durableObject.fetch(new Request('https://do/sse'));
		}

		// 3. Frontend requests QR code image
		if (path === '/qrcode') {
			const ticket = url.searchParams.get('ticket');
			if (!ticket) return new Response('Ticket not provided', { status: 400 });
			const qr = new QRCode({ content: ticket, padding: 1, join: true });
			return new Response(qr.svg(), { headers: { 'Content-Type': 'image/svg+xml' } });
		}

		// 4. Serve the main login page
		if (path === '/login') {
			return new Response(loginPageHtml, { headers: { 'Content-Type': 'text/html' } });
		}

		return new Response('Not Found', { status: 404 });
	},
};
