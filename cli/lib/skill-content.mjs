import fs from "node:fs";
import path from "node:path";
import { agentProfiles } from "../../providers/agent-profiles.mjs";
import { runtimeCommands, upstreamSkillEntries } from "./catalog.mjs";

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SELECTOR = /^[a-z0-9][a-z0-9._\-/]*$/;
const ALIAS_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ACTION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const AGENT_PROFILE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_BOOTSTRAP_BYTES = 2 * 1024;
const MAX_SLICE_BYTES = 8 * 1024;
const RUNTIME_SCRIPT_REFERENCE = /\bagentgear\s+run\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s+([A-Za-z0-9.][A-Za-z0-9._/-]*\.(?:mjs|cjs|js))(?![A-Za-z0-9._/-])/g;
const INLINE_CODE = /`([^`\r\n]+)`/g;
const ACTION_PRODUCER_DECLARATION = "action-producers.json";
const ACTION_PRODUCER_MODULE = "action-producers.mjs";
const ACTION_PRODUCER_HELPER = "action-producer.mjs";
const WAYPOST_SEND_BODY_FILE = /(?:\brun|\brunCommand)\s*\(\s*["']waypost["'][\s\S]{0,1600}?--body-file/g;

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

function normalizeSuggestion(value) {
  return value.toLowerCase().replaceAll("_", "-");
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function textSimilarity(left, right) {
  const maximum = Math.max(left.length, right.length);
  return maximum === 0 ? 1 : 1 - editDistance(left, right) / maximum;
}

function suggestionTokens(value) {
  return new Set(value.split(/[:/._-]+/).filter(Boolean));
}

function tokenSimilarity(left, right) {
  const leftTokens = suggestionTokens(left);
  const rightTokens = suggestionTokens(right);
  let matches = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) matches += 1;
  }
  return matches / Math.max(leftTokens.size, rightTokens.size, 1);
}

function suggestionScore(requested, candidate) {
  const normalizedRequested = normalizeSuggestion(requested);
  const normalizedCandidate = normalizeSuggestion(candidate);
  if (normalizedRequested === normalizedCandidate) return 10;
  const requestedLeaf = normalizedRequested.split(/[:/]/).at(-1);
  const candidateLeaf = normalizedCandidate.split(/[:/]/).at(-1);
  const requestedOwner = normalizedRequested.includes("/") ? normalizedRequested.split("/", 1)[0] : null;
  const candidateOwner = normalizedCandidate.includes("/") ? normalizedCandidate.split("/", 1)[0] : null;
  return (
    0.45 * textSimilarity(normalizedRequested, normalizedCandidate) +
    0.35 * tokenSimilarity(normalizedRequested, normalizedCandidate) +
    0.2 * textSimilarity(requestedLeaf, candidateLeaf) +
    (requestedOwner !== null && requestedOwner === candidateOwner ? 0.1 : 0) +
    (requestedLeaf === candidateLeaf ? 0.25 : 0) +
    (candidateOwner !== null && requestedLeaf === candidateOwner ? 0.3 : 0)
  );
}

function rankedSuggestions(requested, candidates, limit = 3) {
  return [...new Set(candidates)]
    .filter(candidate => candidate !== requested)
    .map(candidate => ({ candidate, score: suggestionScore(requested, candidate) }))
    .filter(record => record.score >= 0.38)
    .sort((left, right) => right.score - left.score || compareUtf8(left.candidate, right.candidate))
    .slice(0, limit)
    .map(record => record.candidate);
}

function skillNameSuggestions(index, requested) {
  return rankedSuggestions(requested, [...index.names, ...index.upstreamEntryAddresses]);
}

function skillAddressSuggestions(index, requested) {
  return rankedSuggestions(requested, [
    ...index.names,
    ...index.upstreamEntryAddresses,
    ...index.byCanonicalAddress.keys(),
    ...index.byAliasAddress.keys()
  ]);
}

function suggestionDiagnostic(candidates, operation) {
  if (candidates.length === 0) return "";
  return `\nDid you mean:\n${candidates.map(candidate => `  agentgear skill ${operation} ${candidate}`).join("\n")}`;
}

function escapeRegex(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export function decodeSimpleFrontmatterScalar(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const quote = trimmed[0];
  if (quote === "\"" || quote === "'") {
    return trimmed.length >= 2 && trimmed.at(-1) === quote
      ? trimmed.slice(1, -1)
      : null;
  }
  return trimmed;
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
      const lookupSkill = separator === -1 ? null : alias.slice(0, separator);
      const lookupSelector = separator === -1 ? alias : alias.slice(separator + 1);
      if (!ALIAS_SELECTOR.test(alias) || (lookupSkill !== null && !SKILL_NAME.test(lookupSkill)) || !ALIAS_SELECTOR.test(lookupSelector)) {
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

function parseAgentAppendixFrontmatter(source, filePath, owner) {
  const { fields, body } = splitFrontmatter(source, filePath);
  const allowed = new Set(["agent", "append-to-selector"]);
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw new SkillContentError(`Unsupported agent appendix frontmatter field ${key}: ${filePath}`);
  }
  const agent = fields.agent;
  const selector = fields["append-to-selector"];
  if (!agent || !AGENT_PROFILE.test(agent)) {
    throw new SkillContentError(`Invalid agent in ${filePath}`);
  }
  if (!Object.hasOwn(agentProfiles, agent)) {
    throw new SkillContentError(`Unsupported agent ${agent} in ${filePath}`);
  }
  if (!selector || !SELECTOR.test(selector)) {
    throw new SkillContentError(`Invalid append-to-selector in ${filePath}`);
  }
  return { owner, agent, selector, body, filePath };
}

function parseRuntimeAppendixFrontmatter(source, filePath, owner) {
  const { fields, body } = splitFrontmatter(source, filePath);
  const allowed = new Set(["runtime-command", "append-to-selector"]);
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw new SkillContentError(`Unsupported runtime appendix frontmatter field ${key}: ${filePath}`);
  }
  const command = fields["runtime-command"];
  const selector = fields["append-to-selector"];
  if (!command || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(command)) {
    throw new SkillContentError(`Invalid runtime-command in ${filePath}`);
  }
  if (!selector || !SELECTOR.test(selector)) {
    throw new SkillContentError(`Invalid append-to-selector in ${filePath}`);
  }
  return { owner, command, selector, body, filePath };
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

function walkSkillFiles(root, relative = "") {
  const directory = path.join(root, relative);
  regularDirectory(directory, "Canonical skill directory");
  const result = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    const child = path.join(root, childRelative);
    if (entry.isSymbolicLink()) {
      throw new SkillContentError(`Canonical skill content must not contain symbolic links: ${child}`);
    }
    if (entry.isDirectory()) result.push(...walkSkillFiles(root, childRelative));
    else if (entry.isFile()) result.push(child);
    else throw new SkillContentError(`Unsupported canonical skill entry: ${child}`);
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
  const upstreamEntryAddresses = new Set(upstreamSkillEntries(catalog).map(entry => entry.name));
  const entryAddresses = new Set([...names, ...upstreamEntryAddresses]);
  const byCanonicalAddress = new Map();
  const byAliasAddress = new Map();
  const byOwner = new Map();
  const agentAppendices = new Map();
  const runtimeAppendices = new Map();
  const overviews = new Map();
  const referencedInvocations = [];
  const referenceErrors = [];
  const documentedScripts = [];
  let commandDefinitions;
  try {
    commandDefinitions = runtimeCommands(catalog);
  } catch (error) {
    throw new SkillContentError(`Invalid runtime guidance catalog: ${error.message}`);
  }

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
    const { fields: overviewFields, body: overview } = splitFrontmatter(overviewSource, overviewPath);
    if (validateBootstraps) {
      const paragraphs = overview.trim().split(/\n[ \t]*\n/).map(paragraph => paragraph.trim());
      const duplicateNameHeading = overviewFields.name && paragraphs[0] === `# ${overviewFields.name}`;
      if (duplicateNameHeading) {
        throw new SkillContentError(`SKILL.md repeats its frontmatter name as a heading: ${overviewPath}`);
      }
      if (overviewFields.description && paragraphs[0] === overviewFields.description) {
        throw new SkillContentError(`SKILL.md repeats its frontmatter description as its first body paragraph: ${overviewPath}`);
      }
    }
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
      const isSelector = Object.hasOwn(fields, "skill-selector");
      const isRuntimeAppendix = Object.hasOwn(fields, "runtime-command");
      const isAgentAppendix = Object.hasOwn(fields, "agent")
        || (Object.hasOwn(fields, "append-to-selector") && !isRuntimeAppendix);
      if (!isSelector && !isAgentAppendix && !isRuntimeAppendix) continue;
      if (Buffer.byteLength(source) > MAX_SLICE_BYTES) {
        throw new SkillContentError(`Prompt slice exceeds ${MAX_SLICE_BYTES} bytes: ${filePath}`);
      }
      if ((isSelector && isAgentAppendix) || (isSelector && isRuntimeAppendix) || (isAgentAppendix && isRuntimeAppendix)) {
        throw new SkillContentError(`A prompt file cannot mix selector, agent appendix, and runtime appendix metadata: ${filePath}`);
      }
      if (isRuntimeAppendix) {
        const appendix = parseRuntimeAppendixFrontmatter(source, filePath, name);
        if (!commandDefinitions.has(appendix.command)) {
          throw new SkillContentError(`Runtime appendix command ${appendix.command} is not declared: ${filePath}`);
        }
        const targetAddress = `${name}/${appendix.selector}`;
        const byCommand = runtimeAppendices.get(targetAddress) ?? new Map();
        if (byCommand.has(appendix.command)) {
          throw new SkillContentError(`Duplicate runtime appendix for ${targetAddress} and ${appendix.command}`);
        }
        byCommand.set(appendix.command, appendix);
        runtimeAppendices.set(targetAddress, byCommand);
        continue;
      }
      if (isAgentAppendix) {
        const appendix = parseAgentAppendixFrontmatter(source, filePath, name);
        const targetAddress = `${name}/${appendix.selector}`;
        const byAgent = agentAppendices.get(targetAddress) ?? new Map();
        if (byAgent.has(appendix.agent)) {
          throw new SkillContentError(`Duplicate agent appendix for ${targetAddress} and ${appendix.agent}`);
        }
        byAgent.set(appendix.agent, appendix);
        agentAppendices.set(targetAddress, byAgent);
        continue;
      }
      const record = parseSelectorFrontmatter(source, filePath, name);
      const canonicalAddress = `${name}/${record.selector}`;
      if (!ALIAS_SELECTOR.test(canonicalAddress)) {
        throw new SkillContentError(`Invalid selector address: ${canonicalAddress}`);
      }
      if (byCanonicalAddress.has(canonicalAddress) || byAliasAddress.has(canonicalAddress)) {
        throw new SkillContentError(`Duplicate selector address: ${canonicalAddress}`);
      }
      byCanonicalAddress.set(canonicalAddress, record);
      const ownerRecords = byOwner.get(name) ?? [];
      ownerRecords.push(record);
      byOwner.set(name, ownerRecords);
      for (const alias of record.aliases) {
        if (entryAddresses.has(alias)) {
          throw new SkillContentError(`Selector alias shadows skill entry address: ${alias}`);
        }
        if (byCanonicalAddress.has(alias) || byAliasAddress.has(alias)) {
          throw new SkillContentError(`Duplicate selector address: ${alias}`);
        }
        byAliasAddress.set(alias, record);
      }
    }
  }

  for (const records of byOwner.values()) records.sort((left, right) => compareUtf8(left.selector, right.selector));
  for (const [targetAddress, byAgent] of agentAppendices) {
    if (!byCanonicalAddress.has(targetAddress)) {
      throw new SkillContentError(`Agent appendix targets an unknown selector: ${targetAddress}`);
    }
    agentAppendices.set(targetAddress, new Map([...byAgent].sort(([left], [right]) => compareUtf8(left, right))));
  }
  for (const [targetAddress, byCommand] of runtimeAppendices) {
    if (!byCanonicalAddress.has(targetAddress)) {
      throw new SkillContentError(`Runtime appendix targets an unknown selector: ${targetAddress}`);
    }
    runtimeAppendices.set(targetAddress, new Map([...byCommand].sort(([left], [right]) => compareUtf8(left, right))));
  }
  for (const name of names) {
    const entryAddress = `${name}/start`;
    const entry = byCanonicalAddress.get(entryAddress) ?? byAliasAddress.get(entryAddress);
    if (!entry) throw new SkillContentError(`Skill has no entry address: ${name}`);
    if (entry.owner !== name) {
      throw new SkillContentError(`Skill entry address ${entryAddress} is owned by ${entry.owner}`);
    }
  }
  const addressIndex = { byCanonicalAddress, byAliasAddress };
  for (const alias of byAliasAddress.keys()) {
    if (alias.includes("/")) continue;
    const candidates = bareSelectorCandidates(addressIndex, alias);
    if (candidates.length > 1) {
      throw new SkillContentError(
        `Ambiguous bare selector alias ${alias}; conflicts with: ${candidates.map(candidate => candidate.address).join(", ")}`
      );
    }
  }

  for (const overview of overviews.values()) {
    collectReferences(overview.body, overview.filePath, referencedInvocations, referenceErrors, documentedScripts);
  }
  for (const record of byCanonicalAddress.values()) {
    collectReferences(record.body, record.filePath, referencedInvocations, referenceErrors, documentedScripts);
  }
  for (const byAgent of agentAppendices.values()) {
    for (const appendix of byAgent.values()) {
      collectReferences(appendix.body, appendix.filePath, referencedInvocations, referenceErrors, documentedScripts);
    }
  }
  for (const byCommand of runtimeAppendices.values()) {
    for (const appendix of byCommand.values()) {
      collectReferences(appendix.body, appendix.filePath, referencedInvocations, referenceErrors, documentedScripts);
    }
  }

  return {
    rootDir: path.resolve(rootDir),
    skillsRoot,
    names,
    overviews,
    byCanonicalAddress,
    byAliasAddress,
    byOwner,
    agentAppendices,
    runtimeAppendices,
    runtimeCommands: commandDefinitions,
    upstreamEntryAddresses,
    referencedInvocations,
    referenceErrors,
    documentedScripts
  };
}

