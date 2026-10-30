/**
 * 有界缓存与派生值缓存的基元。
 *
 * 纯模块：无 React、无其它 import。容量上限与淘汰顺序在此收口，调用方只给出容量与计算方法。
 */

/** 缓存容量配置。 */
export interface CacheLimit {
	/** 允许保留的最大条目数。 */
	readonly limit: number;
	/** 超限时淘汰到的比例：淘汰后条目数为 `ceil(limit * ratio)`。默认为 0.8。 */
	readonly ratio?: number;
}

/**
 * 按插入顺序淘汰的映射表。
 *
 * `get` 命中即把该键移到最新；`peek` 不改变次序。容量只由构造参数决定。
 */
export class LruMap<K, V> {
	private readonly entries = new Map<K, V>();
	private readonly maxSize: number;
	private readonly ratio: number;

	/**
	 * @param options - 容量与淘汰比例。
	 */
	constructor(options: CacheLimit) {
		this.maxSize = Math.max(1, Math.trunc(options.limit));
		const ratio = options.ratio ?? 0.8;
		this.ratio = ratio > 0 && ratio <= 1 ? ratio : 0.8;
	}

	/** 当前条目数。 */
	get size(): number {
		return this.entries.size;
	}

	/** 允许保留的最大条目数。 */
	get limit(): number {
		return this.maxSize;
	}

	/**
	 * 取值；命中后把该键移到最新。
	 *
	 * @param key - 键。
	 * @returns 已缓存的值；未缓存时为 undefined。
	 */
	get(key: K): V | undefined {
		const value = this.entries.get(key);
		if (value === undefined && !this.entries.has(key)) return undefined;
		this.entries.delete(key);
		this.entries.set(key, value as V);
		return value;
	}

	/**
	 * 取值但不改变次序。
	 *
	 * @param key - 键。
	 * @returns 已缓存的值；未缓存时为 undefined。
	 */
	peek(key: K): V | undefined {
		return this.entries.get(key);
	}

	/**
	 * @param key - 键。
	 * @returns 是否已缓存该键（不改变次序）。
	 */
	has(key: K): boolean {
		return this.entries.has(key);
	}

	/**
	 * 写值；写入后超容时按插入序淘汰最旧的若干个。
	 *
	 * @param key - 键。
	 * @param value - 值。
	 * @returns 本对象，便于连续写入。
	 */
	set(key: K, value: V): this {
		this.entries.delete(key);
		this.entries.set(key, value);
		if (this.entries.size > this.maxSize) this.trim();
		return this;
	}

	/**
	 * 删键。
	 *
	 * @param key - 键。
	 * @returns 原先是否存在该键。
	 */
	delete(key: K): boolean {
		return this.entries.delete(key);
	}

	/** 清空。 */
	clear(): void {
		this.entries.clear();
	}

	/**
	 * 按键的新旧顺序（旧到新）遍历键。
	 *
	 * @returns 键的迭代器。
	 */
	keys(): IterableIterator<K> {
		return this.entries.keys();
	}

	/** 淘汰到 `ceil(limit * ratio)`。 */
	private trim(): void {
		const target = Math.max(1, Math.ceil(this.maxSize * this.ratio));
		for (const key of this.entries.keys()) {
			if (this.entries.size <= target) return;
			this.entries.delete(key);
		}
	}
}

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
