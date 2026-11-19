// github-core-clone: GitHub REST v3 under /api/v3.
//
// Repositories, branches, commits, contents, labels, issues, comments and pull requests, all
// backed by the in-memory store (store.ts). Statuses and shapes follow checks-rest.ts exactly:
// POST /user/repos 201 (422 when the name already exists), PUT /contents 201/200/409,
// POST /issues 422 on an unknown label, PUT /pulls/:n/merge 200/404/405, and so on.

import {
  EMPTY_TREE_OID,
  VIEWER,
  branchTip,
  commitList,
  commitTree,
  countLines,
  createCommit,
  diffTrees,
  flattenTree,
  isAncestor,
  mergeBase,
  mergeConflicts,
  parseCommit,
  parseTree,
  putObject,
  refTip,
  setTreePath,
  store,
  treeDirEntries,
  treeLookup,
  viewerIdent,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: unknown;
  bodyRaw: string;
  host: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown, headers?: Record<string, string>): RestResponse => ({ status: 200, body, headers });
const created = (body: unknown): RestResponse => ({ status: 201, body });
const noContent = (): RestResponse => ({ status: 204, body: null });
const err = (status: number, message: string): RestResponse => ({ status, body: { message } });

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(VIEWER.login),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    license: null,
    created_at: new Date(1700000000000).toISOString(),
    updated_at: new Date().toISOString(),
    pushed_at: new Date().toISOString(),
  };
}

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER.login ? VIEWER.id : 0,
    node_id: `U_${login}`,
    avatar_url: `https://example.invalid/avatar/${login}`,
    type: 'User',
    site_admin: false,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, node_id: `L_${label.name}`, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    user: userJson(issue.user),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: new Date(1700000000000 + issue.createdSeq * 1000).toISOString(),
    updated_at: new Date(1700000000000 + issue.createdSeq * 1000).toISOString(),
    closed_at: issue.state === 'closed' ? new Date().toISOString() : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function mergeableOf(repo: Repo, pull: PullRequest): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
  return mergeConflicts(repo, baseSha, headSha) ? 'CONFLICTING' : 'MERGEABLE';
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `P_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: mergeableOf(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(VIEWER.login),
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(VIEWER.login),
      repo: repoJson(repo),
    },
    user: userJson(pull.user),
    assignee: null,
    assignees: [],
    created_at: new Date(1700000000000 + pull.createdSeq * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: pull.state === 'closed' ? new Date().toISOString() : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, base: string, host: string): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `http://${host}${base}?${params.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: slice as T[], link: links.length > 0 ? links.join(', ') : null };
}

function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function bodyObj(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resolveRefTip(repo: Repo, ref: string | null): { tip: string | null; missing: boolean } {
  if (ref === null || ref === '') {
    const tip = branchTip(repo, repo.defaultBranch);
    return { tip: tip ?? null, missing: tip === undefined };
  }
  const asBranch = branchTip(repo, ref);
  if (asBranch !== undefined) return { tip: asBranch, missing: false };
  const asRef = refTip(repo, ref);
  if (asRef !== undefined) return { tip: asRef, missing: false };
  // A raw commit sha.
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return { tip: ref, missing: false };
  return { tip: null, missing: true };
}

/** Create a commit on `branch` that sets `path` to `content` (base64 decoded). */
function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  contentB64: string,
  message: string,
): { commitSha: string; contentSha: string } {
  const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = putObject(repo, 'blob', bytes);
  const tip = branchTip(repo, branch);
  const baseTree = tip === undefined ? null : commitTree(repo, tip);
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  const treeOid = setTreePath(repo, baseTree, segments, blobOid);
  const parents = tip === undefined ? [] : [tip];
  const { commitOid } = createCommit(repo, branch, treeOid, message, parents);
  return { commitSha: commitOid, contentSha: blobOid };
}

