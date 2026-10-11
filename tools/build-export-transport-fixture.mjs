import { createRequire } from 'node:module';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const webpack = require('webpack');
const compiler = webpack({
  mode: 'production',
  target: 'node',
  entry: {
    fixture: resolve(
      'apps/admin-api/src/log-export/export-transport.runtime.fixture.ts',
    ),
    capacity: resolve(
      'apps/admin-api/src/log-export/export-capacity.runtime.fixture.ts',
    ),
    scheduler: resolve(
      'apps/admin-api/src/log-export/export-scheduler.runtime.fixture.ts',
    ),
  },
  output: {
    path: resolve('.local-work/export-transport-runtime'),
    filename: '[name].cjs',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@api-gateway/shared-types': resolve('libs/shared-types/src/index.ts'),
    },
  },
  externals: [
    ({ request }, callback) => {
      if (
        request &&
        !request.startsWith('.') &&
        !request.startsWith('/') &&
        request !== '@api-gateway/shared-types'
      )
        callback(null, `commonjs ${request}`);
      else callback();
    },
  ],
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: require.resolve('ts-loader'),
        options: {
          transpileOnly: true,
          configFile: resolve('apps/admin-api/tsconfig.app.json'),
          compilerOptions: {
            module: 'commonjs',
            esModuleInterop: true,
            verbatimModuleSyntax: false,
            moduleResolution: 'node10',
            customConditions: null,
            allowImportingTsExtensions: false,
            composite: false,
            declaration: false,
            declarationMap: false,
            emitDeclarationOnly: false,
            noEmit: false,
          },
        },
      },
    ],
  },
  optimization: { minimize: false },
});
await new Promise((done, fail) =>
  compiler.run((error, stats) => {
    compiler.close((closeError) => {
      if (error || closeError || stats?.hasErrors())
        fail(
          error ??
            closeError ??
            new Error(stats.toString({ all: false, errors: true })),
        );
      else done();
    });
  }),
);
copyFileSync(
  resolve('docker/postgres-init.sql'),
  resolve('.local-work/export-transport-runtime/postgres-init.sql'),
);
console.log(
  'Built external export transport, capacity and scheduler verification fixtures.',
);
