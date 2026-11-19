export const numberLiteral = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseNumericLiteral(value: unknown) {
  if (typeof value !== 'string' || !numberLiteral.test(value)) return value;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

export function normalizeNumericField(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const fields = value as Record<string, unknown>;
  const normalized = parseNumericLiteral(fields[field]);
  return normalized === fields[field] ? value : { ...fields, [field]: normalized };
}
