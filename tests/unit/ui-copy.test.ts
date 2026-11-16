import { describe, expect, it } from "vitest";
import { displayTitle, displayWarning, renderApprovalPage } from "#/components/approval-page";
import { warningText } from "#/lib/approval-copy";
import { formatDay, formatDayTime, formatFullDate, formatListDate } from "#/lib/dates";

describe("UI dates are English whatever the locale", () => {
	const now = new Date(2026, 10, 16, 15, 0); // Mon 16 Nov 2026, local time

	it("list stamps", () => {
		expect(formatListDate(new Date(2026, 10, 16, 10, 42), now)).toBe("10:42");
		expect(formatListDate(new Date(2026, 10, 15, 9, 5), now)).toBe("Yesterday");
		expect(formatListDate(new Date(2026, 10, 3, 9, 5), now)).toBe("Nov 3");
		expect(formatListDate(new Date(2025, 0, 9, 9, 5), now)).toBe("Jan 9, 2025");
		expect(formatListDate("not a date", now)).toBe("");
	});

	it("message header and full stamps", () => {
		expect(formatDayTime(new Date(2026, 10, 16, 10, 42), now)).toBe("Today, 10:42");
		expect(formatDayTime(new Date(2026, 10, 15, 18, 4), now)).toBe("Yesterday, 18:04");
		expect(formatDayTime(new Date(2026, 10, 14, 17, 20), now)).toBe("Nov 14, 17:20");
		expect(formatFullDate(new Date(2026, 10, 16, 13, 11))).toBe("Mon, 16 Nov 2026, 13:11");
		expect(formatDay(new Date(2026, 2, 12))).toBe("12 Mar 2026");
	});
});

describe("approval warnings: one English mapping, server text as fallback", () => {
	it("translates known codes, including ones with details in the message", () => {
		expect(
			warningText({ code: "live_key", message: "Clave de producción: podrá enviar correo real." }),
		).toBe("Live key: it will be able to send real mail.");
		expect(
			warningText({
				code: "dmarc_external_rua",
				message: "Los informes DMARC agregados se enviarán a una dirección externa: r@x.example",
			}),
		).toBe("Aggregate DMARC reports will go to an outside address: r@x.example");
	});

	it("falls back to the server text for unknown codes or unreadable details", () => {
		expect(warningText({ code: "brand_new", message: "Texto del servidor" })).toBe(
			"Texto del servidor",
		);
		expect(warningText({ code: "dmarc_external_rua", message: "otra forma" })).toBe("otra forma");
		expect(displayWarning({ message: "sin código" })).toBe("sin código");
	});

	it("the standalone page renders the same English copy", () => {
		const html = renderApprovalPage({
			title: "Crear clave API",
			status: "pending",
			kind: "api_key_create",
			fields: [{ label: "Entorno", value: "live" }],
			warnings: [
				{ code: "live_key", message: "Clave de producción: podrá enviar correo real." },
				{ code: "unknown_code", message: "Aviso nuevo" },
			],
		});
		expect(html).toContain("Create an API key");
		expect(html).toContain("Environment");
		expect(html).toContain("Live key: it will be able to send real mail.");
		expect(html).toContain("Aviso nuevo");
		expect(displayTitle("Revisar envío")).toBe("Review this email before it is sent");
	});
});
