import { runAgent as runImplementation, type HarnessOptions } from '../../packages/agent/harness';
import type { z } from 'zod';
import type { requestPlanSchema } from '../../packages/agent/request-plan';
import type { CreativePolicy } from '../../packages/agent/creative-state';

type IntentFixture = { action: 'start' | 'amend'; policy: CreativePolicy } | { action: 'resume' };

type PlanFixture = z.input<typeof requestPlanSchema>;
type Options = HarnessOptions & { plan?: PlanFixture };

export function runHarness(options: Options) {
  return runAgentWithPlan(options);
}

function runAgentWithPlan(options: Options) {
  if (options.plan === undefined) return runImplementation(options);
  return runImplementation({
    ...options,
    client: (request, signal) =>
      request.purpose === 'request_plan'
        ? Promise.resolve({
            text: JSON.stringify(options.plan),
            calls: [],
            raw: {},
            finish: 'complete',
          })
        : options.client(request, signal),
  });
}

export function runAgent(options: Options & { intent?: IntentFixture; useRealPlan?: boolean }) {
  const intent = options.intent ?? {
    action: 'start',
    policy: {
      mode: 'execute',
      target: { stage: 'outline' },
      generateReference: Boolean(options.media?.generateReference),
      importAssets: Boolean(options.media?.importAssets),
    },
  };
  const defaultPlan: PlanFixture =
    intent.action === 'start'
      ? {
          kind: intent.policy.mode === 'discuss' ? 'read' : 'execute',
          canConfirm: intent.policy.canConfirm,
          saveDiscussion: intent.policy.saveDiscussion,
        }
      : { kind: intent.action };
  return runAgentWithPlan({
    ...options,
    plan: options.useRealPlan ? undefined : (options.plan ?? defaultPlan),
    client: (request, signal) => {
      if (
        request.tools.some((tool) => tool.name === 'set_task_scope') &&
        !request.exchanges.length
      ) {
        return Promise.resolve({
          text: '',
          raw: {},
          finish: 'complete',
          calls: [
            { id: 'fixture-scope', name: 'set_task_scope', arguments: JSON.stringify(intent) },
          ],
        });
      }
      return options.client(
        {
          ...request,
          exchanges: request.exchanges.filter(
            (exchange) => exchange.frame.calls[0]?.name !== 'set_task_scope',
          ),
        },
        signal,
      );
    },
  });
}
