import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const temporary = mkdtempSync(join(tmpdir(), 'chooser-runtime-'));
const check = process.argv.includes('--check');

function generatedFiles(directory: string, topLevelOnly = false): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? (topLevelOnly ? [] : generatedFiles(path)) : [path];
	});
}

try {
	const result = spawnSync(process.execPath, [
		require.resolve('typescript-minimum/bin/tsc'),
		'--project', 'tsconfig.runtime.json',
		'--outDir', temporary,
	], { cwd: root, stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error('Strict TypeScript compilation failed.');

	const emitted = new Set<string>();
	const {parse} = require('acorn') as typeof import('acorn');
	for (const path of generatedFiles(temporary)) {
		const name = relative(temporary, path).split(sep).join('/');
		emitted.add(name);
		const pathInRepo = join(root, name);
		const source = 'typescript/' + name.replace(/\.(m?)js$/, '.$1ts');
		const code = readFileSync(path, 'utf8');
		parse(code, {ecmaVersion: 2019, sourceType: name.endsWith('.mjs') ? 'module' : 'script'});
		const expected = `// Generated from ${source}. Run npm run build:runtime.\n` + code;
		if (check) {
			if (readFileSync(pathInRepo, 'utf8') !== expected)
				throw new Error(`Generated runtime is out of date: ${name}. Run npm run build:runtime.`);
		} else {
			mkdirSync(dirname(pathInRepo), {recursive: true});
			writeFileSync(pathInRepo, expected);
		}
	}
	for (const directory of ['www', 'src/browser', 'src/hooks', 'capacitor']) {
		for (const path of generatedFiles(join(root, directory), directory === 'capacitor')) {
			if (!/\.m?js$/.test(path)) continue;
			const name = relative(root, path).split(sep).join('/');
			if (emitted.has(name) || !readFileSync(path, 'utf8').startsWith('// Generated from typescript/')) continue;
			if (check) throw new Error(`Generated runtime has no source: ${name}. Run npm run build:runtime.`);
			rmSync(path);
		}
	}
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
