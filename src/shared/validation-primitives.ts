export function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('结果应当为 JSON 对象');
  return value as Record<string, unknown>;
}

export function textField(value: unknown, max = 20_000, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()))
    throw new Error('结果文字为空或超出长度限制');
  return value.trim();
}
