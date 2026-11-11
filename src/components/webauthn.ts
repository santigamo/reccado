/**
 * Browser WebAuthn helpers. The server returns base64url challenges; the
 * platform API wants ArrayBuffers. No library: the conversion is the whole job.
 */

type CredentialDescriptor = { id: string; transports?: string[] };

export type PasskeyCreationOptions = {
	challenge: string;
	rp: { name: string; id?: string };
	user: { id: string; name: string; displayName: string };
	pubKeyCredParams: PublicKeyCredentialParameters[];
	timeout?: number;
	excludeCredentials?: CredentialDescriptor[];
	authenticatorSelection?: AuthenticatorSelectionCriteria;
	attestation?: AttestationConveyancePreference;
};

function bytesToBase64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64urlToBytes(value: string): Uint8Array {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function registerPasskey(options: PasskeyCreationOptions): Promise<{
	id: string;
	rawId: string;
	type: "public-key";
	response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
	clientExtensionResults: AuthenticationExtensionsClientOutputs;
	authenticatorAttachment?: string;
}> {
	const credential = (await navigator.credentials.create({
		publicKey: {
			challenge: asBuffer(base64urlToBytes(options.challenge)),
			rp: options.rp,
			user: {
				id: asBuffer(base64urlToBytes(options.user.id)),
				name: options.user.name,
				displayName: options.user.displayName,
			},
			pubKeyCredParams: options.pubKeyCredParams,
			timeout: options.timeout,
			attestation: options.attestation,
			authenticatorSelection: options.authenticatorSelection,
			excludeCredentials: options.excludeCredentials?.map((credential) => ({
				type: "public-key" as const,
				id: asBuffer(base64urlToBytes(credential.id)),
				transports: credential.transports as AuthenticatorTransport[] | undefined,
			})),
		},
	})) as PublicKeyCredential | null;
	if (!credential) throw new Error("passkey_cancelled");
	const response = credential.response as AuthenticatorAttestationResponse;
	return {
		id: credential.id,
		rawId: bytesToBase64url(new Uint8Array(credential.rawId)),
		type: "public-key",
		response: {
			clientDataJSON: bytesToBase64url(new Uint8Array(response.clientDataJSON)),
			attestationObject: bytesToBase64url(new Uint8Array(response.attestationObject)),
			transports: response.getTransports?.(),
		},
		clientExtensionResults: credential.getClientExtensionResults(),
		authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
	};
}

export async function authenticatePasskey(input: {
	challenge: string;
	allowCredentials: CredentialDescriptor[];
}): Promise<{
	id: string;
	rawId: string;
	type: "public-key";
	response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
	clientExtensionResults: AuthenticationExtensionsClientOutputs;
	authenticatorAttachment?: string;
}> {
	const credential = (await navigator.credentials.get({
		publicKey: {
			challenge: asBuffer(base64urlToBytes(input.challenge)),
			rpId: location.hostname,
			userVerification: "required",
			allowCredentials: input.allowCredentials.map((item) => ({
				type: "public-key" as const,
				id: asBuffer(base64urlToBytes(item.id)),
				transports: item.transports as AuthenticatorTransport[] | undefined,
			})),
		},
	})) as PublicKeyCredential | null;
	if (!credential) throw new Error("passkey_cancelled");
	const response = credential.response as AuthenticatorAssertionResponse;
	const userHandle = response.userHandle ? bytesToBase64url(new Uint8Array(response.userHandle)) : undefined;
	return {
		id: credential.id,
		rawId: bytesToBase64url(new Uint8Array(credential.rawId)),
		type: "public-key",
		response: {
			clientDataJSON: bytesToBase64url(new Uint8Array(response.clientDataJSON)),
			authenticatorData: bytesToBase64url(new Uint8Array(response.authenticatorData)),
			signature: bytesToBase64url(new Uint8Array(response.signature)),
			...(userHandle ? { userHandle } : {}),
		},
		clientExtensionResults: credential.getClientExtensionResults(),
		authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
	};
}
