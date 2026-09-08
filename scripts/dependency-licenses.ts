import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const packages = new Map<
  string,
  { name: string; version: string; license: unknown }
>();
function inspect(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === ".bin") continue;
    if (entry.name.startsWith("@") || entry.name === ".bun") {
      inspect(path);
      continue;
    }
    const metadata = join(path, "package.json");
    if (existsSync(metadata)) {
      const pkg = JSON.parse(readFileSync(metadata, "utf8"));
      if (!pkg.name.startsWith("@discovery/")) {
        packages.set(pkg.name + "@" + pkg.version, {
          name: pkg.name,
          version: pkg.version,
          license: pkg.license ?? pkg.licenses ?? "UNKNOWN",
        });
      }
    }
    const nested = join(path, "node_modules");
    if (existsSync(nested)) inspect(nested);
  }
}
inspect("node_modules");
const rows = [...packages.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
if (rows.some((row) => row.license === "UNKNOWN"))
  throw new Error("A dependency has no declared license; review the inventory");
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/dependency-licenses.json",
  JSON.stringify(rows, null, 2) + "\n",
);
console.log(
  "Wrote declared-license inventory for " +
    rows.length +
    " installed packages. Review actual licenses when redistributing dependencies.",
);
