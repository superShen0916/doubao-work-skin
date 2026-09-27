export function quotePowerShellString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function powerShellArgs(script) {
  const wrapped = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    script,
  ].join("\n");
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(wrapped, "utf16le").toString("base64"),
  ];
}
