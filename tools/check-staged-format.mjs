import { execFileSync } from 'node:child_process';
import * as prettier from 'prettier';

// Read the index, not working files: partially staged changes remain intact.
const files = execFileSync(
  'git',
  ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
let failed = false;
for (const file of files) {
  const info = await prettier.getFileInfo(file, {
    ignorePath: '.prettierignore',
  });
  if (info.ignored || !info.inferredParser) continue;
  let content;
  try {
    content = execFileSync('git', ['show', `:${file}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    console.error(`Could not read staged content in ${file}.`);
    failed = true;
    continue;
  }
  const options = await prettier.resolveConfig(file, { editorconfig: true });
  try {
    if (await prettier.check(content, { ...options, filepath: file })) continue;
    console.error(`Format the staged content in ${file} before committing.`);
  } catch (error) {
    console.error(`${file}: ${error.message}`);
  }
  failed = true;
}
if (failed) process.exitCode = 1;
