#!/usr/bin/env node
/**
 * `changeover` — the command.
 *
 * There is no command registry in this file and there will not be one. The
 * registry IS the filesystem: `changeover <name>` imports `./commands/<name>.ts`
 * and `changeover --help` lists that directory. Adding a command is adding a
 * file; nobody edits a table, and twenty-five agents adding rows to one array
 * is a merge conflict with a countdown on it.
 *
 * A command module exports ONE of:
 *
 *   export async function run(argv: string[]): Promise<number | void>
 *   export async function main(argv: string[]): Promise<number | void>
 *   export default async function (argv: string[]): Promise<number | void>
 *
 * Return an exit code, or nothing for 0. The house meaning of the three codes
 * is the same here as in the proof scripts: 0 it holds, 1 it fails, 2 the thing
 * under test could not be reached — a missing file, an unreadable corpus, a
 * command that does not exist.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

function commandsDir(): string {
  return join(import.meta.dirname, "commands");
}

function available(): string[] {
  try {
    return readdirSync(commandsDir())
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => entry.slice(0, -3))
      .filter((name) => COMMAND_NAME.test(name))
      .sort();
  } catch {
    return [];
  }
}

function usage(): string {
  const names = available();
  const lines = [
    "changeover — an open commitment boundary for cinema exhibition",
    "",
    "usage: changeover <command> [options]",
    "",
    "commands:",
    ...(names.length > 0 ? names.map((name) => `  ${name}`) : ["  (none installed)"]),
    "",
    "exit codes: 0 it holds  ·  1 it fails  ·  2 could not be reached",
  ];
  return lines.join("\n");
}

async function dispatch(argv: string[]): Promise<number> {
  const name = argv[0];
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    console.log(usage());
    return name === undefined ? 2 : 0;
  }
  if (!COMMAND_NAME.test(name)) {
    console.error(`changeover: "${name}" is not a command name`);
    console.error(usage());
    return 2;
  }
  if (!available().includes(name)) {
    console.error(`changeover: no such command: ${name}`);
    console.error(usage());
    return 2;
  }

  const loaded: Record<string, unknown> = await import(`./commands/${name}.ts`);
  const entry = loaded.run ?? loaded.main ?? loaded.default;
  if (typeof entry !== "function") {
    console.error(`changeover: ${name} exports no run(), main() or default function`);
    return 2;
  }
  const result: unknown = await (entry as (args: string[]) => unknown)(argv.slice(1));
  return typeof result === "number" ? result : 0;
}

try {
  process.exitCode = await dispatch(process.argv.slice(2));
} catch (err) {
  console.error(`changeover: ${(err as Error).message}`);
  process.exitCode = 2;
}
