import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const execute = promisify(execFile);

integration('Retention case ownership after an actual Jest deadline', () => {
  it('preserves the timeout failure and prevents following-case PostgreSQL contamination', async () => {
    const rootDir = resolve(__dirname, '../..');
    const fixture = resolve(__dirname, 'fixtures/retention-timeout.fixture.ts');
    const config = {
      rootDir,
      testEnvironment: 'node',
      testMatch: [fixture],
      transform: {
        '^.+\\.[tj]s$': [
          '@swc/jest',
          {
            ...JSON.parse(
              readFileSync(resolve(rootDir, '.spec.swcrc'), 'utf8'),
            ),
            swcrc: false,
          },
        ],
      },
    };
    const results = [];
    for (const tracked of [false, true]) {
      let stdout: string;
      try {
        await execute(
          process.execPath,
          [
            require.resolve('jest/bin/jest'),
            '--config',
            JSON.stringify(config),
            '--runInBand',
            '--json',
            '--no-cache',
          ],
          {
            cwd: rootDir,
            env: { ...process.env, RETENTION_CASE_TRACKED: String(tracked) },
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          },
        );
        throw new Error(
          'The deliberate child Jest deadline must remain a failure.',
        );
      } catch (error) {
        const child = error as {
          code: unknown;
          stdout?: string;
          stderr?: string;
        };
        if (child.code !== 1 || !child.stdout) throw error;
        stdout = child.stdout;
      }
      const result = JSON.parse(stdout);
      const cases = result.testResults[0].assertionResults;
      expect(cases).toHaveLength(2);
      expect(cases[0].status).toBe('failed');
      expect(cases[0].failureMessages.join('\n')).toContain(
        'Exceeded timeout of 100 ms',
      );
      expect(cases[1].status).toBe(tracked ? 'passed' : 'failed');
      if (!tracked)
        expect(cases[1].failureMessages.join('\n')).toContain(
          'late-previous-case',
        );
      results.push({
        tracked,
        failed: result.numFailedTests,
        passed: result.numPassedTests,
        cases: cases.map((c: { title: string; status: string }) => ({
          title: c.title,
          status: c.status,
        })),
      });
    }
    mkdirSync(resolve(__dirname, '../../../../.local-work'), {
      recursive: true,
    });
    writeFileSync(
      resolve(
        __dirname,
        '../../../../.local-work/issue92-timeout-regression.json',
      ),
      JSON.stringify(results, null, 2),
    );
  }, 30000);
});
