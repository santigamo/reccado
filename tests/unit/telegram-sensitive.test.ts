import { describe, expect, it } from "vitest";
import { formatExpiry, noticeStateFor } from "#/telegram/approval-notices";
import { renderInboundNotification } from "#/telegram/format";
import { renderDecidedNotice, renderIntentCardText } from "#/telegram/intent-cards";
import {
	isInstanceAuthSubject,
	maskSensitiveSubject,
	telegramSensitivity,
} from "#/telegram/sensitive";

const env = { MAIL_FROM_ADDRESS: "noreply@send.example" } as unknown as Env;
const base = { fromAddr: "someone@example.com", subject: "Hola", snippet: "Qué tal" };

describe("telegramSensitivity", () => {
	it("trusts the DO's stored verdict when the row was classified", () => {
		expect(
			telegramSensitivity(env, {
				...base,
				message: { sensitive_classified: 1, sensitive_kind: "magic_link", body_text: "x" },
			}),
		).toBe("magic_link");
		expect(
			telegramSensitivity(env, {
				...base,
				message: { sensitive_classified: 1, sensitive_kind: null, body_text: "x" },
			}),
		).toBeNull();
	});

	it("hides the instance's own auth mail by stored kind, sender or template subject", () => {
		const clean = { sensitive_classified: 1, sensitive_kind: null, body_text: "x" };
		expect(
			telegramSensitivity(env, {
				...base,
				message: { ...clean, sensitive_kind: "instance_auth" },
			}),
		).toBe("otp");
		expect(
			telegramSensitivity(env, { ...base, fromAddr: "NoReply@Send.Example", message: clean }),
		).toBe("otp");
		expect(
			telegramSensitivity(env, { ...base, subject: "Your Reccado sign-in code", message: clean }),
		).toBe("otp");
		expect(isInstanceAuthSubject("Reset your Reccado password")).toBe(true);
		expect(isInstanceAuthSubject("Reset your password")).toBe(false);
	});

	it("fails closed on rows it cannot judge: failed parse, HTML only", () => {
		expect(
			telegramSensitivity(env, { ...base, message: { parse_status: "failed", body_text: null } }),
		).toBe("otp");
		expect(
			telegramSensitivity(env, {
				...base,
				message: { sensitive_classified: 0, body_text: null, body_html_r2_key: "h" },
			}),
		).toBe("otp");
	});

	it("classifies an unclassified row from its stored body, and an unreadable DO from the snippet", () => {
		expect(
			telegramSensitivity(env, {
				...base,
				message: { sensitive_classified: 0, body_text: "Your verification code is 123456" },
			}),
		).toBe("otp");
		expect(
			telegramSensitivity(env, { ...base, snippet: "Your login code: 998877", message: null }),
		).not.toBeNull();
		expect(telegramSensitivity(env, { ...base, message: null })).toBeNull();
	});
});

describe("maskSensitiveSubject", () => {
	it("masks codes and digit runs in the subject", () => {
		expect(maskSensitiveSubject("Your code is 123456", "otp")).not.toContain("123456");
		expect(maskSensitiveSubject("Código 12 34 56", "otp")).not.toMatch(/12 34 56/);
		expect(maskSensitiveSubject("Account 4417 1234 5678 9113", "otp")).not.toMatch(/\d{4}/);
		expect(maskSensitiveSubject(null, "otp")).toBeNull();
	});
});

describe("a sensitive card", () => {
	it("prints the placeholder, never the snippet or the file names", () => {
		const text = renderInboundNotification({
			fromAddr: "a@example.com",
			mailboxAddress: "b@example.com",
			subject: "Acceso",
			snippet: "Introduce 482913",
			hasAttachments: true,
			attachments: [{ filename: "codigo-482913.pdf", size: 10 }],
			sensitive: true,
		});
		expect(text).not.toContain("482913");
		expect(text).toContain("Contenido sensible oculto");
		expect(text).toContain("📎 con adjuntos");
	});
});

describe("approval notice text", () => {
	const view = {
		id: "x",
		kind: "send",
		status: "pending" as const,
		title: "Revisar envío",
		fields: Array.from({ length: 8 }, (_, index) => ({ label: `F${index}`, value: `v${index}` })),
		warnings: [],
		payloadHash: null,
		expiresAt: "2026-11-16T12:10:00.000Z",
	};

	it("is a summary with the expiry and no URL", () => {
		const text = renderIntentCardText(view, { expires: formatExpiry(view.expiresAt, 60) });
		expect(text).toContain("F3");
		expect(text).not.toContain("F4");
		expect(text).toContain("ver detalle completo");
		expect(text).toContain("Caduca a las 13:10 (UTC+01:00)");
		expect(text).not.toContain("http");
	});

	it("says the decided state", () => {
		expect(renderDecidedNotice(view, "approved")).toContain("Aprobado");
		expect(renderDecidedNotice(view, "denied")).toContain("Denegado");
		expect(renderDecidedNotice(view, "expired")).toContain("Caducado");
		expect(noticeStateFor("sent")).toBe("approved");
		expect(noticeStateFor("executed")).toBe("approved");
		expect(noticeStateFor("pending")).toBe("pending");
	});

	it("formats the expiry in UTC when no offset is known", () => {
		expect(formatExpiry("2026-11-16T23:55:00.000Z", 0)).toBe("23:55 (UTC)");
		expect(formatExpiry("2026-11-16T23:55:00.000Z", 120)).toBe("01:55 (UTC+02:00)");
		expect(formatExpiry(null, 0)).toBeNull();
	});
});
