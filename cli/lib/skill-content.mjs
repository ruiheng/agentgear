import fs from "node:fs";
import path from "node:path";

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SELECTOR = /^[a-z0-9][a-z0-9._\-/]*$/;
const ALIAS_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ACTION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_BOOTSTRAP_BYTES = 2 * 1024;
const MAX_SLICE_BYTES = 8 * 1024;
const SKILL_GET_REFERENCE = /\bagentgear\s+skill\s+get\s+(?:--\s+)?([a-z0-9][a-z0-9._-]*)\s+([A-Za-z0-9][A-Za-z0-9._:/-]*)/g;
const RUNTIME_SCRIPT_REFERENCE = /\bagentgear\s+run\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s+([A-Za-z0-9.][A-Za-z0-9._/-]*\.(?:mjs|cjs|js))(?![A-Za-z0-9._/-])/g;

export const skillContentLimits = Object.freeze({
  bootstrapBytes: MAX_BOOTSTRAP_BYTES,
  sliceBytes: MAX_SLICE_BYTES
});

export class SkillContentError extends Error {
  constructor(message, { kind = "corrupt" } = {}) {
    super(message);
    this.name = "SkillContentError";
    this.kind = kind;
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function pathInsideOrEqual(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function regularDirectory(directory, label) {
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SkillContentError(`${label} is not a real directory: ${directory}`);
  }
  return true;
}

function regularFile(filePath, label) {
  const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new SkillContentError(`${label} is missing or is not a regular file: ${filePath}`);
  }
}

function regularFileStatus(root, relativePath) {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  let current = path.resolve(root);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (!pathInsideOrEqual(root, current)) return "invalid";
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!info) return "missing";
    if (info.isSymbolicLink()) return "invalid";
    if (index === parts.length - 1) return info.isFile() ? "file" : "invalid";
    if (!info.isDirectory()) return "invalid";
  }
  return "invalid";
}

function normalizeBody(source) {
  return source.replace(/\r\n/g, "\n").replace(/\n*$/, "") + "\n";
}

export function splitFrontmatter(source, label = "document") {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { fields: {}, body: normalizeBody(normalized) };
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) throw new SkillContentError(`Unterminated frontmatter: ${label}`);
  const fields = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([a-z][a-z-]*): ([^\n]*)$/.exec(line);
    if (!match) throw new SkillContentError(`Invalid frontmatter line in ${label}: ${line}`);
    const [, key, value] = match;
    if (Object.hasOwn(fields, key)) throw new SkillContentError(`Duplicate frontmatter field ${key}: ${label}`);
    fields[key] = value;
  }
  return { fields, body: normalizeBody(normalized.slice(end + 5)) };
}

function parseSelectorFrontmatter(source, filePath, owner) {
  const { fields, body } = splitFrontmatter(source, filePath);
  const allowed = new Set(["skill-selector", "selector-summary", "selector-aliases"]);
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw new SkillContentError(`Unsupported selector frontmatter field ${key}: ${filePath}`);
  }
  const selector = fields["skill-selector"];
  const summary = fields["selector-summary"];
  if (!selector || !SELECTOR.test(selector)) {
    throw new SkillContentError(`Invalid skill-selector in ${filePath}`);
  }
  if (!summary || summary.trim() !== summary || summary.includes("\n")) {
    throw new SkillContentError(`Invalid selector-summary in ${filePath}`);
  }
  const aliases = [];
  if (Object.hasOwn(fields, "selector-aliases")) {
    if (!fields["selector-aliases"]) throw new SkillContentError(`Empty selector-aliases in ${filePath}`);
    for (const rawAlias of fields["selector-aliases"].split(",")) {
      const alias = rawAlias.trim();
      if (!alias || /\s/.test(alias)) throw new SkillContentError(`Whitespace in selector alias ${JSON.stringify(rawAlias)}: ${filePath}`);
      const separator = alias.indexOf("/");
      const lookupSkill = separator === -1 ? "" : alias.slice(0, separator);
      const lookupSelector = separator === -1 ? "" : alias.slice(separator + 1);
      if (!SKILL_NAME.test(lookupSkill) || !ALIAS_SELECTOR.test(lookupSelector)) {
        throw new SkillContentError(`Invalid selector alias ${JSON.stringify(alias)}: ${filePath}`);
      }
      aliases.push(alias);
    }
  }
  if (new Set(aliases).size !== aliases.length) {
    throw new SkillContentError(`Duplicate selector alias in ${filePath}`);
  }
  return { owner, selector, summary, aliases, body, filePath };
}

