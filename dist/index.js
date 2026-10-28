var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name5 in all)
    __defProp(target, name5, { get: all[name5], enumerable: true });
};

// src/config.ts
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { join } from "path";
var Config = z.object({
  skillsRoot: z.string().description("Absolute user-scope skills root the agent writes to (default: <dsh home>/skills)"),
  stateDir: z.string().description("Absolute state directory for the ledger, archive and staged writes (default: <dsh home>/self-evolve)"),
  staleDays: z.natural().description("Days without use before an agent-authored skill is marked stale (default: 30)"),
  archiveDays: z.natural().description("Days without use before an agent-authored skill is archived (default: 90)"),
  maxSkillBytes: z.natural().min(1024).description("Maximum serialized SKILL.md size in bytes (default: 15360)"),
  maxResourceBytes: z.natural().min(1024).description("Maximum skill resource file size in bytes (default: 65536)"),
  curatorIntervalHours: z.natural().description("Minimum hours between curator passes; 0 disables (default: 24)"),
  guidance: z.boolean().description("Contribute the self-improvement system prompt section (default: true)"),
  readBeforeWrite: z.boolean().description("Require a successful skill load before mutating an existing skill (default: true)"),
  writeApproval: z.boolean().description("Stage mutating writes for human approval instead of committing them (default: false)"),
  duplicateThreshold: z.number().min(0).max(1).description("Similarity at or above which create refuses a near-duplicate; 0 disables (default: 0.55)"),
  secretScan: z.boolean().description("Block writes whose text contains credential-shaped strings (default: true)"),
  lint: z.boolean().description("Run the advisory linter on writes (default: true)"),
  projectRootMarkers: z.array(z.string()).description('Markers that identify a project root (default: [".git"])'),
  pendingTtlDays: z.natural().description("Days a staged write survives before pruning (default: 14)"),
  review: z.object({
    enabled: z.boolean().description("Run the post-turn background reviewer (default: false \u2014 it spends tokens)"),
    turnInterval: z.natural().description("Review after this many completed turns without one (default: 10)"),
    toolCallThreshold: z.natural().description("Or after this many tool calls since the last review (default: 15)"),
    cooldownMinutes: z.natural().description("Minimum minutes between reviews of one session (default: 20)"),
    maxPerSession: z.natural().description("Hard cap on reviews per session (default: 8)"),
    provider: z.string().description("Subagent provider for the review child (default: fork)"),
    timeoutMinutes: z.natural().description("Abort a review child after this many minutes (default: 5)"),
    gate: z.union([z.const("counters"), z.const("jev")]).description("What decides whether a due review runs: counters or jev (default: counters)"),
    jev: z.object({
      model: z.string().description("Jev model id or alias (default: jev-latest)"),
      baseURL: z.string().description("TypeSafe API root (default: https://api.typesafe.ai)"),
      apiKeyEnv: z.string().description("Environment variable holding the API key (default: TYPESAFE_API_KEY)"),
      timeoutMs: z.natural().description("Per-attempt timeout in milliseconds (default: 2000)"),
      confidentNo: z.number().min(0).max(1).description('Skip only when Jev answers "no" with at least this confidence (default: 0.75)'),
      cooldownMinutes: z.natural().description("Minimum minutes between gate calls per session (default: 5)")
    })
  })
});
var DEFAULT_PROJECT_MARKERS = [".git"];
function resolveConfig(config = {}) {
  const home = resolveDshHome();
  return {
    skillsRoot: config.skillsRoot ?? join(home, "skills"),
    stateDir: config.stateDir ?? join(home, "self-evolve"),
    staleDays: config.staleDays ?? 30,
    archiveDays: config.archiveDays ?? 90,
    maxSkillBytes: config.maxSkillBytes ?? 15360,
    maxResourceBytes: config.maxResourceBytes ?? 65536,
    curatorIntervalHours: config.curatorIntervalHours ?? 24,
    guidance: config.guidance ?? true,
    readBeforeWrite: config.readBeforeWrite ?? true,
    writeApproval: config.writeApproval ?? false,
    duplicateThreshold: config.duplicateThreshold ?? 0.55,
    secretScan: config.secretScan ?? true,
    lint: config.lint ?? true,
    projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_MARKERS],
    pendingTtlDays: config.pendingTtlDays ?? 14,
    review: {
      enabled: config.review?.enabled ?? false,
      turnInterval: config.review?.turnInterval ?? 10,
      toolCallThreshold: config.review?.toolCallThreshold ?? 15,
      cooldownMinutes: config.review?.cooldownMinutes ?? 20,
      maxPerSession: config.review?.maxPerSession ?? 8,
      provider: config.review?.provider ?? "fork",
      timeoutMinutes: config.review?.timeoutMinutes ?? 5,
      gate: config.review?.gate === "jev" ? "jev" : "counters",
      jev: {
        model: config.review?.jev?.model ?? "jev-latest",
        baseURL: config.review?.jev?.baseURL ?? "https://api.typesafe.ai",
        apiKeyEnv: config.review?.jev?.apiKeyEnv ?? "TYPESAFE_API_KEY",
        timeoutMs: config.review?.jev?.timeoutMs ?? 2e3,
        confidentNo: config.review?.jev?.confidentNo ?? 0.75,
        cooldownMinutes: config.review?.jev?.cooldownMinutes ?? 5
      }
    }
  };
}

// src/tools.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import { join as join6 } from "path";

// src/dedupe.ts
var STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "before",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "then",
  "this",
  "to",
  "use",
  "using",
  "when",
  "where",
  "which",
  "while",
  "with",
  "you",
  "your",
  "skill",
  "skills",
  "task",
  "tasks"
]);
function tokenize(text) {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1 && !STOPWORDS.has(token));
  return new Set(tokens);
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}
function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / Math.min(a.size, b.size);
}
function similarity(name5, description, candidate) {
  const nameScore = jaccard(tokenize(name5), tokenize(candidate.name));
  const descriptionScore = overlap(tokenize(description), tokenize(candidate.description));
  return 0.25 * nameScore + 0.75 * descriptionScore;
}
function findDuplicates(name5, description, candidates, threshold, limit = 3) {
  if (threshold <= 0) return [];
  const matches = [];
  for (const candidate of candidates) {
    if (candidate.name === name5) continue;
    const score = similarity(name5, description, candidate);
    if (score >= threshold) matches.push({ ...candidate, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}

// src/guards.ts
var ReadRegistry = class {
  perAgent = /* @__PURE__ */ new WeakMap();
  anonymous = /* @__PURE__ */ new Set();
  /** Record that `agent` loaded `name` in full. */
  mark(agent, name5) {
    if (agent === void 0) {
      this.anonymous.add(name5);
      return;
    }
    const existing = this.perAgent.get(agent);
    if (existing === void 0) this.perAgent.set(agent, /* @__PURE__ */ new Set([name5]));
    else existing.add(name5);
  }
  /** Whether `agent` loaded `name` in this session. */
  has(agent, name5) {
    if (agent === void 0) return this.anonymous.has(name5);
    return this.perAgent.get(agent)?.has(name5) === true;
  }
  /** Drop the record for one agent (used by tests and explicit resets). */
  reset(agent) {
    if (agent === void 0) this.anonymous.clear();
    else this.perAgent.delete(agent);
  }
};

// src/approval.ts
import { createHash, randomBytes } from "crypto";
import { mkdir as mkdir2, readdir as readdir2, readFile as readFile2, rm as rm2, writeFile as writeFile2 } from "fs/promises";
import { join as join3 } from "path";

// src/store.ts
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { basename, dirname, isAbsolute, join as join2, normalize, resolve, sep } from "path";
import { randomUUID } from "crypto";

// src/skillfile.ts
import { parse, stringify } from "yaml";
var AUTHOR_MARKER = "dsh-self-evolve";
function isValidSkillName(name5) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name5) && name5.length <= 64;
}
function parseSkillFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) return void 0;
  let data;
  try {
    data = parse(match[1] ?? "");
  } catch {
    return void 0;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return void 0;
  const frontmatter = data;
  if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return void 0;
  return { frontmatter, body: match[2] ?? "" };
}
function serializeSkillFile(file) {
  const yaml = stringify(file.frontmatter, { lineWidth: 0 }).trimEnd();
  const body = file.body.replace(/^\r?\n+/, "").trimEnd();
  return `---
${yaml}
---

${body}
`;
}
function isAgentAuthored(file) {
  const metadata = file.frontmatter.metadata;
  return typeof metadata === "object" && metadata !== null && metadata.authoredBy === AUTHOR_MARKER;
}
function metadataString(file, key) {
  const metadata = file.frontmatter.metadata;
  if (typeof metadata !== "object" || metadata === null) return void 0;
  const value = metadata[key];
  return typeof value === "string" ? value : void 0;
}
function isPinned(file) {
  const metadata = file.frontmatter.metadata;
  return typeof metadata === "object" && metadata !== null && metadata.pinned === true;
}
function stampMetadata(file, options) {
  const previous = typeof file.frontmatter.metadata === "object" && file.frontmatter.metadata !== null ? file.frontmatter.metadata : {};
  const previousVersion = Number(previous.version);
  const metadata = {
    ...previous,
    authoredBy: AUTHOR_MARKER,
    updatedAt: options.now,
    version: options.create === true ? 1 : Number.isFinite(previousVersion) ? previousVersion + 1 : 1
  };
  if (options.create === true) metadata.createdAt = options.now;
  delete metadata.status;
  return { frontmatter: { ...file.frontmatter, metadata }, body: file.body };
}
function withStatus(file, status) {
  const previous = typeof file.frontmatter.metadata === "object" && file.frontmatter.metadata !== null ? file.frontmatter.metadata : {};
  const metadata = { ...previous };
  if (status === "active") delete metadata.status;
  else metadata.status = status;
  return { frontmatter: { ...file.frontmatter, metadata }, body: file.body };
}
function withPinned(file, pinned) {
  const previous = typeof file.frontmatter.metadata === "object" && file.frontmatter.metadata !== null ? file.frontmatter.metadata : {};
  const metadata = { ...previous };
  if (pinned) metadata.pinned = true;
  else delete metadata.pinned;
  return { frontmatter: { ...file.frontmatter, metadata }, body: file.body };
}

