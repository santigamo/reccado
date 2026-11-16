import { describe, expect, it } from "vitest";
import {
	classifyAutomatedMail,
	isDmarcReportAttachment,
	isDmarcReportSubject,
} from "#/lib/automated-mail";

/**
 * What the web inbox hides as a DMARC aggregate report, and — more important —
 * what it must never hide. A false positive buries a person's mail; a false
 * negative only shows a report.
 */

const ZIP = (name: string) => ({ filename: name, contentType: "application/zip" });
const GZ = (name: string) => ({ filename: name, contentType: "application/gzip" });

function report(over: Partial<Parameters<typeof classifyAutomatedMail>[0]> = {}) {
	return classifyAutomatedMail({
		from: "noreply-dmarc-support@google.com",
		subject:
			"Report domain: send.transcribo.es Submitter: google.com Report-ID: 5799709528446682960",
		inReplyTo: null,
		references: [],
		attachments: [ZIP("google.com!send.transcribo.es!1763164800!1763251199.zip")],
		...over,
	});
}

describe("classifyAutomatedMail: positives", () => {
	it("Google: RFC 7489 subject with a zip", () => {
		expect(report()).toBe("dmarc_report");
	});

	it("the subject alone is enough when it has domain, submitter and Report-ID", () => {
		expect(report({ attachments: [] })).toBe("dmarc_report");
	});

	it("Yahoo: capitalised 'Report Domain', a submitter with a space, an angle-bracket id, .xml.gz", () => {
		expect(
			report({
				from: "dmarchelp@yahooinc.com",
				subject:
					"Report Domain: imsanti.dev Submitter: Yahoo Inc. Report-ID: <1763251200.774421@dmarc.yahoo.com>",
				attachments: [GZ("yahoo.com!imsanti.dev!1763164800!1763251199.xml.gz")],
			}),
		).toBe("dmarc_report");
	});

	it("Microsoft: protection.outlook.com submitter, hex Report-ID, gz with a unique-id part", () => {
		expect(
			report({
				from: "dmarcreport@microsoft.com",
				subject:
					"Report Domain: transcribo.es Submitter: enterprise.protection.outlook.com Report-ID: 4f7c3b1e8a2d4e6f9b0c1d2e3f4a5b6c",
				attachments: [
					{
						filename:
							"enterprise.protection.outlook.com!transcribo.es!1763164800!1763251200!4f7c3b1e.xml.gz",
						contentType: "application/x-gzip",
					},
				],
			}),
		).toBe("dmarc_report");
	});

	it("tolerates spacing, case, 'Report ID' and a [Preview] tag", () => {
		expect(
			isDmarcReportSubject("REPORT DOMAIN:example.com   SUBMITTER:mail.ru  REPORT ID: 12"),
		).toBe(true);
		expect(
			isDmarcReportSubject("[Preview] Report Domain: example.com Submitter: x.org Report-ID: 1"),
		).toBe(true);
	});

	it("subject without a Report-ID still counts when a report file is attached", () => {
		expect(
			report({
				subject: "Report domain: example.com Submitter: mx.example.net",
				attachments: [
					{
						filename: "mx.example.net!example.com!1763164800!1763251199.xml",
						contentType: "text/xml",
					},
				],
			}),
		).toBe("dmarc_report");
	});

	it("no RFC subject, but only report files, a report-ish subject and an automated sender", () => {
		expect(
			report({
				from: "dmarc-reports@mail.example.net",
				subject: "DMARC Aggregate Report for example.com",
				attachments: [
					{
						filename: "example.net!example.com!1763164800!1763251199.xml",
						contentType: "application/xml",
					},
				],
			}),
		).toBe("dmarc_report");
	});

	it("recognises the conventional report file names and types", () => {
		expect(isDmarcReportAttachment(ZIP("google.com!a.es!1763164800!1763251199.zip"))).toBe(true);
		expect(isDmarcReportAttachment(GZ("google.com!a.es!1763164800!1763251199.xml.gz"))).toBe(true);
		expect(
			isDmarcReportAttachment({
				filename: "google.com!a.es!1763164800!1763251199.xml",
				contentType: "text/xml; charset=utf-8",
			}),
		).toBe(true);
		expect(
			isDmarcReportAttachment({
				filename: "google.com!a.es!1763164800!1763251199.zip",
				contentType: "application/octet-stream",
			}),
		).toBe(true);
	});
});

describe("classifyAutomatedMail: negatives", () => {
	it("a person's mail that only talks about DMARC", () => {
		expect(
			classifyAutomatedMail({
				from: "ana@example.com",
				subject: "Our DMARC report looks wrong",
				inReplyTo: null,
				references: [],
				attachments: [],
			}),
		).toBeNull();
	});

	it("a person attaching a report file is still a person (sender not automated)", () => {
		expect(
			report({
				from: "ana@example.com",
				subject: "DMARC report from google, can you look?",
				attachments: [ZIP("google.com!send.transcribo.es!1763164800!1763251199.zip")],
			}),
		).toBeNull();
	});

	it("a reply quoting a report subject (In-Reply-To set)", () => {
		expect(report({ inReplyTo: "5799709528446682960@google.com" })).toBeNull();
	});

	it("anything with References is part of a conversation", () => {
		expect(report({ references: ["a@b"] })).toBeNull();
	});

	it("Re: / Fwd: / RV: prefixes, even with no threading headers", () => {
		for (const prefix of ["Re: ", "Fwd: ", "FW: ", "RV: ", "AW: "]) {
			expect(
				report({
					subject: `${prefix}Report domain: a.es Submitter: google.com Report-ID: 1`,
				}),
			).toBeNull();
		}
	});

	it("an RFC-shaped subject without Report-ID and without a report file", () => {
		expect(
			report({ subject: "Report domain: a.es Submitter: google.com", attachments: [] }),
		).toBeNull();
	});

	it("attachment-only: another attachment next to the report file is not enough", () => {
		expect(
			report({
				from: "noreply@example.net",
				subject: "Weekly report",
				attachments: [
					ZIP("example.net!example.com!1763164800!1763251199.zip"),
					{ filename: "invoice.pdf", contentType: "application/pdf" },
				],
			}),
		).toBeNull();
	});

	it("file names that only look similar, or have the wrong type", () => {
		expect(isDmarcReportAttachment(ZIP("report.zip"))).toBe(false);
		expect(isDmarcReportAttachment(ZIP("google.com!a.es!yesterday!today.zip"))).toBe(false);
		expect(
			isDmarcReportAttachment({
				filename: "google.com!a.es!1763164800!1763251199.zip",
				contentType: "application/pdf",
			}),
		).toBe(false);
		expect(isDmarcReportAttachment({ filename: null, contentType: "application/zip" })).toBe(false);
	});

	it("no subject at all", () => {
		expect(report({ subject: null, attachments: [] })).toBeNull();
	});
});
