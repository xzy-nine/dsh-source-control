/**
 * 有界缓存的淘汰基元：宿主半边与客户端半边共用同一份容量与淘汰顺序实现。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */

/**
 * 超出容量后回落到的比例：一次淘汰一批，不在容量边界上逐条删。
 *
 * 宿主侧的各类数据缓存共用这一取值。
 */
export const TRIM_RATIO = 0.75;

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
