/**
 * 有界映射表，宿主与客户端共用容量与淘汰顺序实现。
 *
 * 运行时无平台依赖，两边各自打包。
 */

/**
 * 缓存超限后一次淘汰一批的目标比例，避免每次写入都在容量边界淘汰。
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
 * 按最近使用顺序淘汰的映射表。
 *
 * `get` 命中即把该键移到最新，淘汰从最旧一端开始；`peek` 与 `has` 不改变次序。容量只由构造参数决定。
 * 删除与清空保留其余键的次序。`V` 为 undefined 的值仍按存在处理。
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
