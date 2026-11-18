import { describe, expect, it } from "vitest";
import {
	EMAIL_BASE_STYLE,
	INTER_FONT_PATH,
	isRemoteUrl,
	neutralizeRemoteCss,
	prepareEmailHtml,
} from "#/lib/email-html";

/**
 * A sender-controlled body, prepared for the inbox frame: nothing in it may
 * reach another origin while images are off, whatever the CSP covers.
 */

const prepare = (html: string, images = false) => prepareEmailHtml(html, new Map(), images);

describe("prepareEmailHtml", () => {
	it("removes meta refresh in any case or quoting, and referrer overrides, in both modes", async () => {
		const html = `<html><head>
      <META HTTP-EQUIV='Refresh' content='0;url=https://t.example/r'>
      <meta http-equiv=refresh content="0; URL=https://t.example/r2">
      <meta name="Referrer" content="unsafe-url">
      <meta charset="utf-8">
    </head><body><img src="https://t.example/i" referrerpolicy="unsafe-url"><a href="https://x.example" ping="https://t.example/p">x</a></body></html>`;
		for (const images of [false, true]) {
			const out = await prepare(html, images);
			expect(out).not.toMatch(/refresh/i);
			expect(out).not.toMatch(/name="referrer"/i);
			expect(out).not.toMatch(/referrerpolicy|ping=/i);
			expect(out).toContain('<meta charset="utf-8">');
		}
	});

	it("removes the sender's base, every link and embedding or active element, in both modes", async () => {
		const html = `<head><base href="https://t.example/"><link rel="dns-prefetch" href="//t.example"><link rel=preconnect href="https://t.example"><link rel="prefetch" href="https://t.example/p"><link rel="stylesheet" href="https://t.example/s.css"></head>
      <body><object data="https://t.example/o"></object><embed src="https://t.example/e"><iframe src="https://t.example/f"></iframe><frame src="https://t.example/fr"><p>after frame</p><script>x</script><noscript><img src="https://t.example/n"></noscript><p>kept</p></body>`;
		for (const images of [false, true]) {
			const out = await prepare(html, images);
			expect(out).not.toMatch(/<(base|link|object|embed|iframe|frame|script|noscript)\b/i);
			expect(out).not.toContain("t.example");
			expect(out).toContain("<p>kept</p>");
			expect(out).toContain("<p>after frame</p>");
		}
	});

	it("with images off, moves every remote source aside and marks the body", async () => {
		const out = await prepare(`<head></head><body background="https://t.example/bg">
      <img src="https://t.example/i" srcset="https://t.example/i2 2x">
      <video poster="//t.example/poster"><source src="https://t.example/v.mp4"></video>
      <audio src="http://t.example/a"></audio>
      <svg><image href="https://t.example/s"/><use xlink:href="https://t.example/u#x"/></svg>
      <input type="image" src="https://t.example/in">
      <a href="https://example.org/page">link stays</a>
      <img src="/api/mailboxes/m/messages/x/attachments/a?inline=1"><img src="data:image/png;base64,AA=="></body>`);
		expect(out).not.toMatch(
			/\s(src|srcset|background|poster|href|xlink:href)="(https?:)?\/\/t\.example/,
		);
		expect(out).toContain('data-blocked-poster="//t.example/poster"');
		expect(out).toContain('data-blocked-xlink-href="https://t.example/u#x"');
		expect(out).toContain('href="https://example.org/page"');
		expect(out).toContain('src="/api/mailboxes/m/messages/x/attachments/a?inline=1"');
		expect(out).toContain('src="data:image/png;base64,AA=="');
		expect(out).toContain('<meta name="reccado-remote-blocked" content="1">');
	});

	it("with images off, neutralises CSS url(), image-set() and @import in attributes and blocks", async () => {
		const out = await prepare(`<head><style>
      @import url("https://t.example/i.css");
      body { background: url( 'https://t.example/b' ) }
      .x { background-image: -webkit-image-set("https://t.example/s" 1x) }
      .ok { background: url(data:image/png;base64,AA==) }
      a > b { color: red }
    </style></head><body><div style="background:URL(//t.example/d)">x</div><header>h</header></body>`);
		expect(out).not.toContain('t.example/i.css")');
		expect(out).not.toMatch(/url\(\s*['"]?(https?:)?\/\/t\.example/i);
		expect(out).not.toMatch(/@import/i);
		expect(out).toContain("url(data:image/png;base64,AA==)");
		expect(out).toContain("a > b { color: red }");
		expect(out).toContain('style="background:url(about:invalid)"');
		// Marker goes into <head>, not into <header>.
		expect(out).toMatch(/<head><meta name="reccado-remote-blocked"/);
		expect(out).toContain("<header>h</header>");
	});

	it("with images on, leaves remote images and CSS for the CSP to allow", async () => {
		const html = `<head></head><body><img src="https://t.example/i"><div style="background:url(https://t.example/d)">x</div></body>`;
		const out = await prepare(html, true);
		expect(out).toContain('src="https://t.example/i"');
		expect(out).toContain("url(https://t.example/d)");
		expect(out).not.toContain("reccado-remote-blocked");
	});

	it("leaves a body with nothing remote unmarked", async () => {
		const out = await prepare("<head></head><body><p>Hello</p></body>");
		expect(out).not.toContain("reccado-remote-blocked");
	});
});

describe("neutralizeRemoteCss", () => {
	it("drops CSS that reaches a remote URL only through escapes", () => {
		expect(neutralizeRemoteCss("background:\\75 rl(https://t.example/x)")).toEqual({
			css: "",
			blocked: true,
		});
	});

	it("keeps same-origin and inline URLs", () => {
		const css = "background:url(/a.png); x: url(data:,x)";
		expect(neutralizeRemoteCss(css)).toEqual({ css, blocked: false });
	});

	it("knows what leaves this origin", () => {
		expect(isRemoteUrl("https://a")).toBe(true);
		expect(isRemoteUrl("//a")).toBe(true);
		expect(isRemoteUrl(" 'ftp://a' ")).toBe(true);
		expect(isRemoteUrl("/a")).toBe(false);
		expect(isRemoteUrl("data:x")).toBe(false);
		expect(isRemoteUrl("cid:x")).toBe(false);
	});
});

describe("EMAIL_BASE_STYLE", () => {
	const css = EMAIL_BASE_STYLE.replace(/^<style>|<\/style>$/g, "");

	it("loads Inter from this origin only: latin and latin-ext, upright and italic", () => {
		const faces = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]!);
		expect(faces).toHaveLength(4);
		const urls = faces.map((face) => /src:url\(([^)]+)\)/.exec(face)?.[1]);
		expect(urls.sort()).toEqual(
			[
				"inter-latin-ext-wght-italic.woff2",
				"inter-latin-ext-wght-normal.woff2",
				"inter-latin-wght-italic.woff2",
				"inter-latin-wght-normal.woff2",
			].map((file) => `${INTER_FONT_PATH}/${file}`),
		);
		for (const face of faces) {
			expect(face).toContain("font-family:Inter");
			expect(face).toContain("font-weight:100 900");
			expect(face).toMatch(/unicode-range:U\+/);
		}
		expect(EMAIL_BASE_STYLE).not.toMatch(/https?:|\/\//);
	});
});
