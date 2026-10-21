/** Environment-only fallback for DeepSeek balance lookup. Saved credentials live in AI settings. */
export function deepseekApiKey(): string | undefined {
  return process.env.DSH_PET_STANDALONE_DEEPSEEK_API_KEY?.trim() || undefined;
}

/** Only the app-specific variable may bootstrap AI settings before a settings file exists. */
export function standaloneAiEnvironmentApiKey(): string | undefined {
  return process.env.DSH_PET_STANDALONE_DEEPSEEK_API_KEY?.trim() || undefined;
}
