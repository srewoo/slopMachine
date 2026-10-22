/** One model call: a system prompt, a user prompt, and optionally a JSON Schema the answer must follow. */
export interface Task {
  readonly system: string;
  readonly user: string;
  readonly json?: Readonly<Record<string, unknown>>;
}
