/**
 * 反馈页签：填写反馈、可选附带日志，交宿主经 `gh issue create` 建 issue。
 *
 * 日志附带由宿主完成：本页按所选天数挑出日志文件交给宿主，宿主导出脱敏文本并作为独立评论
 * 追加到新建的 issue 下（GitHub 的评论正文上限 65536 字符，日志按它合并成若干条）。
 * 脱敏默认开启；停用脱敏与逐条豁免都在本页操作，被豁免的字符串原样保留。
 *
 * 日志位置列表默认折叠，展开哪一天由本页的展开集决定；所选天数与展开状态都只在本页有效。
 * 提交成功后由一个结果弹窗承接去向，表单页只留输入与提交按钮。
 */
import React from 'react';
import { errorText } from '../../shared/error-text.ts';
import { Button, Checkbox, fileSizeText, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives';
import { loadFeedbackInfo, logClient, submitFeedback } from '../api/index.ts';
import type { FeedbackInfo, FeedbackType } from '../api/index.ts';
import { showMessage, showMessageWithLinks } from '../ui/dialog.ts';
import { openExternal } from '../ui/context-menu.ts';
import { changeRowsOf, type ChangeRow } from './change-tree.ts';
import type { ExternalOpenHandlers } from './settings.ts';
import { cutoffDayKey } from '../../shared/day-key.ts';
import { toggleIn } from '../shared/set-ops.ts';
import { FileRow, FolderRow } from './tree-rows.tsx';
import { useMountedRead } from './use-mounted-read.ts';
import css from '../css/settings.module.css';
import changesCss from '../css/changes.module.css';

/** 类型选项。 */
const TYPE_OPTIONS = [
	{ value: 'bug', label: '缺陷' },
	{ value: 'suggestion', label: '建议' },
	{ value: 'other', label: '其它' },
];

/** 反馈页签属性。 */
export interface FeedbackTabProps extends ExternalOpenHandlers {
	/** 会话工作区路径；提交 gh 命令的工作目录。 */
	readonly cwd: string | null;
	/** 插件版本。 */
	readonly pluginVersion: string;
	/** 打开一个外部地址；缺省用浏览器新标签页。 */
	readonly onOpenExternal?: ((url: string) => void) | undefined;
}

/** 日志天数选项：与宿主保留期一致，最长一档就是全部保留期。 */
const LOG_DAY_OPTIONS = [
	{ value: '1', label: '1 天' },
	{ value: '3', label: '3 天' },
	{ value: '5', label: '5 天' },
	{ value: '15', label: '15 天' },
];

/**
 * 最近 n 天（含今天）的日文件夹名下界。
 *
 * 与 `log-retention.ts` 的 `dayFolderName` 同形，比较用字符串：`YYYY-MM-DD` 定宽，
 * 字典序即时间序。
 *
 * @param now - 当前时间。
 * @param days - 天数。
 * @returns `YYYY-MM-DD` 形态的下界。
 */
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
/**
 * 带标题的一格反馈表单。
 *
 * @param label - 字段标题。
 * @param control - 输入控件。
 * @returns 字段元素。
 */
function feedbackField(label: string, control: React.ReactElement): React.ReactElement {
	return React.createElement('label', { className: css.fbField }, fbLabelNode(label), control);
}

/**
 * 带标题的多节点反馈区块。控件本身可以点（如按钮、目录树）时用它而不是 {@link feedbackField}：
 * 外层是 `div`，不会把点击吞成标签的关联点击。
 *
 * @param label - 区块标题；空串时不渲染标题，控件自带文案时用它。
 * @param children - 区块内容。
 * @returns 区块元素。
 */
function feedbackBlock(label: string, ...children: React.ReactNode[]): React.ReactElement {
	return React.createElement('div', { className: css.fbField }, label === '' ? null : fbLabelNode(label), ...children);
}

/**
 * 字段标题节点。
 *
 * @param label - 字段标题。
 * @returns 标题元素。
 */
function fbLabelNode(label: string): React.ReactElement {
	return React.createElement('span', { className: css.fbLabel }, label);
}

/**
 * 一段反馈表单的说明文字。
 *
 * @param text - 说明正文。
 * @returns 说明元素。
 */
function feedbackNote(text: string): React.ReactElement {
	return React.createElement('div', { className: css.fbNote }, text);
}
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
	// 附带哪几天的日志：只在本页有效，不持久化。
	const [logDays, setLogDays] = React.useState(1);
	// 展开的日志目录：按路径记，默认全部折叠。
	const [openLogs, setOpenLogs] = React.useState<ReadonlySet<string>>(() => new Set());

	// 日志位置与所选仓库无关：不依赖 cwd，挂载即取一次。
	React.useEffect(() => useMountedRead(() => loadFeedbackInfo(cwd), setInfo, () => { setInfo(null); }), []);

	// 按所选天数筛出的日志文件；天数是最近 N 天（含今天）。
	const shownFiles = React.useMemo(() => {
		if (info === null || info === undefined) return [];
		const cutoff = cutoffDayKey(new Date(), logDays);
		return info.files.filter((file) => file.day >= cutoff);
	}, [info, logDays]);

	// 日志文件按「日期/文件名」组成文件树：复用变更区的建行逻辑，日期即为顶层文件夹。
	const logRows = React.useMemo<ChangeRow<LogTreeEntry>[]>(() => {
		const entries: LogTreeEntry[] = shownFiles.map((file) => ({
			path: `${file.day}/${file.name}`,
			fullPath: file.path,
			sizeText: fileSizeText(file.size),
		}));
		// 默认折叠：未展开过的日文件夹都进折叠集；日志按启动先后倒序，最新的排在最上面。
		const days = new Set(shownFiles.map((file) => file.day));
		const collapsed = new Set([...days].filter((day) => !openLogs.has(day)));
		return changeRowsOf(entries, collapsed, true);
	}, [shownFiles, openLogs]);

	/**
	 * 在系统文件管理器中定位一个路径，等宿主受理后再返回。
	 *
	 * 宿主不具备桌面能力、或定位请求被拒时只记一条日志：定位属于便利步骤，
	 * 失败不改变已经成功的提交结果。
	 *
	 * @param path - 要定位的绝对路径。
	 * @returns 定位完成后完成。
	 */
	const revealPath = async (path: string): Promise<void> => {
		if (onRevealPath === undefined) {
			logClient('W', 'feedback', `宿主未提供文件管理器能力，跳过定位 ${path}`);
			return;
		}
		try {
			await onRevealPath(path);
		} catch (error) {
			logClient('W', 'feedback', `定位日志位置失败 ${path}：${errorText(error)}`);
		}
	};

	/** 提交：结果由一个弹窗承接全部去向；失败说明原因并给出日志目录。 */
	const submit = (): void => {
		if (busy) return;
		if (title.trim() === '' || description.trim() === '') {
			void showMessage({ title: '信息不完整', message: '标题与描述都需要填写。' });
			return;
		}
		setBusy(true);
		void (async () => {
			try {
				const outcome = await submitFeedback(cwd, {
					type, title, description, attachLogs, disableRedaction,
					// 只提交所选天数内、当前可见的那些日志；空数组让宿主退回当前启动的那一份。
					logFiles: attachLogs ? shownFiles.map((file) => file.path) : [],
					exemptions: exemptions.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
					pluginVersion,
				});
				if (outcome.error !== null) {
					logClient('E', 'feedback', `反馈提交失败，原因分类 ${outcome.kind}：${outcome.error}`);
					const hint = FAILURE_HINT[outcome.kind] ?? '可手动在上游仓库创建 issue。';
					await showMessage({
						title: '反馈未提交',
						message: `${outcome.error}\n\n${hint}\n\n日志目录：\n${outcome.logDir === '' ? (info?.logDir ?? '') : outcome.logDir}`,
					});
					return;
				}
				const { url, commentCount, commentError } = outcome;
				logClient('I', 'feedback', `反馈已提交，issue 地址：${url}${commentCount === 0 ? '（未附带日志）' : `，日志评论 ${String(commentCount)} 条`}${commentError === null ? '' : `，${commentError}`}`);
				setTitle('');
				setDescription('');
				// 去向全部在结果弹窗里：地址是一个可点入口，勾选只决定关闭后是否自动打开。
				const openNow = await showMessageWithLinks({
					title: '反馈已提交',
					message: [
						'提交完成。日志全文已作为独立评论追加在本 issue 下。',
						'',
						...commentCount === 0
							? ['本次未附带日志。']
							: commentError === null
								? [`日志已分成 ${String(commentCount)} 条评论追加。`]
								: [`日志评论未全部发出：${commentError}`],
					].join('\n'),
					links: [
						...(url === '' ? [] : [{ label: `打开反馈页：${url}`, onClick: () => { onOpenExternal(url); } }]),
					],
					checkboxLabel: '自动打开反馈页便于查看',
				});
				if (openNow && url !== '') onOpenExternal(url);
			} catch (error) {
				logClient('E', 'feedback', `反馈提交过程出错：${errorText(error)}`);
				await showMessage({ title: '反馈未提交', message: errorText(error) });
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
		feedbackField('标题', React.createElement(Input, {
			value: title, placeholder: '一句话说明问题或建议',
			onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setTitle(event.target.value); },
		})),
		feedbackField('描述', React.createElement('textarea', {
			className: css.fbTextarea, value: description, rows: 5,
			placeholder: '期望的行为、实际的行为、复现步骤',
			onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { setDescription(event.currentTarget.value); },
		})),
		feedbackBlock('', React.createElement(Checkbox, {
			checked: attachLogs, label: '附带日志文件',
			onChange: setAttachLogs,
		}), feedbackNote('日志以 logcat threadtime 格式记录，每次启动一个文件，单份写满 60000 字符时另起一份。提交的是脱敏后的文本副本，磁盘上的原始日志不变。')),
		attachLogs && feedbackBlock('日志范围', React.createElement(SegmentedControl, {
			id: 'ggg-fb-log-days', label: '日志范围', value: String(logDays),
			onChange: (next: string) => { setLogDays(Number(next)); },
			options: LOG_DAY_OPTIONS,
		}), feedbackNote(`将提交最近 ${String(logDays)} 天内的 ${String(shownFiles.length)} 份日志。`)),
		attachLogs && feedbackBlock('', React.createElement(Checkbox, {
			checked: disableRedaction, label: '停用脱敏（提交原始内容）',
			onChange: setDisableRedaction,
		}), feedbackNote('默认屏蔽 URL 中的账号口令、令牌串与系统用户名，替换为 <url-credential>、<token>、<user>。本地路径不处理。'),
			!disableRedaction && feedbackField('豁免字符串（每行一条，原样保留）', React.createElement('textarea', {
				className: css.fbTextarea, value: exemptions, rows: 2,
				placeholder: '确需保留的关键信息，逐行填写',
				onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { setExemptions(event.currentTarget.value); },
			})),
		),
		feedbackBlock('日志位置',
			React.createElement('button', {
				type: 'button', className: css.fbPathLink,
				disabled: info === null || info === undefined || info.logDir === '' || onRevealPath === undefined,
				title: info !== null && info !== undefined && info.logDir !== '' ? `在文件管理器中打开：${info.logDir}` : undefined,
				onClick: () => { if (info !== null && info !== undefined && info.logDir !== '') void revealPath(info.logDir); },
			}, info === undefined ? '（读取中）' : info === null ? '（读取失败）' : info.logDir === '' ? '（不可用）' : info.logDir),
			logRows.length > 0 && React.createElement('div', { className: changesCss.logTree },
				...logRows.map((row) => {
					if (row.kind === 'folder') {
						return React.createElement(FolderRow, {
							key: `f:${row.path}`, path: row.path, name: row.name, depth: row.depth, open: row.open, count: row.count,
							onToggle: () => { setOpenLogs((previous) => toggleIn(previous, row.path)); },
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
			info !== null && info !== undefined && info.files.length === 0 && feedbackNote('该目录下还没有日志文件'),
			info !== null && info !== undefined && info.files.length > 0 && shownFiles.length === 0 && feedbackNote(`最近 ${String(logDays)} 天内没有日志文件`),
		),
		React.createElement('div', { className: css.fbActions },
			React.createElement(Button, { variant: 'primary', size: 'sm', disabled: busy, onClick: submit },
				busy ? '提交中…' : '提交反馈'),
		),
	);
}
