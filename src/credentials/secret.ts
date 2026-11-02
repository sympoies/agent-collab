// Wrapper that keeps a credential out of logs, errors and serialized state
// (docs/design.md, section 6). Only the HTTP layer calls reveal().

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "Secret([redacted])";
  }
}
