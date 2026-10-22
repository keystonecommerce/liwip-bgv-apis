// Rewrites the generated roles and permissions section of docs/AUTH.md from the code.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { withRolesReference } from "../apps/verification-api/src/modules/admin-access/roles-reference";

const path = resolve(process.cwd(), "docs/AUTH.md");
writeFileSync(path, withRolesReference(readFileSync(path, "utf8")));
console.log("docs/AUTH.md: roles and permissions updated");
