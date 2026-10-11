/**
 * 构建浏览器半边：把 src/client/index.js 用 esbuild 打成 DSH 的模块包络。
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
	'@deepseek-ai/dsh-client-ui-primitives',
];

const bundled = await build({
	entryPoints: [join(root, 'src', 'client', 'index.js')],
	bundle: true,
	format: 'cjs',
	platform: 'browser',
	target: ['chrome100'],
	// charset 'utf8' 保留中文字面量原样，默认的 'ascii' 会转义成 \\uXXXX。
	charset: 'utf8',
	external: CLIENT_EXTERNALS,
	write: false,
	legalComments: 'none',
});

const body = bundled.outputFiles?.[0]?.text;
if (body === undefined || body.length === 0) throw new Error('esbuild 没有产出内容');

const bundle = `/**
 * ${pkg.name} 浏览器半边 —— 由 scripts/build-client.mjs 从 src/client/ 生成，请勿手改。
 * ModuleLoader 包络：id 为包名，工厂函数收到 web 运行时的 require。
 */
window.__ModuleLoader__.load({
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
console.log(`[${pkg.name}] lib/client.js ${Buffer.byteLength(bundle)} 字节`);
