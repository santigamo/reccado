import { describe, expect, it } from "vitest";
import { checkTemplateLinks } from "#/lib/template-links";

const policy = { linkDomains: ["transcribo.app", "Mañana.example"], allowVariableLinks: false };
const html = (body: string, p = policy) => checkTemplateLinks({ bodyHtml: body }, p);
const text = (body: string, p = policy) => checkTemplateLinks({ bodyText: body }, p);
const refused = (r: ReturnType<typeof checkTemplateLinks>) => (r.ok ? null : r.reason);

describe("checkTemplateLinks", () => {
	it("allows the domain, its subdomains, mailto, fragments and relative paths", () => {
		expect(html('<a href="https://transcribo.app/x">a</a> <a href="https://APP.Transcribo.app/y?q=1">b</a>').ok).toBe(true);
		expect(html('<a href="mailto:hi@x.test">m</a><a href="#top">t</a><a href="/path">r</a>').ok).toBe(true);
		expect(text("Visit https://www.transcribo.app/help or mailto:a@b.co").ok).toBe(true);
	});
	it("refuses external hosts in href, src, srcset, css url(), @import, form action and meta refresh", () => {
		for (const body of [
			'<a href="https://evil.example/x">a</a>',
			'<img src="http://evil.example/p.png">',
			'<img srcset="https://transcribo.app/a.png 1x, https://evil.example/b.png 2x">',
			'<div style="background:url(https://evil.example/b.png)">x</div>',
			"<style>@import 'https://evil.example/a.css';</style>",
			'<form action="https://evil.example/post"></form>',
			'<meta http-equiv="refresh" content="0; url=https://evil.example">',
			"<p>see https://evil.example/now</p>",
		]) expect(refused(html(body)), body).toMatch(/not allowed/);
		expect(refused(text("go to www.evil.example"))).toMatch(/not allowed/);
	});
	it("does not treat lookalike hosts or userinfo tricks as the allowed domain", () => {
		for (const url of [
			"https://transcribo.app.evil.example/",
			"https://eviltranscribo.app/",
			"https://transcribo.app@evil.example/",
			"https://evil.example/transcribo.app",
			"https://evil.example#@transcribo.app",
		]) expect(html(`<a href="${url}">x</a>`).ok, url).toBe(false);
	});
	it("handles protocol-relative and backslash hosts", () => {
		expect(html('<a href="//evil.example/x">a</a>').ok).toBe(false);
		expect(html('<a href="\\\\evil.example/x">a</a>').ok).toBe(false);
		expect(html('<a href="//transcribo.app/x">a</a>').ok).toBe(true);
	});
	it("fails javascript:, data: and other schemes, even obfuscated", () => {
		for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "jav&#x61;script:alert(1)", "&#106;avascript:1", "data:text/html;base64,AAAA", "vbscript:x", "ftp://transcribo.app/x", "tel:+3412345"])
			expect(html(`<a href="${url}">x</a>`).ok, url).toBe(false);
		expect(html('<img src="data:image/png;base64,AAAA">').ok).toBe(false);
		expect(text("click javascript:alert(1)").ok).toBe(false);
	});
	it("normalises punycode and case in the policy and in links", () => {
		expect(html('<a href="https://xn--maana-pta.example/x">a</a>').ok).toBe(true);
		expect(html('<a href="https://MAÑANA.example/x">a</a>').ok).toBe(true);
		expect(html('<a href="https://sub.mañana.example/x">a</a>').ok).toBe(true);
	});
	it("fails template syntax in hosts and unknown-host bases", () => {
		const loose = { ...policy, allowVariableLinks: true };
		for (const url of ["https://{{host}}/x", "https://{{host}}.transcribo.app/x", "{{base}}/x", "https://transcribo.app@{{h}}/x", "{{url}}?x=1"])
			expect(html(`<a href="${url}">x</a>`, loose).ok, url).toBe(false);
	});
	it("allows a template variable in the path or query of an allowed host", () => {
		expect(html('<a href="https://transcribo.app/t/{{id}}?x={{y}}">x</a>').ok).toBe(true);
	});
	it("allows href=\"{{var}}\" only when the policy opts in, and reports it", () => {
		const a = '<a href="{{url}}">Open</a><a href="{{ link_2 }}">x</a>';
		expect(refused(html(a))).toMatch(/variable/);
		const loose = html(a, { ...policy, allowVariableLinks: true });
		expect(loose).toEqual({ ok: true, variableLinks: ["{{url}}", "{{link_2}}"] });
		// Only a whole-attribute single variable qualifies, and only for href.
		expect(html('<a href=" {{url}}x">x</a>', { ...policy, allowVariableLinks: true }).ok).toBe(false);
		expect(html('<img src="{{url}}">', { ...policy, allowVariableLinks: true }).ok).toBe(false);
		expect(html('<a href="{{a}}{{b}}">x</a>', { ...policy, allowVariableLinks: true }).ok).toBe(false);
	});
	it("finds links in unquoted and single-quoted attributes and link text", () => {
		expect(html("<a href=https://evil.example/x>x</a>").ok).toBe(false);
		expect(html("<a href='https://evil.example/x'>x</a>").ok).toBe(false);
		expect(html("<a href=\"https://transcribo.app\">https://evil.example</a>").ok).toBe(false);
	});
	it("fails closed on an invalid policy domain and passes when there are no links", () => {
		expect(checkTemplateLinks({ bodyHtml: "<p>hi</p>" }, { linkDomains: ["bad domain"], allowVariableLinks: false }).ok).toBe(false);
		expect(checkTemplateLinks({ bodyHtml: "<p>hi {{name}}</p>", bodyText: "hi {{name}}" }, { linkDomains: [], allowVariableLinks: false }).ok).toBe(true);
	});
});
