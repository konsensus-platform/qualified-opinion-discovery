import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const excluded = new Set([
  ".git",
  "node_modules",
  ".data",
  "artifacts",
  "coverage",
  "dist",
]);

export function publicationFiles(root = process.cwd()): string[] {
  const files: string[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (lstatSync(path).isSymbolicLink())
        throw new Error(
          "Unexpected symlink in publication tree: " + relative(root, path),
        );
      if (entry.isDirectory()) visit(path);
      else files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  visit(root);
  return files.sort();
}

export function fileManifest() {
  return publicationFiles().map((path) => {
    const content = readFileSync(path);
    return {
      path,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
}
