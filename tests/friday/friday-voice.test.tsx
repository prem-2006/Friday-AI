import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FridayVoice } from '../../src/friday/client/FridayVoice';
import { FRIDAY_LANGUAGES } from '../../src/friday/shared/voices';

it('shows push-to-talk, a language picker and read-aloud in the composer', () => {
  const html = renderToStaticMarkup(
    <FridayVoice
      disabled={false}
      onTranscript={async () => {}}
      lastReply={() => ''}
    />,
  );
  expect(html).toContain('aria-label="Talk to Friday"');
  expect(html).toContain('aria-label="Voice language"');
  expect(html).toContain('aria-label="Read the last reply aloud"');
  for (const language of FRIDAY_LANGUAGES)
    expect(html).toContain(`value="${language.code}"`);
  // Until the server confirms GNANI_API_KEY, the mic stays disabled.
  expect(html).toMatch(/aria-label="Talk to Friday"[^>]*disabled/);
});
