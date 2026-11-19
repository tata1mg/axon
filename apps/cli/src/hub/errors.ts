/** Safe, user-facing errors only. Never include configuration values or filesystem errors. */
export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HubError";
  }
}