// src/store.ts
var StoreError = class extends Error {
};
function directoryLocation(scope, root, name5) {
  return { scope, root, layout: "dir", dir: join2(root, name5), filePath: join2(root, name5, "SKILL.md"), name: name5 };
}
function flatLocation(scope, root, name5) {
  return { scope, root, layout: "flat", dir: root, filePath: join2(root, `${name5}.md`), name: name5 };
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function readTextIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return void 0;
  }
}
async function assertNotSymlink(path) {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new StoreError(`"${path}" is a symlink; refusing to write through it`);
    }
  } catch (error) {
    if (error instanceof StoreError) throw error;
  }
}
async function atomicWrite(path, text) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join2(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => void 0);
    throw error;
  }
}
async function writeTextAtomic(path, text) {
  await atomicWrite(path, text);
}
async function readSkillAt(location) {
  const text = await readTextIfExists(location.filePath);
  if (text === void 0) return void 0;
  const parsed = parseSkillFile(text);
  if (parsed === void 0) {
    throw new StoreError(`skill "${location.name}" exists but its instruction file is malformed`);
  }
  return parsed;
}
async function readOwnedSkillAt(location) {
  const file = await readSkillAt(location);
  if (file === void 0) {
    throw new StoreError(`no skill named "${location.name}" exists at ${location.filePath}`);
  }
  if (!isAgentAuthored(file)) {
    throw new StoreError(`skill "${location.name}" was not authored by the agent (bundled or human-authored skills are read-only here)`);
  }
  return file;
}
async function locateSkill(roots, name5) {
  if (!isValidSkillName(name5)) throw new StoreError(`invalid skill name "${name5}" (kebab-case, max 64 chars)`);
  const candidates = [];
  if (roots.project !== void 0) {
    candidates.push(directoryLocation("project", roots.project, name5), flatLocation("project", roots.project, name5));
  }
  candidates.push(directoryLocation("user", roots.user, name5), flatLocation("user", roots.user, name5));
  for (const candidate of candidates) {
    if (await exists(candidate.filePath)) return candidate;
  }
  return void 0;
}
async function listSkills(roots) {
  const seen = /* @__PURE__ */ new Set();
  const entries = [];
  const rootsInRank = roots.project === void 0 ? [{ root: roots.user, scope: "user" }] : [{ root: roots.project, scope: "project" }, { root: roots.user, scope: "user" }];
  for (const { root, scope } of rootsInRank) {
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const kind of ["dir", "flat"]) {
      for (const dirent of dirents) {
        if (dirent.name.startsWith(".")) continue;
        let name5;
        if (kind === "dir") {
          if (!dirent.isDirectory()) continue;
          name5 = dirent.name;
        } else {
          if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
          name5 = dirent.name.slice(0, -3);
        }
        if (!isValidSkillName(name5) || seen.has(name5)) continue;
        const location = kind === "dir" ? directoryLocation(scope, root, name5) : flatLocation(scope, root, name5);
        const text = await readTextIfExists(location.filePath);
        if (text === void 0) continue;
        const file = parseSkillFile(text);
        if (file === void 0) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = (await stat(location.filePath)).mtimeMs;
        } catch {
          continue;
        }
        seen.add(name5);
        entries.push({ name: name5, file, location, mtimeMs });
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}
function assertSize(file, maxSkillBytes) {
  const serialized = serializeSkillFile(file);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxSkillBytes) {
    throw new StoreError(
      `skill "${file.frontmatter.name}" is ${bytes} bytes; the cap is ${maxSkillBytes}. Tighten the body \u2014 a skill is a procedure, not a document dump.`
    );
  }
  return serialized;
}
async function writeNewSkill(location, file, options) {
  if (!isValidSkillName(file.frontmatter.name)) {
    throw new StoreError(`invalid skill name "${file.frontmatter.name}" (kebab-case, max 64 chars)`);
  }
  if (await exists(location.filePath)) {
    throw new StoreError(`skill "${location.name}" already exists \u2014 use action "patch" or "edit" to change it`);
  }
  if (location.layout === "dir" && await exists(location.dir)) {
    throw new StoreError(`directory ${location.dir} already exists but has no SKILL.md; inspect it before writing`);
  }
  await assertNotSymlink(location.filePath);
  await atomicWrite(location.filePath, assertSize(file, options.maxSkillBytes));
}
async function writeSkillAt(location, file, options) {
  if (!isValidSkillName(file.frontmatter.name)) {
    throw new StoreError(`invalid skill name "${file.frontmatter.name}" (kebab-case, max 64 chars)`);
  }
  if (!await exists(location.filePath)) {
    throw new StoreError(`no skill named "${location.name}" exists to update`);
  }
  await assertNotSymlink(location.filePath);
  await atomicWrite(location.filePath, assertSize(file, options.maxSkillBytes));
}
async function archiveSkillAt(location, archiveDir, now) {
  if (!isValidSkillName(location.name)) throw new StoreError(`invalid skill name "${location.name}"`);
  if (!await exists(location.filePath)) throw new StoreError(`no skill named "${location.name}" exists`);
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const to = location.layout === "dir" ? join2(archiveDir, `${location.name}-${timestamp}`) : join2(archiveDir, `${location.name}-${timestamp}.md`);
  await mkdir(archiveDir, { recursive: true });
  await rename(location.layout === "dir" ? location.dir : location.filePath, to);
  return to;
}
function resolveWithin(root, relativePath) {
  if (relativePath === "" || isAbsolute(relativePath)) return void 0;
  if (relativePath.includes("\0")) return void 0;
  const normalized = normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) return void 0;
  const absolute = resolve(root, normalized);
  const rootResolved = resolve(root);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + sep)) return void 0;
  return absolute;
}
function resourceTarget(location, relativePath) {
  if (location.layout === "flat") {
    throw new StoreError("flat single-file skills cannot carry resource files \u2014 use a directory-package skill");
  }
  const target = resolveWithin(location.dir, relativePath);
  if (target === void 0) {
    throw new StoreError(`invalid resource path "${relativePath}" (must stay inside the skill directory)`);
  }
  if (resolve(target) === resolve(location.filePath)) {
    throw new StoreError("SKILL.md is managed through create/patch/edit, not write_file");
  }
  return target;
}
async function writeResourceAt(location, relativePath, content, options) {
  const target = resourceTarget(location, relativePath);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > options.maxResourceBytes) {
    throw new StoreError(`resource is ${bytes} bytes; the cap is ${options.maxResourceBytes}`);
  }
  await assertNotSymlink(target);
  await atomicWrite(target, content);
  return target;
}
async function removeResourceAt(location, relativePath) {
  const target = resourceTarget(location, relativePath);
  await rm(target, { force: false });
}