function collectReferences(body, filePath, invocations, errors, scripts) {
  for (const match of body.matchAll(INLINE_CODE)) {
    const code = match[1].trim();
    if (!code.startsWith("agentgear skill get")) continue;
    const parsed = parseSkillGetReference(code, filePath);
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    invocations.push({ addresses: parsed.addresses, filePath });
  }
  for (const match of body.matchAll(RUNTIME_SCRIPT_REFERENCE)) {
    scripts.push({ skill: match[1], script: match[2], filePath });
  }
}

// Prompt references are intentionally limited to an argv-shaped inline code
// command.  This recognizes every selector in one lookup (rather than only
// the first regex capture) and keeps prose around a command out of the API.
function parseSkillGetReference(source, filePath) {
  const argv = source.split(/\s+/).filter(Boolean);
  if (argv[0] !== "agentgear" || argv[1] !== "skill" || argv[2] !== "get") {
    return { addresses: [] };
  }
  let cursor = 3;
  if (argv[cursor] === "--") cursor += 1;
  const addresses = argv.slice(cursor);
  if (addresses.length === 0) {
    return { error: `${filePath}: missing agentgear skill get address in ${JSON.stringify(source)}` };
  }
  for (const address of addresses) {
    if (!ALIAS_SELECTOR.test(address)) {
      return { error: `${filePath}: invalid agentgear skill get address ${JSON.stringify(address)}` };
    }
  }
  return { addresses };
}

