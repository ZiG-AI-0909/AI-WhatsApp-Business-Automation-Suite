// Minimal ESLint config used ONLY by the `lint:undef` script:
// undefined-identifier detection over src, nothing else (oxlint remains
// the project's main linter — this does not change that setup).
import globals from 'globals';

export default [
    {
        files: ['src/**/*.{js,jsx}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: {
                ...globals.browser,
                ...globals.es2024,
                ...globals.node,
            },
        },
        rules: {
            'no-undef': 'error',
        },
    },
];