// src/approval.ts
var ApprovalError = class extends Error {
};
var ID_PATTERN = /^[0-9a-z-]{6,64}$/;
var CONTENT_FILE = "content";
var MANIFEST_FILE = "manifest.json";
function pendingRoot(stateDir) {
  return join3(stateDir, "pending");
}
function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}
function newId(now) {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
function diffOps(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i2 = n - 1; i2 >= 0; i2 -= 1) {
    for (let j2 = m - 1; j2 >= 0; j2 -= 1) {
      const index = i2 * width + j2;
      table[index] = a[i2] === b[j2] ? (table[(i2 + 1) * width + (j2 + 1)] ?? 0) + 1 : Math.max(table[(i2 + 1) * width + j2] ?? 0, table[i2 * width + (j2 + 1)] ?? 0);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + (j + 1)] ?? 0)) {
      ops.push({ type: "-", text: a[i] ?? "" });
      i += 1;
    } else {
      ops.push({ type: "+", text: b[j] ?? "" });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "-", text: a[i] ?? "" });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "+", text: b[j] ?? "" });
    j += 1;
  }
  return ops;
}
function unifiedDiff(before, after, label) {
  const beforeLines = before === "" ? 0 : before.split("\n").length;
  const afterLines = after === "" ? 0 : after.split("\n").length;
  if (beforeLines * afterLines > 1e6) {
    return {
      text: `(diff omitted: ${beforeLines} -> ${afterLines} lines)`,
      additions: Math.max(0, afterLines - beforeLines),
      deletions: Math.max(0, beforeLines - afterLines)
    };
  }
  const ops = diffOps(before, after);
  const changed = ops.map((op, index) => op.type === " " ? -1 : index).filter((index) => index >= 0);
  if (changed.length === 0) return { text: "", additions: 0, deletions: 0 };
  const context = 3;
  const hunks = [];
  let start = Math.max(0, (changed[0] ?? 0) - context);
  let end = Math.min(ops.length, (changed[0] ?? 0) + context + 1);
  for (const index of changed.slice(1)) {
    if (index <= end + context) {
      end = Math.min(ops.length, index + context + 1);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, index - context);
      end = Math.min(ops.length, index + context + 1);
    }
  }
  hunks.push([start, end]);
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  const lines = [`--- a/${label}`, `+++ b/${label}`];
  let additions = 0;
  let deletions = 0;
  for (let h = 0; h < hunks.length; h += 1) {
    const [hunkStart, hunkEnd] = hunks[h];
    while (cursor < hunkStart) {
      const op = ops[cursor];
      if (op.type !== "+") oldLine += 1;
      if (op.type !== "-") newLine += 1;
      cursor += 1;
    }
    let oldCount = 0;
    let newCount = 0;
    const body = [];
    for (; cursor < hunkEnd; cursor += 1) {
      const op = ops[cursor];
      body.push(`${op.type}${op.text}`);
      if (op.type !== "+") {
        oldCount += 1;
        oldLine += 1;
      }
      if (op.type !== "-") {
        newCount += 1;
        newLine += 1;
      }
      if (op.type === "+") additions += 1;
      if (op.type === "-") deletions += 1;
    }
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine - oldCount;
    const newStart = newCount === 0 ? newLine - 1 : newLine - newCount;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    lines.push(...body);
  }
  return { text: lines.join("\n"), additions, deletions };
}
async function writeManifest(dir, manifest) {
  await writeFile2(join3(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}
`, "utf8");
}
async function stage(stateDir, manifest, content) {
  const dir = join3(pendingRoot(stateDir), manifest.id);
  await mkdir2(dir, { recursive: true });
  if (content !== void 0) await writeFile2(join3(dir, CONTENT_FILE), content, "utf8");
  await writeManifest(dir, manifest);
  return manifest;
}
async function stageSkillWrite(stateDir, params) {
  const now = /* @__PURE__ */ new Date();
  const newText = serializeSkillFile(params.file);
  const diff = unifiedDiff(params.oldText ?? "", newText, `${params.location.name}/SKILL.md`);
  const manifest = {
    id: newId(now),
    action: params.action,
    name: params.location.name,
    scope: params.location.scope,
    root: params.location.root,
    layout: params.location.layout,
    target: params.location.filePath,
    createdAt: now.toISOString(),
    ...params.sessionId === void 0 ? {} : { sessionId: params.sessionId },
    summary: `${params.action} ${params.location.name} (${params.location.scope} scope)`,
    diff: diff.text,
    additions: diff.additions,
    deletions: diff.deletions,
    ...params.oldText === void 0 ? {} : { baseHash: hash(params.oldText) },
    staged: CONTENT_FILE
  };
  return stage(stateDir, manifest, newText);
}
async function stageDelete(stateDir, params) {
  const now = /* @__PURE__ */ new Date();
  const diff = unifiedDiff(params.oldText, "", `${params.location.name}/SKILL.md`);
  const manifest = {
    id: newId(now),
    action: "delete",
    name: params.location.name,
    scope: params.location.scope,
    root: params.location.root,
    layout: params.location.layout,
    target: params.location.filePath,
    createdAt: now.toISOString(),
    ...params.sessionId === void 0 ? {} : { sessionId: params.sessionId },
    summary: `delete ${params.location.name} -> archive (${params.location.scope} scope)`,
    diff: diff.text,
    additions: 0,
    deletions: diff.deletions,
    baseHash: hash(params.oldText),
    staged: ""
  };
  return stage(stateDir, manifest);
}
async function stageResourceWrite(stateDir, params) {
  const now = /* @__PURE__ */ new Date();
  const diff = unifiedDiff(params.previous ?? "", params.content, `${params.location.name}/${params.relativePath}`);
  const manifest = {
    id: newId(now),
    action: "write_file",
    name: params.location.name,
    scope: params.location.scope,
    root: params.location.root,
    layout: params.location.layout,
    target: params.target,
    createdAt: now.toISOString(),
    ...params.sessionId === void 0 ? {} : { sessionId: params.sessionId },
    summary: `write_file ${params.location.name}/${params.relativePath}`,
    diff: diff.text,
    additions: diff.additions,
    deletions: diff.deletions,
    ...params.previous === void 0 ? {} : { baseHash: hash(params.previous) },
    staged: CONTENT_FILE,
    resourcePath: params.relativePath
  };
  return stage(stateDir, manifest, params.content);
}
async function stageResourceRemove(stateDir, params) {
  const now = /* @__PURE__ */ new Date();
  const diff = unifiedDiff(params.previous, "", `${params.location.name}/${params.relativePath}`);
  const manifest = {
    id: newId(now),
    action: "remove_file",
    name: params.location.name,
    scope: params.location.scope,
    root: params.location.root,
    layout: params.location.layout,
    target: params.target,
    createdAt: now.toISOString(),
    ...params.sessionId === void 0 ? {} : { sessionId: params.sessionId },
    summary: `remove_file ${params.location.name}/${params.relativePath}`,
    diff: diff.text,
    additions: 0,
    deletions: diff.deletions,
    baseHash: hash(params.previous),
    staged: "",
    resourcePath: params.relativePath
  };
  return stage(stateDir, manifest);
}
async function readPending(stateDir, id) {
  if (!ID_PATTERN.test(id)) throw new ApprovalError(`invalid pending id "${id}"`);
  try {
    const raw = JSON.parse(await readFile2(join3(pendingRoot(stateDir), id, MANIFEST_FILE), "utf8"));
    if (typeof raw !== "object" || raw === null) return void 0;
    return raw;
  } catch {
    return void 0;
  }
}
async function listPending(stateDir) {
  let ids;
  try {
    ids = (await readdir2(pendingRoot(stateDir))).filter((id) => ID_PATTERN.test(id));
  } catch {
    return [];
  }
  const manifests = [];
  for (const id of ids) {
    const manifest = await readPending(stateDir, id);
    if (manifest !== void 0) manifests.push(manifest);
  }
  manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return manifests;
}
function locationFromManifest(manifest) {
  return manifest.layout === "dir" ? directoryLocation(manifest.scope, manifest.root, manifest.name) : flatLocation(manifest.scope, manifest.root, manifest.name);
}
async function assertBaseUnchanged(manifest) {
  const current = await readTextIfExists(manifest.target);
  if (manifest.action === "create") {
    if (current !== void 0) {
      throw new ApprovalError(`"${manifest.name}" already exists; the staged create is stale`);
    }
    return void 0;
  }
  if (manifest.baseHash === void 0) {
    if (current !== void 0) {
      throw new ApprovalError(`target ${manifest.target} appeared since this write was staged; reject it and stage again`);
    }
    return void 0;
  }
  if (current === void 0) {
    throw new ApprovalError(`target ${manifest.target} no longer exists; the staged write is stale`);
  }
  if (hash(current) !== manifest.baseHash) {
    throw new ApprovalError(`target ${manifest.target} changed since this write was staged; reject it and stage again`);
  }
  return current;
}
async function approvePending(stateDir, id, options) {
  const manifest = await readPending(stateDir, id);
  if (manifest === void 0) throw new ApprovalError(`no pending write "${id}"`);
  await assertBaseUnchanged(manifest);
  const pendingDir = join3(pendingRoot(stateDir), id);
  const location = locationFromManifest(manifest);
  switch (manifest.action) {
    case "create": {
      const text = await readFile2(join3(pendingDir, manifest.staged), "utf8");
      const file = parseSkillFile(text);
      if (file === void 0) throw new ApprovalError("staged SKILL.md no longer parses");
      await writeNewSkill(location, file, { maxSkillBytes: Number.MAX_SAFE_INTEGER });
      break;
    }
    case "patch":
    case "edit":
    case "pin":
    case "unpin": {
      const text = await readFile2(join3(pendingDir, manifest.staged), "utf8");
      const file = parseSkillFile(text);
      if (file === void 0) throw new ApprovalError("staged SKILL.md no longer parses");
      await writeSkillAt(location, file, { maxSkillBytes: Number.MAX_SAFE_INTEGER });
      break;
    }
    case "delete": {
      const archived = await archiveSkillAt(location, options.archiveDir, /* @__PURE__ */ new Date());
      await rm2(pendingDir, { recursive: true, force: true });
      return `deleted ${manifest.name}: archived to ${archived}`;
    }
    case "write_file": {
      const content = await readFile2(join3(pendingDir, manifest.staged), "utf8");
      await writeTextAtomic(manifest.target, content);
      break;
    }
    case "remove_file": {
      await rm2(manifest.target, { force: true });
      break;
    }
  }
  await rm2(pendingDir, { recursive: true, force: true });
  return `applied ${manifest.action} ${manifest.name} (${manifest.additions} added, ${manifest.deletions} removed)`;
}
async function rejectPending(stateDir, id) {
  const manifest = await readPending(stateDir, id);
  if (manifest === void 0) throw new ApprovalError(`no pending write "${id}"`);
  await rm2(join3(pendingRoot(stateDir), id), { recursive: true, force: true });
  return `rejected ${manifest.action} ${manifest.name}`;
}
async function prunePending(stateDir, ttlDays, now) {
  if (ttlDays <= 0) return 0;
  const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1e3;
  let pruned = 0;
  for (const manifest of await listPending(stateDir)) {
    const created = Date.parse(manifest.createdAt);
    if (Number.isFinite(created) && created < cutoff) {
      await rm2(join3(pendingRoot(stateDir), manifest.id), { recursive: true, force: true });
      pruned += 1;
    }
  }
  return pruned;
}
var APPROVAL_FILE = "approval.json";
async function approvalEnabled(stateDir, fallback) {
  try {
    const raw = JSON.parse(await readFile2(join3(stateDir, APPROVAL_FILE), "utf8"));
    if (typeof raw.enabled === "boolean") return raw.enabled;
  } catch {
  }
  return fallback;
}
async function setApprovalEnabled(stateDir, enabled) {
  await mkdir2(stateDir, { recursive: true });
  await writeFile2(join3(stateDir, APPROVAL_FILE), `${JSON.stringify({ enabled }, null, 2)}
`, "utf8");
}

// src/lint.ts
var SECRET_PATTERNS = [
  { rule: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { rule: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { rule: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "openai-style-key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  {
    rule: "secret-assignment",
    pattern: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{16,}['"]?/i
  }
];
var DANGEROUS_PATTERNS = [
  { rule: "pipe-to-shell", pattern: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba)?sh\b/ },
  { rule: "rm-root", pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$)/ },
  { rule: "chmod-777", pattern: /\bchmod\s+(?:-R\s+)?777\b/ }
];
var PLACEHOLDER = /example|placeholder|redacted|xxxx|dummy|\$\{|\$[A-Z_]+/i;
function scanSecrets(text) {
  const issues = [];
  for (const { rule, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    if (PLACEHOLDER.test(match[0])) continue;
    issues.push({
      severity: "error",
      rule: `secret:${rule}`,
      message: `looks like a credential (${rule}). Skills are loaded into every matching session \u2014 replace it with a placeholder such as $API_KEY.`
    });
  }
  return issues;
}
function scanDangerous(text) {
  const issues = [];
  for (const { rule, pattern } of DANGEROUS_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    issues.push({
      severity: "warn",
      rule: `danger:${rule}`,
      message: `contains a destructive shell idiom (${rule}); make the guard rails explicit in the step that runs it.`
    });
  }
  return issues;
}
var INCIDENT_TOKEN = /(?:#[0-9]{3,}|\b[A-Z][A-Z0-9]+-[0-9]{2,}\b)/g;
var MAX_BODY_CHARS = 24e3;
var MAX_DESCRIPTION_CHARS = 1024;
var MAX_REFERENCES = 60;
function lintSkill(file, options = {}) {
  const issues = [];
  const description = file.frontmatter.description.trim();
  const body = file.body.trim();
  if (description.length === 0) {
    issues.push({ severity: "error", rule: "description-empty", message: "description is required; it is what future sessions match against." });
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    issues.push({
      severity: "error",
      rule: "description-too-long",
      message: `description is ${description.length} chars; the cap is ${MAX_DESCRIPTION_CHARS}. Keep it one sentence.`
    });
  }
  if (body.length === 0) {
    issues.push({ severity: "error", rule: "body-empty", message: "the body is empty; a skill without a procedure is not a skill." });
  } else if (body.length > MAX_BODY_CHARS) {
    issues.push({
      severity: "warn",
      rule: "oversized-body",
      message: `body is ${body.length} chars (>${MAX_BODY_CHARS}); a loaded skill stays in context for the rest of the session. Move depth into references/.`
    });
  }
  const incidentTokens = body.match(INCIDENT_TOKEN) ?? [];
  if (incidentTokens.length > 8) {
    issues.push({
      severity: "warn",
      rule: "incident-log-shape",
      message: `body contains ${incidentTokens.length} issue/PR-style references. Skills capture lessons, not logs: keep the generalizable rule and drop the ticket numbers.`
    });
  }
  if ((options.resourceCount ?? 0) > MAX_REFERENCES) {
    issues.push({
      severity: "warn",
      rule: "references-sprawl",
      message: `${options.resourceCount} resource files (>${MAX_REFERENCES}). Consolidate into a few topical references instead of one file per session.`
    });
  }
  return issues;
}
function scanSkill(file, options) {
  const issues = [];
  if (options.lint) issues.push(...lintSkill(file, { resourceCount: options.resourceCount }));
  const serialized = `${file.frontmatter.description}
${file.body}`;
  if (options.secretScan) issues.push(...scanSecrets(serialized));
  issues.push(...scanDangerous(serialized));
  return issues;
}
function blockingIssues(issues) {
  return issues.filter((issue) => issue.severity === "error");
}
function formatIssues(issues) {
  if (issues.length === 0) return "";
  return issues.map((issue) => `${issue.severity === "error" ? "ERROR" : "warning"} [${issue.rule}] ${issue.message}`).join("\n");
}

// src/ledger.ts
import { mkdir as mkdir3, readFile as readFile3, writeFile as writeFile3 } from "fs/promises";
import { dirname as dirname2, join as join4 } from "path";
function ledgerPath(stateDir) {
  return join4(stateDir, "usage.json");
}
async function loadLedger(stateDir) {
  try {
    const raw = JSON.parse(await readFile3(ledgerPath(stateDir), "utf8"));
    if (typeof raw === "object" && raw !== null && typeof raw.skills === "object") {
      return raw;
    }
  } catch {
  }
  return { skills: {} };
}
async function saveLedger(stateDir, ledger) {
  const path = ledgerPath(stateDir);
  await mkdir3(dirname2(path), { recursive: true });
  await writeFile3(path, `${JSON.stringify(ledger, null, 2)}
`, "utf8");
}
function recordUse(ledger, name5, now) {
  const existing = ledger.skills[name5];
  ledger.skills[name5] = {
    lastUsedAt: now.toISOString(),
    uses: (existing?.uses ?? 0) + 1
  };
}
function pruneLedger(ledger, liveNames) {
  for (const name5 of Object.keys(ledger.skills)) {
    if (!liveNames.has(name5)) delete ledger.skills[name5];
  }
}

// src/roots.ts
import { stat as stat2 } from "fs/promises";
import { dirname as dirname3, join as join5, resolve as resolve2 } from "path";
async function findProjectRoot(cwd, markers) {
  let dir = resolve2(cwd);
  for (; ; ) {
    for (const marker of markers) {
      if (marker === "") continue;
      try {
        await stat2(join5(dir, marker));
        return dir;
      } catch {
      }
    }
    const parent = dirname3(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
async function resolveSkillRoots(userRoot, cwd, markers) {
  if (cwd === void 0) return { user: userRoot };
  const projectRoot = await findProjectRoot(cwd, markers) ?? resolve2(cwd);
  return { user: userRoot, project: join5(projectRoot, ".dsh", "skills") };
}
function rootForScope(roots, scope) {
  if (scope === "user") return roots.user;
  if (roots.project === void 0) {
    throw new Error("project scope is unavailable: this session has no working directory");
  }
  return roots.project;
}

// src/tools.ts
var ACTIONS = ["create", "patch", "edit", "delete", "write_file", "remove_file", "pin", "unpin", "list"];
var MUTATING_ACTIONS = ["patch", "edit", "delete", "write_file", "remove_file", "pin", "unpin"];
function applyPatch(file, find, replace) {
  const text = serializeSkillFile(file);
  const first = text.indexOf(find);
  if (first === -1) {
    throw new Error('patch "find" text not found in the skill \u2014 load the skill and copy the exact text');
  }
  if (text.indexOf(find, first + 1) !== -1) {
    throw new Error('patch "find" text matches more than once \u2014 include more surrounding context to make it unique');
  }
  const patchedText = text.slice(0, first) + replace + text.slice(first + find.length);
  const patched = parseSkillFile(patchedText);
  if (patched === void 0) {
    throw new Error("patch would corrupt the SKILL.md structure (frontmatter must remain valid YAML with name and description)");
  }
  return patched;
}
function sessionCwd(exec) {
  const cwd = exec.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : void 0;
}
function sessionId(exec) {
  const id = exec.agent?.id;
  return typeof id === "string" ? id : void 0;
}
async function touchLedger(config, name5) {
  const ledger = await loadLedger(config.stateDir);
  recordUse(ledger, name5, /* @__PURE__ */ new Date());
  await saveLedger(config.stateDir, ledger);
}
function warningText(issues) {
  const warnings = issues.filter((issue) => issue.severity === "warn");
  if (warnings.length === 0) return "";
  return `

Lint warnings:
${formatIssues(warnings)}`;
}
function describeEntries(entries) {
  return entries.map((entry) => {
    const description = entry.file.frontmatter.description.replace(/\s+/g, " ").trim();
    const short = description.length > 90 ? `${description.slice(0, 87)}\u2026` : description;
    return `- ${entry.name} [${entry.location.scope}/${entry.location.layout}] ${short}`;
  }).join("\n");
}
function readGuardMessage(name5) {
  return `Skill "${name5}" has not been loaded in this session. Call skill(name="${name5}") first \u2014 patching from the catalog description alone destroys the procedure. (Set readBeforeWrite=false to disable this guard.)`;
}
function approvalMessage(manifest) {
  return `Staged for approval: ${manifest.summary} (+${manifest.additions}/-${manifest.deletions}, id ${manifest.id}). Nothing has been written. Run /skills pending to review, /skills approve ${manifest.id} to apply, or /skills reject ${manifest.id} to discard.`;
}
async function commitSkillWrite(write, action, location, file, options) {
  const approval = await approvalEnabled(write.config.stateDir, write.config.writeApproval);
  const verb = action === "create" ? "saved" : "updated";
  if (approval) {
    const manifest = await stageSkillWrite(write.config.stateDir, {
      action,
      location,
      file,
      ...options.oldText === void 0 ? {} : { oldText: options.oldText },
      ...sessionId(write.exec) === void 0 ? {} : { sessionId: sessionId(write.exec) }
    });
    return approvalMessage(manifest);
  }
  if (action === "create") {
    await writeNewSkill(location, file, { maxSkillBytes: write.config.maxSkillBytes });
  } else {
    await writeSkillAt(location, file, { maxSkillBytes: write.config.maxSkillBytes });
  }
  write.reads.mark(write.exec.agent, file.frontmatter.name);
  await touchLedger(write.config, file.frontmatter.name);
  const where = `${location.scope} scope at ${location.filePath}`;
  return `Skill "${file.frontmatter.name}" ${verb} (${where}).${options.warnings}`;
}
function registerSkillManageTool(ctx, config) {
  const reads = new ReadRegistry();
  ctx.tools.register(defineTool({
    name: "skill_manage",
    description: [
      "Save or maintain a learned skill (a reusable procedure) so future sessions follow it instead of rediscovering it.",
      "Use after a non-trivial problem: a multi-step fix found by trial and error, an error whose cause was hard to find, or a workflow the user corrected.",
      "A skill stores a PROCEDURE (steps, pitfalls, verification) \u2014 durable facts belong in memory or project notes, not here.",
      "Actions: list (what exists), create (new skill), patch (exact-text replace; PREFER this for small updates), edit (replace body/description), delete (archives, never destroys), write_file / remove_file (supporting files), pin / unpin (protect from curation).",
      "Read before write: load an existing skill with the skill tool in this session before patching, editing, deleting or pinning it.",
      'Scope: create with scope "user" (default, ~/.dsh/skills) or "project" (<project>/.dsh/skills).',
      "Only skills created through this tool can be modified; bundled and human-authored skills are read-only."
    ].join(" "),
    parameters: {
      action: { type: "string", required: true, enum: ACTIONS, description: "What to do" },
      name: { type: "string", description: 'Skill name in kebab-case, e.g. "debug-oomkilled-pods" (omit only for list)' },
      scope: { type: "string", enum: ["user", "project"], description: "create: which root to write to (default user)" },
      description: { type: "string", description: "create/edit: one sentence stating what the skill does and when to use it (what future sessions match against)" },
      when_to_use: { type: "string", description: "create/edit: optional extra trigger guidance" },
      body: { type: "string", description: "create/edit: numbered procedure, pitfalls, and how to verify success" },
      find: { type: "string", description: "patch: exact existing text to replace (must match exactly once)" },
      replace: { type: "string", description: "patch: replacement text" },
      path: { type: "string", description: 'write_file/remove_file: resource path relative to the skill directory, e.g. "scripts/check.sh"' },
      content: { type: "string", description: "write_file: full file content" }
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    async execute(args, exec) {
      const action = args.action;
      const name5 = typeof args.name === "string" ? args.name.trim() : "";
      const write = {
        config,
        roots: await resolveSkillRoots(config.skillsRoot, sessionCwd(exec), config.projectRootMarkers),
        exec,
        reads
      };
      try {
        if (action === "list") {
          const entries2 = await listSkills(write.roots);
          const pending = await listPending(config.stateDir);
          const pendingLine = pending.length === 0 ? "" : `

${pending.length} staged write(s) awaiting approval \u2014 /skills pending.`;
          if (entries2.length === 0) {
            return `No skills found in the user or project roots.${pendingLine}`;
          }
          const ledger = await loadLedger(config.stateDir);
          const body = entries2.map((entry) => {
            const uses = ledger.skills[entry.name]?.uses ?? 0;
            return describeEntries([entry]) + ` (uses: ${uses})`;
          }).join("\n");
          return `Skills (${entries2.length}):
${body}${pendingLine}`;
        }
        if (!isValidSkillName(name5)) {
          return `Invalid skill name "${name5}": use kebab-case (lowercase letters, digits, hyphens), max 64 chars.`;
        }
        if (MUTATING_ACTIONS.includes(action)) {
          const location2 = await locateSkill(write.roots, name5);
          if (location2 === void 0) {
            return `No skill named "${name5}" exists in the user or project roots.`;
          }
          if (config.readBeforeWrite && !reads.has(exec.agent, name5)) {
            return readGuardMessage(name5);
          }
          switch (action) {
            case "patch": {
              if (args.find === void 0 || args.replace === void 0) {
                return 'patch requires "find" and "replace".';
              }
              const file2 = await readOwnedSkillAt(location2);
              const patched = stampMetadata(applyPatch(file2, args.find, args.replace), { now: (/* @__PURE__ */ new Date()).toISOString() });
              const issues2 = scanSkill(patched, { secretScan: config.secretScan, lint: config.lint });
              const blocking2 = blockingIssues(issues2);
              if (blocking2.length > 0) {
                return `skill_manage patch refused:
${formatIssues(blocking2)}`;
              }
              return await commitSkillWrite(write, "patch", location2, patched, {
                oldText: await readTextIfExists(location2.filePath),
                warnings: warningText(issues2)
              });
            }
            case "edit": {
              if (args.body === void 0 && args.description === void 0 && args.when_to_use === void 0) {
                return 'edit requires at least one of "body", "description" or "when_to_use".';
              }
              const file2 = await readOwnedSkillAt(location2);
              const edited = stampMetadata({
                frontmatter: {
                  ...file2.frontmatter,
                  ...args.description === void 0 ? {} : { description: args.description },
                  ...args.when_to_use === void 0 ? {} : { whenToUse: args.when_to_use }
                },
                body: args.body ?? file2.body
              }, { now: (/* @__PURE__ */ new Date()).toISOString() });
              const issues2 = scanSkill(edited, { secretScan: config.secretScan, lint: config.lint });
              const blocking2 = blockingIssues(issues2);
              if (blocking2.length > 0) {
                return `skill_manage edit refused:
${formatIssues(blocking2)}`;
              }
              return await commitSkillWrite(write, "edit", location2, edited, {
                oldText: await readTextIfExists(location2.filePath),
                warnings: warningText(issues2)
              });
            }
            case "pin":
            case "unpin": {
              const file2 = await readOwnedSkillAt(location2);
              const pinned = withPinned(file2, action === "pin");
              return await commitSkillWrite(write, action, location2, pinned, {
                oldText: await readTextIfExists(location2.filePath),
                warnings: ""
              });
            }
            case "delete": {
              const file2 = await readOwnedSkillAt(location2);
              if (await approvalEnabled(config.stateDir, config.writeApproval)) {
                const manifest = await stageDelete(config.stateDir, {
                  location: location2,
                  oldText: serializeSkillFile(file2),
                  ...sessionId(exec) === void 0 ? {} : { sessionId: sessionId(exec) }
                });
                return approvalMessage(manifest);
              }
              const archived = await archiveSkillAt(location2, join6(config.stateDir, "archive"), /* @__PURE__ */ new Date());
              return `Skill "${name5}" archived to ${archived}. Nothing is hard-deleted; a human can restore it.`;
            }
            case "write_file": {
              if (args.path === void 0 || args.content === void 0) {
                return 'write_file requires "path" and "content".';
              }
              await readOwnedSkillAt(location2);
              const target = resourceTarget(location2, args.path);
              const issues2 = [
                ...config.secretScan ? scanSecrets(args.content) : [],
                ...scanDangerous(args.content)
              ];
              const blocking2 = blockingIssues(issues2);
              if (blocking2.length > 0) {
                return `skill_manage write_file refused:
${formatIssues(blocking2)}`;
              }
              const previous = await readTextIfExists(target);
              if (await approvalEnabled(config.stateDir, config.writeApproval)) {
                const manifest = await stageResourceWrite(config.stateDir, {
                  location: location2,
                  relativePath: args.path,
                  target,
                  content: args.content,
                  ...previous === void 0 ? {} : { previous },
                  ...sessionId(exec) === void 0 ? {} : { sessionId: sessionId(exec) }
                });
                return approvalMessage(manifest);
              }
              await writeResourceAt(location2, args.path, args.content, { maxResourceBytes: config.maxResourceBytes });
              return `Resource "${args.path}" written inside skill "${name5}".${warningText(issues2)}`;
            }
            case "remove_file": {
              if (args.path === void 0) return 'remove_file requires "path".';
              await readOwnedSkillAt(location2);
              const target = resourceTarget(location2, args.path);
              const previous = await readTextIfExists(target);
              if (previous === void 0) {
                return `No resource "${args.path}" exists inside skill "${name5}".`;
              }
              if (await approvalEnabled(config.stateDir, config.writeApproval)) {
                const manifest = await stageResourceRemove(config.stateDir, {
                  location: location2,
                  relativePath: args.path,
                  target,
                  previous,
                  ...sessionId(exec) === void 0 ? {} : { sessionId: sessionId(exec) }
                });
                return approvalMessage(manifest);
              }
              await removeResourceAt(location2, args.path);
              return `Resource "${args.path}" removed from skill "${name5}".`;
            }
            default:
              break;
          }
          return `Unknown action "${String(action)}".`;
        }
        if (action !== "create") {
          return `Unknown action "${String(action)}".`;
        }
        if (args.description === void 0 || args.body === void 0) {
          return 'create requires "description" and "body".';
        }
        const existing = await locateSkill(write.roots, name5);
        if (existing !== void 0) {
          return `Skill "${name5}" already exists at ${existing.filePath} (${existing.scope} scope, ${existing.layout} layout). Use patch or edit instead.`;
        }
        const entries = await listSkills(write.roots);
        const duplicates = findDuplicates(
          name5,
          args.description,
          entries.map((entry) => ({
            name: entry.name,
            description: entry.file.frontmatter.description,
            scope: entry.location.scope
          })),
          config.duplicateThreshold
        );
        if (duplicates.length > 0) {
          const candidates = duplicates.map((match) => `- ${match.name} (${match.scope}, score ${match.score.toFixed(2)}): ${match.description.slice(0, 100)}`).join("\n");
          return [
            `Refusing to create "${name5}": it overlaps existing skills.`,
            candidates,
            'Patch the closest umbrella with skill_manage(action="patch", name="<name>") instead of adding a near-duplicate.'
          ].join("\n");
        }
        const scope = args.scope === "project" ? "project" : "user";
        const root = rootForScope(write.roots, scope);
        const location = directoryLocation(scope, root, name5);
        const file = stampMetadata({
          frontmatter: {
            name: name5,
            description: args.description,
            ...args.when_to_use === void 0 ? {} : { whenToUse: args.when_to_use }
          },
          body: args.body
        }, { now: (/* @__PURE__ */ new Date()).toISOString(), create: true });
        const issues = scanSkill(file, { secretScan: config.secretScan, lint: config.lint });
        const blocking = blockingIssues(issues);
        if (blocking.length > 0) {
          return `skill_manage create refused:
${formatIssues(blocking)}`;
        }
        return await commitSkillWrite(write, "create", location, file, { warnings: warningText(issues) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `skill_manage ${action} failed: ${message}`;
      }
    }
  }));
  ctx.on("tools/result", (exec, result) => {
    if (exec.name !== "skill" || result.isError) return;
    const skillName = exec.arguments?.name;
    if (typeof skillName !== "string" || !isValidSkillName(skillName)) return;
    reads.mark(exec.agent, skillName);
    void (async () => {
      const location = await locateSkill(
        await resolveSkillRoots(config.skillsRoot, sessionCwd(exec), config.projectRootMarkers),
        skillName
      ).catch(() => void 0);
      if (location === void 0) return;
      await touchLedger(config, skillName);
    })().catch((error) => {
      ctx.logger.warn("self-evolve usage tracking failed for %s: %s", skillName, String(error));
    });
  });
}

// src/curator.ts
import { utimes } from "fs/promises";
import { join as join7 } from "path";
var DAY_MS = 24 * 60 * 60 * 1e3;
var HOUR_MS = 60 * 60 * 1e3;
function lastActivityMs(ledger, name5, updatedAt, mtimeMs) {
  const candidates = [mtimeMs];
  const use = ledger.skills[name5]?.lastUsedAt;
  if (use !== void 0) {
    const parsed = Date.parse(use);
    if (Number.isFinite(parsed)) candidates.push(parsed);
  }
  if (updatedAt !== void 0) {
    const parsed = Date.parse(updatedAt);
    if (Number.isFinite(parsed)) candidates.push(parsed);
  }
  return Math.max(...candidates);
}
function curatorDue(ledger, intervalHours, now) {
  if (intervalHours <= 0) return false;
  if (ledger.lastCuratorRunAt === void 0) return true;
  const last = Date.parse(ledger.lastCuratorRunAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= intervalHours * HOUR_MS;
}
async function runCurator(config, now) {
  const ledger = await loadLedger(config.stateDir);
  if (!curatorDue(ledger, config.curatorIntervalHours, now)) return void 0;
  const report = { scanned: 0, markedStale: [], archived: [], skippedPinned: [] };
  const entries = await listSkills({ user: config.skillsRoot });
  const liveNames = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (entry.location.scope !== "user") continue;
    if (!isAgentAuthored(entry.file)) continue;
    report.scanned += 1;
    liveNames.add(entry.name);
    const idleMs = now.getTime() - lastActivityMs(
      ledger,
      entry.name,
      metadataString(entry.file, "updatedAt"),
      entry.mtimeMs
    );
    if (isPinned(entry.file)) {
      if (idleMs >= config.staleDays * DAY_MS) report.skippedPinned.push(entry.name);
      continue;
    }
    if (idleMs >= config.archiveDays * DAY_MS) {
      await archiveSkillAt(entry.location, join7(config.stateDir, "archive"), now);
      report.archived.push(entry.name);
      liveNames.delete(entry.name);
      continue;
    }
    const currentStatus = metadataString(entry.file, "status");
    if (idleMs >= config.staleDays * DAY_MS && currentStatus !== "stale") {
      await writeStatusPreservingMtime(entry, "stale");
      report.markedStale.push(entry.name);
    } else if (idleMs < config.staleDays * DAY_MS && currentStatus === "stale") {
      await writeStatusPreservingMtime(entry, "active");
    }
  }
  pruneLedger(ledger, liveNames);
  ledger.lastCuratorRunAt = now.toISOString();
  await saveLedger(config.stateDir, ledger);
  return report;
}
async function writeStatusPreservingMtime(entry, status) {
  await writeSkillAt(entry.location, withStatus(entry.file, status), {
    maxSkillBytes: Number.MAX_SAFE_INTEGER
  });
  const original = new Date(entry.mtimeMs);
  await utimes(entry.location.filePath, original, original);
}

// src/guidance.ts
var guidance_exports = {};
__export(guidance_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
var name = "self-evolve-guidance";
var inject = ["systemPrompt"];
var GUIDANCE_ORDER = 160;
var TEXT = [
  "Self-improvement: you can save learned procedures as skills with the skill_manage tool.",
  "After you solve a non-trivial problem \u2014 a fix found through several attempts, an error whose root cause was hard to locate, a workflow the user corrected you on \u2014 save the proven procedure with skill_manage(create): numbered steps, known pitfalls, and how to verify success.",
  'Before saving, run skill_manage(action="list") and check the catalog: if a matching skill exists, improve it with skill_manage(patch) instead of creating a duplicate. Near-duplicates are refused.',
  "Read before write: load an existing skill with the skill tool in this session before patching, editing, deleting or pinning it.",
  "When a loaded skill turns out wrong or incomplete during use, patch it in the same session while the correction is fresh.",
  'Use scope "project" for procedures specific to this repository; the default user scope is for procedures that apply everywhere.',
  "Skills store procedures. Durable facts, preferences and one-off context belong in memory or project notes, not in skills.",
  "Save selectively: a skill must be reusable and verified to have worked. Never put credentials or secrets in a skill; writes are scanned."
].join(" ");
function apply(ctx) {
  ctx.systemPrompt.section({
    name: "self-evolve:guidance",
    order: GUIDANCE_ORDER,
    text: TEXT
  });
}

// src/command.ts
var command_exports = {};
__export(command_exports, {
  apply: () => apply2,
  inject: () => inject2,
  name: () => name2
});
import { join as join8 } from "path";
var name2 = "self-evolve-command";
var inject2 = ["commands"];
var USAGE = [
  "Usage: /skills [pending | diff <id> | approve <id|all> | reject <id|all> | approval on|off | review [on|off|now]]",
  "",
  "pending        list staged skill_manage writes waiting for approval",
  "diff <id>      show the staged diff",
  'approve <id>   apply one staged write (or "all")',
  'reject <id>    discard one staged write (or "all")',
  "approval on    stage every skill_manage write until turned off",
  "review         show the post-turn reviewer state",
  "review on|off  enable or disable automatic post-turn reviews",
  "review now     run one review immediately"
].join("\n");
function success(text) {
  return { kind: "success", text };
}
function failure(text) {
  return { kind: "error", text };
}
function apply2(ctx, options) {
  const { config, review } = options;
  const commands = ctx.commands;
  if (commands === void 0) return;
  commands.register({
    name: "skills",
    description: "Review staged skill writes and control the post-turn skill reviewer",
    input: { hint: "pending | diff <id> | approve <id|all> | reject <id|all> | approval on|off | review [on|off|now]" },
    async handler({ rawInput, agent }) {
      const tokens = rawInput.trim().split(/\s+/).filter((token) => token.length > 0);
      const sub = tokens[0] ?? "pending";
      try {
        switch (sub) {
          case "pending": {
            const pending = await listPending(config.stateDir);
            if (pending.length === 0) return success("No staged skill writes.");
            const lines = pending.map((manifest) => {
              const when = manifest.createdAt.replace("T", " ").slice(0, 19);
              return `${manifest.id}  ${when}  ${manifest.summary}  +${manifest.additions}/-${manifest.deletions}`;
            });
            return success(`Staged skill writes (${pending.length}):
${lines.join("\n")}

Apply with /skills approve <id>, discard with /skills reject <id>.`);
          }
          case "diff": {
            const id = tokens[1];
            if (id === void 0) return failure("Usage: /skills diff <id>");
            const manifest = await readPending(config.stateDir, id);
            if (manifest === void 0) return failure(`No staged write "${id}".`);
            const diff = manifest.diff.length > 12e3 ? `${manifest.diff.slice(0, 12e3)}
\u2026 (truncated; open the pending manifest for the full diff)` : manifest.diff;
            return success(`${manifest.summary}

${diff === "" ? "(no textual diff)" : diff}`);
          }
          case "approve": {
            const target = tokens[1];
            if (target === void 0) return failure("Usage: /skills approve <id|all>");
            if (target === "all") {
              const pending = await listPending(config.stateDir);
              if (pending.length === 0) return success("No staged skill writes.");
              const outcomes = [];
              for (const manifest of pending) {
                outcomes.push(await approvePending(config.stateDir, manifest.id, { archiveDir: join8(config.stateDir, "archive") }));
              }
              return success(outcomes.join("\n"));
            }
            return success(await approvePending(config.stateDir, target, { archiveDir: join8(config.stateDir, "archive") }));
          }
          case "reject": {
            const target = tokens[1];
            if (target === void 0) return failure("Usage: /skills reject <id|all>");
            if (target === "all") {
              const pending = await listPending(config.stateDir);
              if (pending.length === 0) return success("No staged skill writes.");
              const outcomes = [];
              for (const manifest of pending) outcomes.push(await rejectPending(config.stateDir, manifest.id));
              return success(outcomes.join("\n"));
            }
            return success(await rejectPending(config.stateDir, target));
          }
          case "approval": {
            const value = tokens[1];
            if (value !== "on" && value !== "off") {
              const current = await approvalEnabled(config.stateDir, config.writeApproval);
              return success(`Approval gate is ${current ? "on" : "off"}. Use /skills approval on|off.`);
            }
            await setApprovalEnabled(config.stateDir, value === "on");
            return success(value === "on" ? "Approval gate on: every skill_manage write is staged until approved with /skills approve." : "Approval gate off: skill_manage writes commit immediately.");
          }
          case "review": {
            const controller = review.controller;
            if (controller === void 0) {
              return failure("Reviewer unavailable: this composition has no subagent service (mount @deepseek-ai/dsh-subagent and a provider).");
            }
            const action = tokens[1];
            if (action === void 0) return success(await controller.status());
            if (action === "on" || action === "off") {
              await controller.setEnabled(action === "on");
              return success(action === "on" ? `Automatic review on. ${await controller.status()}` : `Automatic review off. ${await controller.status()}`);
            }
            if (action === "now") return success(await controller.force(agent));
            return failure("Usage: /skills review [on|off|now]");
          }
          default:
            return failure(USAGE);
        }
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    }
  });
}

// src/review.ts
var review_exports = {};
__export(review_exports, {
  REVIEW_TOOLS: () => REVIEW_TOOLS,
  apply: () => apply3,
  inject: () => inject3,
  isRootAgent: () => isRootAgent,
  name: () => name3,
  reviewDecision: () => reviewDecision,
  reviewEnabled: () => reviewEnabled,
  setReviewEnabled: () => setReviewEnabled
});
import { mkdir as mkdir5, readFile as readFile4, writeFile as writeFile4 } from "fs/promises";
import { join as join10 } from "path";

// src/digest.ts
var MAX_TEXT_CHARS = 3e3;
var MAX_SESSIONS = 200;
var MAX_SKILLS = 12;
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (typeof block !== "object" || block === null) continue;
    const text = block.text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}
function truncate(text, max = MAX_TEXT_CHARS) {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\u2026`;
}
var DigestBuffer = class {
  sessions = /* @__PURE__ */ new Map();
  stateFor(sessionId2) {
    const existing = this.sessions.get(sessionId2);
    if (existing !== void 0) return existing;
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== void 0) this.sessions.delete(oldest);
    }
    const created = { user: "", assistant: "", turn: 0, skills: /* @__PURE__ */ new Set() };
    this.sessions.set(sessionId2, created);
    return created;
  }
  /** Record a direct-human user message; synthetic injections are ignored. */
  noteUser(sessionId2, content, sourceKind) {
    if (sourceKind !== "user") return;
    this.stateFor(sessionId2).user = truncate(textOf(content));
  }
  noteAssistant(sessionId2, content) {
    this.stateFor(sessionId2).assistant = truncate(textOf(content));
  }
  noteTurn(sessionId2, turn) {
    const state = this.stateFor(sessionId2);
    state.turn = turn;
    state.skills.clear();
  }
  noteSkill(sessionId2, name5) {
    const state = this.stateFor(sessionId2);
    if (state.skills.size >= MAX_SKILLS) return;
    state.skills.add(name5);
  }
  /** Build the gate input; undefined when the session produced nothing reviewable. */
  build(sessionId2, toolCalls) {
    const state = this.sessions.get(sessionId2);
    if (state === void 0) return void 0;
    if (state.user === "" && state.assistant === "") return void 0;
    return {
      sessionId: sessionId2,
      turn: state.turn,
      userMessage: state.user,
      assistantMessage: state.assistant,
      toolCalls,
      skillsLoaded: [...state.skills]
    };
  }
  /** Clear the per-turn skill set after a gate decision. */
  clearSkills(sessionId2) {
    this.sessions.get(sessionId2)?.skills.clear();
  }
  get size() {
    return this.sessions.size;
  }
};

