export class ChangeForgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly suggestion?: string
  ) {
    super(message);
    this.name = "ChangeForgeError";
  }
}

export function messageFor(error: unknown) {
  if (error instanceof ChangeForgeError && error.suggestion) {
    return `${error.message}\n\n${error.suggestion}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
