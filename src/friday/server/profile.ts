// Friday: the owner's details, kept on this PC (data/friday-profile.json) and
// edited on Friday's main page. Only the Friday Dot sees them, marked private,
// so it can fill in a form or sign a message without asking every time.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { FRIDAY_DOT_NAME } from './delegate.js';

const LIMITS = {
  name: 80,
  email: 120,
  phone: 30,
  city: 80,
  address: 300,
  notes: 1000,
  // The Google account Friday's Chrome signs in to (its own, or the owner's).
  friday_google: 120,
} as const;
type Field = keyof typeof LIMITS;
export type OwnerProfile = Partial<Record<Field, string>>;

const LABELS: Record<Field, string> = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  city: 'City',
  address: 'Address',
  notes: 'Notes from the owner',
  friday_google: 'Google account Friday uses (Gmail, Calendar, YouTube)',
};

export const profileSchema = z
  .object(
    Object.fromEntries(
      Object.entries(LIMITS).map(([field, max]) => [
        field,
        z.string().trim().max(max).optional(),
      ]),
    ) as Record<Field, z.ZodOptional<z.ZodString>>,
  )
  .strict();

export const profilePath = (env: Record<string, string | undefined>) =>
  env.FRIDAY_PROFILE_PATH?.trim() || 'data/friday-profile.json';

export function readProfile(path = profilePath(process.env)): OwnerProfile {
  try {
    const parsed = profileSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeProfile(
  profile: OwnerProfile,
  path = profilePath(process.env),
) {
  const clean = Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(clean, null, 2));
  return clean as OwnerProfile;
}

/** The owner's details for the Friday Dot's instructions; empty for others. */
export function ownerDetailsPrompt(
  dotName: string,
  profile: OwnerProfile = readProfile(),
) {
  if (dotName !== FRIDAY_DOT_NAME) return '';
  const lines = (Object.keys(LABELS) as Field[])
    .filter((field) => profile[field])
    .map((field) => `${LABELS[field]}: ${profile[field]}`);
  if (!lines.length) return '';
  return ` Owner details (private: use only what a task strictly needs, and ask the owner before sharing them with anyone): ${lines.join('; ')}.`;
}

export function fridayProfileRoutes(path?: string) {
  const app = new Hono();
  app.get('/friday/profile', (c) => c.json(readProfile(path)));
  app.put('/friday/profile', async (c) => {
    const input = profileSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json({ error: 'Some details are too long or unknown.' }, 400);
    return c.json(writeProfile(input.data, path));
  });
  return app;
}
