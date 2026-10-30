import { join } from "@std/path";

const excludedDirectories = new Set([
  ".git",
  ".deno",
  "node_modules",
  "coverage",
  "dist",
  "build",
  ".local",
  "volumes",
]);
const patterns: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Telegram bot token", /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["GitHub token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];

const findings: string[] = [];
await scan(".");
if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  Deno.exit(1);
}
console.log(JSON.stringify({ secretScan: "passed", patterns: patterns.length }));

async function scan(directory: string): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name.startsWith(".env") && entry.name !== ".env.example") continue;
    if (entry.isDirectory && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      await scan(path);
      continue;
    }
    if (!entry.isFile || !isTextFile(entry.name)) continue;
    const text = await Deno.readTextFile(path).catch(() => "");
    for (const [name, pattern] of patterns) {
      if (pattern.test(text)) findings.push(`${path}: possible ${name}`);
    }
  }
}

function isTextFile(name: string): boolean {
  return /(?:\.(?:ts|tsx|js|json|ya?ml|md|sql|toml|txt|example|dockerignore)|Dockerfile)$/i.test(
    name,
  ) || name === "Dockerfile";
}
