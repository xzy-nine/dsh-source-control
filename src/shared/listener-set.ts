/**
 * 订阅者集合：登记、注销与逐个调用。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */

/** 订阅者集合。 */
export interface ListenerSet<L> {
	/** 登记一个订阅者。 */
	readonly add: (listener: L) => void;
	/** 注销一个订阅者。 */
	readonly delete: (listener: L) => void;
	/** 注销全部订阅者。 */
	readonly clear: () => void;
	/** 当前订阅者快照；调用期间新增或注销的订阅者不参与当次遍历。 */
	readonly snapshot: () => L[];
}

/**
 * 建立一个订阅者集合。
 *
 * @returns 集合。
 */
export function createListenerSet<L>(): ListenerSet<L> {
	const listeners = new Set<L>();
	return {
		add: (listener) => { listeners.add(listener); },
		delete: (listener) => { listeners.delete(listener); },
		clear: () => { listeners.clear(); },
		snapshot: () => [...listeners],
	};
}

/**
 * 把订阅包成「登记并返回取消函数」。
 *
 * @param set - 订阅者集合。
 * @param listener - 订阅者。
 * @returns 取消订阅的函数。
 */
export function subscribeIn<L>(set: ListenerSet<L>, listener: L): () => void {
	set.add(listener);
	return () => { set.delete(listener); };
}
