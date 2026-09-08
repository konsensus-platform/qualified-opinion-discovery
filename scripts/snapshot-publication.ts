import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileManifest } from "./publication-files";

const files = fileManifest();
const result = {
  schema: "opinion-discovery-source-manifest-v1",
  files,
  fileListSha256: createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex"),
};
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/source-manifest.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  "Wrote artifacts/source-manifest.json for " + files.length + " files",
);
