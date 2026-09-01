# greeting

A deliberately small Claude Code plugin: it greets you with a time-appropriate
salutation, asks how your day is going, and responds to the answer. Its real job is to
be a working reference for the **plugin → Docker → GitHub Actions** pipeline, so the
interesting parts are the tests, the Dockerfile, and the two workflows.

## What it does

| Tool | Input | Output |
| --- | --- | --- |
| `greeting_hello` | `name?`, `hour?` (0–23) | `"Good morning, Resty! How's your day going so far?"` |
| `greeting_day_check` | `answer`, `name?` | `mood` (`positive` / `negative` / `neutral`) + a matching reply |

Salutation buckets: 05–11 morning, 12–17 afternoon, 18–21 evening, 22–04 a neutral
`Hello`. Mood is keyword-matched, with negations checked first so `"not great"` reads
as negative rather than positive.

Both tools are read-only — no network, no auth, no stored state.

## Layout

```
.claude-plugin/plugin.json   plugin manifest (name, version, → .mcp.json)
.mcp.json                    how the host launches the MCP server
skills/greeting/SKILL.md     when and how Claude should use the tools
servers/
  greeting-server.js         composition root; also `--selftest`
  lib/greeting.js            pure logic — everything testable lives here
  lib/respond.js             MCP response shaping
  tools/greet.js             greeting_hello
  tools/day-check.js         greeting_day_check
  test/                      node:test suites (23 tests, zero test deps)
Dockerfile                   deps → test → runtime, multi-stage
.github/workflows/ci.yml     tests, manifest validation, docker build + smoke test
.github/workflows/cd.yml     build and publish to ghcr.io
```

## Run it locally

```sh
cd servers
npm ci
npm test          # 23 tests
npm run selftest  # exercise both tools, print JSON
npm start         # speak MCP over stdio
```

## Run it in Docker

```sh
docker build --target test -t greeting-plugin:test .    # runs the suite in-image
docker build -t greeting-plugin:local .                 # runtime image
docker run --rm greeting-plugin:local --selftest        # diagnostics
docker run --rm -i greeting-plugin:local                # MCP over stdio
```

The runtime image carries production dependencies only, runs as the non-root `node`
user, and its `HEALTHCHECK` is the self-test.

To have Claude Code launch the containerised server instead of local Node, swap the
entry in [.mcp.json](.mcp.json) for:

```json
{ "command": "docker", "args": ["run", "--rm", "-i", "ghcr.io/OWNER/REPO:latest"] }
```

## CI/CD

**[ci.yml](.github/workflows/ci.yml)** — on every push to `main` and every PR:

- `test` — `npm ci && npm test && npm run selftest` on Node 20 and 22.
- `validate-plugin` — every JSON file parses; `plugin.json` and `servers/package.json`
  agree on version; the path in `.mcp.json` actually exists.
- `docker` — builds the `test` stage (suite runs inside the image), builds `runtime`,
  runs `--selftest` against the built image and asserts it is not running as root.

**[cd.yml](.github/workflows/cd.yml)** — on push to `main` and on `v*.*.*` tags:
runs the suite inside the image first, then builds `linux/amd64` + `linux/arm64` and
pushes to `ghcr.io/<owner>/<repo>`.

| Trigger | Tags published |
| --- | --- |
| push to `main` | `main`, `sha-<commit>` |
| tag `v1.2.3` | `1.2.3`, `1.2`, `1`, `latest` |

Auth uses the built-in `GITHUB_TOKEN` with `packages: write` — no secrets to configure.
The first publish creates a private package; make it public under
*Repo → Packages → Package settings* if you want to pull it anonymously.

### Cutting a release

Bump the version in **both** `.claude-plugin/plugin.json` and `servers/package.json`
(CI fails on drift), then:

```sh
git tag v0.1.1 && git push origin v0.1.1
```

## Extending it

Add a tool as `servers/tools/<name>.js` exporting `{ handler, register }`, register it
in the `TOOL_MODULES` array in [servers/greeting-server.js](servers/greeting-server.js),
and add its name to the `tools` list in `selftest()` — `test/tools.test.js` asserts that
list, so a tool added without a test fails CI on purpose.
