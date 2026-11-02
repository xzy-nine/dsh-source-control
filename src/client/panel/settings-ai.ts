/**
 * AI 提交信息生成的模型配置区。
 */
import React from 'react';
import { fetchAiModels, type AiModelCatalog } from '../api/index.ts';
import { DropdownRow } from './settings-rows.ts';
import css from '../css/settings.module.css';

/**
 * AI 提交信息生成的模型配置区。
 *
 * @param props.provider - 当前保存的供应商 id（空串 = 未配置）。
 * @param props.model - 当前保存的模型 id。
 * @param props.rules - 自定义规则提示词。
 * @param props.onChange - 供应商与模型变更回调。
 * @param props.onRulesChange - 规则变更回调。
 * @returns 区元素。
 */
export function AiModelConfigSection({ provider, model, rules, onChange, onRulesChange }: {
	provider: string;
	model: string;
	rules: string;
	onChange: (provider: string, model: string) => void;
	onRulesChange: (rules: string) => void;
}): React.ReactElement {
	const [catalog, setCatalog] = React.useState<AiModelCatalog | null>(null);
	React.useEffect(() => {
		let cancelled = false;
		fetchAiModels().then((data) => { if (!cancelled) setCatalog(data); }).catch(() => { if (!cancelled) setCatalog(null); });
		return () => { cancelled = true; };
	}, []);
	const providers = catalog?.providers ?? [];
	const modelsByProvider = catalog?.modelsByProvider ?? {};
	const fallback = catalog?.fallback ?? null;
	const models = modelsByProvider[provider] ?? [];
	return React.createElement(
		'div',
		{ className: css.setAiModel },
		provider === '' && fallback !== null
			? React.createElement('div', { className: css.setNote }, '未配置专用模型，将使用当前会话模型（', fallback.provider, '/', fallback.model, '）。')
			: provider === ''
				? React.createElement('div', { className: css.setNote }, '未配置专用模型，且无法获取当前会话模型。')
				: null,
		React.createElement(DropdownRow, {
			label: '供应商',
			value: provider,
			options: [
				{ value: '', label: '（使用当前会话模型）' },
				...providers.map((p) => ({ value: p.id, label: p.name || p.id })),
			],
			onChange: (next: string) => { onChange(next, ''); },
		}),
		provider !== '' && React.createElement(DropdownRow, {
			label: '模型',
			value: model,
			options: models.map((m) => ({ value: m, label: m })),
			onChange: (next: string) => { onChange(provider, next); },
		}),
		React.createElement('div', { className: css.setRow },
			React.createElement('label', { className: css.setLabel }, '规则'),
			React.createElement('textarea', {
				className: css.setTextarea,
				value: rules,
				placeholder: '自定义规则提示词，追加到系统提示词末尾。例如：使用中文；提交信息不超过 50 字符。',
				onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => { onRulesChange(e.currentTarget.value); },
				rows: 3,
			}),
		),
	);
}