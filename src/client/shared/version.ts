/**
 * 插件版本号：由构建脚本从 package.json 注入（见 scripts/build-client.mjs 的 define）。
 *
 * 反馈正文据此报告版本，便于定位问题发生在哪一版。
 */
export const PLUGIN_VERSION: string = typeof __DSH_PLUGIN_VERSION__ === 'string' ? __DSH_PLUGIN_VERSION__ : '未知';
