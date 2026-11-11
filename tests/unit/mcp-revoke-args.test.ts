import { describe, expect, it } from "vitest";
import { parseMcpRevokeArgs } from "../../src/api/oauth-client-routes";

describe("parseMcpRevokeArgs", () => {
	it("accepts one opaque client id", () => {
		expect(parseMcpRevokeArgs(["ClaudeCodeClientId1234567890abcd"])).toBe(
			"ClaudeCodeClientId1234567890abcd",
		);
		expect(parseMcpRevokeArgs(["az.AZ_09~-"])).toBe("az.AZ_09~-");
	});

	it("rejects a missing, repeated, or unsafe client id", () => {
		expect(() => parseMcpRevokeArgs([])).toThrow(/requires a client_id/);
		expect(() => parseMcpRevokeArgs(["one", "two"])).toThrow(/exactly one/);
		for (const bad of [
			"",
			"has space",
			"a/b",
			"https://client.example/cb",
			"../x",
			"x".repeat(257),
		]) {
			expect(() => parseMcpRevokeArgs([bad])).toThrow(/client_id must be 1-256/);
		}
	});
});
