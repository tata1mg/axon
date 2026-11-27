export interface ProcessLogger {
  readonly logFile: string;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  install(): void;
  flush(): void;
  dispose(): void;
}

export function createProcessLogger(
  home: string,
  options?: { readonly redact?: (message: string) => string },
): ProcessLogger;