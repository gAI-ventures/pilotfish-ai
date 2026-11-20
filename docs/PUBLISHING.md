# How the packages are released

Three npm packages and one Python package are built from this repository:

| Package | Folder | MCP Registry |
| --- | --- | --- |
| [`@gaiventures/pilotfish-mcp`](https://www.npmjs.com/package/@gaiventures/pilotfish-mcp) | `packages/mcp` | `io.github.gAI-ventures/pilotfish` |
| [`@gaiventures/pilotfish-mcp-managed`](https://www.npmjs.com/package/@gaiventures/pilotfish-mcp-managed) | `packages/mcp-managed` | `io.github.gAI-ventures/pilotfish-managed` |
| [`@gaiventures/pilotfish`](https://www.npmjs.com/package/@gaiventures/pilotfish) (the TypeScript SDK) | `packages/sdk` | |
| [`pilotfish-ai`](https://pypi.org/project/pilotfish-ai/) on PyPI (the Python SDK, imported as `pilotfish`) | `sdks/python` | |

`.github/workflows/publish.yml` runs on every push to `main` (each sync from the maintainers' repository is one):

1. **Build and test:** `npm run build`, `npm test`, and for the local MCP its browser e2e.
2. **Version and package** (`scripts/mcp-release.mjs`): the version is `release.json`'s when that is above the latest
   on npm, else the latest plus one patch; `packages/<name>/scripts/package.mjs` builds the package with its checks
   (only modules listed in `packages/mcp/bundle.json` ship, no model SDK ships, the README's tools and settings tables
   match the server); then what would ship is compared with the latest on npm.
3. **Pack and test the installed package**, as a user would install it.
4. **Publish** to npm, only when step 2 found a change, with npm trusted publishing and provenance (no stored token).
5. **List** the version in the MCP Registry (`scripts/mcp-registry.mjs`, GitHub OIDC login).
6. **Release** it on GitHub: a release and tag `<package>-v<version>` (`mcp-v0.1.70`), linking the npm version. It never
   fails the publish, and a version that already has its release is left alone.

The TypeScript SDK goes through the same steps but the MCP Registry; its installed package is also tested driving a
real Chrome through the open MCP.

`.github/workflows/publish-python.yml` releases the Python SDK: on every push that changes `sdks/python`, it runs its
tests (the local client against a real Chrome through the MCP built here), builds the sdist and wheel, and publishes
to PyPI with PyPI trusted publishing (no stored token) when the package's version is not on PyPI yet, only with
the repository variable `PYPI_PUBLISH_ENABLED=true`. To release, raise `__version__` in `sdks/python/src/pilotfish/_version.py` (`pyproject.toml` reads it).

A manual run (Actions → Publish → Run workflow) is a dry run unless "publish" is ticked.

## Trying it locally

```sh
npm ci && npm run build
node packages/mcp/scripts/package.mjs           # or packages/mcp-managed/scripts/package.mjs
node scripts/mcp-release.mjs mcp                # the version a push would publish, and whether anything changed
cd packages/mcp/npm-package && npm pack         # the tarball users would install
```

To change a minor or major version, raise `version` in `packages/<name>/release.json`.
