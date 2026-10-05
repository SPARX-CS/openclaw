// patch 前後の結果の比較。node compare.mjs <before.json> <after.json>  → 型ごとの pass/total の前後と、状態が変わった試験
import { readFileSync } from "node:fs";
const [b, a] = process.argv.slice(2);
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
const B = load(b),
  A = load(a);
const typeOf = (n) => (n.match(/\bF(\d)\b/) ?? n.match(/\bF(\d)\./))?.[1] ?? "?";
const rows = {};
for (const n of new Set([...B.keys(), ...A.keys()])) {
  const k = typeOf(n);
  rows[k] ??= { bp: 0, bt: 0, ap: 0, at: 0 };
  if (B.has(n)) {
    rows[k].bt++;
    if (B.get(n) === "PASS") rows[k].bp++;
  }
  if (A.has(n)) {
    rows[k].at++;
    if (A.get(n) === "PASS") rows[k].ap++;
  }
}
console.log("| 型 | 前 pass/total | 後 pass/total |\n|---|---|---|");
for (const k of Object.keys(rows).sort())
  console.log(`| F${k} | ${rows[k].bp}/${rows[k].bt} | ${rows[k].ap}/${rows[k].at} |`);
const tp = (m) => [...m.values()].filter((v) => v === "PASS").length;
console.log(`| 合計 | ${tp(B)}/${B.size} | ${tp(A)}/${A.size} |\n`);
const changed = [],
  regress = [],
  gone = [];
for (const [n, s] of A) {
  const o = B.get(n);
  if (o === undefined) continue;
  if (o !== s) (o === "PASS" ? regress : changed).push(`${o}->${s}  ${n}`);
}
for (const n of B.keys()) if (!A.has(n)) gone.push(n);
console.log("## 悪化（PASS→FAIL）:", regress.length);
regress.forEach((x) => console.log("  " + x));
console.log("## 改善（FAIL→PASS）:", changed.length);
changed.forEach((x) => console.log("  " + x.slice(0, 220)));
console.log("## 後に無い試験（名前が変わった/消えた）:", gone.length);
gone.forEach((x) => console.log("  " + x.slice(0, 200)));
console.log("## 後で新しい試験:", [...A.keys()].filter((n) => !B.has(n)).length);
