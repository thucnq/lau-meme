import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules', '.wrangler', 'coverage'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: globals.serviceworker },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // D1: always prepare().bind() - never build SQL from strings
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.property.name=/^(prepare|exec)$/] > TemplateLiteral[expressions.length>0]",
        message: 'Không ghép chuỗi vào SQL - dùng prepare(...).bind(...)',
      }],
    },
  },
)
