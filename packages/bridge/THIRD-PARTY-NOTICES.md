# Third-party notices

`lib/index.js` is a self-contained build: it statically inlines the packages below
instead of importing them from `node_modules`, because the dsh host only guarantees
Node builtins when it loads a plugin from a `link:` or unpacked install. Inlining
changes packaging, not authorship — each package remains under its own license, and
this file reproduces the notice those licenses require.

Every package in this list is MIT licensed. The one MIT text below applies to all of
them; the copyright lines are per package, taken from each package's own `LICENSE`.

| Package | Version | Copyright |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.4 | Copyright (c) 2021-present Shigma |
| `@deepseek-ai/cosmokit` | 1.8.5 | Copyright (c) 2021-present Shigma |
| `@deepseek-ai/dsh-brand` | 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-home-paths` | 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-llm` | 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-sandbox` | 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-scope` | 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-timeout` | 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-tools` | 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-typert-protocol` | 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-util-crypto` | 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/dsh-util-values` | 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/schemastery` | 3.18.4 | Copyright (c) 2021-present Shigma |
| `ws` | 8.22.0 | Copyright (c) 2011 Einar Otto Stangvik \<einaros@gmail.com\>; Copyright (c) 2013 Arnout Kazemier and contributors |

`pnpm run check-bundle` fails if the build starts importing anything outside this
list (anything that is not a `node:*` builtin), so this file and the bundle cannot
drift apart silently.

## MIT License

Copyright (c) the respective copyright holders named above.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
