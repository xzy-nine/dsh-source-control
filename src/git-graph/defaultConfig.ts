/**
 * git-graph 前端所需的初始状态默认值。
 * 常量取值与 mhutchie/vscode-git-graph 扩展默认一致（见 ../vendor/git-graph/LICENSE）。
 * 注：const enum 在编译后不可跨模块引用，此处按源码定义写死数值/字符串。
 */
import {
	CommitOrdering,
	GitResetMode,
	RepoCommitOrdering,
} from '../../vendor/git-graph/types.js';
import type {
	GitGraphViewConfig,
	GitGraphViewGlobalState,
	GitGraphViewWorkspaceState,
	GitRepoSet,
	GitRepoState,
} from '../../vendor/git-graph/types.js';

export const DEFAULT_GRAPH_COLOURS = [
	'#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000',
	'#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00',
];

export function createDefaultViewConfig(): GitGraphViewConfig {
	return {
		commitDetailsView: {
			autoCenter: true,
			fileTreeCompactFolders: true,
			fileViewType: 1, // FileViewType.Tree
			location: 0, // CommitDetailsViewLocation.Inline
		},
		commitOrdering: CommitOrdering.Date,
		contextMenuActionsVisibility: {
			branch: { checkout: true, rename: true, delete: true, merge: true, rebase: true, push: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
			commit: { addTag: true, createBranch: true, checkout: true, cherrypick: true, revert: true, drop: true, merge: true, rebase: true, reset: true, copyHash: true, copySubject: true },
			commitDetailsViewFile: { viewDiff: true, viewFileAtThisRevision: true, viewDiffWithWorkingFile: true, openFile: true, markAsReviewed: true, markAsNotReviewed: true, resetFileToThisRevision: true, copyAbsoluteFilePath: true, copyRelativeFilePath: true },
			remoteBranch: { checkout: true, delete: true, fetch: true, merge: true, pull: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
			stash: { apply: true, createBranch: true, pop: true, drop: true, copyName: true, copyHash: true },
			tag: { viewDetails: true, delete: true, push: true, createArchive: true, copyName: true },
			uncommittedChanges: { stash: true, reset: true, clean: true, openSourceControlView: true },
		},
		customBranchGlobPatterns: [],
		customEmojiShortcodeMappings: [],
		customPullRequestProviders: [],
		dateFormat: { type: 0, iso: false }, // DateFormatType.DateAndTime
		defaultColumnVisibility: { author: true, commit: true, date: true },
		dialogDefaults: {
			addTag: { pushToRemote: false, type: 0 }, // TagType.Annotated
			applyStash: { reinstateIndex: false },
			cherryPick: { noCommit: false, recordOrigin: false },
			createBranch: { checkout: false },
			deleteBranch: { forceDelete: false },
			fetchIntoLocalBranch: { forceFetch: false },
			fetchRemote: { prune: false, pruneTags: false },
			general: { referenceInputSpaceSubstitution: null },
			merge: { noCommit: false, noFastForward: true, squash: false },
			popStash: { reinstateIndex: false },
			pullBranch: { noFastForward: false, squash: false },
			rebase: { ignoreDate: true, interactive: false },
			resetCommit: { mode: GitResetMode.Mixed },
			resetUncommitted: { mode: GitResetMode.Mixed },
			stashUncommittedChanges: { includeUntracked: true },
		},
		enhancedAccessibility: false,
		fetchAndPrune: false,
		fetchAndPruneTags: false,
		fetchAvatars: false,
		graph: {
			colours: DEFAULT_GRAPH_COLOURS,
			style: 0, // GraphStyle.Rounded
			grid: { x: 16, y: 24, offsetX: 16, offsetY: 12, expandY: 250 },
			uncommittedChanges: 0, // GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges
		},
		includeCommitsMentionedByReflogs: false,
		initialLoadCommits: 300,
		keybindings: { find: 'f', refresh: 'r', scrollToHead: 'h', scrollToStash: 's' },
		loadMoreCommits: 100,
		loadMoreCommitsAutomatically: true,
		markdown: true,
		mute: { commitsNotAncestorsOfHead: false, mergeCommits: true },
		onlyFollowFirstParent: false,
		onRepoLoad: { scrollToHead: false, showCheckedOutBranch: false, showSpecificBranches: [] },
		referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: true, tagLabelsOnRight: false },
		repoDropdownOrder: 2, // RepoDropdownOrder.WorkspaceFullPath
		showRemoteBranches: true,
		showStashes: true,
		showTags: true,
	};
}

export const DEFAULT_REPO_STATE: GitRepoState = {
	cdvDivider: 0.5,
	cdvHeight: 250,
	columnWidths: null,
	commitOrdering: RepoCommitOrdering.Default,
	fileViewType: 0, // FileViewType.Default
	hideRemotes: [],
	includeCommitsMentionedByReflogs: 0, // BooleanOverride.Default
	issueLinkingConfig: null,
	lastImportAt: 0,
	name: null,
	onlyFollowFirstParent: 0,
	onRepoLoadShowCheckedOutBranch: 0,
	onRepoLoadShowSpecificBranches: null,
	pullRequestConfig: null,
	showRemoteBranches: true,
	showRemoteBranchesV2: 0,
	showStashes: 0,
	showTags: 0,
	workspaceFolderIndex: null,
};

export const DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE: GitGraphViewGlobalState = {
	alwaysAcceptCheckoutCommit: false,
	issueLinkingConfig: null,
	pushTagSkipRemoteCheck: false,
};

export const DEFAULT_GIT_GRAPH_VIEW_WORKSPACE_STATE: GitGraphViewWorkspaceState = {
	findIsCaseSensitive: false,
	findIsRegex: false,
	findOpenCommitDetailsView: false,
};

export function createDefaultRepos(repo: string): GitRepoSet {
	return { [repo]: Object.assign({}, DEFAULT_REPO_STATE) };
}
