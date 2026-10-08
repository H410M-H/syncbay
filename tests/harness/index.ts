/**
 * Syncbay PaaS — E2E Test Harness Core
 * Provides deterministic assertions, test registry, and runner utilities.
 */

import assert from "node:assert";

export interface TestResult {
  id: string;
  name: string;
  tier: number;
  feature: string;
  passed: boolean;
  error?: Error;
  durationMs: number;
}

export interface TestCase {
  id: string;
  name: string;
  tier: number;
  feature: string;
  run: () => Promise<void> | void;
}

export class TestRegistry {
  private tests: TestCase[] = [];

  register(testCase: TestCase): void {
    this.tests.push(testCase);
  }

  getTests(filter?: { tier?: number; feature?: string }): TestCase[] {
    return this.tests.filter((t) => {
      if (filter?.tier && t.tier !== filter.tier) return false;
      if (filter?.feature && t.feature !== filter.feature) return false;
      return true;
    });
  }

  clear(): void {
    this.tests = [];
  }
}

export const registry = new TestRegistry();

export function registerTest(
  id: string,
  feature: string,
  tier: number,
  name: string,
  fn: () => Promise<void> | void
): void {
  registry.register({
    id,
    feature,
    tier,
    name,
    run: fn,
  });
}

// Assertions re-export & custom helpers
export function assertTrue(condition: boolean, message?: string): void {
  assert.strictEqual(condition, true, message || "Expected true but got false");
}

export function assertFalse(condition: boolean, message?: string): void {
  assert.strictEqual(condition, false, message || "Expected false but got true");
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  assert.strictEqual(actual, expected, message);
}

export function assertDeepEqual<T>(actual: T, expected: T, message?: string): void {
  assert.deepStrictEqual(actual, expected, message);
}

export function assertMatch(str: string, regex: RegExp, message?: string): void {
  assert.match(str, regex, message);
}

export function assertIncludes(container: string | any[], item: any, message?: string): void {
  if (typeof container === "string") {
    assert.ok(container.includes(item), message || `Expected string to contain "${item}"`);
  } else if (Array.isArray(container)) {
    assert.ok(container.includes(item), message || `Expected array to contain item`);
  }
}

export async function assertRejects(
  asyncFn: () => Promise<any>,
  expectedErrorRegex?: RegExp | string | Function,
  message?: string
): Promise<void> {
  let threw = false;
  try {
    await asyncFn();
  } catch (err: any) {
    threw = true;
    if (expectedErrorRegex) {
      if (typeof expectedErrorRegex === "function") {
        assert.ok(
          err instanceof (expectedErrorRegex as any) || err.name === (expectedErrorRegex as any).name,
          `Expected error to be instance of ${(expectedErrorRegex as any).name}, got ${err}`
        );
      } else if (typeof expectedErrorRegex === "string") {
        assert.ok(
          err.message?.includes(expectedErrorRegex),
          `Expected error message "${err.message}" to include "${expectedErrorRegex}"`
        );
      } else {
        assert.match(err.message || "", expectedErrorRegex);
      }
    }
  }
  assert.ok(threw, message || "Expected async function to throw an error, but it succeeded");
}

export function assertThrows(
  syncFn: () => any,
  expectedErrorRegex?: RegExp | string,
  message?: string
): void {
  let threw = false;
  try {
    syncFn();
  } catch (err: any) {
    threw = true;
    if (expectedErrorRegex) {
      if (typeof expectedErrorRegex === "string") {
        assert.ok(
          err.message?.includes(expectedErrorRegex),
          `Expected error message "${err.message}" to include "${expectedErrorRegex}"`
        );
      } else {
        assert.match(err.message || "", expectedErrorRegex);
      }
    }
  }
  assert.ok(threw, message || "Expected function to throw an error, but it succeeded");
}

export {
  hybridHarness,
  RunnerDriverError,
  AuthenticationError,
  TimeoutError,
} from "./hybrid-harness";
export type * from "./hybrid-harness";