export function resolveSkillOverview(index, skill) {
  const overview = index.overviews.get(skill);
  if (!overview) {
    const suggestions = suggestionDiagnostic(skillNameSuggestions(index, skill), "list");
    throw new SkillContentError(
      `Unknown skill: ${skill}.${suggestions}\nDiscover skills:\n  agentgear skill list`,
      { kind: "unknown" }
    );
  }
  return overview;
}

export function resolveSkillSelector(index, skill, selector) {
  if (!index.overviews.has(skill)) {
    const requested = `${skill}/${selector}`;
    const suggestions = suggestionDiagnostic(skillAddressSuggestions(index, requested), "get");
    throw new SkillContentError(
      `Unknown skill address: ${requested}.${suggestions}\nDiscover skills:\n  agentgear skill list`,
      { kind: "unknown" }
    );
  }
  const canonical = index.byCanonicalAddress.get(`${skill}/${selector}`);
  const record = canonical ?? index.byAliasAddress.get(`${skill}/${selector}`);
  if (!record) {
    const requested = `${skill}/${selector}`;
    const suggestions = suggestionDiagnostic(skillAddressSuggestions(index, requested), "get");
    throw new SkillContentError(
      `Unknown selector: ${requested}.${suggestions}\nInspect selectors:\n  agentgear skill list ${skill}`,
      { kind: "unknown" }
    );
  }
  return selectorRecordForSkill(record, skill, selector);
}