function walkMarkdown(root, relative = "") {
  const directory = path.join(root, relative);
  regularDirectory(directory, "Selector references directory");
  const result = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    const child = path.join(root, childRelative);
    if (entry.isSymbolicLink()) {
      throw new SkillContentError(`Selector references must not contain symbolic links: ${child}`);
    }
    if (entry.isDirectory()) result.push(...walkMarkdown(root, childRelative));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(child);
    else if (!entry.isFile()) throw new SkillContentError(`Unsupported selector references entry: ${child}`);
  }
  return result;
}

function canonicalSkillNames(catalog) {
  return Object.keys(catalog?.skills?.skills ?? {}).sort(compareUtf8);
}

function selectorRecordForSkill(record, lookupSkill, requestedSelector = record.selector) {
  return {
    requestedSkill: lookupSkill,
    selector: requestedSelector,
    owner: record.owner,
    canonicalSelector: record.selector,
    aliases: [...record.aliases],
    summary: record.summary,
    body: record.body
  };
}

/**
 * Build the complete canonical selector index directly from a runtime or a
 * source checkout.  It intentionally has no cache: the runtime snapshot is
 * the trust boundary and the index is tiny enough to derive per invocation.
 */
export function buildSkillContentIndex(rootDir, catalog, { validateBootstraps = false } = {}) {
  const skillsRoot = path.resolve(rootDir, "skills");
  regularDirectory(skillsRoot, "Canonical skills directory");
  const names = canonicalSkillNames(catalog);
  const byCanonicalAddress = new Map();
  const byAliasAddress = new Map();
  const byOwner = new Map();
  const overviews = new Map();
  const referencedSelectors = [];
  const documentedScripts = [];

  for (const name of names) {
    const skillRoot = path.resolve(skillsRoot, name);
    if (!pathInsideOrEqual(skillsRoot, skillRoot)) throw new SkillContentError(`Unsafe canonical skill name: ${name}`);
    regularDirectory(skillRoot, "Canonical skill directory");
    const overviewPath = path.join(skillRoot, "SKILL.md");
    regularFile(overviewPath, "Canonical SKILL.md");
    const overviewSource = fs.readFileSync(overviewPath, "utf8");
    if (validateBootstraps && Buffer.byteLength(overviewSource) > MAX_BOOTSTRAP_BYTES) {
      throw new SkillContentError(`SKILL.md exceeds ${MAX_BOOTSTRAP_BYTES} bytes: ${overviewPath}`);
    }
    const overview = splitFrontmatter(overviewSource, overviewPath).body;
    overviews.set(name, { owner: name, body: overview, filePath: overviewPath });

    const referenceRoot = path.join(skillRoot, "references");
    const referenceInfo = fs.lstatSync(referenceRoot, { throwIfNoEntry: false });
    if (!referenceInfo) continue;
    if (!referenceInfo.isDirectory() || referenceInfo.isSymbolicLink()) {
      throw new SkillContentError(`Selector references directory is not a real directory: ${referenceRoot}`);
    }
    for (const filePath of walkMarkdown(referenceRoot)) {
      const source = fs.readFileSync(filePath, "utf8");
      if (!source.replace(/\r\n/g, "\n").startsWith("---\n")) continue;
      const fields = splitFrontmatter(source, filePath).fields;
      if (!Object.hasOwn(fields, "skill-selector")) continue;
      if (Buffer.byteLength(source) > MAX_SLICE_BYTES) {
        throw new SkillContentError(`Selector slice exceeds ${MAX_SLICE_BYTES} bytes: ${filePath}`);
      }
      const record = parseSelectorFrontmatter(source, filePath, name);
      const canonicalAddress = `${name}/${record.selector}`;
      if (byCanonicalAddress.has(canonicalAddress) || byAliasAddress.has(canonicalAddress)) {
        throw new SkillContentError(`Duplicate selector address: ${canonicalAddress}`);
      }
      byCanonicalAddress.set(canonicalAddress, record);
      const ownerRecords = byOwner.get(name) ?? [];
      ownerRecords.push(record);
      byOwner.set(name, ownerRecords);
      for (const alias of record.aliases) {
        if (byCanonicalAddress.has(alias) || byAliasAddress.has(alias)) {
          throw new SkillContentError(`Duplicate selector address: ${alias}`);
        }
        byAliasAddress.set(alias, record);
      }
    }
  }

  for (const records of byOwner.values()) records.sort((left, right) => compareUtf8(left.selector, right.selector));

  for (const overview of overviews.values()) {
    collectReferences(overview.body, overview.filePath, referencedSelectors, documentedScripts);
  }
  for (const record of byCanonicalAddress.values()) {
    collectReferences(record.body, record.filePath, referencedSelectors, documentedScripts);
  }

  return {
    rootDir: path.resolve(rootDir),
    skillsRoot,
    names,
    overviews,
    byCanonicalAddress,
    byAliasAddress,
    byOwner,
    referencedSelectors,
    documentedScripts
  };
}

