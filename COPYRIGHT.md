# Copyright and licensing

This project is a derivative work. Two sets of rights apply, and this file says
which is which so nobody has to guess.

## Upstream: the browser engine

The following come from the upstream browser engine and remain under its MIT license:

- `packages/bridge/` — the bridge plugin
- `extension/src/content/` — the page snapshot and action pipeline
- `extension/src/security/` — the approval and trust model
- `extension/src/background/` — except `session.ts`
- `benchmark/` — the evaluation harness

**Which repository that is, exactly.** The fork point was
[`Lum1104/dsh-browser`](https://github.com/Lum1104/dsh-browser), which has since been
renamed and transferred to **`omdsh-dev/dsh-browser`**; the old URL still resolves by
redirect. The original name is kept here because it is the historical record of where
this code was received from, and `omdsh-dev/dsh-browser` is the current location of the
same project — not a different one.

**The paths above are this fork's, and the layout differs.** Upstream keeps the bridge at
`packages/browser/bridge-browser/` and the extension at `extensions/dsh-browser/`; this
fork flattened both (`packages/bridge/`, `extension/`). Every file in the five groups
above was checked against the current upstream tree: all five exist there. A file being
in one of these groups means **the file originates upstream**, not that it is still
byte-identical — this fork has since modified some of them heavily, which is what the
MIT notice permits and what the next section delimits.

At the fork point these were 78 byte-identical files and about 90% of upstream's
lines, which is why the notice below has to be preserved. That is a condition of
the license the code was received under, not a courtesy.

    MIT License

    Copyright (c) 2026 Yuxiang Lin

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

## This fork: the interaction layer

Copyright (c) 2026 youbaiyun. Also MIT, on the same terms as above.

The files this fork is responsible for, none of which come from upstream:

- `extension/control/` — the side-panel UI, dependency-free vanilla TypeScript (replaces the upstream panel)
- `extension/src/settings.ts` — the settings model
- `extension/src/markers.ts` — the browser-panel prompt marker (replaces upstream's
  `selection.ts`, away from the *selection* concept and towards an origin marker)
- `extension/src/background/session.ts` — panel-to-conversation binding
- `skills/dsh-browser-crossplatform-troubleshooting/` — the troubleshooting skill
- the panel's own tests (`extension/tests/`), and the build/packaging scripts under
  `extension/scripts/` (`build.mjs`, `package.mjs`, `extension-id.mjs`)

### Same, and different

Stated plainly, because "derivative" can mean anything from a rename to a rewrite:

| | Upstream | This fork |
|---|---|---|
| **Shared** | the browser engine: content-script snapshot and action pipeline, the approval/trust model, the bridge transport, the benchmark harness | the same code, still under upstream's MIT notice |
| **Shared** | tool surface of `browser_*`, side-panel concept, MV3 + Firefox dual build, `--load-extension`-free operation | same architecture, extended rather than replaced |
| **Different** | the panel as upstream ships it (`panel/`, plus panel sources under `src/panel/`) | a dependency-free vanilla-TS panel under `control/`; no framework, no build-time UI dependency |
| **Different** | `selection.ts` (selection-based prompt handling) | `markers.ts` (an origin marker the model can check mechanically) |
| **Different** | one version number per package | one version number across five packages (root, protocol, bridge, extension, benchmark), asserted by a test |
| **Different** | bridge = `packages/browser/bridge-browser/`, extension = `extensions/dsh-browser/` | `packages/bridge/`, `extension/` |
| **Different** | ships no settings model of its own; panel owns almost no policy | `extension/src/settings.ts` owns the choices, and the panel only renders what it is handed |
| **Added here** | — | `session.follow` / `session.unfollow`, whole-workspace mirroring, `browser_launch`, image recognition relay, the troubleshooting skill, and the plugin settings page |

## Bundled npm packages in the bridge build

Since 0.38.8, `packages/bridge/lib/index.js` is self-contained: the build inlines
the npm packages the plugin calls, so a `link:` or unpacked install needs no
`node_modules` of its own. Those packages stay under their own licenses, and their
notices are preserved in
[`packages/bridge/THIRD-PARTY-NOTICES.md`](packages/bridge/THIRD-PARTY-NOTICES.md),
which `pnpm pack` and the npm registry include alongside `lib/`.

The inlined set is fixed and checked: `pnpm --dir packages/bridge run check-bundle`
fails if the bundle imports anything other than `node:*`. All fourteen packages are
MIT licensed. Inlining does not relicense any of them, and no upstream browser-engine
code is involved — this is about npm dependencies of this fork's bridge.

## Removed on purpose

`.github/FUNDING.yml` was deleted. It named the upstream maintainer's sponsorship
account, which would have collected donations intended for this fork.

## Contributions upstream

Engine defects belong in the upstream issue tracker, because the code in question
is theirs. Panel and interaction defects belong here.
