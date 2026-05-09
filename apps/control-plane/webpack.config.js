const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join, resolve } = require('path');

const workspaceRoot = resolve(__dirname, '../..');

module.exports = {
  resolve: {
    alias: {
      '@api-gateway/shared-types': resolve(workspaceRoot, 'libs/shared-types/src/index.ts'),
    },
  },
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
  ],
};
