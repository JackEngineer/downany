import * as path from "node:path";

import { PROTOCOL_SCHEME } from "./deepLink";

interface ProtocolRegistrar {
  setAsDefaultProtocolClient(protocol: string, executable?: string, args?: string[]): boolean;
}

interface ProtocolRuntime {
  env: NodeJS.ProcessEnv;
  defaultApp?: boolean;
  execPath: string;
  argv: readonly string[];
}

/** Isolated package checks must not replace the installed app's association. */
export function registerProtocolClient(app: ProtocolRegistrar, runtime: ProtocolRuntime): boolean {
  if (runtime.env.DOWNANY_SKIP_PROTOCOL_REGISTRATION === "1") return false;
  if (runtime.defaultApp) {
    if (runtime.argv.length < 2) return false;
    return app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, runtime.execPath, [
      path.resolve(runtime.argv[1]),
    ]);
  }
  return app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}
