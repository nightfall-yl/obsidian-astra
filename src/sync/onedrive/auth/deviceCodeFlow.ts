/**
 * OAuth 2.0 Device Code Flow 实现（RFC 8628）
 *
 * 为什么不用 @azure/msal-* 库：
 *   msal-node 需要 Node.js API（crypto、http、fs），在 iOS/Android WebView 中不存在 → 移动端挂掉。
 *   msal-browser 用 redirect flow，与 Obsidian 沙箱环境不兼容。
 * 本实现直接使用 Obsidian 的 requestUrl() API —— 桌面端与移动端完全相同的代码路径，
 * 无需任何平台分支。
 *
 * 完整流程：
 *   ① POST /oauth2/v2.0/devicecode  → 拿到 device_code + user_code + verification_uri
 *   ② 用户在浏览器打开 verification_uri → 输入 user_code → 登录授权
 *   ③ 插件后台轮询 POST /oauth2/v2.0/token (grant_type=device_code) → 拿到 access_token + refresh_token
 */
import { requestUrl } from "obsidian";
import { sleep } from "../../misc";
import { syncLog } from "../../log";
import { mapEntraAuthError } from "./entraErrors";

/** Device code endpoint 返回的字段（精简，只用我们需要的） */
export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number; // 秒
	interval: number;   // 建议轮询间隔（秒）
	message?: string;
}

/** Token endpoint 返回的成功响应（简化版） */
export interface TokenResponse {
	token_type: "Bearer" | "bearer";
	expires_in: number;
	access_token: string;
	refresh_token?: string;
	scope?: string;
	id_token?: string;
}

/** 授权过程中可能抛出的业务错误 */
export class AuthenticationError extends Error {
	public readonly code?: string;
	constructor(message: string, code?: string) {
		super(message);
		this.name = "AuthenticationError";
		this.code = code;
	}
}

export interface OAuthEndpoints {
	deviceCode: string;
	token: string;
}

export interface DeviceCodeFlowClientOptions {
	clientId: string;
	endpoints: OAuthEndpoints;
	scopes: string[];
}

export class DeviceCodeFlowClient {
	private cancelled = false;

	constructor(private readonly options: DeviceCodeFlowClientOptions) {}

	/** 取消正在进行中的轮询（用户关掉 Modal 等场景） */
	cancelPolling(): void {
		this.cancelled = true;
	}

