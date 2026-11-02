/**
 * 设置模块共用的类型：用户身份与设置页签。
 */
/** 用户身份（本地与全局）。 */
export interface UserDetails {
	readonly userName?: { local?: string | null; global?: string | null } | null;
	readonly userEmail?: { local?: string | null; global?: string | null } | null;
}

/** 设置页签。 */
export type SettingsTab = 'repo' | 'global' | 'feedback';