// src/gate.ts
import { appendFile, mkdir as mkdir4 } from "fs/promises";
import { join as join9 } from "path";
var defaultFetch = (url, init) => fetch(url, init);
function createCountersGate() {
  return {
    async decide() {
      return { review: true, source: "counters", reason: "counters due" };
    }
  };
}
var LESSON_QUESTION = {
  type: "choice",
  instructions: [
    "This is one completed turn of a coding agent.",
    "Does it contain a durable, reusable lesson for the skill library \u2014 a user correction or standing preference,",
    "a non-trivial procedure that succeeded only after trial and error, or a loaded skill that proved wrong?"
  ].join(" "),
  criteria: {
    yes: "The turn contains a correction, preference, or reusable procedure worth saving.",
    no: "The turn was routine, one-off, or taught nothing that a future turn would reuse.",
    unclear: "There may be a lesson, but the turn is ambiguous, incomplete, or too small to judge."
  }
};
function buildJevRequest(digest, config) {
  return {
    model: config.model,
    state: {
      turn: digest.turn,
      userMessage: digest.userMessage,
      assistantMessage: digest.assistantMessage,
      toolCalls: digest.toolCalls,
      skillsLoaded: digest.skillsLoaded
    },
    questions: { lesson: LESSON_QUESTION }
  };
}
function decisionFromAnswer(answer, confidentNo) {
  if (typeof answer !== "object" || answer === null) {
    return { review: true, reason: "fallback: no answer" };
  }
  const candidate = answer;
  if (typeof candidate.choice !== "string") {
    return { review: true, reason: "fallback: unrecognized answer" };
  }
  const confidence = typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence) ? candidate.confidence : 0;
  const probabilities = typeof candidate.probabilities === "object" && candidate.probabilities !== null ? candidate.probabilities : {};
  const yes = typeof probabilities.yes === "number" ? probabilities.yes : void 0;
  if (candidate.choice === "no" && confidence >= confidentNo) {
    return {
      review: false,
      reason: `confident no (confidence ${confidence.toFixed(2)})`,
      choice: "no",
      confidence,
      ...yes === void 0 ? {} : { probability: yes }
    };
  }
  if (candidate.choice === "no") {
    return {
      review: true,
      reason: `no but not confident (confidence ${confidence.toFixed(2)})`,
      choice: "no",
      confidence,
      ...yes === void 0 ? {} : { probability: yes }
    };
  }
  return {
    review: true,
    reason: `${candidate.choice} (confidence ${confidence.toFixed(2)})`,
    choice: candidate.choice,
    confidence,
    ...yes === void 0 ? {} : { probability: yes }
  };
}
var CIRCUIT_THRESHOLD = 3;
function createJevGate(options) {
  const config = options.config;
  const fetchImpl = options.fetch ?? defaultFetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve3) => setTimeout(resolve3, ms)));
  let failures = 0;
  let open = false;
  const fallback = (reason, startedAt) => ({
    review: true,
    source: "counters",
    reason: `fallback: ${reason}`,
    latencyMs: now() - startedAt
  });
  return {
    async decide(digest) {
      const startedAt = now();
      if (open) return fallback("circuit open", startedAt);
      const body = JSON.stringify(buildJevRequest(digest, config));
      const url = `${config.baseURL.replace(/\/+$/, "")}/v1/systemone`;
      const headers = {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      };
      try {
        let response;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), config.timeoutMs);
          try {
            response = await fetchImpl(url, { method: "POST", headers, body, signal: controller.signal });
          } finally {
            clearTimeout(timer);
          }
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt === 0) {
            await sleep(150);
            continue;
          }
          break;
        }
        if (response === void 0) throw new Error("no response");
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status}`);
        }
        const parsed = JSON.parse(await response.text());
        const decision = decisionFromAnswer(parsed.answers?.lesson, config.confidentNo);
        failures = 0;
        return {
          ...decision,
          source: "jev",
          latencyMs: now() - startedAt
        };
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (failures >= CIRCUIT_THRESHOLD && !open) {
          open = true;
          options.logger?.warn("review gate: circuit opened after %d failures (%s)", failures, message);
        }
        return fallback(message, startedAt);
      }
    }
  };
}
function selectGate(review, logger, fetchImpl) {
  if (review.gate !== "jev") return { gate: createCountersGate(), mode: "counters" };
  const apiKey = process.env[review.jev.apiKeyEnv]?.trim();
  if (apiKey === void 0 || apiKey === "") {
    logger.warn(
      'review gate "jev" selected but %s is empty; falling back to counters',
      review.jev.apiKeyEnv
    );
    return { gate: createCountersGate(), mode: "counters", note: "missing-api-key" };
  }
  return {
    gate: createJevGate({ config: review.jev, apiKey, ...fetchImpl === void 0 ? {} : { fetch: fetchImpl }, logger }),
    mode: "jev"
  };
}
async function appendGateLog(stateDir, entry) {
  try {
    await mkdir4(stateDir, { recursive: true });
    await appendFile(join9(stateDir, "gates.jsonl"), `${JSON.stringify(entry)}
