# Contributing

Thank you for helping. Issues and pull requests are welcome.

## How this repository works

This repository is a mirror. pilotfish is developed in the maintainers' own repository, and each sync publishes a
snapshot of the open MCP and the code it is built from here as one commit, "Sync from private @ <commit>". A sync
replaces the whole tree, `.github` included, so a commit made directly here (by anyone, maintainers too) is
overwritten by the next one.

## Pull requests

1. Open a pull request here as usual. CI builds it and runs the unit tests and the MCP's browser tests.
2. A maintainer reviews it here. Once it is accepted, they apply your change in the maintainers' repository, crediting
   you as a co-author (a `Co-authored-by: Your Name <your@email>` trailer, from your commit's author line).
3. The next sync brings the change here, and your pull request is closed with a link to the sync commit.

Please keep a pull request to one change, with a test where the change has behaviour, and run `npm run build` and
`npm test` before you open it. For a change to a tool, its input schema or a setting, also update the tools or
settings table in `packages/mcp/README.npm.md`: the package build checks that it lists exactly what the server has.

## What belongs here

The local MCP is plain by design: a real Chrome on the user's own machine and IP, driven by the user's own agent.
It keeps no saved logins and makes no model calls. Features of the hosted service are not part of this repository.

## Code of conduct

Be kind and assume good faith. Maintainers may close or lock discussions that are not.
