import { readFileSync } from "node:fs";
import { publicationFiles } from "./publication-files";

const files = publicationFiles();
const failures: string[] = [];
for (const required of [
  "LICENSE",
  "LICENSE-DATA.md",
  "NOTICE.md",
  "PUBLICATION-PROVENANCE.json",
  "README.md",
  "bun.lock",
]) {
  if (!files.includes(required))
    failures.push("Missing publication file: " + required);
}
if (!readFileSync("LICENSE", "utf8").includes("Version 2.0, January 2004"))
  failures.push("Apache license file was not found");
const runtimeRoots = ["packages/", "apps/", "examples/", "fixtures/", "tests/"];
const legacy =
  /HUKUKCA_|@konsensus\/(?:db|config|domain|instance-hukukca)|hukuk[cç]a|hukuka_|city_baro|barolar_birligi/iu;
const privateKey = new RegExp(
  "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE" + " KEY-----",
);
const token = new RegExp(
  "\\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AIza[0-9A-Za-z_-]{30,})\\b",
);
for (const path of files) {
  if (
    /(^|\/)(\.env(?:\..*)?|proxy\.env)$|\.(?:sqlite(?:-.*)?|pem|key|p12|dump|zip)$/i.test(
      path,
    )
  ) {
    failures.push(
      "Runtime data, credential or archive file in publication tree: " + path,
    );
  }
  const text = readFileSync(path, "utf8");
  if (
    runtimeRoots.some((prefix) => path.startsWith(prefix)) &&
    legacy.test(text)
  ) {
    failures.push(
      "Instance-specific upstream marker in reusable source: " + path,
    );
  }
  if (privateKey.test(text) || token.test(text))
    failures.push("Possible credential in: " + path);
}
const provenance = JSON.parse(
  readFileSync("PUBLICATION-PROVENANCE.json", "utf8"),
);
if (!/^[a-f0-9]{40}$/.test(provenance.upstream.commit))
  failures.push("Invalid upstream revision");
if (
  !Array.isArray(provenance.files) ||
  provenance.files.some(
    (entry: { sourceSha256: string }) =>
      !/^[a-f0-9]{64}$/.test(entry.sourceSha256),
  )
) {
  failures.push("Invalid upstream file hashes");
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Publication boundary passed for " +
      files.length +
      " files (supplement with a release secret scan).",
  );
}
