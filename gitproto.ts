// github-core-clone: git smart HTTP — info/refs advertisements, ls-refs, fetch (v2 and v0)
// and receive-pack. No git binary: pkt-lines, packfiles and the object graph are all in-process
// (store.ts). The wire shapes follow the suite's client (git-client.ts) exactly:
//
//   - upload-pack answers v2 when the request carries `Git-Protocol: version=2`, else v0;
//     receive-pack is always v0.
//   - v2 fetch answers sections (acknowledgments, shallow-info, wanted-refs, packfile) with
//     sideband framing; v0 answers bare NAK/ACK/shallow lines plus sideband pack packets.
//   - receive-pack answers report-status inside sideband band 1 when negotiated.

import {
  ZERO_OID,
  collectReachable,
  commitTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  putObject,
  readPack,
  refTip,
  store,
  writePack,
  type GitObject,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse a whole body into packets; throws on a malformed length prefix. */
export function decodePktLines(body: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('pkt-line is truncated');
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('pkt-line has a bad length prefix');
    if (len === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'end' });
      offset += 4;
    } else {
      if (offset + len > body.length) throw new Error('pkt-line is truncated');
      out.push({ kind: 'data', payload: body.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

/** The data packets' payloads, in order, as text lines (trailing newline stripped). */
export function pktLinesText(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      try {
        line.peeled = parseTag(object.data).object;
      } catch {
        // not a parseable tag; no peel
      }
    }
    out.push(line);
  }
  return out;
}

function headRefLine(repo: Repo): { oid: string; target: string } {
  const target = `refs/heads/${repo.defaultBranch}`;
  const oid = repo.refs.get(target) ?? ZERO_OID;
  return { oid, target };
}

const AGENT = 'makefun-git-forge/1.0';

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(service: 'git-upload-pack'): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const head = headRefLine(repo);
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${head.target} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`
      : `symref=HEAD:${head.target} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    parts.push(pktLine(`${head.oid} HEAD\u0000${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, in a stable order. */
  objects: GitObject[];
  /** New shallow boundaries the client gains. */
  shallow: string[];
  /** Old shallow boundaries that stop being boundaries. */
  unshallow: string[];
  /** The refs whose tips were wanted. */
  wantedRefs: Array<{ oid: string; ref: string }>;
}

/** Walk commits from `roots` up to `maxDepth` generations (undefined = whole history). */
function walkCommits(
  repo: Repo,
  roots: readonly string[],
  maxDepth: number | undefined,
): { commits: Map<string, number>; tags: string[] } {
  const commits = new Map<string, number>();
  const tags: string[] = [];
  const queue: Array<[string, number]> = [];
  for (const root of roots) {
    const object = repo.objects.get(root);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tags.push(root);
      const target = parseTag(object.data).object;
      queue.push([target, 0]);
    } else if (object.type === 'commit') {
      queue.push([root, 0]);
    }
  }
  while (queue.length > 0) {
    const [oid, depth] = queue.shift() as [string, number];
    if (commits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (maxDepth !== undefined && depth >= maxDepth) continue;
    commits.set(oid, depth);
    for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
  }
  return { commits, tags };
}

/** The full object set for a fetch: commits (depth-limited) plus their trees/blobs and tags. */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);

  // What the client already holds: the closure of its haves, not crossing its shallow boundary.
  const held = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of haves) {
      const object = repo.objects.get(have);
      if (object === undefined) continue;
      queue.push(have);
    }
    const shallowSet = new Set(shallowBoundaries);
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      held.add(oid);
      if (object.type === 'commit') {
        if (shallowSet.has(oid)) continue; // a shallow boundary's parents are not held
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      }
    }
  }

  // What the fetch delivers: depth-limited commit walk plus the trees/blobs under them.
  const { commits, tags } = walkCommits(repo, wants, depth);
  const send = new Set<string>();
  for (const tag of tags) send.add(tag);
  for (const commitOid of commits.keys()) {
    send.add(commitOid);
    const tree = commitTree(repo, commitOid);
    if (tree !== null) {
      for (const oid of collectReachable([tree], lookup, true)) send.add(oid);
    }
  }
  for (const oid of [...send]) if (held.has(oid)) send.delete(oid);

  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // Stable order: commits first (in walk order), then trees, then blobs, then tags.
  const rank = (object: GitObject): number =>
    object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'blob' ? 2 : 3;
  objects.sort((a, b) => rank(a) - rank(b));

  // Shallow boundaries after the fetch: held commits + sent commits whose parent is missing.
  const afterCommits = new Set<string>();
  for (const oid of held) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') afterCommits.add(oid);
  }
  for (const oid of commits.keys()) afterCommits.add(oid);
  const afterBoundaries = new Set<string>();
  for (const oid of afterCommits) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !afterCommits.has(parent))) afterBoundaries.add(oid);
  }
  const beforeSet = new Set(shallowBoundaries);
  const shallow = [...afterBoundaries].filter((oid) => !beforeSet.has(oid)).sort();
  const unshallow = [...beforeSet].filter((oid) => !afterBoundaries.has(oid)).sort();

  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const ref of sortedRefs(repo)) {
    if (wants.includes(ref.oid)) wantedRefs.push({ oid: ref.oid, ref: ref.name });
  }
  const head = headRefLine(repo);
  if (wants.includes(head.oid) && head.oid !== ZERO_OID) {
    // HEAD itself is not a wanted-ref; the branch it points at already covers it.
  }
  return { objects, shallow, unshallow, wantedRefs };
}

/** Split pack bytes into sideband band-1 pkt-lines (each total <= 65520 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

export interface GitRequest {
  owner: string;
  repoName: string;
  service: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

function repoOrNull(req: GitRequest): Repo | null {
  if (req.owner !== 'adaiversen') {
    // Repositories only exist under the viewer; any other owner is a missing repo.
    const found = store.getRepo(req.owner, req.repoName);
    return found ?? null;
  }
  return store.getRepo(req.owner, req.repoName) ?? null;
}

export function handleInfoRefs(
  req: GitRequest,
): { status: number; contentType: string; body: Buffer } {
  const repo = repoOrNull(req);
  if (repo === null) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  if (req.service === 'git-upload-pack') {
    const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (wantsV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement('git-upload-pack') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (req.service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const include = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const head = headRefLine(repo);
  if (include('HEAD') && args.prefixes.length === 0) {
    if (head.oid === ZERO_OID) {
      if (args.unborn) {
        parts.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:${head.target}` : ''}\n`));
      }
    } else {
      parts.push(pktLine(`${head.oid} HEAD${args.symrefs ? ` symref-target:${head.target}` : ''}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!include(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n)) args.depth = n;
    } else if (line === 'done') args.done = true;
  }
  return args;
}

