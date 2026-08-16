# Releasing

Releases are cut from the GitHub Actions tab. Nothing is published from a
laptop, and no version number is burned by merging a pull request.

## Cutting a release

1. Open **Actions → Release → Run workflow** (branch: `main`).
2. Leave the version box empty, or type an exact version.
3. Run it.

## How the version is chosen

The last released version is read from the git tags, not from `package.json`,
because tags record what was actually published.

| You enter | Last tag | Released |
| --- | --- | --- |
| *(empty)* | *(none)* | `v0.0.1` |
| *(empty)* | `v1.2.9` | `v1.2.10` |
| `1.4.0` | `v1.2.9` | `v1.4.0` |
| `1.2.8` | `v1.2.9` | rejected - not newer |
| `1.4` | any | rejected - not a semver number |

So an empty box always means "one patch up", and a fresh repository with no
tags starts at `0.0.1`.

The workflow lints, tests and audits, sets the version, builds, then publishes
in this order:

| Artifact | Where |
| --- | --- |
| npm package | `vidaa-edge` on npmjs.com |
| Container image | `ghcr.io/<owner>/vidaa-edge:<version>` and `:latest` |
| Release page | GitHub Releases, with generated changelog and install snippets |

Only after every artifact is published does it commit the version bump, push
the `v<version>` tag, and write the release page — so a failed build never
leaves a dangling tag behind.

Tick **dry run** to rehearse the whole thing: it builds, packs and scans, but
publishes nothing and leaves git untouched.

> If `main` is a protected branch, allow GitHub Actions to push to it (or add
> the workflow to the bypass list), otherwise the final commit is rejected
> after everything has already been published.

## Between releases

Every push to `main` publishes `ghcr.io/<owner>/vidaa-edge:edge`. Use that to
test the latest code without waiting for a version.

## One-time setup

**Container image** — nothing to do. `GITHUB_TOKEN` can already push to GHCR.
After the first release, make the package public at
*Packages → vidaa-edge → Package settings → Change visibility*, otherwise
`docker pull` asks for credentials.

**npm** — publishing is skipped until it is switched on, so releases work
before this is done:

1. Publish once manually to claim the name: `npm publish --access public`.
2. On npmjs.com, open the package → *Settings → Trusted publisher* → GitHub
   Actions, repository `<owner>/vidaa-edge`, workflow `release.yml`.
3. In the GitHub repository, add variable `PUBLISH_NPM` = `true`
   (*Settings → Secrets and variables → Actions → Variables*).

Trusted publishing uses short-lived OIDC tokens, so there is no npm token to
store or rotate, and published versions carry a provenance attestation. If you
would rather use a classic token, add it as the `NPM_TOKEN` secret instead —
the workflow falls back to it.

## What gates a release

Lint, tests and the production build all gate the release: if any of them
fails, nothing is published.

`npm audit` is the exception — it reports but does not fail the run, because
the pinned Angular range carries advisories that can only be cleared by
widening it, which is a dependency decision rather than a release-process one.
Dependabot proposes those bumps.

## Security scanning

- **Dependabot** opens grouped dependency pull requests every Monday.
- **Trivy** scans the built image on every pull request and every release;
  CRITICAL and HIGH findings with a fix available land in the *Security* tab.
- **npm audit** reports high-severity advisories in runtime dependencies on
  every run. It does not fail the build: the pinned Angular 19.0.x range
  currently carries advisories that can only be cleared by widening the range,
  which is a dependency decision rather than a release-process one. Dev-only
  advisories are excluded — they never reach the published artifact.
