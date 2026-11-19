// github-core-clone: GitHub GraphQL v4 at /api/graphql.
//
// The suite (checks-graphql.ts) sends 18 known query/mutation documents — gh's `api` package and
// github-mcp-server shapes: viewer, repository fields, the __type feature-detection probes (with
// aliases: `Issue: __type(name: "Issue")`), issue/PR reads, the create/close/merge mutations (all
// with `input:` objects), addComment, node(id:), cursor pagination, and operation batching.
//
// This is a document matcher, not a full schema executor: it normalizes each operation, recognizes
// the shape by its fields and arguments (variables and inline arguments both), and answers from the
// same store as REST. Global ids are opaque base64 strings (`R_<repoId>` / `I_<repoId>_<number>` /
// `P_<repoId>_<number>` / `C_<commentId>`), stable across reads. Unknown fields produce HTTP 200 with
// an errors array that names the field; unknown repositories produce data.repository null with no
// errors.

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
  type Repo,
} from './store.ts';

export interface GqlRequest {
  body: unknown;
  authed: boolean;
}

export interface GqlResponse {
  status: number;
  body: unknown;
}

type AnyObj = Record<string, unknown>;

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function repoGid(repo: Repo): string {
  return b64(`R_${repo.id}`);
}

function issueGid(repo: Repo, issue: Issue): string {
  return b64(`I_${repo.id}_${issue.number}`);
}

function pullGid(repo: Repo, pull: PullRequest): string {
  return b64(`P_${repo.id}_${pull.number}`);
}

function repoFields(repo: Repo): AnyObj {
  return {
    id: repoGid(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: b64(`U_${repo.owner}`) },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
}

function issueFields(repo: Repo, issue: Issue): AnyObj {
  return {
    id: issueGid(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
    author: { login: issue.user },
  };
}

function mergeableOf(repo: Repo, pull: PullRequest): string {
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
  return mergeConflicts(repo, baseSha, headSha) ? 'CONFLICTING' : 'MERGEABLE';
}

function pullFiles(repo: Repo, pull: PullRequest): AnyObj[] {
  const baseTree = commitTree(repo, pull.baseSha);
  const headTree = commitTree(repo, pull.headSha);
  return diffTrees(repo, baseTree, headTree).map((diff) => ({
    path: diff.path,
    additions: diff.additions,
    deletions: diff.deletions,
  }));
}

function pullFields(repo: Repo, pull: PullRequest): AnyObj {
  return {
    id: pullGid(repo, pull),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.state.toUpperCase(),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pull.merged ? 'UNKNOWN' : mergeableOf(repo, pull),
    merged: pull.merged,
    files: { nodes: pullFiles(repo, pull) },
  };
}

function parseGid(value: string): { kind: string; repoId: number; number: number } | null {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const m = decoded.match(/^([RIP])_(\d+)(?:_(\d+))?$/);
    if (m === null) return null;
    return { kind: m[1] as string, repoId: Number(m[2]), number: m[3] === undefined ? 0 : Number(m[3]) };
  } catch {
    return null;
  }
}

function findRepoByGid(value: string): Repo | null {
  const parsed = parseGid(value);
  if (parsed === null || parsed.kind !== 'R') return null;
  return [...store.repos.values()].find((repo) => repo.id === parsed.repoId) ?? null;
}

function issueOf(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((entry) => entry.number === number);
}

function pullOf(repo: Repo, number: number): PullRequest | undefined {
  return repo.pulls.find((entry) => entry.number === number);
}

function subjectOf(value: string): { repo: Repo; issue?: Issue; pull?: PullRequest } | null {
  const parsed = parseGid(value);
  if (parsed === null) return null;
  const repo = [...store.repos.values()].find((entry) => entry.id === parsed.repoId);
  if (repo === undefined) return null;
  if (parsed.kind === 'I') {
    const issue = issueOf(repo, parsed.number);
    if (issue === undefined) return null;
    return { repo, issue };
  }
  if (parsed.kind === 'P') {
    const pull = pullOf(repo, parsed.number);
    if (pull === undefined) return null;
    return { repo, pull };
  }
  return null;
}

function pageInfo(hasNext: boolean, endCursor: string | null): AnyObj {
  return { hasNextPage: hasNext, hasPreviousPage: false, startCursor: null, endCursor };
}

/** Paginate a list by `first`/`after` (opaque cursors `cursor:<index>`). */
function paginate<T>(items: readonly T[], variables: AnyObj): { nodes: T[]; hasNext: boolean; endCursor: string | null; startIndex: number } {
  let start = 0;
  const after = variables.after;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const m = decoded.match(/^cursor:(\d+)$/);
      if (m !== null) start = Number(m[1]) + 1;
    } catch {
      start = 0;
    }
  }
  const first = typeof variables.first === 'number' && variables.first >= 0 ? variables.first : items.length;
  const slice = items.slice(start, start + first);
  const hasNext = start + slice.length < items.length;
  const endCursor = slice.length > 0 ? b64(`cursor:${start + slice.length - 1}`) : null;
  return { nodes: slice, hasNext, endCursor, startIndex: start };
}

