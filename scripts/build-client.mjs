/**
 * 构建浏览器半边：把 src/client/index.ts 用 esbuild 打成 DSH 的模块包络。
 *
 * react 与 @deepseek-ai/dsh-client-ui-primitives 是 shell 共享的平台模块，
 * 因此外部化；其余依赖一律打进包内。宿主半边仍由 tsc 从 src/ 编译。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** 与 @deepseek-ai/dsh-client-web 的 PLATFORM_MODULES 保持一致的外部模块。 */
const CLIENT_EXTERNALS = [
	'react',
	'react/jsx-runtime',
	'react-dom',
	'react-dom/client',
	'@deepseek-ai/dsh-client-ui-primitives',
];

const bundled = await build({
	entryPoints: [join(root, 'src', 'client', 'index.ts')],
	bundle: true,
	format: 'cjs',
	platform: 'browser',
	target: ['chrome100'],
	// 复制的 FileDiff 用自动 JSX 运行时（不显式导入 React）。
	jsx: 'automatic',
	// charset 'utf8' 保留中文字面量原样，默认的 'ascii' 会转义成 \\uXXXX。
	charset: 'utf8',
	// assets/ 下的图标以文本形式内联，客户端不额外请求资源。
	// CSS 模块由 esbuild 转成类名映射；其样式文本单独产出，下面内联进包。
	loader: { '.svg': 'text', '.css': 'local-css' },
	external: CLIENT_EXTERNALS,
	// CSS 模块需要输出路径才能解析；写到 lib 后随即读回并内联，不留下独立样式文件。
	outdir: join(root, 'lib'),
	write: false,
	legalComments: 'none',
});

const outputs = bundled.outputFiles ?? [];
const jsFile = outputs.find((file) => file.path.endsWith('.js'));
const cssFiles = outputs.filter((file) => file.path.endsWith('.css'));
if (jsFile === undefined || jsFile.text.length === 0) throw new Error('esbuild 没有产出 JS');
const css = cssFiles.map((file) => file.text).join('\n');

const body = jsFile.text;

const bundle = `/**
 * ${pkg.name} 浏览器半边 —— 由 scripts/build-client.mjs 从 src/client/ 生成，请勿手改。
 * ModuleLoader 包络：id 为包名，工厂函数收到 web 运行时的 require。
 */
${css === '' ? '' : `(function () {
  if (typeof document === 'undefined') return;
  if (document.getElementById('dsh-source-control-module-style') !== null) return;
  var style = document.createElement('style');
  style.id = 'dsh-source-control-module-style';
  style.textContent = ${JSON.stringify(css)};
  document.head.appendChild(style);
})();
`}window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  },
});
`;

mkdirSync(join(root, 'lib'), { recursive: true });
writeFileSync(join(root, 'lib', 'client.js'), bundle);
console.log(`[${pkg.name}] lib/client.js ${Buffer.byteLength(bundle)} 字节${css === '' ? '' : `（含内联样式 ${Buffer.byteLength(css)} 字节）`}`);
