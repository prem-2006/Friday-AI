import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotChatToolCallsView: () => null,
  useAgent: () => ({ agent: { messages: [] }, isReady: false }),
  useCopilotKit: () => ({ copilotkit: {} }),
  useHumanInTheLoop: () => {},
}));
vi.mock('../../src/client/api', () => ({ api: vi.fn() }));
vi.mock('../../src/client/ConnectionActionCard', () => ({
  ConnectionActionCard: () => null,
}));
import { FridayStage } from '../../src/friday/client/stage/FridayStage';
import type { WorkspaceState } from '../../src/shared/types';

const workspace = (dots: string[], missing: string[]) =>
  ({
    spaces: [],
    dots: dots.map((name, index) => ({ id: `d${index}`, name })),
    conversations: [],
    setup: { missing },
    calls: [],
  }) as unknown as WorkspaceState;

const render = (state?: WorkspaceState, configured = false) =>
  renderToStaticMarkup(
    <FridayStage workspace={state} configured={configured} onExit={() => {}} />,
  );

it('shows the stage with clear next steps before setup is done', () => {
  const noFriday = render(workspace(['Dot'], []), true);
  expect(noFriday).toContain('Almost ready');
  expect(noFriday).toContain('setup-friday-dot.mjs');

  const noKeys = render(
    workspace(['Friday', 'Navigator', 'Operator'], ['OPENAI_API_KEY']),
  );
  expect(noKeys).toContain('Add to .env, then restart: OPENAI_API_KEY.');
  expect(noKeys).toContain('Your AI Voice Assistant');
  expect(noKeys).toContain('aria-label="Open Friday&#x27;s main page"');
});
