import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

export function log(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel("Threadside", { log: true });
  return channel;
}

/** Bearer tokens, tickets and pairing secrets never reach the log. */
export function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
    .replace(/((?:wsTicket|token|ticket|code)=)[^&\s"]+/gi, "$1***")
    .replace(/(#token=)[^&\s"]+/gi, "$1***");
}