export function handleRest(req: RestRequest): RestResponse {
  const s = req.segments;
  const method = req.method;

  // API root and meta are public; everything else needs the token (checked by the caller via
  // req.authed — here we re-check with the header the app passes in `headers`).
  if (method === 'GET' && s.length === 0) {
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (method === 'GET' && s.length === 1 && s[0] === 'meta') {
    return ok({ installed_version: '1.0.0' });
  }

  const authed = req.headers['x-authed'] === '1';
  if (!authed) return err(401, 'Requires authentication');

  if (method === 'GET' && s.length === 1 && s[0] === 'user') {
    return ok({
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: `U_${VIEWER.login}`,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      site_admin: false,
    });
  }

  // POST /user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'POST') {
      const body = bodyObj(req.body);
      const name = str(body.name);
      if (name === '') return err(422, 'Validation Failed: name is required');
      if (store.getRepo(VIEWER.login, name) !== undefined) {
        return err(422, `Repository ${VIEWER.login}/${name} already exists`);
      }
      const repo = store.createRepo(VIEWER.login, name, body.private === true, str(body.description));
      return created(repoJson(repo));
    }
    if (method === 'GET') {
      const repos = store.viewerRepos();
      const { page, link } = paginate(repos.map((repo) => repoJson(repo)), req.query, '/api/v3/user/repos', req.host);
      return { status: 200, body: page, headers: link === null ? {} : { link } };
    }
  }

  // /repos/{owner}/{repo}/...
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1] as string;
    const name = s[2] as string;
    const repo = findRepo(owner, name);
    const rest = s.slice(3);

    if (repo === null) return err(404, 'Not Found');

    if (rest.length === 0) {
      if (method === 'GET') return ok(repoJson(repo));
      if (method === 'PATCH') {
        const body = bodyObj(req.body);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return noContent();
      }
      return err(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const out: Array<Record<string, unknown>> = [];
        for (const ref of [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort()) {
          const branch = ref.slice('refs/heads/'.length);
          out.push({ name: branch, commit: { sha: repo.refs.get(ref) }, protected: false });
        }
        return ok(out);
      }
      if (rest.length === 2 && method === 'GET') {
        const tip = branchTip(repo, rest[1] as string);
        if (tip === undefined) return err(404, 'Not Found');
        return ok({ name: rest[1], commit: { sha: tip }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const sha = req.query.get('sha');
      const { tip, missing } = resolveRefTip(repo, sha);
      if (missing || tip === null) {
        if (sha !== null) return err(404, 'Not Found');
        return ok([]);
      }
      const out: Array<Record<string, unknown>> = [];
      for (const oid of commitList(repo, tip)) {
        const commit = parseCommit(repo.objects.get(oid)?.data ?? Buffer.alloc(0));
        out.push({
          sha: oid,
          commit: {
            // Git stores the message with a trailing newline; the API presents it without one.
            message: commit.message.replace(/\n+$/, ''),
            author: { name: VIEWER.name, email: VIEWER.email, date: new Date(1700000000000).toISOString() },
            committer: { name: VIEWER.name, email: VIEWER.email, date: new Date(1700000000000).toISOString() },
          },
          author: userJson(VIEWER.login),
          committer: userJson(VIEWER.login),
        });
      }
      return ok(out);
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = bodyObj(req.body);
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Validation Failed: ref and sha are required');
        const object = repo.objects.get(sha);
        if (object === undefined) return err(422, 'Validation Failed: sha does not exist');
        repo.refs.set(ref, sha);
        return created({ ref, object: { sha, type: object.type } });
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const out: Array<Record<string, unknown>> = [];
          for (const ref of [...repo.refs.keys()].sort()) {
            out.push({ ref, object: { sha: repo.refs.get(ref), type: repo.objects.get(repo.refs.get(ref) as string)?.type ?? 'commit' } });
          }
          return ok(out);
        }
        const refName = rest.slice(2).join('/');
        const tip = refTip(repo, refName);
        if (tip === undefined) return err(404, 'Not Found');
        return ok({ ref: refName, object: { sha: tip, type: repo.objects.get(tip)?.type ?? 'commit' } });
      }
      if (method === 'DELETE' && rest.length > 2) {
        const refName = rest.slice(2).join('/');
        if (!repo.refs.has(refName)) return err(404, 'Not Found');
        repo.refs.delete(refName);
        return noContent();
      }
      return err(404, 'Not Found');
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'PUT') {
        const body = bodyObj(req.body);
        const message = str(body.message) || 'Update';
        const content = str(body.content);
        if (content === '') return err(422, 'Validation Failed: content is required');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        let tip = branchTip(repo, branch);
        if (tip === undefined) {
          // A new branch starts from the default branch's tip (or from nothing).
          const base = branchTip(repo, repo.defaultBranch);
          if (base !== undefined) repo.refs.set(`refs/heads/${branch}`, base);
          tip = base;
        }
        const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
        const currentTree = tip === undefined ? null : commitTree(repo, tip);
        const currentBlob = currentTree === null ? null : treeLookup(repo, currentTree, segments);
        const isUpdate = currentBlob !== null;
        if (typeof body.sha === 'string' && body.sha !== '' && isUpdate && body.sha.toLowerCase() !== currentBlob.toLowerCase()) {
          return err(409, 'Conflict: sha does not match the current blob');
        }
        const { commitSha, contentSha } = commitFile(repo, branch, path, content, message);
        const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
        return {
          status: isUpdate ? 200 : 201,
          body: {
            content: {
              name: segments[segments.length - 1] ?? '',
              path,
              sha: contentSha,
              size: bytes.length,
              type: 'file',
              encoding: 'base64',
              content: bytes.toString('base64'),
            },
            commit: { sha: commitSha, message },
          },
        };
      }
      if (method === 'GET') {
        const ref = req.query.get('ref');
        const { tip, missing } = resolveRefTip(repo, ref);
        if (missing || tip === null) return err(404, 'Not Found');
        const treeOid = commitTree(repo, tip);
        if (treeOid === null) return err(404, 'Not Found');
        const segments = path === '' ? [] : path.split('/').filter((segment) => segment !== '' && segment !== '.');
        if (segments.length === 0) {
          const entries = treeDirEntries(repo, treeOid, []);
          if (entries === null) return err(404, 'Not Found');
          return ok(entries.map((entry) => dirEntryJson(repo, '', entry)));
        }
        const blobOid = treeLookup(repo, treeOid, segments);
        if (blobOid !== null) {
          const blob = repo.objects.get(blobOid);
          const data = blob?.data ?? Buffer.alloc(0);
          return ok({
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: segments[segments.length - 1] ?? '',
            path,
            sha: blobOid,
            content: data.toString('base64'),
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/HEAD/${path}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`,
            download_url: `https://example.invalid/${owner}/${name}/raw/HEAD/${path}`,
          });
        }
        const entries = treeDirEntries(repo, treeOid, segments);
        if (entries === null) return err(404, 'Not Found');
        return ok(entries.map((entry) => dirEntryJson(repo, path, entry)));
      }
      if (method === 'DELETE') {
        const body = bodyObj(req.body);
        const message = str(body.message) || 'Delete';
        const branch = repo.defaultBranch;
        const tip = branchTip(repo, branch);
        if (tip === undefined) return err(404, 'Not Found');
        const treeOid = commitTree(repo, tip);
        if (treeOid === null) return err(404, 'Not Found');
        const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
        const currentBlob = treeLookup(repo, treeOid, segments);
        if (currentBlob === null) return err(404, 'Not Found');
        const newTree = setTreePath(repo, treeOid, segments, null);
        const { commitOid } = createCommit(repo, branch, newTree, message, [tip]);
        return ok({ commit: { sha: commitOid, message }, content: null });
      }
      return err(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const body = bodyObj(req.body);
        const nameLabel = str(body.name);
        if (nameLabel === '') return err(422, 'Validation Failed: name is required');
        const label: Label = {
          name: nameLabel,
          color: typeof body.color === 'string' ? body.color : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.set(nameLabel, label);
        return created(labelJson(label));
      }
      if (method === 'GET' && rest.length === 1) {
        return ok([...repo.labels.values()].map((label) => labelJson(label)));
      }
      return err(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = bodyObj(req.body);
          const title = str(body.title);
          if (title === '') return err(422, 'Validation Failed: title is required');
          const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
          }
          const number = repo.nextNumber++;
          const issue: Issue = {
            id: store.nextIssueId++,
            number,
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels,
            user: VIEWER.login,
            createdSeq: store.nextSeq++,
            comments: [],
          };
          repo.issues.push(issue);
          return created(issueJson(repo, issue));
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          let list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
          if (sort === 'created') {
            list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const { page, link } = paginate(list.map((issue) => issueJson(repo, issue)), req.query, `/api/v3/repos/${owner}/${name}/issues`, req.host);
          return { status: 200, body: page, headers: link === null ? {} : { link } };
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(issueJson(repo, issue));
        if (method === 'PATCH') {
          const body = bodyObj(req.body);
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          return ok(issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const body = bodyObj(req.body);
          const text = str(body.body);
          if (text === '') return err(422, 'Validation Failed: body is required');
          const comment = { id: store.nextCommentId++, body: text, user: VIEWER.login, createdAt: new Date().toISOString() };
          issue.comments.push(comment);
          return created({
            id: comment.id,
            node_id: `C_${comment.id}`,
            body: comment.body,
            user: userJson(comment.user),
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          });
        }
        if (method === 'GET') {
          return ok(
            issue.comments.map((comment) => ({
              id: comment.id,
              node_id: `C_${comment.id}`,
              body: comment.body,
              user: userJson(comment.user),
              created_at: comment.createdAt,
              updated_at: comment.createdAt,
            })),
          );
        }
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = bodyObj(req.body);
          const title = str(body.title);
          const head = str(body.head);
          const base = str(body.base);
          if (title === '' || head === '' || base === '') return err(422, 'Validation Failed: title, head and base are required');
          const headSha = branchTip(repo, head);
          const baseSha = branchTip(repo, base);
          if (headSha === undefined) return err(422, `Validation Failed: head branch "${head}" does not exist`);
          if (baseSha === undefined) return err(422, `Validation Failed: base branch "${base}" does not exist`);
          const number = repo.nextNumber++;
          const pull: PullRequest = {
            id: store.nextIssueId++,
            number,
            title,
            body: typeof body.body === 'string' ? body.body : '',
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
          return created(pullJson(repo, pull));
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const list = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
          const { page, link } = paginate(list.map((pull) => pullJson(repo, pull)), req.query, `/api/v3/repos/${owner}/${name}/pulls`, req.host);
          return { status: 200, body: page, headers: link === null ? {} : { link } };
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(pullJson(repo, pull));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const baseTree = commitTree(repo, pull.baseSha);
        const headTree = commitTree(repo, pull.headSha);
        const diffs = diffTrees(repo, baseTree, headTree);
        return ok(
          diffs.map((diff) => ({
            filename: diff.path,
            status: diff.status,
            additions: diff.additions,
            deletions: diff.deletions,
            changes: diff.additions + diff.deletions,
          })),
        );
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.merged || pull.state !== 'open') return err(405, 'Pull request has already been merged');
        const headSha = branchTip(repo, pull.headRef);
        const baseSha = branchTip(repo, pull.baseRef);
        if (headSha === undefined || baseSha === undefined) return err(404, 'Not Found');
        if (mergeConflicts(repo, baseSha, headSha)) return err(405, 'Merge conflict: the pull request cannot be merged');
        const headTree = commitTree(repo, headSha);
        if (headTree === null) return err(404, 'Not Found');
        const { commitOid } = createCommit(repo, pull.baseRef, headTree, `Merge pull request #${pull.number} from ${pull.headRef}`, [baseSha]);
        pull.merged = true;
        pull.mergedAt = new Date().toISOString();
        pull.mergeCommitSha = commitOid;
        pull.state = 'closed';
        pull.baseSha = commitOid;
        return ok({ sha: commitOid, merged: true, message: 'Pull request successfully merged' });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function dirEntryJson(repo: Repo, dir: string, entry: { mode: string; name: string; oid: string }): Record<string, unknown> {
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const size = isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
    download_url: isDir ? null : `https://example.invalid/${repo.owner}/${repo.name}/raw/HEAD/${path}`,
  };
}

export { EMPTY_TREE_OID, countLines, flattenTree, isAncestor, mergeBase, parseTree };
