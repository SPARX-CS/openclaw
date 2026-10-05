// patch 前後（A_before/A_after/B_before/B_after.json）から、試験ごとの前後の表（Markdown）を作る。
//   node before-after-table.mjs out/A_before.json out/A_after.json out/B_before.json out/B_after.json
import { readFileSync } from "node:fs";
const [ab, aa, bb, ba] = process.argv.slice(2);
const load = (f) => {
  const m = new Map();
  for (const r of JSON.parse(readFileSync(f, "utf8")).testResults)
    for (const t of r.assertionResults)
      m.set(
        t.fullName,
        t.status === "passed" ? "PASS" : t.status === "failed" ? "FAIL" : t.status.toUpperCase(),
      );
  return m;
};
const [AB, AA, BB, BA] = [ab, aa, bb, ba].map(load);
const names = [...new Set([...AB.keys(), ...AA.keys(), ...BB.keys(), ...BA.keys()])].sort((x, y) =>
  x.localeCompare(y, undefined, { numeric: true }),
);
console.log("| 試験 | A 前 | A 後 | B 前 | B 後 |\n|---|---|---|---|---|");
for (const n of names) {
  if (/^F7[ .]/.test(n)) continue; // F7（参照実装の試験）は前後で同じ。件数は PATCHES.md
  const row = [AB, AA, BB, BA].map((m) => m.get(n) ?? "-");
  const mark = row[0] !== row[1] || row[2] !== row[3] ? " **" : "";
  console.log(
    `| ${n.replace(/\|/g, "\\|").slice(0, 230)}${mark ? "（変化）" : ""} | ${row.join(" | ")} |`,
  );
}
