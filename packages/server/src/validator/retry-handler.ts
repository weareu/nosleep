import type { ValidationResult, Goal } from "@nosleep/shared";
import { MAX_RETRY_AFTER_VALIDATION_FAIL } from "@nosleep/shared";

interface RetryContext {
  readonly prompt: string;
  readonly retriesRemaining: number;
  readonly shouldRetry: boolean;
}

export class RetryHandler {
  /**
   * Build a retry prompt from a failed validation, giving the session
   * specific instructions about what is incomplete.
   */
  buildRetryPrompt(validationResult: ValidationResult, goal: Goal): RetryContext {
    const retriesRemaining = MAX_RETRY_AFTER_VALIDATION_FAIL;

    if (validationResult.verdict === "complete") {
      return {
        prompt: "",
        retriesRemaining,
        shouldRetry: false,
      };
    }

    const sections: string[] = [];

    sections.push("# VALIDATION FAILED - RETRY REQUIRED");
    sections.push("");
    sections.push(`Verdict: ${validationResult.verdict.toUpperCase()}`);
    sections.push(`Objective: ${goal.objective}`);
    sections.push("");

    // List stub patterns found
    if (validationResult.details.stubPatterns.length > 0) {
      sections.push("## Stub Patterns Detected");
      sections.push("The following stubs/placeholders MUST be replaced with real implementations:");
      for (const stub of validationResult.details.stubPatterns) {
        sections.push(`  - ${stub}`);
      }
      sections.push("");
    }

    // List unmet criteria
    const unmet = validationResult.details.criteriaResults.filter(
      (c) => c.status !== "met",
    );
    if (unmet.length > 0) {
      sections.push("## Incomplete Acceptance Criteria");
      sections.push("These criteria have NOT been met:");
      for (const criterion of unmet) {
        const statusLabel = criterion.status === "partial" ? "PARTIAL" : "NOT MET";
        sections.push(`  - [${statusLabel}] ${criterion.criterion}`);
        if (criterion.notes) {
          sections.push(`    Notes: ${criterion.notes}`);
        }
      }
      sections.push("");
    }

    // Add overall notes
    if (validationResult.details.overallNotes) {
      sections.push(`## Notes`);
      sections.push(validationResult.details.overallNotes);
      sections.push("");
    }

    // Instructions
    sections.push("## Instructions");
    sections.push("1. Fix all stub patterns - replace with real implementations");
    sections.push("2. Address each incomplete criterion listed above");
    sections.push("3. Do NOT add new features outside the stated goal");
    sections.push("4. Call goal_progress to report completion of each criterion");
    sections.push(`5. You have ${retriesRemaining} retry attempt(s) remaining`);

    return {
      prompt: sections.join("\n"),
      retriesRemaining,
      shouldRetry: true,
    };
  }

  /**
   * Determine if more retries are allowed given past attempt count.
   */
  canRetry(attemptCount: number): boolean {
    return attemptCount < MAX_RETRY_AFTER_VALIDATION_FAIL;
  }
}
