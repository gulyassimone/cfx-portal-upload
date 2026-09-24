# Shared resource release

Copy [`examples/garage-release.yml`](../examples/garage-release.yml) to the
resource repository as `.github/workflows/release.yml`. Keep its existing
`ci.yml` unchanged. Publish this workflow and both Action bundles before
switching the caller to that revision.

The caller waits for its own CI and calls `resource-release.yml`. The shared
workflow downloads the existing CI web artifact when configured, prepares the
manifest version, packages runtime files, and publishes verified archives with
provenance. It never rebuilds the web. The CFX job runs only on `deploy-branch`
and verifies the downloaded ZIP's SHA-256 and manifest version before upload.

## Default: manifest-based runtime packaging

`package-mode: auto` is the default: it selects runtime packaging unless a
custom command is provided. Set `package-mode: runtime` to require runtime
packaging. No project packaging command or Python/Lua interpreter is needed. The
Node.js implementation parses `fxmanifest.lua` and:

- includes `client_script(s)`, `server_script(s)`, `shared_script(s)`,
  `file(s)`, local `ui_page`, `loadscreen`, `before_level_meta`,
  `after_level_meta` and `data_file` filename references;
- resolves glob patterns, including CFX's recursive `**.lua` spelling;
- includes directory contents for directory references such as audio wavepacks;
- skips external `@resource/...` references and HTTP(S) UI pages;
- includes the manifest itself and the conventional `stream/` runtime directory;
- always includes `install/schema.sql` and `install/seed.sql` if they exist;
  their absence is not an error, and other install files are not implicitly
  added;
- excludes development directories (`node_modules`, tests, Git/editor folders,
  `web/src` and the configured web directory's sibling `src`), README files,
  package manifests/lockfiles, `.env` files, source maps and input archives;
- rejects unresolved references, unsafe paths, symlinks and non-regular files.

The file selection is generic: it does not contain garage-specific paths or SQL
names beyond the two agreed conventional install files. Resource names only
control the archive root and filenames. A script's runtime `require()` calls or
web imports are not recursively analyzed: include those files via manifest
entries. `escrow_ignore` controls encryption, not file inclusion.

The parser supports literal strings, list tables, long-bracket strings,
comments, local string/list constants, and string concatenation. It does **not**
execute Lua. Conditional declarations, loops, functions, runtime-generated paths
and syntax unsupported by its Lua 5.3 parser fail explicitly. For those
manifests, use the custom mode rather than silently producing an incomplete
archive. Type-specific `data_file` aliases that do not resolve to real
files/directories also require custom packaging.

Every selected file is copied into temporary staging. ZIP and TAR.GZ files are
then created with `<resource-name>/` as their root. The complete entry list and
SHA-256 of every file in **both** archives are compared against the original
source. Staging is removed afterwards; artifact staging is removed after upload.

## What stays in the resource

- CI, tests, sources and production web build commands.
- `fxmanifest.lua`, runtime files, and optional install SQL files.
- A short release caller, configuration variables and secrets.

The garage caller now selects runtime mode and does not run
`npm run package --prefix web` during release. Existing garage packaging scripts
and their tests may remain for local use and the unchanged CI. Their source was
not available during this implementation, so equivalence to every
garage-specific check must still be verified against a real garage package
before production use.

## Optional custom packager

To retain an existing project packager, set all three inputs:

```yaml
package-mode: custom
package-command: npm run package --prefix web
package-zip: dist/sa_garage-release.zip
```

The command runs at the caller workspace root and must consume the existing CI
build. The shared workflow does not install project dependencies or run a web
build for it. Runtime mode rejects custom command inputs to avoid silently
ignoring the selected packager. Custom mode keeps the input ZIP byte-for-byte
and performs the common archive/version/web checks; source-file comparison and
runtime selection remain the custom packager's responsibility.

## Inputs

| Input               | Meaning                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `resource-name`     | Required archive root and deploy resource name, e.g. `sa_garage`                                    |
| `asset-name`        | CFX display name; defaults to `resource-name`                                                       |
| `runners`           | JSON runner-label array; default `["ubuntu-latest"]`                                                |
| `node-version`      | Node version for project commands; default `22`                                                     |
| `node-version-file` | Optional caller version file; overrides `node-version`                                              |
| `manifest-path`     | Workspace-relative source manifest; default `fxmanifest.lua`; its parent is the runtime source root |
| `version-mode`      | `run`: MAJOR.run_number.run_attempt; `manifest`: preserve the version                               |
| `web-artifact-name` | Optional CI artifact from the same workflow run                                                     |
| `web-build-path`    | Resource-relative production web directory; paired with web-artifact-name                           |
| `package-mode`      | `auto` (default), `runtime` or `custom`                                                             |
| `package-command`   | Required only in custom mode                                                                        |
| `package-zip`       | Workspace-relative custom output ZIP path; required only in custom mode                             |
| `deploy-branch`     | Branch allowed to upload to CFX and deploy; default `master`                                        |
| `deploy`            | Default `true`; `false` uploads to CFX without SSH deployment                                       |
| `ssh-port`          | Default `22`                                                                                        |
| `backup-path`       | Default `~/.cfx-portal-upload/backups`                                                              |

For a web-less resource, omit both web inputs. No artifact download or web check
is performed. With web enabled, `index.html`, JavaScript and CSS must exist in
the build and the packaged files. The caller's CI still owns its complete web
checks.

Pass `FORUM_COOKIE` and, for deployment, `SERVER_HOST`, `SERVER_USER`, `SSH_KEY`
and `DEPLOY_PATH` as named secrets. There is no deployment-directory fallback.
The ZIP root and deploy resource name must agree; CFX's asset name can differ.

`version-mode: run` modifies only the release checkout, never commits back. When
there is no version declaration it adds `1.run_number.run_attempt`. Otherwise it
requires exactly one literal `version 'MAJOR.MINOR.PATCH'` declaration and uses
the caller's run number and attempt. Keep the caller workflow identity stable if
you depend on that version sequence.

## Artifacts and composition

The artifact name is `<resource-name>-release-<run_id>-<run_attempt>` and is
retained for 14 days. Runtime mode produces:

- `<resource-name>-release.zip` and `<resource-name>.tar.gz`;
- `<resource-name>-release.metadata.json` (resource, full commit SHA, version,
  archive filenames, ZIP SHA-256, file list, per-file hashes,
  `encrypted: false`);
- `contents.txt` and `SHA256SUMS` (ZIP checksum).

`encrypted: false` describes the package before CFX processing. Custom mode
collects the ZIP and provenance only; it does not generate a TAR.

The workflow uses GitHub's `$/package` and `$/` self-repository references so
both Actions come from its own revision, not the resource checkout. This
requires GitHub.com support for self-repository references; older GHES is not
targeted. The caller owns CI dependencies and production concurrency.
Pull-request events are skipped by the shared release workflow.

The root upload Action's legacy automatic packaging is separate. The common
workflow uses the `/package` Action and passes a prepared ZIP to the root Action
with `makeZip: false`. `package-mode` is a reusable workflow input, not a new
input on the root upload Action.

Set `deploy-enabled: false` for artifact-only releases, without CFX upload or
SSH deployment. No secrets are required in this mode. `deploy: false` alone
still uploads to CFX and therefore requires `FORUM_COOKIE`.