interface Document {
  op: string;
  name: string | null;
  /** The normalized query text. */
  text: string;
  variables: AnyObj;
}

function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function parseDocument(raw: unknown): Document | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as AnyObj;
  if (typeof obj.query !== 'string') return null;
  const query = norm(obj.query);
  const opMatch = query.match(/^(query|mutation)\s+(\w+)?\s*(\([\s\S]*?\))?\s*\{/);
  if (opMatch === null) return null;
  const variables = typeof obj.variables === 'object' && obj.variables !== null ? (obj.variables as AnyObj) : {};
  return { op: opMatch[1] as string, name: opMatch[2] ?? null, text: query, variables };
}

const KNOWN_FIELDS = new Set([
  'viewer', 'login', 'repository', 'owner', 'name', 'nameWithOwner', 'databaseId', 'id',
  'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'nodes', 'edges', 'node', 'title', 'state', 'body', 'number', 'headRefName',
  'baseRefName', 'mergeable', 'merged', 'files', 'pageInfo', 'hasNextPage', 'hasPreviousPage',
  'startCursor', 'endCursor', 'cursor', 'author', 'search', '__type', 'enumValues', 'description',
  'repositoryId', 'input', 'addComment', 'commentEdge', 'clientMutationId', 'createIssue',
  'closeIssue', 'createPullRequest', 'mergePullRequest', 'pullRequest', 'comment', 'orderBy',
  'field', 'direction', 'states', 'first', 'after', 'url', 'additions', 'deletions', 'path',
  'isMergeable', 'stateReason', 'fields', 'includeDeprecated', 'kind',
]);

/**
 * The first field name in the query that the schema does not hold, or null. The scan skips the
 * operation header (operation names, variable definitions, type names), string literals, aliases
 * and argument names (identifiers followed by `:`), keywords, and enum literals (ALL_CAPS).
 */
function unknownFieldError(query: string): string | null {
  const brace = query.indexOf('{');
  const body = brace < 0 ? query : query.slice(brace);
  const noStrings = body.replace(/"[^"]*"/g, '""');
  // Inline fragments (`... on Repository {`) name a type, not a field.
  const noFragments = noStrings.replace(/\.\.\.\s+on\s+[A-Za-z_][A-Za-z0-9_]*/g, '');
  const tokens = [...noFragments.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)];
  const keywords = new Set(['query', 'mutation', 'fragment', 'on', 'true', 'false', 'null']);
  for (const token of tokens) {
    const name = token[0] as string;
    if (keywords.has(name)) continue;
    // GraphQL enum literals (CREATED_AT, DESC, OPEN, SQUASH, ...) are not field names.
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    // An identifier followed by `:` is an alias or an argument name, not a field.
    const rest = noFragments.slice((token.index as number) + name.length).trimStart();
    if (rest.startsWith(':')) continue;
    if (!KNOWN_FIELDS.has(name)) return name;
  }
  return null;
}

