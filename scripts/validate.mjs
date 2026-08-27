import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCatalog,
  MAX_SKILL_NAME_LENGTH,
  resolveSelection,
  validateCatalog
} from "../cli/lib/catalog.mjs";
import {
  buildSkillContentIndex,
  decodeSimpleFrontmatterScalar,
  validateSkillContentIndex
} from "../cli/lib/skill-content.mjs";
import { validateLegacySkillNames } from "../cli/lib/legacy-skill-migration.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function walk(root, relative = "") {
  const current = path.join(root, relative);
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const result = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    const childPath = path.join(root, child);
    if (entry.isDirectory()) result.push(...walk(root, child));
    else if (entry.isFile()) result.push(childPath);
  }
  return result;
}

function validateSkill(skillDir) {
  const name = path.basename(skillDir);
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    errors.push("Missing SKILL.md: " + skillDir);
    return;
  }
  const source = fs.readFileSync(skillFile, "utf8");
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontmatter) {
    errors.push("Invalid frontmatter: " + skillFile);
    return;
  }
  const fields = Object.fromEntries(frontmatter[1]
    .split(/\r?\n/)
    .map(line => line.match(/^([^:#]+):\s*(.*)$/))
    .filter(Boolean)
    .map(match => [match[1].trim(), decodeSimpleFrontmatterScalar(match[2])]));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    errors.push("Invalid skill directory name: " + name);
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    errors.push(`Skill name exceeds ${MAX_SKILL_NAME_LENGTH} characters: ${name}`);
  }
  if (fields.name !== name) {
    errors.push("Frontmatter name must match directory: " + skillFile);
  }
  if (!fields.description) {
    errors.push("Missing frontmatter description: " + skillFile);
  }
}

function checkSyntax(filePath) {
  let command;
  let args;
  if (/\.(?:cjs|mjs|js)$/.test(filePath)) {
    command = process.execPath;
    args = ["--check", filePath];
  } else {
    return;
  }
  const result = childProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    errors.push("Syntax check failed: " + filePath + "\n" + (result.stderr || result.stdout));
  }
}

const catalog = loadCatalog(rootDir);
errors.push(...validateCatalog(rootDir, catalog));
for (const pack of Object.keys(catalog.skills.packs)) {
  try {
    resolveSelection(catalog, { packs: [pack] });
  } catch (error) {
    errors.push(error.message);
  }
}

const skillsRoot = path.join(rootDir, "skills");
for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
  if (entry.isDirectory()) validateSkill(path.join(skillsRoot, entry.name));
}

try {
  const index = buildSkillContentIndex(rootDir, catalog, { validateBootstraps: true });
  errors.push(...validateSkillContentIndex(index));
} catch (error) {
  errors.push(`Invalid selector content: ${error.message}`);
}

try {
  validateLegacySkillNames();
} catch (error) {
  errors.push(error.message);
}

for (const filePath of walk(skillsRoot)) {
  const source = fs.readFileSync(filePath, "utf8");
  if (source.includes(".config/ai-agent") || source.includes("/home/ruiheng/config_files")) {
    errors.push("Nonportable installation path: " + filePath);
  }
  checkSyntax(filePath);
}

const workflowScripts = path.join(skillsRoot, "multi-agent-protocol", "scripts");
for (const entry of fs.readdirSync(workflowScripts, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (!/\.(?:mjs|js)$/.test(entry.name)) {
    errors.push("Workflow scripts must use JavaScript: " + path.join(workflowScripts, entry.name));
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write("error: " + error + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write("Validated " + Object.keys(catalog.skills.skills).length + " skills.\n");
}
