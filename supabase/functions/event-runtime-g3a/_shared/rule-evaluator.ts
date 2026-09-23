export type RuleOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in" | "exists";

export interface RuntimeCondition {
  id: string;
  position: number;
  path: string;
  operator: RuleOperator;
  value: unknown;
}

export interface RuntimeAction {
  id: string;
  position: number;
  action_type: string;
  params: Record<string, unknown>;
  timeout_ms: number;
  max_attempts: number;
  retry_backoff_seconds: number;
}

export interface RuntimeRule {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match_mode: "all" | "any";
  conditions: RuntimeCondition[];
  actions: RuntimeAction[];
}

function getByPath(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object"
      && Object.prototype.hasOwnProperty.call(value, key)) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, input);
}

function compare(actual: unknown, condition: RuntimeCondition): boolean {
  const expected = condition.value;
  switch (condition.operator) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt": return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "contains": return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "in": return Array.isArray(expected) && expected.includes(actual);
    case "exists": return actual !== undefined && actual !== null;
  }
}

export function ruleMatches(event: unknown, rule: RuntimeRule): boolean {
  if (!rule.enabled) return false;
  const checks = rule.conditions.map((condition) => compare(getByPath(event, condition.path), condition));
  return rule.match_mode === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

export function matchingRules(event: unknown, rules: RuntimeRule[]): RuntimeRule[] {
  return rules.filter((rule) => ruleMatches(event, rule)).sort((a, b) => b.priority - a.priority);
}

