import path from "node:path";

function csv(value, option) {
  if (!value) throw new Error("Missing value for " + option);
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

export function parseOptions(argumentsList, { allowAgentProfile = false } = {}) {
  const options = {
    packs: [],
    skills: [],
    targets: [],
    scope: "global",
    project: process.cwd(),
    projectSpecified: false,
    destination: undefined,
    force: false,
    purge: false,
    noLauncher: false,
    apply: false,
    json: false,
    agentProfile: undefined,
    supplied: new Set(),
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
        options.supplied.add("pack");
        options.packs.push(...csv(next(), argument));
        break;
      case "--skill":
        options.supplied.add("skill");
        options.skills.push(...csv(next(), argument));
        break;
      case "--target":
      case "--provider":
        options.supplied.add("target");
        options.targets.push(...csv(next(), argument));
        break;
      case "--scope":
        options.supplied.add("scope");
        options.scope = next();
        break;
      case "--project":
        options.supplied.add("project");
        options.project = next();
        options.projectSpecified = true;
        break;
      case "--dest":
        options.supplied.add("dest");
        options.destination = next();
        break;
      case "--force":
        options.supplied.add("force");
        options.force = true;
        break;
      case "--purge":
        options.supplied.add("purge");
        options.purge = true;
        break;
      case "--no-launcher":
        options.supplied.add("no-launcher");
        options.noLauncher = true;
        break;
      case "--apply":
        options.supplied.add("apply");
        options.apply = true;
        break;
      case "--json":
        options.supplied.add("json");
        options.json = true;
        break;
      case "--agent-profile":
        if (!allowAgentProfile) throw new Error("Unknown option: " + argument);
        options.supplied.add("agent-profile");
        options.agentProfile = next();
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (argument === "--") {
          options.positional.push(...argumentsList.slice(index + 1));
          index = argumentsList.length;
          break;
        }
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
