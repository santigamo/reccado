// Minimal Reflect metadata polyfill, as an ES module so it runs in import order.
//
// `@simplewebauthn/server` → `@peculiar/x509` → `tsyringe` throws at module evaluation when
// `Reflect.getMetadata` is missing. The `reflect-metadata` package is CommonJS, which the bundler
// wraps lazily and evaluates after the chunk that contains tsyringe, so it cannot help here.
// Import this module first in every file that imports `@simplewebauthn/server` or
// `@better-auth/passkey`.

type Key = unknown;
type Target = object;
type Store = Map<string | symbol | undefined, Map<Key, unknown>>;

const R = Reflect as unknown as Record<string, unknown>;

if (typeof R.getMetadata !== "function") {
	const stores = new WeakMap<Target, Store>();
	const own = (target: Target, property: string | symbol | undefined, create: boolean) => {
		let byProperty = stores.get(target);
		if (!byProperty) {
			if (!create) return undefined;
			byProperty = new Map();
			stores.set(target, byProperty);
		}
		let map = byProperty.get(property);
		if (!map && create) {
			map = new Map();
			byProperty.set(property, map);
		}
		return map;
	};
	const chain = function* (target: Target) {
		for (let t: Target | null = target; t; t = Object.getPrototypeOf(t)) yield t;
	};

	R.defineMetadata = (key: Key, value: unknown, target: Target, property?: string | symbol) => {
		own(target, property, true)!.set(key, value);
	};
	R.getOwnMetadata = (key: Key, target: Target, property?: string | symbol) =>
		own(target, property, false)?.get(key);
	R.hasOwnMetadata = (key: Key, target: Target, property?: string | symbol) =>
		own(target, property, false)?.has(key) ?? false;
	R.getMetadata = (key: Key, target: Target, property?: string | symbol) => {
		for (const t of chain(target)) {
			const map = own(t, property, false);
			if (map?.has(key)) return map.get(key);
		}
		return undefined;
	};
	R.hasMetadata = (key: Key, target: Target, property?: string | symbol) => {
		for (const t of chain(target)) if (own(t, property, false)?.has(key)) return true;
		return false;
	};
	R.getOwnMetadataKeys = (target: Target, property?: string | symbol) => [
		...(own(target, property, false)?.keys() ?? []),
	];
	R.getMetadataKeys = (target: Target, property?: string | symbol) => {
		const keys = new Set<Key>();
		for (const t of chain(target)) for (const k of own(t, property, false)?.keys() ?? []) keys.add(k);
		return [...keys];
	};
	R.deleteMetadata = (key: Key, target: Target, property?: string | symbol) =>
		own(target, property, false)?.delete(key) ?? false;
	R.metadata =
		(key: Key, value: unknown) =>
		(target: Target, property?: string | symbol) =>
			(R.defineMetadata as (k: Key, v: unknown, t: Target, p?: string | symbol) => void)(
				key,
				value,
				target,
				property,
			);
}

export {};
