// github-core-clone: Model Context Protocol endpoint at /mcp.
//
// JSON-RPC 2.0 over HTTP (Streamable HTTP transport) plus the legacy initialize handshake and
// the modern 2026-07-28 server/discover era. Tools act on the same store as REST and GraphQL.
// Tool names are matched by suffix so aliases resolve to the canonical tool.

import {
  VIEWER,
  branchTip,
  commitTree,
  createCommit,
  diffTrees,
  mergeConflicts,
  store,
  type Issue,
  type PullRequest,
} from './store.ts';

export interface McpRequest {
  body: unknown;
  bodyRaw: string;
  authed: boolean;
}

export interface McpResponse {
  status: number;
  body: unknown;
}

type AnyObj = Record<string, unknown>;

const TOOLS: AnyObj[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function findTool(name: string): AnyObj | undefined {
  const wanted = name.split('.').pop() as string;
  return TOOLS.find((tool) => (tool.name as string) === wanted || (tool.name as string).endsWith(`_${wanted}`) || wanted.endsWith(tool.name as string));
}

function textResult(value: unknown, isError = false): AnyObj {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], structuredContent: value, isError };
}

function callTool(name: string, args: AnyObj): AnyObj {
  const tool = findTool(name);
  if (tool === undefined) {
    return { code: -32601, message: `Method not found: ${name}` };
  }
  const required = ((tool.inputSchema as AnyObj).required as string[]) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return textResult({ error: `Missing required argument: ${key}` }, true);
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  const repo = store.getRepo(owner, repoName);
  const toolName = tool.name as string;

  if (toolName === 'create_repo') {
    const name = String(args.name ?? '');
    if (store.getRepo(VIEWER.login, name) !== undefined) return textResult({ error: `Repository ${VIEWER.login}/${name} already exists` }, true);
    const created = store.createRepo(VIEWER.login, name, args.private === true, typeof args.description === 'string' ? args.description : '');
    return textResult({ id: created.id, name: created.name, full_name: `${created.owner}/${created.name}`, default_branch: created.defaultBranch, private: created.isPrivate });
  }
  if (repo === undefined) return textResult({ error: `Repository ${owner}/${repoName} not found` }, true);

  if (toolName === 'get_repo') {
    return textResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, default_branch: repo.defaultBranch, description: repo.description, private: repo.isPrivate });
  }
  if (toolName === 'create_issue') {
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: store.nextIssueId++,
      number,
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      user: VIEWER.login,
      createdSeq: store.nextSeq++,
      comments: [],
    };
    repo.issues.push(issue);
    return textResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
  }
  if (toolName === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
    return textResult({ issues: list.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, state: issue.state, body: issue.body })) });
  }
  if (toolName === 'create_pull_request') {
    const head = String(args.head ?? '');
    const base = String(args.base ?? '');
    const headSha = branchTip(repo, head);
    const baseSha = branchTip(repo, base);
    if (headSha === undefined) return textResult({ error: `Head branch "${head}" does not exist` }, true);
    if (baseSha === undefined) return textResult({ error: `Base branch "${base}" does not exist` }, true);
    const number = repo.nextNumber++;
    const pull: PullRequest = {
      id: store.nextIssueId++,
      number,
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: VIEWER.login,
      createdSeq: store.nextSeq++,
    };
    repo.pulls.push(pull);
    return textResult({ id: pull.id, number: pull.number, title: pull.title, state: pull.state, head: pull.headRef, base: pull.baseRef, head_sha: pull.headSha, base_sha: pull.baseSha });
  }
  if (toolName === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return textResult({ error: `Pull request #${number} not found` }, true);
    if (pull.merged || pull.state !== 'open') return textResult({ error: 'Pull request has already been merged' }, true);
    const headSha = branchTip(repo, pull.headRef);
    const baseSha = branchTip(repo, pull.baseRef);
    if (headSha === undefined || baseSha === undefined) return textResult({ error: 'Head or base branch does not exist' }, true);
    if (mergeConflicts(repo, baseSha, headSha)) return textResult({ error: 'Merge conflict: the pull request cannot be merged' }, true);
    const headTree = commitTree(repo, headSha);
    if (headTree === null) return textResult({ error: 'Head commit has no tree' }, true);
    const { commitOid } = createCommit(repo, pull.baseRef, headTree, `Merge pull request #${pull.number} from ${pull.headRef}`, [baseSha]);
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = commitOid;
    pull.state = 'closed';
    pull.baseSha = commitOid;
    return textResult({ sha: commitOid, merged: true, number: pull.number });
  }
  return { code: -32601, message: `Method not found: ${name}` };
}

function rpcError(id: unknown, code: number, message: string): AnyObj {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): AnyObj {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

function handleOne(request: unknown): AnyObj {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = request as AnyObj;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = typeof req.params === 'object' && req.params !== null ? (req.params as AnyObj) : {};

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return rpcResult(id, {});
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05'],
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as AnyObj) : {};
    const out = callTool(name, args);
    if (typeof out.code === 'number') return rpcError(id, out.code, String(out.message ?? 'Error'));
    return rpcResult(id, out);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function handleMcp(req: McpRequest): McpResponse {
  if (!req.authed) return { status: 401, body: { message: 'Requires authentication' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.bodyRaw);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => handleOne(entry)) };
  }
  return { status: 200, body: handleOne(parsed) };
}

export { diffTrees };
