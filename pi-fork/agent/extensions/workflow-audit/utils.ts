/** Conservative, canonical read-only shell classification for workflow-audit. */

export interface CanonicalShellCommand {
  id: string;
  executable: string;
  argv: string[];
}

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

type Quote = "'" | '"' | null;

function hasSafeShellSyntax(input: string): boolean {
  let quote: Quote = null;

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
  let quote: Quote = null;
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

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let inWord = false;
  let quote: Quote = null;

  const pushToken = () => {
    if (!inWord) return;
    tokens.push(token);
    token = "";
    inWord = false;
  };

  for (const character of command) {
    if (quote === "'") {
      if (character === "'") quote = null;
      else token += character;
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else token += character;
      inWord = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      inWord = true;
    } else if (/\s/.test(character)) {
      pushToken();
    } else {
      token += character;
      inWord = true;
    }
  }

  if (quote !== null) return null;
  pushToken();
  return tokens.length > 0 ? tokens : null;
}

function canonicalizeCommand(command: string): CanonicalShellCommand | null {
  const argv = tokenizeCommand(command);
  if (!argv) return null;
  const executable = argv[0];
  if (!/^[\w+.-]+$/.test(executable)) return null;
  const id = executable === "git" ? `git:${argv[1] ?? ""}` : executable;
  return { id, executable, argv };
}

export function canonicalizeReadOnlyShellCommand(input: unknown): CanonicalShellCommand[] | null {
  if (typeof input !== "string" || !input.trim()) return null;
  if (!hasSafeShellSyntax(input)) return null;

  const commands = splitTopLevelCommands(input).map(canonicalizeCommand);
  return commands.length > 0 && commands.every((command): command is CanonicalShellCommand => command !== null)
    ? commands
    : null;
}

function hasOption(argv: string[], predicate: (option: string) => boolean): boolean {
  return argv.slice(1).some((option) => predicate(option));
}

function isCommandAllowed(command: CanonicalShellCommand): boolean {
  const { executable, argv } = command;
  if (executable === "set") return /^-[a-z]+$/i.test(argv[1] ?? "") && argv.length === 2;
  if (executable === "command") return argv.length === 3 && argv[1] === "-v" && /^[\w+.-]+$/.test(argv[2]);

  if (executable === "git") {
    const subcommand = argv[1];
    const allowed = new Set(["cat-file", "describe", "diff", "log", "ls-files", "ls-tree", "name-rev", "rev-parse", "show", "status"]);
    return (
      typeof subcommand === "string" &&
      allowed.has(subcommand) &&
      !hasOption(argv.slice(1), (option) => option === "--ext-diff" || option === "--textconv" || option === "--output" || option.startsWith("--output="))
    );
  }
  if (executable === "find") {
    const forbidden = new Set(["-delete", "-exec", "-execdir", "-fls", "-fprint", "-fprintf", "-ok", "-okdir"]);
    return !hasOption(argv, (option) => forbidden.has(option));
  }
  if (executable === "rg" || executable === "grep") {
    return !hasOption(argv, (option) => option === "--pre" || option.startsWith("--pre=") || option === "--pre-glob" || option.startsWith("--pre-glob="));
  }
  if (executable === "tree") {
    return !hasOption(argv, (option) => option === "--output" || option.startsWith("--output=") || (option.startsWith("-") && !option.startsWith("--") && option.slice(1).includes("o")));
  }
  if (executable === "file") {
    return !hasOption(argv, (option) => option === "--compile" || (option.startsWith("-") && !option.startsWith("--") && option.slice(1).includes("C")));
  }
  if (executable === "date") {
    return !hasOption(argv, (option) => option === "--set" || option.startsWith("--set=") || (option.startsWith("-") && !option.startsWith("--") && option.slice(1).includes("s")));
  }

  return READ_ONLY_COMMANDS.has(executable);
}

export function isReadOnlyShellCommand(input: unknown): boolean {
  const commands = canonicalizeReadOnlyShellCommand(input);
  return commands !== null && commands.every(isCommandAllowed);
}