/** Pack bytes cache: identical fetches (the 50 concurrent clones in the benchmark all ask for the
 *  same tip at the same depth) reuse one deflated pack. The key carries the repo's version, which
 *  every object/ref mutation bumps, so a cached pack can never be stale. */
const packCache = new Map<string, Buffer>();

function cachedPack(repo: Repo, plan: FetchPlan, args: FetchArgs): Buffer {
  const key = `${repo.id}:${repo.version}:${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth ?? ''}`;
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(plan.objects);
  // Bound the cache: a forge holds few distinct fetch shapes; drop the oldest when it grows.
  if (packCache.size > 64) {
    const first = packCache.keys().next().value;
    if (first !== undefined) packCache.delete(first);
  }
  packCache.set(key, pack);
  return pack;
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = cachedPack(repo, plan, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    for (const have of args.haves) {
      if (repo.objects.has(have)) parts.push(pktLine(`ACK ${have}\n`));
    }
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const ref of plan.wantedRefs) parts.push(pktLine(`${ref.oid} ${ref.ref}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = cachedPack(repo, plan, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    let acked = false;
    for (const have of args.haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(
  req: GitRequest,
): { status: number; contentType: string; body: Buffer } {
  const repo = repoOrNull(req);
  if (repo === null) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  let packets: Pkt[];
  try {
    packets = decodePktLines(req.body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
  }
  const lines = pktLinesText(packets);
  const command = lines[0] ?? '';
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (command === 'command=ls-refs' || command.startsWith('command=ls-refs')) {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of lines.slice(1)) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    if (!isV2) {
      // A v0 ls-refs is the advertisement itself; the client never sends it, but answer anyway.
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0Advertisement(repo, 'git-upload-pack') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, args) };
  }
  if (command === 'command=fetch' || command.startsWith('command=fetch')) {
    const args = parseFetchArgs(lines.slice(1));
    if (args.wants.length === 0) {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat([pktLine('packfile\n'), ...sidebandPack(writePack([])), pktFlush()]) };
    }
    const body = isV2 ? handleFetchV2(repo, args) : handleFetchV0(repo, args);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
  }
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  req: GitRequest,
): { status: number; contentType: string; body: Buffer } {
  const repo = repoOrNull(req);
  if (repo === null) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  // Split the command list (pkt-lines up to the first flush) from the pack that follows it.
  let offset = 0;
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let flushAt = -1;
  try {
    while (offset < req.body.length) {
      if (offset + 4 > req.body.length) throw new Error('truncated pkt-line');
      const len = parseInt(req.body.subarray(offset, offset + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) throw new Error('bad pkt-line length');
      if (len === 0) {
        flushAt = offset + 4;
        break;
      }
      if (len < 4 || offset + len > req.body.length) throw new Error('truncated pkt-line');
      const text = req.body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\u0000');
      let line = text;
      if (commands.length === 0 && nul >= 0) {
        capabilities = text.slice(nul + 1).split(' ').filter(Boolean);
        line = text.slice(0, nul);
      }
      const parts = line.split(' ');
      if (parts.length < 3) throw new Error('bad push command');
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
      offset += len;
    }
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
  }
  if (flushAt < 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n', 'utf8') };
  }
  const sideband = capabilities.includes('side-band-64k');
  const packBytes = req.body.subarray(flushAt);

  // Unpack: store every object the pack carries, even for refused refs.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasUpdates && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  } else if (hasUpdates && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'unpack error';
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let refsChanged = false;
  if (!unpackOk) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: unpackDetail });
  } else {
    for (const command of commands) {
      const current = refTip(repo, command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          refsChanged = true;
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const newObject = repo.objects.get(command.newOid);
      if (newObject === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        refsChanged = true;
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (command.newOid === command.oldOid) {
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (!isAncestorFast(repo, command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      refsChanged = true;
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  if (refsChanged) repo.version += 1;

  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const reportStream = Buffer.concat(reportLines.map((line) => pktLine(line)));
  let body: Buffer;
  if (sideband) {
    const frames: Buffer[] = [];
    for (let off = 0; off < reportStream.length; off += 65000) {
      frames.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(off, Math.min(reportStream.length, off + 65000))])));
    }
    frames.push(pktFlush());
    body = Buffer.concat(frames);
  } else {
    body = Buffer.concat([reportStream, pktFlush()]);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}

/** Whether `ancestor` is reachable from `descendant` (parents walked, early exit). */
function isAncestorFast(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return false;
}

export { hashObject, putObject };
