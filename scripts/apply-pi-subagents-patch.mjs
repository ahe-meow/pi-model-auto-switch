import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const expectedVersion = "1.5.4";
const agentDir =
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const packageDir = path.join(
  agentDir,
  "npm",
  "node_modules",
  "pi-subagents-j0k3r",
);
const packageJsonPath = path.join(packageDir, "package.json");
const runnerPath = path.join(packageDir, "src", "runner", "sdk-runner.ts");

let packageJson;
try {
  packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
} catch (error) {
  throw new Error(`Unable to read ${packageJsonPath} as JSON`, {
    cause: error,
  });
}
if (packageJson.version !== expectedVersion) {
  throw new Error(
    `Unsupported pi-subagents-j0k3r version: ${packageJson.version}; expected ${expectedVersion}`,
  );
}

const source = fs.readFileSync(runnerPath, "utf8");
const original = `  const created = await createAgentSession(options);\n  return { ...created, nested_session_path: resolvedSessionPath, pi_version: versionFromPiSdk(piSdk) };`;
const replacement = `  const created = await createAgentSession(options);\n  // SDK sessions do not bind extension handlers automatically. Without this,\n  // session_start never reaches providers that need the current model registry.\n  if (typeof created.session?.bindExtensions === 'function') {\n    await created.session.bindExtensions({ mode: 'print' });\n  }\n  return { ...created, nested_session_path: resolvedSessionPath, pi_version: versionFromPiSdk(piSdk) };`;

if (source.includes(replacement)) {
  process.stdout.write(
    `pi-subagents-j0k3r ${expectedVersion} patch already applied\n`,
  );
} else {
  if (!source.includes(original)) {
    throw new Error(
      `Expected sdk-runner.ts patch context was not found: ${runnerPath}`,
    );
  }

  fs.writeFileSync(runnerPath, source.replace(original, replacement));
  process.stdout.write(
    `Applied pi-subagents-j0k3r ${expectedVersion} patch to ${runnerPath}\n`,
  );
}
