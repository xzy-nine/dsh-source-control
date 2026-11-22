/**
 * 面板状态与写入器：多个 hook 的依赖面与返回值都带这一对。
 *
 * 纯模块：无平台依赖，两个半边各自打进自己的产物。
 */
import type { Dispatch, SetStateAction } from 'react';
import type { PanelState } from '../shared/types.ts';

/** 面板状态与其写入器。 */
export interface PanelStateAccess {
	/** 面板状态。 */
	readonly state: PanelState;
	/** 面板状态写入器。 */
	readonly setState: Dispatch<SetStateAction<PanelState>>;
}
