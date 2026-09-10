/** Conservative read-only shell classification for workflow-audit. */

const READ_ONLY_COMMANDS = new Set([
  "basename",
  "cat",
  "cmp",
  "cut",
  "date",
  "df",
  "diff",
  "dirname",
  "du",
  "echo",
  "file",
  "grep",
  "head",
  "id",
  "jq",
  "ls",
  "md5sum",
  "pwd",
  "printf",
  "readlink",
  "realpath",
  "rg",
  "sha256sum",
  "sort",
  "stat",
  "tail",
  "tree",
  "tr",
  "uname",
  "uniq",
  "wc",
  "whoami",
]);

function hasSafeShellSyntax(input: string): boolean {
  let quote: "'" | '"' | null = null;

  for (const character of input) {
    if (character === "\r" || character === "\n") return false;

    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "$" || character === "`" || character === "\\") return false;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "<" || character === ">" || character === "&" || character === "`" || character === "$" || character === "\\") {
      return false;
    }
  }

  return quote === null;
}

function splitTopLevelCommands(input: string): string[] {
  const commands: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== ";" && character !== "|") continue;

    commands.push(input.slice(start, index).trim());
    if (character === "|" && input[index + 1] === "|") index += 1;
    start = index + 1;
  }
  commands.push(input.slice(start).trim());
  return commands.filter(Boolean);
}

function isCommandAllowed(command: string): boolean {
  if (/^set\s+-[a-z]+$/i.test(command)) return true;
  if (/^command\s+-v\s+[\w+-]+$/i.test(command)) return true;

  const match = command.match(/^([\w+.-]+)/);
  if (!match) return false;
  const executable = match[1];

  if (executable === "git") {
    return (
      /^git\s+(?:cat-file|describe|diff|log|ls-files|ls-tree|name-rev|rev-parse|show|status)(?:\s|$)/i.test(command) &&
      !/\s(?:--output(?:=|\s)|--ext-diff\b|--textconv\b)/i.test(command)
    );
  }
  if (executable === "find") {
    return !/\s-(?:delete|exec|execdir|fls|fprint|fprintf|ok|okdir)(?:\s|$)/i.test(command);
  }
  if ((executable === "rg" || executable === "grep") && /\s--(?:pre|pre-glob)(?:[=\s]|$)/i.test(command)) return false;
  if (executable === "tree" && /\s(?:-[^\s]*o[^\s]*|--output(?:\s|=|$))/i.test(command)) return false;
  if (executable === "file" && /\s(?:-[^\s]*C[^\s]*|--compile)(?:\s|=|$)/i.test(command)) return false;
  if (executable === "date" && /\s(?:-[^\s]*s[^\s]*|--set)(?:\s|=|$)/i.test(command)) return false;

  return READ_ONLY_COMMANDS.has(executable);
}

export function isReadOnlyShellCommand(input: unknown): boolean {
  if (typeof input !== "string" || !input.trim()) return false;
  if (!hasSafeShellSyntax(input)) return false;
  const commands = splitTopLevelCommands(input);
  return commands.length > 0 && commands.every(isCommandAllowed);
}
