import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const temporary = mkdtempSync(join(tmpdir(), 'chooser-runtime-'));
const check = process.argv.includes('--check');

function generatedFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? generatedFiles(path) : [path];
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

	for (const path of generatedFiles(temporary)) {
		const name = relative(temporary, path);
		const pathInRepo = join(root, name);
		const source = 'typescript/' + name.replace(/\.js$/, '.ts');
		const expected = `// Generated from ${source}. Run npm run build.\n` + readFileSync(path, 'utf8');
		if (check) {
			if (readFileSync(pathInRepo, 'utf8') !== expected)
				throw new Error(`Generated runtime is out of date: ${name}. Run npm run build.`);
		} else {
			writeFileSync(pathInRepo, expected);
		}
	}
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