`, "utf8");
  } catch {
  }
}

// src/review.ts
function reviewDecision(state, policy, now) {
  if (state.inFlight) return { due: false, reason: "a review is already running" };
  if (state.count >= policy.maxPerSession) return { due: false, reason: "session review budget exhausted" };
  if (state.lastReviewAt !== void 0) {
    const elapsed = now - state.lastReviewAt;
    if (elapsed < policy.cooldownMinutes * 6e4) {
      return { due: false, reason: "cooldown" };
    }
  }
  if (state.tools >= policy.toolCallThreshold) return { due: true, reason: "tools" };
  if (state.turns >= policy.turnInterval) return { due: true, reason: "turns" };
  return { due: false, reason: "not due yet" };
}
function isRootAgent(agent) {
  const header = agent.session.header;
  if (header.origin === "subagent") return false;
  return (header.delegationDepth ?? 0) === 0;
}
var REVIEW_PROMPT = [
  "You are the skill-review pass for the conversation above. It is a completed turn; the user is not waiting for you and will not see your reply.",
  "",
  "Decide whether this turn produced a durable, reusable lesson for the skill library, and apply it with `skill_manage`.",
  "",
  "Signals that warrant an update (any one is enough):",
  '- the user corrected your approach, or stated a standing preference ("from now on", "always", "never");',
  "- a non-trivial workflow succeeded after trial and error, and would be rediscovered next time;",
  "- a skill that was loaded or used in this conversation turned out wrong, incomplete, or outdated;",
  "- a repeated task appeared that a procedure would make routine.",
  "",
  "Do not save: one-off facts, incident narration (PR/issue numbers, dates, chat quotes), secrets, environment trivia, or anything already covered by the loaded skill or AGENTS.md.",
  "",
  "Preference order \u2014 pick the earliest that fits:",
  "1. PATCH a skill that was loaded or used in this conversation (load it with `skill(name)` first \u2014 the write guard refuses a patch you have not read).",
  '2. PATCH an existing umbrella skill that covers this class of task (`skill_manage(action="list")` to find it).',
  "3. CREATE a new class-level skill: numbered procedure, pitfalls with the reason they matter, and how to verify success. Keep the body under ~12 KB; put depth in `references/` via write_file.",
  "",
  "Rules:",
  "- Use only `skill` and `skill_manage`. Do not run shell commands, do not read or edit other files, do not ask questions.",
  "- Write lessons, not logs: a generalizable rule plus the mechanism it protects, once, at the step it affects.",
  "- Do not create a near-duplicate; the tool will refuse it and tell you which skill to patch.",
  "",
  "If nothing here warrants a change, reply with exactly `no skill update` and stop. That is a valid and common outcome."
].join("\n");
var REVIEW_FLAG = "review.json";
async function reviewEnabled(stateDir, fallback) {
  try {
    const raw = JSON.parse(await readFile4(join10(stateDir, REVIEW_FLAG), "utf8"));
    if (typeof raw.enabled === "boolean") return raw.enabled;
  } catch {
  }
  return fallback;
}
async function setReviewEnabled(stateDir, enabled) {
  await mkdir5(stateDir, { recursive: true });
  await writeFile4(join10(stateDir, REVIEW_FLAG), `${JSON.stringify({ enabled }, null, 2)}
