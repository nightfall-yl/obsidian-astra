/**
 * Map Microsoft Entra ID (Azure AD) OAuth error codes to user-friendly messages.
 *
 * When a device-code or token request fails, Entra includes an AADSTSxxxxx code
 * in `error_description`. We map the most likely codes here so the user sees
 * something actionable instead of a raw internal ID.
 *
 * Codes not recognized fall through to `null`, so the caller can still show
 * the raw `error_description` as last resort.
 */

export interface EntraAuthErrorInfo {
	code: string;
	message: string;
}

/**
 * Try to identify an Entra error from the OAuth error body.
 * @param oauthError  The `error` field (e.g. `invalid_client`, `access_denied`, `interaction_required`)
 * @param description The `error_description` field, which may contain an AADSTSxxxxx code
 * @returns A friendly message if we matched a known code, or null otherwise.
 */
export function mapEntraAuthError(
	oauthError?: string,
	description?: string
): EntraAuthErrorInfo | null {
	const desc = description ?? "";

	// ── Entra AADSTS codes (found inside error_description) ──

	// 租户条件访问策略拒绝 device code（最常见的"企业账号没法用"场景）
	if (desc.includes("AADSTS50152")) {
		return {
			code: "AADSTS50152",
			message:
				"你使用的是企业/学校 Microsoft 365 账号，但本插件的 OneDrive 同步仅支持个人 Microsoft 账号（@outlook.com / @hotmail.com 等）。请改用个人账号登录，或使用 OneDrive 原生同步客户端。",
		};
	}

	// 租户需要管理员批准这个应用（企业账号常见）
	if (desc.includes("AADSTS70002")) {
		return {
			code: "AADSTS70002",
			message:
				"你使用的是企业/学校 Microsoft 365 账号，但本插件的 OneDrive 同步仅支持个人 Microsoft 账号（@outlook.com / @hotmail.com 等）。请改用个人账号登录。",
		};
	}

	// 账号类型不匹配 app 注册（个人账号配企业 app 或反之）
	if (desc.includes("AADSTS50020") || desc.includes("AADSTS50026")) {
		return {
			code: desc.includes("AADSTS50020") ? "AADSTS50020" : "AADSTS50026",
			message:
				"你登录的账号类型与本插件不兼容。本插件的 OneDrive 同步仅支持个人 Microsoft 账号（@outlook.com / @hotmail.com 等），不支持企业/学校 Microsoft 365 账号。",
		};
	}

	// device code 无效或已过期（用户没在有效期内输入）
	if (desc.includes("AADSTS50166")) {
		return {
			code: "AADSTS50166",
			message: "设备码已失效或不存在。请在插件中重新发起授权。",
		};
	}

	// 设备码已被其他会话使用（很少见，通常是快速重开两个授权流程）
	if (desc.includes("AADSTS50194")) {
		return {
			code: "AADSTS50194",
			message: "此设备码已被其他会话使用。请在插件中重新发起授权。",
		};
	}

	// 交互式登录必须（企业安全策略要求用户在浏览器重新交互）
	if (desc.includes("AADSTS16002")) {
		return {
			code: "AADSTS16002",
			message:
				"Microsoft 需要在浏览器中完成额外的验证步骤。请在浏览器中按提示完成验证后重新发起授权。",
		};
	}

	// ── OAuth-level error codes ──
	switch (oauthError) {
		case "access_denied":
		case "authorization_declined":
			return {
				code: oauthError,
				message: "你已取消或拒绝了授权请求。",
			};
		case "expired_token":
			return {
				code: oauthError,
				message: "设备码已过期。请在插件中重新发起授权。",
			};
		case "invalid_client":
			return {
				code: oauthError,
				message: "客户端 ID 无效。请联系插件作者报告此问题。",
			};
		case "interaction_required":
			return {
				code: oauthError,
				message:
					"Microsoft 需要在浏览器中完成额外验证。请在插件中重新发起授权。",
			};
		case "temporarily_unavailable":
			return {
				code: oauthError,
				message: "Microsoft 身份验证服务暂时不可用，请稍后重试。",
			};
		default:
			return null;
	}
}
