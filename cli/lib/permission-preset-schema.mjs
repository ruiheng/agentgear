const safeName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const safeToken = /^[A-Za-z0-9_./:@+~-]+$/;

export function validatePermissionPreset(preset, source = "permission preset") {
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  if (!safeName.test(preset.name ?? "")) {
    throw new Error(`${source} has an invalid name; use lowercase kebab-case`);
  }
  if (typeof preset.description !== "string" || preset.description.trim() === "") {
    throw new Error(`${source} must have a description`);
  }
  if (/\p{Cc}/u.test(preset.description)) {
    throw new Error(`${source} description must be a single line without control characters`);
  }
  if (!Array.isArray(preset.rules) || preset.rules.length === 0) {
    throw new Error(`${source} must have at least one rule`);
  }
  for (const [index, rule] of preset.rules.entries()) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`${source} rule ${index + 1} must be an object`);
    }
    if (!Array.isArray(rule.command) || rule.command.length === 0
      || rule.command.some(token => typeof token !== "string" || !safeToken.test(token))) {
      throw new Error(`${source} rule ${index + 1} must use non-empty, shell-safe command tokens`);
    }
    if (typeof rule.justification !== "string" || rule.justification.trim() === "") {
      throw new Error(`${source} rule ${index + 1} must have a justification`);
    }
  }
  return preset;
}
