# Publishing **Ollama Coder** to the VS Code Marketplace

This file is a runbook for the maintainer. The Marketplace requires a personal
Microsoft account and a personal Azure DevOps token, so **only the publisher
themselves can run the final command** — no CI bot or co-author can do it on
your behalf.

Everything *else* (manifest, icon, categories, changelog, README, .vscodeignore)
is already prepared in this repo.

---

## 0. Prerequisites

- A free [Microsoft account](https://account.microsoft.com).
- Node ≥ 18 and `npm` installed locally.
- This repo cloned, with `npm install` done.

---

## 1. Create your Marketplace publisher (one-time)

1. Sign in at <https://dev.azure.com> with your Microsoft account and create
   an Azure DevOps organisation (any name; free tier).
2. Go to <https://marketplace.visualstudio.com/manage> and create a
   **publisher**. Use the publisher ID that already lives in `package.json`:

   ```json
   "publisher": "evilmucedin"
   ```

   If you choose a different publisher ID, update `package.json` (and the
   `homepage` / `repository.url` if needed) before publishing.

---

## 2. Create a Personal Access Token (one-time, can be rotated)

1. In Azure DevOps, click your avatar → **Personal access tokens**.
2. **New token**:
   - **Organization**: *All accessible organizations*
   - **Scopes**: *Custom defined* → enable **Marketplace → Manage**
   - **Expiration**: up to 1 year
3. Copy the token **once** — Azure won’t show it again.
4. Store it in your shell or keychain. The simplest:

   ```sh
   export VSCE_PAT="<paste token here>"
   ```

   Or, more durable (macOS):

   ```sh
   security add-generic-password -a "$USER" -s vsce-pat -w "<paste>"
   # Later, in your shell rc:
   export VSCE_PAT="$(security find-generic-password -a $USER -s vsce-pat -w)"
   ```

---

## 3. Sanity-check the package locally

```sh
npm install                # one-time
npm test                   # compile + tsc --noEmit + unit tests
npx @vscode/vsce ls         # list every file that will be published — make sure no secrets!
npx @vscode/vsce package -o ollama-coder.vsix
```

Install the local `.vsix` once to smoke-test:

```sh
code --install-extension ./ollama-coder.vsix --force
```

Open the chat, try inline completion, switch models, and exercise an agent
turn before publishing.

---

## 4. Publish

Bump the version first (semver — patch/minor/major). `vsce` does this for you:

```sh
npx @vscode/vsce publish patch   # 0.1.0 -> 0.1.1
# or: npx @vscode/vsce publish minor
# or: npx @vscode/vsce publish 0.2.3   # explicit version
```

`vsce` reads `$VSCE_PAT`, increments the version in `package.json`, runs the
`vscode:prepublish` script (which runs `npm run compile`), packages, uploads,
and verifies. First-time publishes can take ~1–2 minutes to appear in search.

Watch the status at:

- <https://marketplace.visualstudio.com/manage/publishers/evilmucedin>

Once published, the extension page will be at:

- <https://marketplace.visualstudio.com/items?itemName=evilmucedin.ollama-coder>

And users can install via:

```sh
code --install-extension evilmucedin.ollama-coder
```

…or from VS Code → **Extensions** → search “Ollama Coder”.

---

## 5. After publishing

- Tag the release:
  ```sh
  git tag v0.1.0 && git push origin v0.1.0
  ```
- Create a GitHub Release with the relevant section of `CHANGELOG.md`.
- For subsequent versions: update `CHANGELOG.md`, then `vsce publish patch`.

---

## 6. Rolling out / unpublishing

| Action | Command |
| --- | --- |
| Unpublish a bad version | `npx @vscode/vsce unpublish evilmucedin.ollama-coder@0.1.1` |
| Unlist the whole extension | <https://marketplace.visualstudio.com/manage/publishers/evilmucedin> → ellipsis → **Unlist** |
| Rotate the PAT | Create a new token in Azure DevOps, replace `$VSCE_PAT`, run `vsce verify-pat` |

---

## 7. Optional: also publish to Open VSX (for VSCodium / Cursor / Theia)

```sh
npm i -g ovsx
ovsx publish ollama-coder.vsix -p "$OVSX_TOKEN"
```

`OVSX_TOKEN` comes from <https://open-vsx.org/user-settings/tokens>.
