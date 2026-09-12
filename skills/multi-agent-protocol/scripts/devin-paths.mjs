import os from "node:os";
import path from "node:path";

export function devinConfigHome(env = process.env) {
  const home = path.resolve(env.HOME || os.homedir());
  if (process.platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "devin");
  }
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(xdgConfig, "devin");
}
