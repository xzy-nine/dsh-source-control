/**
 * 原生打开：把当前文件交给宿主的桌面应用打开，或在其文件管理器中定位。
 *
 * 能力来自宿主 Remote 的会话命名空间：先探测可用性，再列出该文件的注册应用。
 * 宿主不具备桌面能力时整个控件不渲染，与 DSH 的评审视图一致。
 */
import React from 'react';
import {
	IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular, IconRightUpOutlineRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { logClient } from '../api/log.ts';
import css from '../css/native-open.module.css';

/** 宿主报告的一个注册应用。 */
export interface NativeApplication {
	readonly id: string;
	readonly name: string;
	readonly default: boolean;
	readonly icon: string | null;
}

/** 本模块用到的会话 Remote 切片。 */
interface SessionRemote {
	canOpenWorkspacePath?: () => Promise<{ ok?: boolean; value?: boolean }>;
	workspacePathApplications?: (request: { path: string }) => Promise<{ ok?: boolean; value?: unknown }>;
	openWorkspacePath?: (request: { path: string; action?: 'reveal'; application?: string }) => Promise<{ ok?: boolean }>;
}

/**
 * 读取会话 Remote；未装载时返回 undefined。
 *
 * @param ctx - Cordis 上下文。
 * @returns 具备原生打开能力的 Remote 切片。
 */
function remoteOf(ctx: unknown): SessionRemote | undefined {
	try {
		const getter = (ctx as { get?: (name: string) => unknown } | null | undefined)?.get;
		if (typeof getter !== 'function') return undefined;
		const remote = getter.call(ctx, 'remote') as { session?: SessionRemote } | undefined | null;
		const session = remote?.session;
		return session !== undefined && typeof session.openWorkspacePath === 'function' ? session : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 校验宿主返回的应用列表。
 *
 * @param value - 宿主回投的数组。
 * @returns 形状合法的应用列表；不合法时为空数组。
 */
function applicationsOf(value: unknown): NativeApplication[] {
	if (!Array.isArray(value)) return [];
	const read: NativeApplication[] = [];
	for (const item of value) {
		if (item === null || typeof item !== 'object') continue;
		const entry = item as Record<string, unknown>;
		if (typeof entry.id !== 'string' || entry.id === '') continue;
		read.push({
			id: entry.id,
			name: typeof entry.name === 'string' ? entry.name : entry.id,
			default: entry.default === true,
			icon: typeof entry.icon === 'string' ? entry.icon : null,
		});
	}
	return read;
}

/**
 * 原生打开控件：主按钮执行默认动作，菜单列出注册应用与「显示文件位置」。
 *
 * @param props.ctx - Cordis 上下文，用于读取会话 Remote。
 * @param props.path - 要打开的绝对路径。
 * @returns 控件；宿主不支持原生打开时不渲染任何内容。
 */
export function NativeOpenControl({ ctx, path }: { ctx: unknown; path: string }): React.ReactElement | null {
	const remote = React.useMemo(() => remoteOf(ctx), [ctx]);
	const [available, setAvailable] = React.useState(false);
	const [apps, setApps] = React.useState<NativeApplication[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [pending, setPending] = React.useState(false);
	const [menuOpen, setMenuOpen] = React.useState(false);
	React.useEffect(() => {
		let cancelled = false;
		if (remote === undefined || typeof remote.canOpenWorkspacePath !== 'function') {
			setAvailable(false);
			setLoading(false);
			return;
		}
		void remote.canOpenWorkspacePath()
			.then((result) => {
				if (cancelled) return;
				const usable = result.ok === true && result.value === true;
				setAvailable(usable);
				if (!usable || typeof remote.workspacePathApplications !== 'function') return undefined;
				return remote.workspacePathApplications({ path }).then((answer) => {
					if (cancelled) return;
					setApps(answer.ok === true ? applicationsOf(answer.value) : []);
				});
			})
			.catch(() => { if (!cancelled) setAvailable(false); })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [remote, path]);
	const run = React.useCallback((request: { action?: 'reveal'; application?: string }) => {
		if (remote === undefined || typeof remote.openWorkspacePath !== 'function' || pending) return;
		setPending(true);
		setMenuOpen(false);
		void remote.openWorkspacePath({ path, ...request })
			.then((result) => {
				if (result.ok !== true) logClient('W', 'open-in-app', `宿主拒绝原生打开 ${path}`);
			})
			.catch((error: unknown) => {
				logClient('W', 'open-in-app', `原生打开失败 ${path}：${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => { setPending(false); });
	}, [remote, path, pending]);
	if (!available) return null;
	const preferred: NativeApplication | undefined = apps.length === 0 ? undefined : (apps.find((app) => app.default) ?? apps[0]);
	const revealDefault = preferred === undefined;
	const disabled = pending || loading;
	const icon = revealDefault
		? React.createElement(IconFolderOpenOutlineRegular, { size: 13 })
		: preferred.icon === null
			? React.createElement(IconRightUpOutlineRegular, { size: 13 })
			: React.createElement('img', { src: preferred.icon, width: 13, height: 13, alt: '', draggable: false, className: css.appIcon });
	const hasMenu = loading || apps.length + 1 > 1;
	const primaryLabel = revealDefault ? '在文件管理器中显示' : `用 ${preferred.name} 打开`;
	const main = React.createElement(Tooltip, {
		label: primaryLabel, side: 'bottom', delayMs: 500,
		children: React.createElement('button', {
			type: 'button', className: css.main, disabled, 'aria-label': primaryLabel, 'data-open-path-open': '',
			onClick: () => {
				if (revealDefault) { run({ action: 'reveal' }); return; }
				if (preferred.id !== apps.find((app) => app.default)?.id) { run({ application: preferred.id }); return; }
				run({});
			},
		}, icon),
	});
	const chevron = hasMenu
		? React.createElement('button', {
			type: 'button', className: css.chevron, disabled,
			'aria-haspopup': 'menu', 'aria-expanded': menuOpen && !disabled, 'aria-label': '更多打开方式',
			'data-open-path-more': '',
			onClick: () => { setMenuOpen((value) => !value); },
		}, React.createElement(IconChevronDownOutlineRegular, { size: 10 }))
		: null;
	return React.createElement(Menu, {
		className: css.menuAnchor,
		open: menuOpen && !disabled && hasMenu,
		autoFocus: true, portal: true, dense: true, align: 'end',
		onClose: () => { setMenuOpen(false); },
		items: apps.map((app) => ({
			id: `app:${app.id}`,
			icon: app.icon === null
				? React.createElement(IconRightUpOutlineRegular)
				: React.createElement('img', { src: app.icon, width: 14, height: 14, alt: '', draggable: false, className: css.appIcon }),
			label: app.id === preferred?.id ? `${app.name}（默认）` : app.name,
		})),
		footer: [{
			id: 'reveal',
			icon: React.createElement(IconFolderOpenOutlineRegular),
			label: revealDefault ? '在文件管理器中显示（默认）' : '在文件管理器中显示',
		}],
		onSelect: (id: string) => {
			if (id === 'reveal') { run({ action: 'reveal' }); return; }
			run({ application: id.slice(4) });
		},
		anchor: React.createElement('div', {
			className: css.split, 'data-open-target': 'file', 'data-state': disabled ? 'busy' : 'idle',
		}, main, chevron),
	});
}