function bareSelectorCandidates(index, selector) {
  const candidates = new Map();
  for (const [address, record] of index.byCanonicalAddress) {
    if (record.selector === selector) candidates.set(`${record.owner}/${record.selector}`, { address, record });
  }
  for (const [address, record] of index.byAliasAddress) {
    if (address.slice(address.indexOf("/") + 1) === selector) {
      const canonicalAddress = `${record.owner}/${record.selector}`;
      candidates.set(canonicalAddress, { address: canonicalAddress, record });
    }
  }
  return [...candidates.values()].sort((left, right) => compareUtf8(left.address, right.address));
}

export function resolveSkillAddress(index, address) {
  if (!ALIAS_SELECTOR.test(address)) {
    const discovery = address.startsWith("action:")
      ? "Discover registered actions:\n  agentgear action list"
      : "Discover skills:\n  agentgear skill list";
    throw new SkillContentError(
      `Invalid skill address: ${address}\n${discovery}`,
      { kind: "unknown" }
    );
  }
  if (index.overviews.has(address)) {
    const record = index.byCanonicalAddress.get(`${address}/start`) ?? index.byAliasAddress.get(`${address}/start`);
    if (!record) throw new SkillContentError(`Skill has no entry address: ${address}`, { kind: "corrupt" });
    return { ...selectorRecordForSkill(record, address, "start"), requestedAddress: address };
  }
  const separator = address.indexOf("/");
  if (separator !== -1) {
    const record = index.byCanonicalAddress.get(address) ?? index.byAliasAddress.get(address);
    if (record) {
      return { ...selectorRecordForSkill(record, record.owner, address), requestedAddress: address };
    }
    const skill = address.slice(0, separator);
    const selector = address.slice(separator + 1);
    return { ...resolveSkillSelector(index, skill, selector), requestedAddress: address };
  }
  const candidates = bareSelectorCandidates(index, address);
  if (candidates.length === 1) {
    const { record } = candidates[0];
    return { ...selectorRecordForSkill(record, record.owner, address), requestedAddress: address };
  }
  if (candidates.length > 1) {
    throw new SkillContentError(
      `Ambiguous skill address ${address}; use one of: ${candidates.map(candidate => candidate.address).join(", ")}`,
      { kind: "unknown" }
    );
  }
  const suggestions = suggestionDiagnostic(skillAddressSuggestions(index, address), "get");
  const discovery = address.startsWith("action:")
    ? "Discover registered actions:\n  agentgear action list"
    : "Discover skills:\n  agentgear skill list";
  throw new SkillContentError(
    `Unknown skill address: ${address}.${suggestions}\n${discovery}`,
    { kind: "unknown" }
  );
}

