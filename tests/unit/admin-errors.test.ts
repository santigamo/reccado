import { describe, expect, it } from "vitest";
import { adminResponse, AdminRemoteError, readAdminResponse } from "#/lib/admin/errors";

describe("admin DO response mapping", () => {
	it("preserves response bytes and exposes parsed data", async () => {
		const result = await readAdminResponse(
			new Response('{ "value": 1 }', {
				status: 201,
				headers: { "content-type": "application/json" },
			}),
		);
		expect(result.value).toEqual({ value: 1 });
		const response = adminResponse(result);
		expect(response.status).toBe(201);
		expect(await response.text()).toBe('{ "value": 1 }');
	});
	it("preserves a DO error and exposes its stable code", async () => {
		const failure = await readAdminResponse(
			Response.json({ error: "template_not_found" }, { status: 404 }),
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AdminRemoteError);
		expect(failure).toMatchObject({
			code: "template_not_found",
			status: 404,
			body: '{"error":"template_not_found"}',
		});
	});
});
