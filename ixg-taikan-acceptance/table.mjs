// out/A_all.json と out/B_all.json（run.sh の結果）から、試験ごとの A／B の通・不通の表を作る。
//   node table.mjs [A.json B.json]   → 標準出力に Markdown
import { readFileSync } from "node:fs";
const [aFile = "out/A_all.json", bFile = "out/B_all.json"] = process.argv.slice(2);
function load(file) {
  const m = new Map();
  for (const f of JSON.parse(readFileSync(file, "utf8")).testResults) {
    if (f.assertionResults.length === 0) m.set(`(file) ${f.name.split("/").pop()}`, "ERROR");
    for (const t of f.assertionResults)
      m.set(
        t.fullName,
        t.status === "passed" ? "PASS" : t.status === "failed" ? "FAIL" : t.status.toUpperCase(),
      );
  }
  return m;
}
const A = load(aFile),
  B = load(bFile);
const names = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) =>
  (x.match(/F\d+(\.\d+)?[a-z]*/)?.[0] ?? x).localeCompare(
    y.match(/F\d+(\.\d+)?[a-z]*/)?.[0] ?? y,
    undefined,
    { numeric: true },
  ),
);
const byF = new Map();
for (const n of names) {
  const k =
    n
      .match(/\bF(\d)\b|\bF(\d)\./)
      ?.slice(1)
      .find(Boolean) ?? "?";
  (byF.get(k) ?? byF.set(k, []).get(k)).push(n);
}
const sum = (m) => ({ p: [...m.values()].filter((v) => v === "PASS").length, t: m.size });
console.log("| 型 | A pass/total | B pass/total |\n|---|---|---|");
for (const [k, list] of [...byF].sort()) {
  const a = list.filter((n) => A.has(n)).length
    ? { p: list.filter((n) => A.get(n) === "PASS").length, t: list.filter((n) => A.has(n)).length }
    : { p: 0, t: 0 };
  const b = {
    p: list.filter((n) => B.get(n) === "PASS").length,
    t: list.filter((n) => B.has(n)).length,
  };
  console.log(`| F${k} | ${a.p}/${a.t} | ${b.p}/${b.t} |`);
}
console.log(`| 合計 | ${sum(A).p}/${sum(A).t} | ${sum(B).p}/${sum(B).t} |\n`);
console.log("| 試験 | A | B |\n|---|---|---|");
for (const n of names)
  console.log(`| ${n.replace(/\|/g, "\\|")} | ${A.get(n) ?? "-"} | ${B.get(n) ?? "-"} |`);
