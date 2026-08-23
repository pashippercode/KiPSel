const BUILTIN_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  luna: "111/gpt-5.6-luna",
  "gpt-5.6-luna": "111/gpt-5.6-luna",
  "111/luna": "111/gpt-5.6-luna",
  "lavenda/luna": "111/gpt-5.6-luna",
});

export function resolveModelAlias(input: string | undefined, extraAliases?: Readonly<Record<string, string>>): string | undefined {
  const value = input?.trim();
  if (!value) return undefined;
  const aliases = extraAliases ? { ...BUILTIN_MODEL_ALIASES, ...extraAliases } : BUILTIN_MODEL_ALIASES;
  return aliases[value.toLowerCase()] ?? value;
}

export function modelAliasTable(): Readonly<Record<string, string>> {
  return BUILTIN_MODEL_ALIASES;
}
