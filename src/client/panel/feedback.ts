/**
 * 反馈页签：填写反馈、可选附带日志，交宿主经 `gh issue create` 建 issue。
 *
 * 日志附带由宿主完成：先在本地写出一份脱敏副本并压成 zip，再把压缩包路径交回本页；
 * 提交成功后本页把 issue 与新开页打开，由用户把压缩包拖到 issue 评论框上传
 * （GitHub 的附件接口不接受日志等文本类型，只能由界面手动上传）。
 * 脱敏默认开启；停用脱敏与逐条豁免都在本页操作，被豁免的字符串原样保留。
 */
import React from 'react';
import { Button, Checkbox, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives';
import { loadFeedbackInfo, logClient, submitFeedback } from '../api/index.ts';
import type { FeedbackInfo, FeedbackType, SubmitFeedbackOutcome } from '../api/index.ts';
import { showMessage } from '../ui/dialog.ts';
import { openExternal } from '../ui/context-menu.ts';
import { changeRowsOf, type ChangeRow } from './change-tree.ts';
import { FileRow, FolderRow } from './tree-rows.tsx';
import css from '../css/settings.module.css';
import changesCss from '../css/changes.module.css';

/** 类型选项。 */
const TYPE_OPTIONS = [
	{ value: 'bug', label: '缺陷' },
	{ value: 'suggestion', label: '建议' },
	{ value: 'other', label: '其它' },
];

/** 反馈页签属性。 */
export interface FeedbackTabProps {
	/** 会话工作区路径；提交 gh 命令的工作目录。 */
	readonly cwd: string | null;
	/** 插件版本。 */
	readonly pluginVersion: string;
	/** 打开一个外部地址；缺省用浏览器新标签页。 */
	readonly onOpenExternal?: ((url: string) => void) | undefined;
	/** 按绝对路径打开一个文件；缺省不做任何事。 */
	readonly onOpenFile?: ((path: string) => void) | undefined;
	/** 在系统文件管理器中定位一个路径；缺省不做任何事。 */
	readonly onRevealPath?: ((path: string) => void) | undefined;
}

/** 日志文件的树条目：路径是 `日期/文件名`，真实路径另存。 */
interface LogTreeEntry {
	readonly path: string;
	readonly fullPath: string;
	readonly sizeText: string;
}

/** 失败分类到处理建议。 */
const FAILURE_HINT: Readonly<Record<string, string>> = {
	'missing-cli': '请安装 GitHub CLI（https://cli.github.com）并运行 gh auth login。',
	'not-logged-in': '请运行 gh auth login 后重试。',
	'missing-scope': '授权不足，请按提示补 scope 后重试。',
	forbidden: '当前账号没有该仓库的 issue 权限。',
	invalid: '请检查标题与描述后重试。',
};

/**
 * 反馈页签。
 *
 * @param props - 见 {@link FeedbackTabProps}。
 * @returns 页签元素。
 */
export function FeedbackTab({ cwd, pluginVersion, onOpenExternal = openExternal, onOpenFile, onRevealPath }: FeedbackTabProps): React.ReactElement {
	const [type, setType] = React.useState<FeedbackType>('bug');
	const [title, setTitle] = React.useState('');
	const [description, setDescription] = React.useState('');
	const [attachLogs, setAttachLogs] = React.useState(true);
	const [disableRedaction, setDisableRedaction] = React.useState(false);
	const [exemptions, setExemptions] = React.useState('');
	// undefined 表示读取中，null 表示读取失败；两者在界面上分开显示。
	const [info, setInfo] = React.useState<FeedbackInfo | null | undefined>(undefined);
	const [busy, setBusy] = React.useState(false);
	const [result, setResult] = React.useState<SubmitFeedbackOutcome | null>(null);
	// 折叠的日志目录：按路径记，默认全部展开。
	const [collapsedLogs, setCollapsedLogs] = React.useState<ReadonlySet<string>>(() => new Set());

	// 日志位置与所选仓库无关：不依赖 cwd，挂载即取一次。
	React.useEffect(() => {
		let cancelled = false;
		loadFeedbackInfo(cwd)
			.then((data) => { if (!cancelled) setInfo(data); })
			.catch(() => { if (!cancelled) setInfo(null); });
		return () => { cancelled = true; };
	}, []);

	// 日志文件按「日期/文件名」组成文件树：复用变更区的建行逻辑，日期即为顶层文件夹。
	const logRows = React.useMemo<ChangeRow<LogTreeEntry>[]>(() => {
		if (info === null || info === undefined) return [];
		const entries: LogTreeEntry[] = info.files.map((file) => ({
			path: `${file.day}/${file.name}`,
			fullPath: file.path,
			sizeText: file.sizeText,
		}));
		// 日志文件按启动先后倒序：最新的一次启动排在最上面。
		return changeRowsOf(entries, collapsedLogs, true);
	}, [info, collapsedLogs]);

	/** 提交：成功时打开 issue 页并提示上传压缩包，失败说明原因并给出日志目录。 */
	const submit = (): void => {
		if (busy) return;
		if (title.trim() === '' || description.trim() === '') {
			void showMessage({ title: '信息不完整', message: '标题与描述都需要填写。' });
			return;
		}
		setBusy(true);
		setResult(null);
		void (async () => {
			try {
				const outcome = await submitFeedback(cwd, {
					type, title, description, attachLogs, disableRedaction,
					exemptions: exemptions.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
					pluginVersion,
				});
				setResult(outcome);
				if (outcome.error !== null) {
					logClient('E', 'feedback', `反馈提交失败，原因分类 ${outcome.kind}：${outcome.error}`);
					const hint = FAILURE_HINT[outcome.kind] ?? '可手动在上游仓库创建 issue。';
					await showMessage({
						title: '反馈未提交',
						message: `${outcome.error}\n\n${hint}\n\n日志目录：\n${outcome.logDir === '' ? (info?.logDir ?? '') : outcome.logDir}`,
					});
					return;
				}
				logClient('I', 'feedback', `反馈已提交，issue 地址：${outcome.url}${outcome.archive === null ? '（未附带日志）' : `，日志压缩包：${outcome.archive}`}`);
				// 新开页打开 issue：用户在其中把压缩包拖进评论框上传。
				if (outcome.url !== '') onOpenExternal(outcome.url);
				setTitle('');
				setDescription('');
				await showMessage({
					title: '反馈已提交',
					message: [
						outcome.url,
						'',
						...outcome.archive === null
							? ['本次未附带日志。']
							: [
								`日志已打包：${outcome.archive}`,
								'',
								'请把该压缩包拖到刚打开的 issue 评论框上传；GitHub 的附件接口不接受日志等文本类型。',
								...(outcome.compressed ? [] : ['（系统没有可用的 tar，压缩包实际是未压缩的日志副本。）']),
							],
					].join('\n'),
				});
			} catch (error) {
				logClient('E', 'feedback', `反馈提交过程出错：${error instanceof Error ? error.message : String(error)}`);
				await showMessage({ title: '反馈未提交', message: error instanceof Error ? error.message : String(error) });
			} finally {
				setBusy(false);
			}
		})();
	};

	return React.createElement(
		'div',
		{ className: css.fbWrap },
		React.createElement('div', { className: css.fbRow },
			React.createElement(SegmentedControl, {
				id: 'ggg-fb-type', label: '类型', value: type,
				onChange: (next: string) => { setType(next === 'suggestion' ? 'suggestion' : next === 'other' ? 'other' : 'bug'); },
				options: TYPE_OPTIONS,
			}),
		),
		React.createElement('label', { className: css.fbField },
			React.createElement('span', { className: css.fbLabel }, '标题'),
			React.createElement(Input, {
				value: title, placeholder: '一句话说明问题或建议',
				onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setTitle(event.target.value); },
			}),
		),
		React.createElement('label', { className: css.fbField },
			React.createElement('span', { className: css.fbLabel }, '描述'),
			React.createElement('textarea', {
				className: css.fbTextarea, value: description, rows: 5,
				placeholder: '期望的行为、实际的行为、复现步骤',
				onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { setDescription(event.currentTarget.value); },
			}),
		),
		React.createElement('div', { className: css.fbField },
			React.createElement(Checkbox, {
				checked: attachLogs, label: '附带日志文件',
				onChange: setAttachLogs,
			}),
			React.createElement('div', { className: css.fbNote },
				'日志以 logcat threadtime 格式记录，每次启动一个文件。提交时打包脱敏副本，磁盘上的原始日志不变。'),
		),
		attachLogs && React.createElement('div', { className: css.fbField },
			React.createElement(Checkbox, {
				checked: disableRedaction, label: '停用脱敏（打包原始内容）',
				onChange: setDisableRedaction,
			}),
			React.createElement('div', { className: css.fbNote },
				'默认屏蔽 URL 中的账号口令、令牌串与系统用户名，替换为 <url-credential>、<token>、<user>。本地路径不处理。'),
			!disableRedaction && React.createElement('label', { className: css.fbField },
				React.createElement('span', { className: css.fbLabel }, '豁免字符串（每行一条，原样保留）'),
				React.createElement('textarea', {
					className: css.fbTextarea, value: exemptions, rows: 2,
					placeholder: '确需保留的关键信息，逐行填写',
					onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { setExemptions(event.currentTarget.value); },
				}),
			),
		),
		React.createElement('div', { className: css.fbField },
			React.createElement('span', { className: css.fbLabel }, '日志位置'),
			React.createElement('button', {
				type: 'button', className: css.fbPathLink,
				disabled: info === null || info === undefined || info.logDir === '' || onRevealPath === undefined,
				title: info !== null && info !== undefined && info.logDir !== '' ? `在文件管理器中打开：${info.logDir}` : undefined,
				onClick: () => { if (info !== null && info !== undefined && info.logDir !== '') onRevealPath?.(info.logDir); },
			}, info === undefined ? '（读取中）' : info === null ? '（读取失败）' : info.logDir === '' ? '（不可用）' : info.logDir),
			logRows.length > 0 && React.createElement('div', { className: changesCss.logTree },
				...logRows.map((row) => {
					if (row.kind === 'folder') {
						return React.createElement(FolderRow, {
							key: `f:${row.path}`, path: row.path, name: row.name, depth: row.depth, open: row.open, count: row.count,
							onToggle: () => { setCollapsedLogs((previous) => {
								const next = new Set(previous);
								if (next.has(row.path)) next.delete(row.path);
								else next.add(row.path);
								return next;
							}); },
						});
					}
					const entry = row.entry;
					return React.createElement(FileRow, {
						key: `e:${entry.path}`, fileName: entry.path, title: entry.fullPath, depth: row.depth,
						tail: entry.sizeText,
						onOpen: () => { onOpenFile?.(entry.fullPath); },
					});
				}),
			),
			info !== null && info !== undefined && info.files.length === 0 && React.createElement('div', { className: css.fbNote }, '该目录下还没有日志文件'),
		),
		React.createElement('div', { className: css.fbActions },
			React.createElement(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: submit },
				busy ? '提交中…' : '提交反馈'),
			result !== null && result.error === null && result.url !== '' && React.createElement('span', { className: css.fbResult },
				React.createElement('a', {
					href: result.url, target: '_blank', rel: 'noreferrer',
					onClick: (event: React.MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); onOpenExternal(result.url); },
				}, result.url),
			),
			result !== null && result.error !== null && React.createElement('span', { className: css.fbResult }, result.error),
			result !== null && result.error === null && result.archive !== null && React.createElement('div', { className: css.fbPathLink }, result.archive),
		),
	);
}
