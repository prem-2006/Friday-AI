// Friday: the people Friday may phone for the owner, kept on this PC
// (data/friday-contacts.json) and edited on Friday's main page. The Friday Dot
// sees them in its instructions, so "call Rahul" finds Rahul's number.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { FRIDAY_DOT_NAME } from './delegate.js';

export const contactSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    // Digits with an optional leading +, spaces and dashes allowed.
    phone: z
      .string()
      .trim()
      .regex(/^\+?[\d\s-]{7,20}$/, 'A phone number has 7 to 15 digits.'),
    note: z.string().trim().max(120).optional(),
  })
  .strict();
export type Contact = z.infer<typeof contactSchema>;
const contactsSchema = z.array(contactSchema).max(200);

export const contactsPath = (env: Record<string, string | undefined>) =>
  env.FRIDAY_CONTACTS_PATH?.trim() || 'data/friday-contacts.json';

/** A 10-digit Indian number gets +91; anything else keeps its own code. */
export function internationalPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

export function readContacts(path = contactsPath(process.env)): Contact[] {
  try {
    const parsed = contactsSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function writeContacts(
  contacts: Contact[],
  path = contactsPath(process.env),
) {
  const clean = contacts.map((contact) => ({
    ...contact,
    phone: internationalPhone(contact.phone),
  }));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(clean, null, 2));
  return clean;
}

/** The contacts for the Friday Dot's instructions; empty for others. */
export function contactsPrompt(
  dotName: string,
  contacts: Contact[] = readContacts(),
) {
  if (dotName !== FRIDAY_DOT_NAME || !contacts.length) return '';
  const lines = contacts.map(
    (contact) =>
      `${contact.name}: ${contact.phone}${contact.note ? ` (${contact.note})` : ''}`,
  );
  return ` The owner's contacts (use these numbers when the owner asks to call someone by name; private, share with no one): ${lines.join('; ')}.`;
}

export function fridayContactsRoutes(path?: string) {
  const app = new Hono();
  app.get('/friday/contacts', (c) => c.json(readContacts(path)));
  app.put('/friday/contacts', async (c) => {
    const input = contactsSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      return c.json(
        {
          error:
            input.error.issues[0]?.message ?? 'Check the names and numbers.',
        },
        400,
      );
    return c.json(writeContacts(input.data, path));
  });
  return app;
}
