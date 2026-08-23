const SIMPLE_ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const BRACED_ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export function secretEnvName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.match(SIMPLE_ENV_REF)?.[1] ?? trimmed.match(BRACED_ENV_REF)?.[1];
}

export function isSecretReference(value: unknown): value is string {
  return secretEnvName(value) !== undefined;
}

export function resolveSecretReference(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const name = secretEnvName(value);
  if (!name) throw new Error("apiKey must be an external environment reference ($NAME or ${NAME})");
  return env[name] || undefined;
}