function withoutTerminalNewline(body, label) {
  if (!body.endsWith("\n")) {
    throw new SkillContentError(`${label} has no normalized terminal newline`);
  }
  return body.slice(0, -1);
}

export function appendAgentGuidance(index, selection, agentProfiles = []) {
  const byAgent = index.agentAppendices.get(`${selection.owner}/${selection.canonicalSelector}`);
  if (!byAgent || agentProfiles.length === 0) return selection;
  const appendices = agentProfiles
    .map(agent => byAgent.get(agent))
    .filter(Boolean);
  if (appendices.length === 0) return selection;
  const bodies = [
    withoutTerminalNewline(selection.body, "Base selector body"),
    ...appendices.map(appendix => {
      const body = withoutTerminalNewline(appendix.body, "Agent appendix body");
      return body.startsWith("\n") ? body.slice(1) : body;
    })
  ];
  const body = bodies.join("\n\n") + "\n";
  return {
    ...selection,
    body,
    agentAppendices: appendices.map(appendix => ({ agent: appendix.agent }))
  };
}

export function runtimeCommandDefinitions(index, selections) {
  const commands = new Map();
  for (const selection of selections) {
    const byCommand = index.runtimeAppendices.get(`${selection.owner}/${selection.canonicalSelector}`);
    for (const name of byCommand?.keys() ?? []) {
      commands.set(name, index.runtimeCommands.get(name));
    }
  }
  return [...commands.values()];
}

export function appendRuntimeGuidance(index, selection, readyCommands = new Set()) {
  const byCommand = index.runtimeAppendices.get(`${selection.owner}/${selection.canonicalSelector}`);
  if (!byCommand) return selection;
  const appendices = [...byCommand]
    .filter(([command]) => readyCommands.has(command))
    .map(([, appendix]) => appendix);
  if (appendices.length === 0) return selection;
  const bodies = [
    withoutTerminalNewline(selection.body, "Base selector body"),
    ...appendices.map(appendix => {
      const body = withoutTerminalNewline(appendix.body, "Runtime appendix body");
      return body.startsWith("\n") ? body.slice(1) : body;
    })
  ];
  return {
    ...selection,
    body: bodies.join("\n\n") + "\n"
  };
}

