/**
 * 有界缓存与派生值缓存的基元。
 *
 * 纯模块：无 React、无其它 import。容量上限与淘汰顺序在 {@link LruMap} 里收口，
 * 宿主半边与客户端半边共用同一份实现。
 */
import { LruMap, type CacheLimit } from '../../shared/lru-map.ts';

export { LruMap, type CacheLimit } from '../../shared/lru-map.ts';

/** 缓存容器的读写面：`Map`、`WeakMap` 与 {@link LruMap} 都满足。 */
interface CacheStore<K, V> {
	has(key: K): boolean;
	get(key: K): V | undefined;
	set(key: K, value: V): unknown;
}

/**
 * 用「有无、读、写」三件操作的容器包装计算方法。
 *
 * @param compute - 未缓存时的计算方法。
 * @param store - 缓存容器。
 * @returns 带缓存的取值函数。
 */
function cachedBy<K, V>(compute: (key: K) => V, store: CacheStore<K, V>): (key: K) => V {
	return (key: K): V => {
		if (store.has(key)) return store.get(key) as V;
		const value = compute(key);
		store.set(key, value);
		return value;
	};
}

/**
 * 按对象身份缓存派生值；键随对象回收，无需容量上限。
 *
 * @param compute - 由键计算值。
 * @returns 带缓存的取值函数；同一对象返回同一引用。
 */
export function forObject<K extends object, V>(compute: (key: K) => V): (key: K) => V {
	return cachedBy(compute, new WeakMap<K, V>());
}

/**
 * 按键值缓存派生值，容量有上限。
 *
 * @param compute - 由键计算值。
 * @param options - 容量与淘汰比例。
 * @returns 带缓存的取值函数；淘汰后再次取值会重算。
 */
export function forKey<K, V>(compute: (key: K) => V, options: CacheLimit): (key: K) => V {
	return cachedBy(compute, new LruMap<K, V>(options));
}

/**
 * 逐项比对两个映射表。
 *
 * @param left - 左侧映射表。
 * @param right - 右侧映射表。
 * @param equals - 值的相等判据，默认 `Object.is`。
 * @returns 键集合与值都相等时为 true。
 */
export function mapsEqual<K, V>(
	left: ReadonlyMap<K, V>,
	right: ReadonlyMap<K, V>,
	equals: (a: V, b: V) => boolean = Object.is,
): boolean {
	if (left === right) return true;
	if (left.size !== right.size) return false;
	for (const [key, value] of left) {
		if (!right.has(key)) return false;
		if (!equals(value, right.get(key) as V)) return false;
	}
	return true;
}

/**
 * 就地淘汰最旧的条目，使条目数不超过上限。
 *
 * @param map - 待淘汰的映射表。
 * @param limit - 保留的最大条目数。
 * @returns 传入的同一个映射表。
 */
export function trimOldest<K, V>(map: Map<K, V>, limit: number): Map<K, V> {
	for (const key of map.keys()) {
		if (map.size <= limit) return map;
		map.delete(key);
	}
	return map;
}