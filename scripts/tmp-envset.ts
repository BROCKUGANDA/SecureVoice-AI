import { readFileSync, writeFileSync } from "node:fs";

const NEW_URL = 'DATABASE_URL="postgresql://securevoice:securevoice@127.0.0.1:55433/securevoice?schema=public&sslmode=disable"';
const path = ".env";
const lines = readFileSync(path, "utf8").split(/\r?\n/);
const next = lines.map((l) => (l.startsWith("DATABASE_URL=") ? NEW_URL : l));
writeFileSync(path, next.join("\n"));
console.log("done:", next.find((l) => l.startsWith("DATABASE_URL=")));