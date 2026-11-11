/**
 * A P-256 software authenticator for the Workers test runtime.
 *
 * Registration is a `none` attestation (no attestation signature). Assertions
 * are real ECDSA signatures over authenticatorData || sha256(clientDataJSON),
 * wrapped in the DER form @simplewebauthn/server unwraps. That is the part the
 * passkey probe never reached.
 */

export type RegistrationResponse = {
	id: string;
	rawId: string;
	type: "public-key";
	response: {
		clientDataJSON: string;
		attestationObject: string;
		transports: string[];
	};
	clientExtensionResults: Record<string, never>;
	authenticatorAttachment: "platform";
};

export type AssertionResponse = {
	id: string;
	rawId: string;
	type: "public-key";
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
	};
	clientExtensionResults: Record<string, never>;
	authenticatorAttachment: "platform";
};

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return new Uint8Array(buffer);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const length = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return owned(out);
}

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function cborText(value: string): Uint8Array {
	const bytes = utf8(value);
	if (bytes.length >= 24) throw new Error("cbor text too long");
	return concat([new Uint8Array([0x60 + bytes.length]), bytes]);
}

function cborBytes(bytes: Uint8Array): Uint8Array {
	if (bytes.length < 24) return concat([new Uint8Array([0x40 + bytes.length]), bytes]);
	if (bytes.length < 256) return concat([new Uint8Array([0x58, bytes.length]), bytes]);
	throw new Error("cbor bytes too long");
}

function coseKey(x: Uint8Array, y: Uint8Array): Uint8Array {
	// Canonical key order: 1, 3, -1, -2, -3. ES256 / P-256.
	return concat([
		new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
		cborBytes(x),
		new Uint8Array([0x22]),
		cborBytes(y),
	]);
}

function uint32(value: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value);
	return bytes;
}

function derInteger(bytes: Uint8Array): Uint8Array {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
	let body = bytes.slice(start);
	if ((body[0] ?? 0) & 0x80) {
		const padded = new Uint8Array(body.length + 1);
		padded.set(body, 1);
		body = padded;
	}
	return concat([new Uint8Array([0x02, body.length]), body]);
}

function derSignature(raw: Uint8Array): Uint8Array {
	if (raw.length !== 64) throw new Error(`expected a 64-byte P-256 signature, got ${raw.length}`);
	const body = concat([derInteger(raw.slice(0, 32)), derInteger(raw.slice(32))]);
	if (body.length >= 128) throw new Error("DER signature too long");
	return concat([new Uint8Array([0x30, body.length]), body]);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	return owned(new Uint8Array(await crypto.subtle.digest("SHA-256", owned(bytes))));
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): Uint8Array {
	return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

export class SoftAuthenticator {
	private keys: CryptoKeyPair | null = null;
	private x: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
	private y: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
	readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
	/** The id the server stored, once registration has told us. */
	storedId: string | null = null;

	constructor(
		private readonly rpId: string,
		private readonly origin: string,
	) {}

	private async ensureKeys(): Promise<CryptoKeyPair> {
		if (this.keys) return this.keys;
		this.keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
		const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
		this.x = base64urlToBytes(jwk.x ?? "");
		this.y = base64urlToBytes(jwk.y ?? "");
		if (this.x.length !== 32 || this.y.length !== 32) throw new Error("unexpected P-256 coordinates");
		return this.keys;
	}

	private async authData(flags: number, counter: number, includeCredential: boolean): Promise<Uint8Array> {
		await this.ensureKeys();
		const head = concat([
			await sha256(utf8(this.rpId)),
			new Uint8Array([flags]),
			uint32(counter),
		]);
		if (!includeCredential) return head;
		const idLength = new Uint8Array(2);
		new DataView(idLength.buffer).setUint16(0, this.credentialId.length);
		return concat([
			head,
			new Uint8Array(16),
			idLength,
			this.credentialId,
			coseKey(this.x, this.y),
		]);
	}

	async registration(challenge: string): Promise<RegistrationResponse> {
		const authData = await this.authData(0x45, 0, true);
		const attestation = concat([
			new Uint8Array([0xa3]),
			cborText("fmt"),
			cborText("none"),
			cborText("attStmt"),
			new Uint8Array([0xa0]),
			cborText("authData"),
			cborBytes(authData),
		]);
		const id = base64url(this.credentialId);
		return {
			id,
			rawId: id,
			type: "public-key",
			response: {
				clientDataJSON: base64url(clientData("webauthn.create", challenge, this.origin)),
				attestationObject: base64url(attestation),
				transports: ["internal"],
			},
			clientExtensionResults: {},
			authenticatorAttachment: "platform",
		};
	}

	/** `counter` is the authenticator's sign count. The server rejects a repeat. */
	async assertion(challenge: string, counter: number): Promise<AssertionResponse> {
		const keys = await this.ensureKeys();
		const authenticatorData = await this.authData(0x05, counter, false);
		const collected = clientData("webauthn.get", challenge, this.origin);
		const raw = new Uint8Array(
			await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				keys.privateKey,
				owned(concat([authenticatorData, await sha256(collected)])),
			),
		);
		const id = this.storedId ?? base64url(this.credentialId);
		return {
			id,
			rawId: id,
			type: "public-key",
			response: {
				clientDataJSON: base64url(collected),
				authenticatorData: base64url(authenticatorData),
				signature: base64url(derSignature(raw)),
			},
			clientExtensionResults: {},
			authenticatorAttachment: "platform",
		};
	}
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
	const binary = atob(padded);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