`, "utf8");
}
var REVIEW_TOOLS = ["skill", "skill_manage"];
var name3 = "self-evolve-review";
var inject3 = ["agents", "subagents"];
function apply3(ctx, options) {
  const { config, ref } = options;
  const policy = config.review;
  const digests = new DigestBuffer();
  const selection = options.gate === void 0 ? selectGate(policy, ctx.logger) : { gate: options.gate, mode: "jev" };
  const states = /* @__PURE__ */ new Map();
  const stateFor = (id) => {
    const existing = states.get(id);
    if (existing !== void 0) return existing;
    const created = { turns: 0, tools: 0, count: 0, inFlight: false };
    states.set(id, created);
    return created;
  };
  const startReview = async (agent, state, trigger) => {
    if (state.inFlight) return false;
    const decision = trigger === "auto" ? reviewDecision(state, policy, Date.now()) : { due: true, reason: trigger };
    if (!decision.due) return false;
    state.inFlight = true;
    const previousCount = state.count;
    const previousLast = state.lastReviewAt;
    const controller2 = new AbortController();
    const timeout = setTimeout(() => controller2.abort(), policy.timeoutMinutes * 6e4);
    try {
      const activation = await ctx.subagents.startActivation({
        provider: policy.provider,
        label: "skill review",
        request: {
          prompt: [{ type: "text", text: REVIEW_PROMPT }],
          parent: agent
        },
        signal: controller2.signal,
        delivery: "caller"
      });
      restrictChildTools(ctx, activation.childId);
      state.count = previousCount + 1;
      state.lastReviewAt = Date.now();
      state.tools = 0;
      state.turns = 0;
      ctx.logger.info("review started for %s (%s)", agent.id, trigger);
      void activation.result.then((result) => {
        ctx.logger.info("review finished for %s: %s", agent.id, result.stopReason);
      }).catch((error) => {
        ctx.logger.warn("review failed for %s: %s", agent.id, String(error));
      }).finally(() => {
        clearTimeout(timeout);
        state.inFlight = false;
      });
      return true;
    } catch (error) {
      clearTimeout(timeout);
      state.inFlight = false;
      state.count = previousCount;
      state.lastReviewAt = previousLast;
      ctx.logger.warn("review could not start for %s: %s", agent.id, String(error));
      return false;
    }
  };
  const onTurnEnd = async (agent) => {
    if (!isRootAgent(agent)) return;
    if (!await reviewEnabled(config.stateDir, policy.enabled)) return;
    const state = stateFor(agent.id);
    state.turns += 1;
    if (!reviewDecision(state, policy, Date.now()).due) return;
    await new Promise((resolve3) => setTimeout(resolve3, 0));
    if (selection.mode === "jev") {
      const gateCooldown = policy.jev.cooldownMinutes * 6e4;
      if (state.lastGateAt !== void 0 && Date.now() - state.lastGateAt < gateCooldown) return;
      const toolCalls = state.tools;
      const digest = digests.build(agent.id, toolCalls);
      const outcome = digest === void 0 ? { review: true, source: "counters", reason: "fallback: empty digest" } : await selection.gate.decide(digest);
      state.lastGateAt = Date.now();
      state.turns = 0;
      state.tools = 0;
      digests.clearSkills(agent.id);
      void appendGateLog(config.stateDir, {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        session: agent.id,
        turn: digest?.turn ?? 0,
        decision: outcome.review ? "review" : "skip",
        source: outcome.source,
        reason: outcome.reason,
        ...outcome.choice === void 0 ? {} : { choice: outcome.choice },
        ...outcome.confidence === void 0 ? {} : { confidence: outcome.confidence },
        ...outcome.probability === void 0 ? {} : { probability: outcome.probability },
        toolCalls,
        ...outcome.latencyMs === void 0 ? {} : { latencyMs: outcome.latencyMs },
        ...selection.mode === "jev" ? { threshold: policy.jev.confidentNo } : {}
      });
      if (!outcome.review) {
        ctx.logger.info("review skipped by gate for %s: %s", agent.id, outcome.reason);
        return;
      }
    }
    await startReview(agent, state, selection.mode === "jev" ? "gate" : "auto");
  };
  ctx.on("tools/result", (exec, result) => {
    const agent = exec.agent;
    if (agent === void 0 || !isRootAgent(agent)) return;
    stateFor(agent.id).tools += 1;
    if (exec.name !== "skill" || result.isError) return;
    const skillName = exec.arguments?.name;
    if (typeof skillName === "string") digests.noteSkill(agent.id, skillName);
  });
  ctx.on("session/event", (session, event) => {
    switch (event.type) {
      case "turn/start":
        digests.noteTurn(session.id, event.data.turn);
        return;
      case "user/message":
        digests.noteUser(session.id, event.data.content, event.data.source.kind);
        return;
      case "assistant/message":
        digests.noteAssistant(session.id, event.data.message.content);
        return;
      case "turn/end": {
        if (event.data.reason.kind !== "completed") return;
        const agent = ctx.agents.get(session.id);
        if (agent === void 0) return;
        void onTurnEnd(agent);
        return;
      }
      default:
        return;
    }
  });
  const controller = {
    enabled: () => reviewEnabled(config.stateDir, policy.enabled),
    setEnabled: (enabled) => setReviewEnabled(config.stateDir, enabled),
    async status() {
      const on = await reviewEnabled(config.stateDir, policy.enabled);
      return `review ${on ? "on" : "off"} \u2014 every ${policy.turnInterval} turns or ${policy.toolCallThreshold} tool calls, cooldown ${policy.cooldownMinutes}m, max ${policy.maxPerSession}/session, provider "${policy.provider}", gate "${selection.mode}"`;
    },
    async force(agent) {
      if (!isRootAgent(agent)) return "review only runs for a top-level session";
      const state = stateFor(agent.id);
      const started = await startReview(agent, state, "forced");
      return started ? "review started in a forked child session" : "review not started (already running, budget exhausted, or the subagent service refused)";
    }
  };
  ref.controller = controller;
  if (process.env.DSH_SELF_EVOLVE_DEBUG === "1") {
    process.stderr.write(
      `[self-evolve] review ready: provider=${policy.provider} gate=${selection.mode} turns=${policy.turnInterval} tools=${policy.toolCallThreshold} cooldown=${policy.cooldownMinutes}m max=${policy.maxPerSession}
