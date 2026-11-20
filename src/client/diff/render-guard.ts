/**
 * 差异页正文的渲染守卫：一处渲染失败只影响这一段，页头与本页其余控件照常可用。
 *
 * 宿主按页类型给侧栏页正文套错误边界，整棵正文树抛错时该类型的其它页一并失去内容
 * （见 ui-slots 的 `reportEntryError`）。正文的渲染失败在这里收住，改画一段可读说明与
 * 重试入口；换文件时由调用方换 `key` 重新挂载。
 */
import React from 'react';
import css from '../css/index.module.css';

/** 守卫的状态。 */
interface DiffRenderGuardState {
	/** 上一次渲染抛出的错误文本；没有失败时为 null。 */
	readonly failure: string | null;
}

/**
 * 差异正文的渲染守卫。
 *
 * 失败时不重抛：抛到宿主那一层会让整类页面一起失去内容。正文改画失败原因与重试按钮，
 * 页头的文件切换、换行与跳转因此仍可用。
 */
export class DiffRenderGuard extends React.Component<{ readonly children?: React.ReactNode }, DiffRenderGuardState> {
	state: DiffRenderGuardState = { failure: null };

	/**
	 * 记下渲染失败。
	 *
	 * @param error - 抛出的错误。
	 * @returns 新状态。
	 */
	static getDerivedStateFromError(error: unknown): DiffRenderGuardState {
		return { failure: error instanceof Error ? error.message : String(error) };
	}

	/**
	 * 重试：清掉失败状态，让正文按当前数据重画。
	 *
	 * @returns 无。
	 */
	private retry = (): void => { this.setState({ failure: null }); };

	render(): React.ReactNode {
		if (this.state.failure === null) return this.props.children;
		return React.createElement(
			'div',
			{ className: css.status, role: 'alert', 'data-sc-diff-failed': '' },
			React.createElement('span', null, `这段差异渲染失败：${this.state.failure}`),
			React.createElement('button', { type: 'button', className: css.tool, onClick: this.retry }, '重试'),
		);
	}
}
