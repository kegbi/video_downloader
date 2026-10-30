const [path = "coverage.lcov", minimumText = "80"] = Deno.args;
const minimum = Number(minimumText);
if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
  throw new Error("Coverage minimum must be between 0 and 100");
}

const records = (await Deno.readTextFile(path)).split("end_of_record");
let linesFound = 0;
let linesHit = 0;
let functionsFound = 0;
let functionsHit = 0;
let branchesFound = 0;
let branchesHit = 0;
for (const record of records) {
  const source = record.match(/^SF:(.+)$/m)?.[1]?.replaceAll("\\", "/");
  if (!source || !isCore(source)) continue;
  linesFound += field(record, "LF");
  linesHit += field(record, "LH");
  functionsFound += field(record, "FNF");
  functionsHit += field(record, "FNH");
  branchesFound += field(record, "BRF");
  branchesHit += field(record, "BRH");
}
if (linesFound === 0) throw new Error("No core apps/packages lines were found in the LCOV report");

const lines = percentage(linesHit, linesFound);
const functions = percentage(functionsHit, functionsFound);
const branches = percentage(branchesHit, branchesFound);
console.log(JSON.stringify({
  core: {
    lines: { hit: linesHit, found: linesFound, percent: lines },
    functions: { hit: functionsHit, found: functionsFound, percent: functions },
    branches: { hit: branchesHit, found: branchesFound, percent: branches },
  },
  minimumLinePercent: minimum,
}));
if (lines < minimum) {
  console.error(`Core line coverage ${lines.toFixed(2)}% is below ${minimum.toFixed(2)}%`);
  Deno.exit(1);
}

function isCore(source: string): boolean {
  return (source.includes("/apps/") || source.includes("/packages/")) &&
    !source.endsWith("/main.ts");
}

function field(record: string, name: string): number {
  return Number(record.match(new RegExp(`^${name}:(\\d+)$`, "m"))?.[1] ?? 0);
}

function percentage(hit: number, found: number): number {
  return found === 0 ? 100 : hit / found * 100;
}
