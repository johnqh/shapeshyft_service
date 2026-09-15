/**
 * @fileoverview Environment reader with `.env.local` priority
 * @description The API shells read their configuration through this and pass
 * values into the service factories. The shell supplies the environment
 * itself, so this package still never reads `process.env`. `.env.local` is
 * parsed once per reader and wins over that environment, which wins over a
 * default.
 */

import { readFileSync } from "fs";
import { join } from "path";

export interface EnvReader {
  /** The value, or `defaultValue` when unset or empty. */
  get(key: string, defaultValue?: string): string | undefined;
  /** The value; throws when unset or empty. */
  getRequired(key: string): string;
  /** The value as a number, or undefined when unset. */
  getNumber(key: string): number | undefined;
}

/** Parse `KEY=value` lines, skipping blanks and comments, unquoting values. */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    values[key] = value.replace(/^["']|["']$/g, "");
  }
  return values;
}

/**
 * Create an environment reader.
 *
 * @param options.processEnv - The environment to fall back on; the shell passes
 *   `process.env`.
 * @param options.envFile - Path of the override file. Default: `.env.local` in
 *   the working directory. A missing file is not an error.
 */
export function createEnvReader(options: {
  processEnv: Record<string, string | undefined>;
  envFile?: string;
}): EnvReader {
  let fileValues: Record<string, string> | null = null;
  const fromFile = () => {
    if (fileValues === null) {
      try {
        fileValues = parseEnvFile(
          readFileSync(
            options.envFile ?? join(process.cwd(), ".env.local"),
            "utf8"
          )
        );
      } catch {
        fileValues = {};
      }
    }
    return fileValues;
  };
  const processEnv = options.processEnv;

  const get = (key: string, defaultValue?: string) => {
    const local = fromFile()[key];
    if (local !== undefined && local !== "") return local;
    const inherited = processEnv[key];
    if (inherited !== undefined && inherited !== "") return inherited;
    return defaultValue;
  };

  return {
    get,
    getRequired(key) {
      const value = get(key);
      if (value === undefined || value === "") {
        throw new Error(`Required environment variable ${key} is not set`);
      }
      return value;
    },
    getNumber(key) {
      const value = get(key);
      return value ? Number(value) : undefined;
    },
  };
}
