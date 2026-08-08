import path from "node:path";

function csv(value, option) {
  if (!value) throw new Error("Missing value for " + option);
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

export function parseOptions(argumentsList) {
  const options = {
    packs: [],
    skills: [],
    targets: [],
    scope: "global",
    project: process.cwd(),
    destination: undefined,
    force: false,
    purge: false,
    noLauncher: false,
    json: false,
    positional: []
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const next = () => {
      index += 1;
      if (index >= argumentsList.length) throw new Error("Missing value for " + argument);
      return argumentsList[index];
    };
    switch (argument) {
      case "--pack":
        options.packs.push(...csv(next(), argument));
        break;
      case "--skill":
        options.skills.push(...csv(next(), argument));
        break;
      case "--target":
      case "--provider":
        options.targets.push(...csv(next(), argument));
        break;
      case "--scope":
        options.scope = next();
        break;
      case "--project":
        options.project = next();
        break;
      case "--dest":
        options.destination = next();
        break;
      case "--force":
        options.force = true;
        break;
      case "--purge":
        options.purge = true;
        break;
      case "--no-launcher":
        options.noLauncher = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (argument.startsWith("-")) throw new Error("Unknown option: " + argument);
        options.positional.push(argument);
    }
  }

  if (!["global", "project"].includes(options.scope)) {
    throw new Error("Invalid scope: " + options.scope + ". Use global or project.");
  }
  options.project = path.resolve(options.project);
  return options;
}