export function listSkillSelectors(index, skill) {
  resolveSkillOverview(index, skill);
  const records = [];
  for (const record of index.byOwner.get(skill) ?? []) {
    records.push(selectorRecordForSkill(record, skill, `${skill}/${record.selector}`));
  }
  for (const [address, record] of index.byAliasAddress) {
    if (record.owner !== skill) continue;
    records.push(selectorRecordForSkill(record, skill, address));
  }
  return records.sort((left, right) => compareUtf8(left.selector, right.selector));
}

export function formatSkillText({ selections = [] }) {
  if (selections.length === 1) return normalizeBody(selections[0].body);
  return selections.map(selection => {
    const indented = normalizeBody(selection.body).slice(0, -1).split("\n")
      .map(line => `  ${line}`)
      .join("\n");
    return `agentgear skill: ${selection.requestedAddress}\n${indented}`;
  }).join("\n\n") + "\n";
}

export function actionAliases(index) {
  const result = new Map();
  for (const [address, record] of index.byAliasAddress) {
    const prefix = "action:";
    if (!address.startsWith(prefix)) continue;
    const token = address.slice(prefix.length);
    if (!ACTION_TOKEN.test(token)) throw new SkillContentError(`Invalid action alias token: ${address}`);
    result.set(token, record);
  }
  return result;
}

export function listRegisteredActions(index) {
  return [...actionAliases(index)].map(([action, record]) => ({
    action,
    address: `action:${action}`,
    owner: record.owner,
    canonicalSelector: record.selector,
    summary: record.summary
  })).sort((left, right) => compareUtf8(left.address, right.address));
}

function validateMarkdownFences(filePath, source) {
  let open = null;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
    if (!match) continue;
    const marker = match[1];
    if (open === null) {
      open = { marker: marker[0], length: marker.length, line: index + 1 };
      continue;
    }
    if (marker[0] === open.marker && marker.length >= open.length && match[2].trim() === "") {
      open = null;
    }
  }
  return open === null
    ? []
    : [`${filePath}:${open.line}: unclosed Markdown fence; each selector must be self-contained.`];
}

export function validateSkillContentIndex(index) {
  const errors = [...index.referenceErrors];
  const appendices = [...index.agentAppendices.values()].flatMap(byAgent => [...byAgent.values()]);
  const runtimeAppendices = [...index.runtimeAppendices.values()].flatMap(byCommand => [...byCommand.values()]);
  for (const record of [...index.overviews.values(), ...index.byCanonicalAddress.values(), ...appendices, ...runtimeAppendices]) {
    errors.push(...validateMarkdownFences(record.filePath, record.body));
  }
  for (const appendix of appendices) {
    const firstLine = appendix.body.split("\n").find(line => line.trim() !== "");
    const expectedHeading = agentProfiles[appendix.agent].heading;
    const headingPattern = new RegExp(`^ {0,3}${escapeRegex(expectedHeading)}[\t ]*$`);
    if (firstLine === undefined || !headingPattern.test(firstLine)) {
      errors.push(`${appendix.filePath}: agent appendix must start with ${JSON.stringify(expectedHeading)}.`);
    }
    for (const candidate of markdownActionTemplateLines(appendix.filePath, appendix.body)) {
      errors.push(`${appendix.filePath}:${candidate.lineNumber}: agent appendix cannot declare an Action header.`);
    }
    for (const candidate of markdownTransportHeaderLines(appendix.body)) {
      errors.push(`${appendix.filePath}:${candidate.lineNumber}: agent appendix cannot declare a transport header.`);
    }
  }
  for (const appendix of runtimeAppendices) {
    const firstLine = appendix.body.split("\n").find(line => line.trim() !== "");
    const expectedHeading = `## Runtime guidance: ${appendix.command}`;
    const headingPattern = new RegExp(`^ {0,3}${escapeRegex(expectedHeading)}[\t ]*$`);
    if (firstLine === undefined || !headingPattern.test(firstLine)) {
      errors.push(`${appendix.filePath}: runtime appendix must start with ${JSON.stringify(expectedHeading)}.`);
    }
    for (const candidate of markdownActionTemplateLines(appendix.filePath, appendix.body)) {
      errors.push(`${appendix.filePath}:${candidate.lineNumber}: runtime appendix cannot declare an Action header.`);
    }
    for (const candidate of markdownTransportHeaderLines(appendix.body)) {
      errors.push(`${appendix.filePath}:${candidate.lineNumber}: runtime appendix cannot declare a transport header.`);
    }
  }
  for (const invocation of index.referencedInvocations) {
    const upstreamAddresses = invocation.addresses.filter(address => index.upstreamEntryAddresses.has(address));
    if (upstreamAddresses.length > 0 && invocation.addresses.length !== 1) {
      errors.push(`${invocation.filePath}: Upstream skill ${upstreamAddresses[0]} cannot be combined with other addresses.`);
      continue;
    }
    for (const address of invocation.addresses) {
      if (index.upstreamEntryAddresses.has(address)) continue;
      try {
        resolveSkillAddress(index, address);
      } catch (error) {
        errors.push(`${invocation.filePath}: ${error.message}`);
      }
    }
  }
  try {
    const aliases = actionAliases(index);
    errors.push(...validateActionTemplates(index, aliases));
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

function markdownActionTemplateLines(filePath, source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const candidates = [];
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    // A header-shaped line is a producer whether it is in a fenced message
    // template or in an indented template that is trimmed before sending.
    // Generic prose should refer to the header inline (for example,
    // `Action:`), rather than spelling a placeholder header line.
    if (fence !== null || /^\s*Action:/.test(line)) {
      const actionMatch = /^\s*(Action:.*)$/.exec(line);
      if (actionMatch) candidates.push({ line: actionMatch[1], lineNumber });
    }
  }
  return candidates;
}

function markdownTransportHeaderLines(source) {
  return source.replace(/\r\n/g, "\n").split("\n")
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => /^\s*(?:From|To):/i.test(line));
}

