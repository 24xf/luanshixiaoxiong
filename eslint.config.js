// ESLint flat config（ESLint 10 + typescript-eslint）。
// 范围说明：仅对 TypeScript（server/*.ts、测试、src 下 ts）做严格 lint。
//   - 引擎 src/**/*.js 与前端 public/*.js 暂不纳入：它们是 checkJs:false 的松散写法，
//     且依赖大量 node/browser 全局、策略基类方法签名带未用形参；强开只会触发一次性 style war，
//     留作后续独立 pass（需配套 globals 配置）。
//   - @typescript-eslint/no-explicit-any 关闭：引擎/TS 边界（createState/makePlayer 等）刻意用 any，
//     且它并非 TS strict 的一部分，强开只会造成无安全收益的改动噪声。
//   - eslint-config-prettier 关闭所有与 Prettier 冲突的格式化规则（格式化交给 Prettier）。
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '*.log',
      'hero-ui-smoke.cjs', // 开发用一次性冒烟脚本，使用 require，不纳入 gate
      '**/*.js', // 引擎/前端 JS 暂不 lint（见上方范围说明）
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  // TypeScript
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // 保留对未用变量/形参的捕获，但允许 `_` 前缀形参（策略签名常有无用形参）
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Prettier 最后：关闭格式化类规则，避免与 prettier 冲突
  prettier,
);
