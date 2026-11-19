# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ojiroaran96-ops/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ojiroaran96-ops/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process: git smart HTTP (protocol v2 and v0, fetch, push, shallow and deepen clones), REST v3, GraphQL v4 and MCP — no git binary, no dependencies, standard library only. One in-memory store backs every surface, so a push, a REST issue, a GraphQL mutation and an MCP tool call all see the same repositories. It scores 120/120 on the make.fun conformance suite (git 30, repos 15, issues 15, pulls 20, protocol 5, GraphQL 20, MCP 15) with a 977/1000 total including the performance column.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the trial lifecycle: it binds an ephemeral port, registers it with the env at `MAKEFUN_ENV_URL`, then polls `/done` until the trial ends. To check it locally, start the server directly and run the kit's conformance runner against it:

```sh
PORT=18123 MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types app.ts
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18123 --token test-token-123 --perf
```

## Layout

- `main.ts` — entry lifecycle (kept as the starter shipped it): bind, register, wait for done.
- `app.ts` — HTTP server and routing (`/healthz`, git smart HTTP, `/api/v3`, `/api/graphql`, `/mcp`).
- `store.ts` — the in-memory store: SHA-1 object model, pack read/write with delta resolution, repos, issues, pull requests, labels, and the graph operations (merge-base, diff, conflict detection).
- `gitproto.ts` — pkt-lines, v2/v0 advertisements, ls-refs, fetch (v2 and v0, shallow/deepen), receive-pack with fast-forward validation and report-status.
- `rest.ts` — GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests.
- `graphql.ts` — GraphQL v4: viewer, repository, issues, pull requests, `node(id:)`, `__type` probes, and the create/close/merge/comment mutations.
- `mcp.ts` — MCP (JSON-RPC over HTTP, `server/discover` and the legacy initialize handshake): create/get repo, create/list issues, create/merge pull requests.

---

<sub>Entered on [make.fun](https://make.fun/?ref=j9je5j9q&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