`
    );
  }
  ctx.effect(() => () => {
    if (ref.controller === controller) ref.controller = void 0;
  });
}
function restrictChildTools(ctx, childId) {
  try {
    const child = ctx.agents.get(childId);
    const runtime = child?.ctx?.tools;
    if (runtime?.restrict === void 0) return;
    runtime.restrict({ allow: REVIEW_TOOLS });
  } catch (error) {
    ctx.logger.warn("review: could not restrict child tools: %s", String(error));
  }
}

// src/index.ts
var name4 = "self-evolve";
var inject4 = ["tools"];
function apply4(ctx, config = {}) {
  const resolved = resolveConfig(config);
  registerSkillManageTool(ctx, resolved);
  if (resolved.guidance) ctx.plugin(guidance_exports);
  const reviewRef = {};
  ctx.plugin(review_exports, { config: resolved, ref: reviewRef });
  ctx.plugin(command_exports, { config: resolved, review: reviewRef });
  if (resolved.curatorIntervalHours > 0) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        runCurator(resolved, /* @__PURE__ */ new Date()).then((report) => {
          if (report === void 0) return;
          ctx.logger.info(
            "curator: scanned %d agent-authored skill(s), %d marked stale, %d archived%s",
            report.scanned,
            report.markedStale.length,
            report.archived.length,
            report.skippedPinned.length > 0 ? `, ${report.skippedPinned.length} pinned skipped` : ""
          );
        }).catch((error) => {
          ctx.logger.warn("curator pass failed: %s", String(error));
        });
      }, 3e4);
      return () => clearTimeout(timer);
    });
  }
  void prunePending(resolved.stateDir, resolved.pendingTtlDays, /* @__PURE__ */ new Date()).catch((error) => {
    ctx.logger.warn("pending prune failed: %s", String(error));
  });
  ctx.logger.info(
    "self-evolve ready (skills root: %s, stale after %dd, archive after %dd, approval: %s)",
    resolved.skillsRoot,
    resolved.staleDays,
    resolved.archiveDays,
    resolved.writeApproval ? "on" : "off"
  );
}
export {
  AUTHOR_MARKER,
  Config,
  DigestBuffer,
  apply4 as apply,
  approvalEnabled,
  approvePending,
  createJevGate,
  decisionFromAnswer,
  findDuplicates,
  inject4 as inject,
  isAgentAuthored,
  isPinned,
  isValidSkillName,
  lintSkill,
  listPending,
  name4 as name,
  parseSkillFile,
  rejectPending,
  reviewDecision,
  reviewEnabled,
  runCurator,
  scanSecrets,
  selectGate,
  serializeSkillFile,
  setApprovalEnabled,
  setReviewEnabled,
  similarity,
  stampMetadata,
  withPinned,
  withStatus
};
//# sourceMappingURL=index.js.map