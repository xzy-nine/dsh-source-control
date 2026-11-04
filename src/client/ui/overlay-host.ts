/**
 * 覆盖层宿主：把弹窗与轻量提示渲染到根级 list 席位 `shell.overlay`。
 *
 * 弹窗按入队顺序全部渲染，各自的 Promise 只由自己摘除；提示保持单条，新的一条替换旧的。
 * 内容由它自己的完成回调经 {@link removeDialog}、{@link removeToast} 摘除。宿主由
 * {@link installOverlay} 注册并常驻挂载。
 */
import React from 'react';

/** 覆盖层中的一个条目：队列编号与要渲染的元素。 */
interface OverlayEntry {
	readonly id: number;
	readonly element: React.ReactElement;
}

/** 覆盖层的当前内容：弹窗按入队顺序排列，提示只有当前一条。 */
interface OverlayState {
	readonly dialogs: readonly OverlayEntry[];
	readonly toast: OverlayEntry | null;
}

/** 内容变化通知的订阅者；宿主挂载期间登记。 */
const listeners = new Set<() => void>();

/** 当前内容；无订阅者时也照常更新，宿主首帧据此读到已入队的内容。 */
let state: OverlayState = { dialogs: [], toast: null };

/** 队列编号；每次入队递增，供内容摘除自己。 */
let nextId = 1;

/**
 * 更新当前内容并通知订阅者。
 *
 * @param next - 新内容。
 * @returns 无。
 */
function publish(next: OverlayState): void {
	state = next;
	for (const listener of [...listeners]) listener();
}

/**
 * 订阅内容变化。
 *
 * @param listener - 内容变化时调用。
 * @returns 取消订阅的函数。
 */
function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/**
 * 取当前内容；返回引用稳定，供 `useSyncExternalStore` 判断是否重渲染。
 *
 * @returns 当前内容。
 */
function getSnapshot(): OverlayState {
	return state;
}

/**
 * 把一个弹窗排到队尾；先入队的先渲染。
 *
 * @param render - 用队列编号构造弹窗元素；编号供 {@link removeDialog} 摘除。
 * @returns 无。
 */
export function pushDialog(render: (id: number) => React.ReactElement): void {
	const id = nextId++;
	publish({ ...state, dialogs: [...state.dialogs, { id, element: render(id) }] });
}

/**
 * 按编号摘除弹窗；编号不在队列里时不动。
 *
 * @param id - 入队时给出的编号。
 * @returns 无。
 */
export function removeDialog(id: number): void {
	const dialogs = state.dialogs.filter((entry) => entry.id !== id);
	if (dialogs.length === state.dialogs.length) return;
	publish({ ...state, dialogs });
}

/**
 * 放入一条提示；替换当前提示。
 *
 * @param render - 用队列编号构造提示元素；编号供 {@link removeToast} 摘除。
 * @returns 无。
 */
export function pushToast(render: (id: number) => React.ReactElement): void {
	const id = nextId++;
	publish({ ...state, toast: { id, element: render(id) } });
}

/**
 * 摘除提示；编号不是当前提示时不动。
 *
 * @param id - 入队时给出的编号。
 * @returns 无。
 */
export function removeToast(id: number): void {
	if (state.toast === null || state.toast.id !== id) return;
	publish({ ...state, toast: null });
}

/**
 * 覆盖层宿主：常驻按入队顺序渲染全部弹窗与当前提示。
 *
 * 元素按队列编号换 key：同一文本再次提示、连续两次同类型弹窗都重新挂载，动画从头播放。
 *
 * @returns 覆盖层元素。
 */
export function OverlayHost(): React.ReactElement {
	const current = React.useSyncExternalStore(subscribe, getSnapshot);
	const toast = current.toast;
	return React.createElement(
		React.Fragment,
		null,
		current.dialogs.map((entry) => React.cloneElement(entry.element, { key: `dialog-${String(entry.id)}` })),
		toast !== null && React.cloneElement(toast.element, { key: `toast-${String(toast.id)}` }),
	);
}

/** 席位服务中覆盖层注册用到的最小面。 */
export interface OverlaySlots {
	/** 把注册回调挂到席位；返回撤销函数。 */
	inject(name: string, register: () => unknown): () => void;
	/** 把一个组件注册进席位。 */
	register(meta: { readonly name: string; readonly id: string; readonly order: number }, component: () => React.ReactElement): unknown;
}

/**
 * 把覆盖层宿主注册进根级 list 席位。
 *
 * @param slots - 席位服务。
 * @returns 撤销注册的函数。
 */
export function installOverlay(slots: OverlaySlots): () => void {
	return slots.inject('shell.overlay', () => slots.register(
		{ name: 'shell.overlay', id: 'dsh-source-control.overlay', order: 100 },
		OverlayHost,
	));
}
