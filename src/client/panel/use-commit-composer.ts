/**
 * 提交框的状态与动作：提交信息草稿、钩子勾选、AI 生成、翻译与提交。
 *
 * 草稿按仓库根存会话级存储（sessionStorage），键为 `ggg-commit-msg:<仓库根绝对路径>`：
 * 草稿只活在本次会话，不落宿主；键取仓库根，因此同一工作区下的不同仓库各存各的。
 */
import React from 'react';
import {
	clearPersistedDraft, commitStaged, generateCommitMessage, loadCommitMessage, loadHooksState,
	takePersistedDraft, translateAvailable, translateText,
} from '../api/index.ts';
import type { HooksState } from '../api/index.ts';
import { draftKeyOf, loadSessionValue, saveSessionValue } from './storage.ts';
import { interfaceLanguage, showTranslateEntry, translateCommitMessage } from './language.ts';
import { canSubmitOf, commitButtonDisabledOf } from './submit-state.ts';
import { commitEntries } from './optimistic.ts';
import type { AiStats, Commit, PanelRun, Settings, WorkingTreeEntry } from '../shared/types.ts';

/**
 * 翻译服务是否可用：换仓库时重查一次（同一进程内结果稳定，不必频繁请求）。
 *
 * 提交框与图形区都按它决定是否显示翻译入口，因此独立成一个 hook，供两处共用。
 *
 * @param workingTreePath - 当前工作树路径；未选中时为 null。
 * @returns 翻译服务可用时为 true。
 */
export function useTranslateReady(workingTreePath: string | null): boolean {
	const [translateReady, setTranslateReady] = React.useState(false);
	React.useEffect(() => {
		if (workingTreePath === null) { setTranslateReady(false); return undefined; }
		let cancelled = false;
		void translateAvailable(workingTreePath).then((available) => { if (!cancelled) setTranslateReady(available); });
		return () => { cancelled = true; };
	}, [workingTreePath]);
	return translateReady;
}

/** 提交框的依赖面。 */
export interface CommitComposerDeps {
	/** 当前选中的工作树路径。 */
	readonly workingTreePath: string | null;
	/** 当前设置：AI 模型、规则与语言。 */
	readonly settings: Settings;
	/** 已加载的提交列表：修补时取上一条提交的信息。 */
	readonly commits: readonly Commit[];
	/** 是否处于未完成的合并。 */
	readonly merging: boolean;
	/** 工作区条目：据此推算已暂存路径数。 */
	readonly entries: readonly WorkingTreeEntry[];
	/** 翻译服务是否可用。 */
	readonly translateReady: boolean;

	/** 提交影响面是否正忙。 */
	readonly commitBusy: boolean;
	/** 执行一次操作并刷新。 */
	readonly run: PanelRun;
	/** 轻量提示。 */
	readonly notify: (message: string) => Promise<void>;
}

/** 提交框的状态与动作。 */
export interface CommitComposer {
	/** 提交信息。 */
	readonly message: string;
	/** 提交信息写入器。 */
	readonly setMessage: React.Dispatch<React.SetStateAction<string>>;
	/** 是否修补上一次提交。 */
	readonly amend: boolean;
	/** 本次提交与推送是否运行 git 钩子。 */
	readonly runHooks: boolean;
	/** 钩子勾选写入器。 */
	readonly setRunHooks: React.Dispatch<React.SetStateAction<boolean>>;
	/** 当前仓库的钩子状态。 */
	readonly hooksState: HooksState;
	/** 任一钩子激活即显示勾选项。 */
	readonly hooksActive: boolean;
	/** AI 生成进行中。 */
	readonly aiBusy: boolean;
	/** AI 生成的告警文本。 */
	readonly aiWarning: string;
	/** AI 生成的用量统计。 */
	readonly aiStats: AiStats | null;
	/** 翻译进行中。 */
	readonly translateBusy: boolean;
	/** 翻译服务是否可用。 */
	readonly translateReady: boolean;
	/** 是否显示翻译入口。 */
	readonly showTranslate: boolean;
	/** 提交按钮可用。 */
	readonly canSubmit: boolean;
	/** 切换修补勾选。 */
	readonly toggleAmend: (checked: boolean) => void;
	/** 提交暂存区。 */
	readonly submit: () => void;
	/** AI 生成提交信息。 */
	readonly handleAiCommit: () => void;
	/** 翻译提交信息。 */
	readonly handleTranslate: () => void;
}

/**
 * 维护提交框状态。
 *
 * @param deps - 见 {@link CommitComposerDeps}。
 * @returns 提交框状态与动作。
 */