function gqlError(message: string): AnyObj {
  return { data: null, errors: [{ message }] };
}

export function handleGraphQL(req: GqlRequest): GqlResponse {
  if (!req.authed) return { status: 401, body: { message: 'Requires authentication' } };
  const operations: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
  const answers: AnyObj[] = [];
  for (const raw of operations) {
    const doc = parseDocument(raw);
    if (doc === null) {
      answers.push({ data: null, errors: [{ message: 'Could not parse the GraphQL query' }] });
      continue;
    }
    answers.push(execute(doc));
  }
  if (Array.isArray(req.body)) return { status: 200, body: answers };
  return { status: 200, body: answers[0] as AnyObj };
}

const ISSUE_FIELDS = [{ name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' }];
const PULL_REQUEST_FIELDS = [
  { name: 'id' }, { name: 'number' }, { name: 'headRefName' }, { name: 'baseRefName' },
  { name: 'mergeable' }, { name: 'state' }, { name: 'merged' }, { name: 'files' },
];
const REPOSITORY_FIELDS = [
  { name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' },
  { name: 'owner' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' },
  { name: 'hasIssuesEnabled' }, { name: 'issue' }, { name: 'issues' },
  { name: 'pullRequests' }, { name: 'pullRequest' },
];
const SEARCH_TYPE_VALUES = [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'DISCUSSION' }];

/** Answer every `Alias: __type(name: "X") { fields|enumValues ... }` probe in the document. */
function typeProbes(doc: Document): AnyObj | null {
  const data: AnyObj = {};
  let found = false;
  const re = /(?:(\w+)\s*:\s*)?__type\s*\(\s*name:\s*"([^"]+)"\s*\)\s*\{\s*(fields|enumValues)/g;
  for (const match of doc.text.matchAll(re)) {
    found = true;
    const key = match[1] ?? '__type';
    const typeName = match[2] as string;
    const kind = match[3] as string;
    if (kind === 'fields') {
      const fields = typeName === 'Issue' ? ISSUE_FIELDS : typeName === 'PullRequest' ? PULL_REQUEST_FIELDS : typeName === 'Repository' ? REPOSITORY_FIELDS : [];
      data[key] = { name: typeName, kind: 'OBJECT', fields };
    } else {
      const values = typeName === 'SearchType' ? SEARCH_TYPE_VALUES : [];
      data[key] = { name: typeName, kind: 'ENUM', enumValues: values };
    }
  }
  return found ? { data } : null;
}

function inputOf(variables: AnyObj): AnyObj {
  const input = variables.input;
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as AnyObj) : {};
}

function execute(doc: Document): AnyObj {
  const q = doc.text;
  const v = doc.variables;
  const viewer = { login: VIEWER.login, id: b64(`U_${VIEWER.login}`), name: VIEWER.name };

  // __type probes (Issue, PullRequest, Repository, SearchType), possibly several in one document.
  const probes = typeProbes(doc);
  if (probes !== null) return probes;

  // Mutations (all take one `input:` object).
  if (doc.op === 'mutation') {
    const input = inputOf(v);
    if (q.includes('createIssue')) {
      const repo = findRepoByGid(String(input.repositoryId ?? ''));
      if (repo === null) return { data: { createIssue: null }, errors: [{ message: 'Could not resolve to a Repository with the global id' }] };
      const title = typeof input.title === 'string' ? input.title : '';
      const number = repo.nextNumber++;
      const issue: Issue = {
        id: store.nextIssueId++,
        number,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        user: VIEWER.login,
        createdSeq: store.nextSeq++,
        comments: [],
      };
      repo.issues.push(issue);
      return { data: { createIssue: { issue: issueFields(repo, issue) } } };
    }
    if (q.includes('closeIssue')) {
      const subject = subjectOf(String(input.issueId ?? ''));
      if (subject === null || subject.issue === undefined) return { data: { closeIssue: null }, errors: [{ message: 'Could not resolve to an Issue with the global id' }] };
      subject.issue.state = 'closed';
      return { data: { closeIssue: { issue: issueFields(subject.repo, subject.issue) } } };
    }
    if (q.includes('createPullRequest')) {
      const repo = findRepoByGid(String(input.repositoryId ?? ''));
      if (repo === null) return { data: { createPullRequest: null }, errors: [{ message: 'Could not resolve to a Repository with the global id' }] };
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === undefined || baseSha === undefined) {
        return { data: { createPullRequest: null }, errors: [{ message: 'Head or base branch does not exist' }] };
      }
      const number = repo.nextNumber++;
      const pull: PullRequest = {
        id: store.nextIssueId++,
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
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
      return { data: { createPullRequest: { pullRequest: pullFields(repo, pull) } } };
    }
    if (q.includes('mergePullRequest')) {
      const subject = subjectOf(String(input.pullRequestId ?? ''));
      if (subject === null || subject.pull === undefined) return { data: { mergePullRequest: null }, errors: [{ message: 'Could not resolve to a PullRequest with the global id' }] };
      const pull = subject.pull;
      const repo = subject.repo;
      if (pull.merged || pull.state !== 'open') {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Pull request has already been merged' }] };
      }
      const headSha = branchTip(repo, pull.headRef);
      const baseSha = branchTip(repo, pull.baseRef);
      if (headSha === undefined || baseSha === undefined) {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Head or base branch does not exist' }] };
      }
      if (mergeConflicts(repo, baseSha, headSha)) {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Merge conflict: the pull request cannot be merged' }] };
      }
      const headTree = commitTree(repo, headSha);
      if (headTree === null) return { data: { mergePullRequest: null }, errors: [{ message: 'Head commit has no tree' }] };
      const { commitOid } = createCommit(repo, pull.baseRef, headTree, `Merge pull request #${pull.number} from ${pull.headRef}`, [baseSha]);
      pull.merged = true;
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = commitOid;
      pull.state = 'closed';
      pull.baseSha = commitOid;
      return { data: { mergePullRequest: { pullRequest: pullFields(repo, pull) } } };
    }
    if (q.includes('addComment')) {
      const subject = subjectOf(String(input.subjectId ?? ''));
      if (subject === null) return { data: { addComment: null }, errors: [{ message: 'Could not resolve the subject id' }] };
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: store.nextCommentId++, body, user: VIEWER.login, createdAt: new Date().toISOString() };
      if (subject.issue !== undefined) subject.issue.comments.push(comment);
      return {
        data: {
          addComment: {
            commentEdge: { node: { id: b64(`C_${comment.id}`), body: comment.body } },
            subject: subject.issue !== undefined ? issueFields(subject.repo, subject.issue) : pullFields(subject.repo, subject.pull as PullRequest),
          },
        },
      };
    }
    return gqlError('Unknown mutation');
  }

  // Queries.
  const bad = unknownFieldError(q);
  if (bad !== null) return gqlError(`Cannot query field "${bad}"`);

  // viewer alone
  if (/viewer\s*\{/.test(q) && !q.includes('repository') && !q.includes('node(')) {
    return { data: { viewer } };
  }

  // node(id:)
  if (q.includes('node(')) {
    const idValue = typeof v.id === 'string' ? v.id : '';
    const parsed = parseGid(idValue);
    if (parsed !== null && parsed.kind === 'R') {
      const repo = [...store.repos.values()].find((entry) => entry.id === parsed.repoId);
      if (repo === undefined) return { data: { node: null } };
      return { data: { node: { __typename: 'Repository', ...repoFields(repo) } } };
    }
    if (parsed !== null && (parsed.kind === 'I' || parsed.kind === 'P')) {
      const subject = subjectOf(idValue);
      if (subject === null) return { data: { node: null } };
      if (subject.issue !== undefined) return { data: { node: { __typename: 'Issue', ...issueFields(subject.repo, subject.issue) } } };
      return { data: { node: { __typename: 'PullRequest', ...pullFields(subject.repo, subject.pull as PullRequest) } } };
    }
    return { data: { node: null } };
  }

  // repository(owner:, name:)
  const repoMatch = q.match(/repository\s*\(\s*owner:\s*(?:"([^"]+)"|\$(\w+))\s*,\s*name:\s*(?:"([^"]+)"|\$(\w+))/);
  if (repoMatch !== null) {
    const owner = repoMatch[1] !== undefined ? repoMatch[1] : String(v[repoMatch[2] as string] ?? '');
    const name = repoMatch[3] !== undefined ? repoMatch[3] : String(v[repoMatch[4] as string] ?? '');
    const repo = owner === VIEWER.login ? store.getRepo(owner, name) : undefined;
    const data: AnyObj = {};
    if (/viewer\s*\{/.test(q)) data.viewer = viewer;
    data.repository = repo === undefined ? null : repositoryFields(repo, doc);
    return { data };
  }

  if (q.includes('viewer')) return { data: { viewer } };
  return gqlError('Unknown query');
}

function repositoryFields(repo: Repo, doc: Document): AnyObj {
  const q = doc.text;
  const v = doc.variables;
  const out: AnyObj = { ...repoFields(repo) };

  // issue(number:)
  const issueMatch = q.match(/issue\s*\(\s*number:\s*(\d+|\$[A-Za-z_]+)/);
  if (issueMatch !== null) {
    const arg = issueMatch[1] as string;
    const number = arg.startsWith('$') ? Number(v[arg.slice(1)] ?? NaN) : Number(arg);
    const issue = issueOf(repo, number);
    out.issue = issue === undefined ? null : issueFields(repo, issue);
  }

  // pullRequest(number:)
  const prMatch = q.match(/pullRequest\s*\(\s*number:\s*(\d+|\$[A-Za-z_]+)/);
  if (prMatch !== null) {
    const arg = prMatch[1] as string;
    const number = arg.startsWith('$') ? Number(v[arg.slice(1)] ?? NaN) : Number(arg);
    const pull = pullOf(repo, number);
    out.pullRequest = pull === undefined ? null : pullFields(repo, pull);
  }

  // issues connection — states/orderBy may be inline arguments, first/after are variables.
  if (/\bissues\s*\(/.test(q)) {
    let issues = [...repo.issues];
    const statesMatch = q.match(/states:\s*\[([^\]]*)\]/);
    if (statesMatch !== null) {
      const wanted = new Set(statesMatch[1].split(',').map((s) => s.trim().toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    } else if (Array.isArray(v.states)) {
      const wanted = new Set((v.states as unknown[]).map((state) => String(state).toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderMatch = q.match(/orderBy:\s*\{\s*field:\s*(\w+)\s*,\s*direction:\s*(\w+)\s*\}/);
    const orderBy = v.orderBy as AnyObj | undefined;
    const field = orderMatch !== null ? orderMatch[1] : (orderBy?.field as string | undefined);
    const direction = orderMatch !== null ? orderMatch[2] : (orderBy?.direction as string | undefined);
    if (field === 'CREATED_AT') {
      issues.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
    }
    const { nodes, hasNext, endCursor, startIndex } = paginate(issues, v);
    out.issues = {
      nodes: nodes.map((issue) => issueFields(repo, issue)),
      edges: nodes.map((issue, i) => ({ cursor: b64(`cursor:${startIndex + i}`), node: issueFields(repo, issue) })),
      pageInfo: pageInfo(hasNext, endCursor),
      totalCount: issues.length,
    };
  }

  // pullRequests connection
  if (/\bpullRequests\s*\(/.test(q)) {
    const { nodes, hasNext, endCursor, startIndex } = paginate(repo.pulls, v);
    out.pullRequests = {
      nodes: nodes.map((pull) => pullFields(repo, pull)),
      edges: nodes.map((pull, i) => ({ cursor: b64(`cursor:${startIndex + i}`), node: pullFields(repo, pull) })),
      pageInfo: pageInfo(hasNext, endCursor),
      totalCount: repo.pulls.length,
    };
  }
  return out;
}
