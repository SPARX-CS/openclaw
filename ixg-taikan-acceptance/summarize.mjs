// vitest の JSON 結果を、試験名ごとの通/不通の一覧にする。
import { readFileSync } from "node:fs";
const [file, label] = process.argv.slice(2);
const data = JSON.parse(readFileSync(file, "utf8"));
const rows = [];
for (const f of data.testResults) {
  if (f.status === "failed" && f.assertionResults.length === 0) {
    rows.push({
      name: `(file) ${f.name.split("/").pop()}`,
      status: "ERROR",
      msg: (f.message ?? "").split("\n")[0],
    });
  }
  for (const t of f.assertionResults) {
    rows.push({
      name: t.fullName,
      status:
        t.status === "passed" ? "PASS" : t.status === "failed" ? "FAIL" : t.status.toUpperCase(),
      msg: (t.failureMessages?.[0] ?? "").split("\n")[0],
    });
  }
}
rows.sort((a, b) => a.name.localeCompare(b.name));
for (const r of rows)
  console.log(
    `${label} ${r.status.padEnd(5)} ${r.name}${r.status === "PASS" ? "" : "  <- " + r.msg.slice(0, 140)}`,
  );
const pass = rows.filter((r) => r.status === "PASS").length;
console.log(`${label} total=${rows.length} pass=${pass} fail=${rows.length - pass}`);