export function useCommitComposer(deps: CommitComposerDeps): CommitComposer {
	const { workingTreePath, settings, commits, merging, entries, commitBusy, run, notify } = deps;
	const [message, setMessage] = React.useState('');
	const [amend, setAmend] = React.useState(false);
	/**
	 * 本次提交与推送是否运行 git 钩子。
	 *
	 * 提交钩子或推送钩子存在时默认勾选，取消勾选即本次用 `--no-verify` 跳过。这是**临时**选择：
	 * 每次切换仓库与每次提交、推送完成后都回到默认勾选，不持久化。
	 */
	const [runHooks, setRunHooks] = React.useState(true);
	/** 当前仓库的钩子状态；未探测到或未激活时两个字段皆为 false。 */
	const [hooksState, setHooksState] = React.useState<HooksState>({ commit: false, push: false, directory: null });
	const [aiBusy, setAiBusy] = React.useState(false);
	const [aiWarning, setAiWarning] = React.useState('');
	const [aiStats, setAiStats] = React.useState<AiStats | null>(null);
	const [translateBusy, setTranslateBusy] = React.useState(false);
	// 翻译服务由 cot-translation bundle 可选装载；不可用时连入口都不显示。
	const translateReady = deps.translateReady;
	// 已翻译过的文本：避免对同一内容重复请求，也用于标记「已翻译」。
	const [translatedFrom, setTranslatedFrom] = React.useState<string | null>(null);
	const aiAbortRef = React.useRef<AbortController | null>(null);

	/* 卸载时终止进行中的生成：回调会写 message 与 aiBusy，组件已不在时不应再更新。 */
	React.useEffect(() => () => {
		if (aiAbortRef.current !== null) { aiAbortRef.current.abort(); aiAbortRef.current = null; }
	}, []);

	/** 草稿是否已读完；读完之前不得写入。 */
	const [draftReadDone, setDraftReadDone] = React.useState(false);
	/** 当前 message 所属的仓库；与 workingTreePath 不同时不得写入。 */
	const [draftPath, setDraftPath] = React.useState<string | null>(null);
	/** message 的当前值：切换仓库的收尾里读取它，避免把旧值写进新仓库的键。 */
	const messageRef = React.useRef(message);
	messageRef.current = message;

	/*
	 * 提交信息草稿：写入必须等草稿读完。message 初始为空串，若在读回之前就写入，会把刚切换过来
	 * 的仓库的草稿覆盖成空。readDone 标记读完这一刻，之后才允许写。切换仓库时先把上一个仓库的
	 * 草稿写回它自己的键，再读新仓库的。
	 */
	React.useEffect(() => {
		const path = workingTreePath;
		if (path === null) { setDraftReadDone(false); setDraftPath(null); return undefined; }
		const cancelled = { current: false };
		// 本轮读取是否完成：cleanup 只在完成后写回，否则会把上一个仓库的 message 写进当前仓库的键。
		let readDone = false;
		setDraftReadDone(false);
		const key = draftKeyOf(path);
		void (async () => {
			// 早期版本把草稿落在宿主：取回一次，转入会话存储后删除宿主旧键。
			const persisted = await takePersistedDraft(path, key);
			if (cancelled.current) return;
			const saved = loadSessionValue<string | null>(key, null);
			if (saved === null && persisted !== null) {
				saveSessionValue(key, persisted);
				// 草稿已落到会话存储，再清宿主旧键；删除失败不影响已取回的草稿。
				void clearPersistedDraft(path, key).catch(() => { /* 删除失败时草稿仍在会话存储 */ });
			}
			setMessage(saved ?? persisted ?? '');
			setDraftPath(path);
			readDone = true;
			setDraftReadDone(true);
		})();
		return () => {
			cancelled.current = true;
			// 离开本仓库：读回完成后 message 才是本仓库的内容，此时才把草稿写回它自己的键。
			if (!readDone) return;
			saveSessionValue(key, messageRef.current);
		};
	}, [workingTreePath]);
	React.useEffect(() => {
		if (workingTreePath === null || !draftReadDone || draftPath !== workingTreePath) return;
		saveSessionValue(draftKeyOf(workingTreePath), message);
	}, [workingTreePath, message, draftReadDone, draftPath]);

	/*
	 * git 钩子状态：换仓库时探测一次，决定提交框是否显示 githook 勾选项。
	 *
	 * 换仓库即回到「运行钩子」：勾选是临时选择，不跨仓库、不跨会话保留。
	 */
	React.useEffect(() => {
		setRunHooks(true);
		if (workingTreePath === null) { setHooksState({ commit: false, push: false, directory: null }); return undefined; }
		let cancelled = false;
		loadHooksState(workingTreePath)
			.then((state) => { if (!cancelled) setHooksState(state); })
			.catch(() => { if (!cancelled) setHooksState({ commit: false, push: false, directory: null }); });
		return () => { cancelled = true; };
	}, [workingTreePath]);

	/**
	 * 勾选「修补上一次提交」时填入上一提交的完整消息；取消勾选时清空。
	 *
	 * 提交列表里的 message 只含标题（`git log --format=%s`），正文需按需取回。
	 *
	 * @param checked - 是否勾选。
	 */
	const toggleAmend = React.useCallback((checked: boolean) => {
		setAmend(checked);
		if (!checked) {
			setMessage('');
			return;
		}
		const lastCommit = commits.find((commit) => commit.hash !== '*');
		if (lastCommit === undefined) return;
		// 先填标题，正文取回后再替换；取不到时保留标题。
		setMessage(lastCommit.message ?? '');
		if (workingTreePath === null) return;
		void loadCommitMessage(workingTreePath, lastCommit.hash)
			.then((full) => { if (full !== null && full !== '') setMessage(full); })
			.catch(() => { /* 取不到正文时保留标题 */ });
	}, [commits, workingTreePath]);

	const stagedCount = React.useMemo(() => entries.filter((entry) => { const staged = entry.index !== ' ' && entry.index !== '?'; return staged; }).length, [entries]);
	const canSubmit = canSubmitOf({ stagedCount, amend, merging });

	/**
	 * 提交暂存区。
	 *
	 * 勾选修补时允许没有暂存改动，只改提交信息；处于未完成的合并时同样允许，此时提交是结束合并
	 * 的唯一动作，提交信息留空表示沿用 git 生成的合并信息。
	 */
	const submit = (): void => {
		if (commitButtonDisabledOf({ busy: commitBusy, canSubmit, messageEmpty: message.trim() === '', merging })) return;
		// 钩子激活且取消勾选时本次跳过；提交完成后回到默认勾选。
		const skipHooks = hooksState.commit && !runHooks;
		void run('commit', async () => {
			await commitStaged(workingTreePath as string, message, amend, skipHooks);
			setMessage('');
			setAmend(false);
			setRunHooks(true);
		}, undefined, commitEntries, { intent: amend ? '修补上一次提交' : (merging ? '提交并结束合并' : '提交暂存的更改') });
	};

	/**
	 * AI 生成提交信息：流式输出，不开启思考。
	 *
	 * 系统提示词带上当前界面语言，降低生成错语言的概率；生成完成后若内容仍以
	 * 非当前语言为主，界面出现翻译按钮。
	 */
	const handleAiCommit = (): void => {
		if (aiBusy) return;
		if (workingTreePath === null) { setAiWarning('未选中仓库'); return; }
		if (aiAbortRef.current !== null) { aiAbortRef.current.abort(); aiAbortRef.current = null; }
		setAiBusy(true);
		setAiWarning('');
		setAiStats(null);
		setTranslatedFrom(null);
		setMessage('');
		const controller = new AbortController();
		aiAbortRef.current = controller;
		generateCommitMessage(workingTreePath, settings.aiCommitProvider, settings.aiCommitModel, settings.aiCommitRules, {
			signal: controller.signal,
			onChunk: (text) => { setMessage((prev) => prev + text); },
			onWarning: (text) => { setAiWarning(text); },
			onError: (text) => { setAiWarning(text); },
			onStats: (stats) => { setAiStats(stats as AiStats); },
		// 勾选「修补上一次提交」时，让宿主把上一提交的改动一并纳入 diff。
		}, amend, interfaceLanguage()).finally(() => { setAiBusy(false); aiAbortRef.current = null; }).catch((err: unknown) => { setAiWarning(err instanceof Error ? err.message : String(err)); });
	};

	/**
	 * 翻译提交信息：按行请求，保持原有换行结构。
	 *
	 * 逐行而不是整段一次：整段会被翻译服务拼成一行，丢失标题与要点的分行。
	 * 每行的 git 惯例前缀（`feat:`、`fix(api):` 等）原样保留，只翻译其后的正文。
	 */
	const handleTranslate = React.useCallback(() => {
		if (translateBusy || workingTreePath === null || message.trim() === '') return;
		const source = message;
		const locale = interfaceLanguage();
		setTranslateBusy(true);
		void (async () => {
			try {
				// 空行保留为空行，其余每行单独翻译。
				setMessage(await translateCommitMessage(source, (body) => translateText(workingTreePath, body, locale)));
				setTranslatedFrom(source);
			} catch (error) {
				await notify(error instanceof Error ? error.message : String(error));
			} finally {
				setTranslateBusy(false);
			}
		})();
	}, [translateBusy, workingTreePath, message, notify]);

	/*
	 * 是否显示提交信息框的翻译入口。
	 *
	 * 判据与提交浮窗共用 {@link showTranslateEntry}：翻译服务已装载（否则点了也失败）、
	 * 当前无生成或翻译任务、内容非空且以非当前语言为主。已翻译过的内容不再重复提示。
	 */
	const showTranslate = showTranslateEntry({
		ready: translateReady, busy: aiBusy || translateBusy, text: message,
		locale: interfaceLanguage(), translatedFrom,
	});

	return {
		message, setMessage, amend, runHooks, setRunHooks, hooksState,
		hooksActive: hooksState.commit || hooksState.push,
		aiBusy, aiWarning, aiStats, translateBusy, translateReady, showTranslate, canSubmit,
		toggleAmend, submit, handleAiCommit, handleTranslate,
	};
}