	/**
	 * Step 1: 向 Microsoft 请求一个 device code。
	 * 返回 user_code（用户要在浏览器里输入的 8 位码）和 verification_uri（打开的页面）。
	 */
	async requestDeviceCode(): Promise<DeviceCodeResponse> {
		syncLog.debug("DeviceCodeFlow: requesting device code");
		try {
			const resp = await requestUrl({
				url: this.options.endpoints.deviceCode,
				method: "POST",
				contentType: "application/x-www-form-urlencoded",
				// throw:false 是关键 —— Entra 把 AADSTS 错误码放在 body 里，
				// 必须读到 body 才能映射成友好文案；否则 requestUrl 直接抛掉 4xx。
				throw: false,
				body: new URLSearchParams({
					client_id: this.options.clientId,
					scope: this.options.scopes.join(" "),
				}).toString(),
			});

			if (resp.status !== 200) {
				const errBody = this.safeParseErrorBody(resp.text);
				const mapped = mapEntraAuthError(errBody.error, errBody.error_description);
				if (mapped) {
					throw new AuthenticationError(mapped.message, mapped.code);
				}
				throw new AuthenticationError(
					`获取设备码失败（HTTP ${resp.status}）：${errBody.error_description || errBody.error || resp.text}`
				);
			}

			const data = resp.json as unknown as DeviceCodeResponse;
			syncLog.debug(
				`DeviceCodeFlow: code received (user_code=${data.user_code}, expires=${data.expires_in}s)`
			);
			return data;
		} catch (err) {
			if (err instanceof AuthenticationError) throw err;
			syncLog.error("DeviceCodeFlow: requestDeviceCode failed", err);
			throw new AuthenticationError(
				`请求设备码失败：${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/**
	 * Step 3: 轮询 token endpoint，直到用户在浏览器里完成授权、device code 过期、
	 * 或遇到不可恢复的错误（如租户策略拒绝）。
	 *
	 * @param onPending 每次 server 返回 authorization_pending 或网络抖动时调用，让 UI 刷新文案
	 */
	async pollForToken(
		deviceCode: string,
		interval: number,
		expiresIn: number,
		onPending?: () => void
	): Promise<TokenResponse> {
		syncLog.debug(`DeviceCodeFlow: start polling (interval=${interval}s, expires=${expiresIn}s)`);
		this.cancelled = false;
		const startTime = Date.now();
		const expiresAt = startTime + expiresIn * 1000;

		// 连续网络错误阈值：超过就放弃，而不是傻等 device code 过期
		const MAX_NETWORK_ERRORS = 5;
		let networkErrorStreak = 0;

		while (Date.now() < expiresAt) {
			if (this.cancelled) {
				syncLog.info("DeviceCodeFlow: polling cancelled by user");
				throw new AuthenticationError("授权已取消");
			}

			try {
				const resp = await requestUrl({
					url: this.options.endpoints.token,
					method: "POST",
					contentType: "application/x-www-form-urlencoded",
					throw: false,
					body: new URLSearchParams({
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						client_id: this.options.clientId,
						device_code: deviceCode,
					}).toString(),
				});

				// 有 HTTP 响应 → 网络是通的，重置 streak
				networkErrorStreak = 0;

				if (resp.status === 200) {
					const data = resp.json as unknown as TokenResponse;
					syncLog.info("DeviceCodeFlow: token obtained successfully");
					return data;
				}

				const errBody = this.safeParseErrorBody(resp.text);
				const mapped = mapEntraAuthError(errBody.error, errBody.error_description);
				if (mapped) {
					// Entra 明确拒绝的错误（租户策略、未批准 app、账号类型不匹配）
					// —— 继续轮询也不会好，直接终止
					syncLog.warn(`DeviceCodeFlow: terminal error ${mapped.code}`);
					throw new AuthenticationError(mapped.message, mapped.code);
				}

				switch (errBody.error) {
					case "authorization_pending":
						// 用户还没在浏览器完成授权，继续等
						syncLog.debug("DeviceCodeFlow: authorization_pending");
						onPending?.();
						break;
					case "slow_down":
						// 服务器让我们放慢节奏，加 5 秒
						interval += 5;
						syncLog.debug(`DeviceCodeFlow: slow_down → new interval ${interval}s`);
						break;
					case "authorization_declined":
					case "access_denied":
						throw new AuthenticationError("你已拒绝授权请求。");
					case "expired_token":
						throw new AuthenticationError("设备码已过期，请重新发起授权。");
					default:
						throw new AuthenticationError(
							`授权失败：${errBody.error_description || errBody.error || `HTTP ${resp.status}`}`
						);
				}
			} catch (err) {
				if (err instanceof AuthenticationError) throw err;
				// 网络抖动 —— 计入 streak，没超过阈值就继续轮询
				networkErrorStreak++;
				syncLog.warn(
					`DeviceCodeFlow: network error (${networkErrorStreak}/${MAX_NETWORK_ERRORS})`,
					err instanceof Error ? err.message : String(err)
				);
				if (networkErrorStreak >= MAX_NETWORK_ERRORS) {
					throw new AuthenticationError(
						"连续网络错误过多，授权中止。请检查网络后重试。"
					);
				}
				onPending?.();
			}

			await sleep(interval * 1000);
		}

		throw new AuthenticationError("设备码已过期，请在插件中重新发起授权。");
	}

	/** 用 refresh_token 换一对新的 token（access_token + 新 refresh_token） */
	async refreshToken(refreshToken: string): Promise<TokenResponse> {
		syncLog.debug("DeviceCodeFlow: refreshing access token");
		try {
			const resp = await requestUrl({
				url: this.options.endpoints.token,
				method: "POST",
				contentType: "application/x-www-form-urlencoded",
				throw: false,
				body: new URLSearchParams({
					grant_type: "refresh_token",
					client_id: this.options.clientId,
					refresh_token: refreshToken,
				}).toString(),
			});

			if (resp.status !== 200) {
				const errBody = this.safeParseErrorBody(resp.text);
				throw new AuthenticationError(
					`Token 刷新失败：${errBody.error_description || errBody.error || `HTTP ${resp.status}`}`
				);
			}

			const data = resp.json as unknown as TokenResponse;
			syncLog.debug("DeviceCodeFlow: token refreshed");
			return data;
		} catch (err) {
			if (err instanceof AuthenticationError) throw err;
			syncLog.error("DeviceCodeFlow: refreshToken failed", err);
			throw new AuthenticationError(
				`Token 刷新失败：${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	// ─────────────────────────── private helpers ───────────────────────────

	/**
	 * requestUrl 的 .json 是惰性 getter，非 JSON 响应体（HTML 错误页 / 空 body）
	 * 会在 .json getter 里直接抛 SyntaxError。这里用 .text 原始文本手动 parse，
	 * 解析失败就返回空对象，绝不丢失 HTTP status。
	 */
	private safeParseErrorBody(text: string): { error?: string; error_description?: string } {
		try {
			return JSON.parse(text) as { error?: string; error_description?: string };
		} catch {
			return {};
		}
	}
}

