// Friday: Gnani Evon is the planner model. When EVON_BASE_URL is set, the
// EVON_* values replace OpenDots' OPENAI_* model settings as a set, so an
// Evon key is never sent to another provider's URL.
export function fridayModelFromEnv(env: Record<string, string | undefined>) {
  const value = (name: string) => env[name]?.trim() || undefined;
  const evonUrl = value('EVON_BASE_URL');
  if (evonUrl)
    return {
      apiKey: value('EVON_API_KEY'),
      model: value('EVON_MODEL'),
      baseUrl: evonUrl,
    };
  return {
    apiKey: value('OPENAI_API_KEY'),
    model: value('OPENAI_MODEL'),
    baseUrl: value('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
  };
}
