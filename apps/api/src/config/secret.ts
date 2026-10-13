import { inspect } from "node:util";

const MASK = "[REDACTED]";

/**
 * Wraps a secret string so that it cannot be leaked by accident. JSON.stringify, template
 * literals, String(), console.log and util.inspect all yield "[REDACTED]". The only way to
 * read the value is the explicit, greppable `reveal()` call.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}