function actionValueFromTemplateLine(line) {
  const match = /^Action:[\t ]*(.*?)[\t ]*$/.exec(line);
  if (!match) return null;
  let value = match[1];
  // Permit a literal source line that closes a JavaScript string/template or
  // carries an escaped line ending. Anything else after the token is part of
  // the emitted header and must be rejected rather than normalized away.
  value = value.replace(/(?:\\[rn])?(?:[`'"])?;?$/, "");
  return value.trimEnd();
}

function actionProducerDeclarations(index) {
  const candidates = [];
  for (const skill of index.names) {
    const filePath = path.join(index.skillsRoot, skill, ACTION_PRODUCER_DECLARATION);
    const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      candidates.push({ filePath, invalid: true, detail: "Action producer declaration is not a regular file" });
      continue;
    }
    let definition;
    try {
      definition = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      candidates.push({ filePath, invalid: true, detail: "Action producer declaration is invalid JSON" });
      continue;
    }
    if (!definition || definition.schemaVersion !== 1 || definition.module !== ACTION_PRODUCER_MODULE || !definition.actions || typeof definition.actions !== "object" || Array.isArray(definition.actions)) {
      candidates.push({ filePath, invalid: true, detail: "Action producer declaration must contain schemaVersion 1 actions" });
      continue;
    }
    const modulePath = path.join(index.skillsRoot, skill, "scripts", definition.module);
    if (regularFileStatus(path.join(index.skillsRoot, skill, "scripts"), definition.module) !== "file") {
      candidates.push({ filePath, invalid: true, detail: `Action producer module is missing or unsafe: ${definition.module}` });
      continue;
    }
    const moduleSource = fs.readFileSync(modulePath, "utf8");
    for (const [name, declaration] of Object.entries(definition.actions)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !declaration || typeof declaration !== "object" || Array.isArray(declaration)
        || typeof declaration.token !== "string" || typeof declaration.script !== "string" || declaration.export !== name
        || typeof declaration.factory !== "string" || !/^[a-z][A-Za-z0-9]*Message$/.test(declaration.factory)
        || typeof declaration.sender !== "string" || !/^[a-z][A-Za-z0-9]*Message$/.test(declaration.sender)) {
        candidates.push({ filePath, invalid: true, detail: `invalid Action producer declaration ${name}` });
        continue;
      }
      const script = path.join(index.skillsRoot, skill, "scripts", declaration.script);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|cjs|js)$/.test(declaration.script) || regularFileStatus(path.join(index.skillsRoot, skill, "scripts"), declaration.script) !== "file") {
        candidates.push({ filePath, invalid: true, detail: `Action producer script is missing or unsafe: ${declaration.script}` });
        continue;
      }
      const source = fs.readFileSync(script, "utf8");
      if (!new RegExp(`export\\s+const\\s+${name}\\s*=`).test(moduleSource)) {
        candidates.push({ filePath, invalid: true, detail: `Action producer module does not export declared value ${name}` });
        continue;
      }
      if (!new RegExp(`export\\s+const\\s+${declaration.factory}\\s*=`).test(moduleSource)) {
        candidates.push({ filePath, invalid: true, detail: `Action producer module does not export declared factory ${declaration.factory}` });
        continue;
      }
      if (!new RegExp(`export\\s+const\\s+${declaration.sender}\\s*=`).test(moduleSource)) {
        candidates.push({ filePath, invalid: true, detail: `Action producer module does not export declared sender ${declaration.sender}` });
        continue;
      }
      if (!new RegExp(`(?:\\b${declaration.factory}\\s*\\(|\\(\\s*${declaration.factory}\\s*,)`).test(source)) {
        candidates.push({ filePath, invalid: true, detail: `Action producer script does not reference declared factory ${declaration.factory}` });
        continue;
      }
      if (!new RegExp(`(?:\\b${declaration.sender}\\s*\\(|\\(\\s*${declaration.sender}\\s*,)`).test(source)) {
        candidates.push({ filePath, invalid: true, detail: `Action producer script does not reference declared sender ${declaration.sender}` });
        continue;
      }
      candidates.push({ filePath, token: declaration.token });
    }
  }
  return candidates;
}

function declaredActionProducerScripts(index) {
  const scripts = new Set();
  for (const skill of index.names) {
    const filePath = path.join(index.skillsRoot, skill, ACTION_PRODUCER_DECLARATION);
    const info = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    try {
      const definition = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const declaration of Object.values(definition?.actions ?? {})) {
        if (typeof declaration?.script === "string") {
          scripts.add(path.join(index.skillsRoot, skill, "scripts", declaration.script));
        }
      }
    } catch {
      // actionProducerDeclarations reports malformed declarations separately.
    }
  }
  return scripts;
}

function undeclaredWaypostActionProducers(index) {
  const declared = declaredActionProducerScripts(index);
  const errors = [];
  for (const skill of index.names) {
    const scriptsRoot = path.join(index.skillsRoot, skill, "scripts");
    const rootInfo = fs.lstatSync(scriptsRoot, { throwIfNoEntry: false });
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) continue;
    for (const filePath of walkSkillFiles(scriptsRoot)) {
      if (!/\.(?:mjs|cjs|js)$/.test(filePath)) continue;
      const source = fs.readFileSync(filePath, "utf8");
      WAYPOST_SEND_BODY_FILE.lastIndex = 0;
      const sendsBody = filePath !== path.join(index.skillsRoot, "multi-agent-protocol", "scripts", ACTION_PRODUCER_HELPER)
        && WAYPOST_SEND_BODY_FILE.test(source);
      WAYPOST_SEND_BODY_FILE.lastIndex = 0;
      if (!sendsBody) continue;
      if (!declared.has(filePath)) {
        errors.push(`${filePath}: Waypost --body-file sender must be declared in ${ACTION_PRODUCER_DECLARATION}`);
        continue;
      }
      if (!/\baction-producers\.mjs["']/.test(source) || !/\bsend[A-Z][A-Za-z0-9]*Message\s*(?:,|\()/.test(source)) {
        errors.push(`${filePath}: declared Waypost Action producer must send through its declared Action sender`);
      }
    }
  }
  return errors;
}

export function validateActionTemplates(index, aliases) {
  const errors = [];
  for (const record of index.byCanonicalAddress.values()) {
    for (const candidate of markdownTransportHeaderLines(record.body)) {
      errors.push(`${record.filePath}:${candidate.lineNumber}: ${candidate.line.trimStart().split(":", 1)[0]} duplicates Waypost transport metadata`);
    }
    for (const candidate of markdownActionTemplateLines(record.filePath, record.body)) {
      const token = actionValueFromTemplateLine(candidate.line);
      if (!ACTION_TOKEN.test(token)) {
        errors.push(`${record.filePath}:${candidate.lineNumber}: dynamic or placeholder Action value is invalid`);
      } else if (!aliases.has(token)) {
        errors.push(`${record.filePath}:${candidate.lineNumber}: unregistered Action token ${token}`);
      }
    }
  }
  for (const candidate of actionProducerDeclarations(index)) {
    if (candidate.invalid) {
      errors.push(`${candidate.filePath}: ${candidate.detail}`);
      continue;
    }
    if (!ACTION_TOKEN.test(candidate.token)) {
      errors.push(`${candidate.filePath}: dynamic or placeholder Action value is invalid`);
    } else if (!aliases.has(candidate.token)) {
      errors.push(`${candidate.filePath}: unregistered Action token ${candidate.token}`);
    }
  }
  errors.push(...undeclaredWaypostActionProducers(index));
  return errors;
}
