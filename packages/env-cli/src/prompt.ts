/**
 * 対話型プロンプトユーティリティ
 */

import * as readline from "node:readline";

export interface Prompt {
  ask: (question: string, defaultValue?: string) => Promise<string>;
  askSecret: (question: string) => Promise<string>;
  close: () => void;
}

export function createPrompt(): Prompt {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    ask(question: string, defaultValue?: string): Promise<string> {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      return new Promise((resolve) => {
        rl.question(`${question}${suffix}: `, (answer) => {
          resolve(answer.trim() || defaultValue || "");
        });
      });
    },

    askSecret(question: string): Promise<string> {
      return new Promise((resolve) => {
        process.stdout.write(`${question}: `);
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        if (stdin.isTTY) {
          stdin.setRawMode(true);
        }
        stdin.resume();

        let secret = "";
        const onData = (char: Buffer): void => {
          const c = char.toString("utf8");
          if (c === "\n" || c === "\r") {
            if (stdin.isTTY) {
              stdin.setRawMode(wasRaw ?? false);
            }
            stdin.removeListener("data", onData);
            process.stdout.write("\n");
            resolve(secret);
          } else if (c === "\u0003") {
            process.exit(1);
          } else if (c === "\u007f" || c === "\b") {
            if (secret.length > 0) {
              secret = secret.slice(0, -1);
              process.stdout.write("\b \b");
            }
          } else {
            secret += c;
            process.stdout.write("*");
          }
        };

        stdin.on("data", onData);
      });
    },

    close(): void {
      rl.close();
    },
  };
}