function collectReferences(body, filePath, selectors, scripts) {
  for (const match of body.matchAll(SKILL_GET_REFERENCE)) {
    selectors.push({ skill: match[1], selector: match[2], filePath });
  }
  for (const match of body.matchAll(RUNTIME_SCRIPT_REFERENCE)) {
    scripts.push({ skill: match[1], script: match[2], filePath });
  }
}

export function resolveSkillOverview(index, skill) {
  const overview = index.overviews.get(skill);
  if (!overview) throw new SkillContentError(`Unknown skill: ${skill}. Run agentgear list for known skills.`, { kind: "unknown" });
  return overview;
}

export function resolveSkillSelector(index, skill, selector) {
  resolveSkillOverview(index, skill);
  const canonical = index.byCanonicalAddress.get(`${skill}/${selector}`);
  const record = canonical ?? index.byAliasAddress.get(`${skill}/${selector}`);
  if (!record) {
    throw new SkillContentError(`Unknown selector ${skill}/${selector}. Run agentgear skill list ${skill}.`, { kind: "unknown" });
  }
  return selectorRecordForSkill(record, skill, selector);
}

export function listSkillSelectors(index, skill) {
  resolveSkillOverview(index, skill);
  const records = [];
  for (const record of index.byOwner.get(skill) ?? []) {
    records.push(selectorRecordForSkill(record, skill, record.selector));
  }
  for (const [address, record] of index.byAliasAddress) {
    const prefix = `${skill}/`;
    if (!address.startsWith(prefix)) continue;
    records.push(selectorRecordForSkill(record, skill, address.slice(prefix.length)));
  }
  return records.sort((left, right) => compareUtf8(left.selector, right.selector));
}

export function formatSkillText({ skill, overview, selections = [] }) {
  if (overview) return normalizeBody(overview.body);
  if (selections.length === 1) return normalizeBody(selections[0].body);
  return selections.map(selection => {
    const indented = normalizeBody(selection.body).slice(0, -1).split("\n")
      .map(line => `  ${line}`)
      .join("\n");
    return `agentgear skill: ${skill}/${selection.requestedSelector}\n${indented}`;
  }).join("\n\n") + "\n";
}

export function actionAliases(index) {
  const result = new Map();
  for (const [address, record] of index.byAliasAddress) {
    const prefix = "check-waypost-messages/action:";
    if (!address.startsWith(prefix)) continue;
    const token = address.slice(prefix.length);
    if (!ACTION_TOKEN.test(token)) throw new SkillContentError(`Invalid action alias token: ${address}`);
    result.set(token, record);
  }
  return result;
}

export function validateSkillContentIndex(index) {
  const errors = [];
  for (const reference of index.referencedSelectors) {
    try {
      resolveSkillSelector(index, reference.skill, reference.selector);
    } catch (error) {
      errors.push(`${reference.filePath}: ${error.message}`);
    }
  }
  try {
    actionAliases(index);
  } catch (error) {
    errors.push(error.message);
  }
  for (const documented of index.documentedScripts) {
    if (!index.names.includes(documented.skill)) {
      errors.push(`${documented.filePath}: unknown documented runtime skill ${documented.skill}`);
      continue;
    }
    if (path.isAbsolute(documented.script) || documented.script.split(/[\\/]/).includes("..")) {
      errors.push(`${documented.filePath}: unsafe documented runtime script ${documented.script}`);
      continue;
    }
    const relative = path.join("skills", documented.skill, "scripts", documented.script);
    if (regularFileStatus(index.rootDir, relative) !== "file") {
      errors.push(`${documented.filePath}: documented runtime script is missing or unsafe: ${relative}`);
    }
  }
  return errors;
}
