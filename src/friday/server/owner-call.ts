// Friday: "call Prem" when Prem is the owner. Models sometimes reach for
// start_call (phone someone else, always asks first) with the owner's own
// number; that is call_me, which rings the owner straight away.
import { readProfile } from './profile.js';

const lastTen = (value: unknown) =>
  String(value ?? '')
    .replace(/\D/g, '')
    .slice(-10);

/** call_me in place of a start_call to the owner's own number, if it is one. */
export function ownerCallInstead(
  tool: string,
  input: Record<string, unknown>,
  ownerPhones: unknown[] = [
    readProfile().phone,
    process.env.FRIDAY_OWNER_PHONE,
  ],
) {
  if (tool !== 'start_call') return undefined;
  const phone = lastTen(input.phone);
  if (phone.length < 10 || !ownerPhones.some((own) => lastTen(own) === phone))
    return undefined;
  const goal = String(input.goal ?? '').trim();
  return {
    tool: 'call_me',
    input: {
      message: goal.length >= 3 ? goal.slice(0, 300) : 'Friday wanted a word.',
    },
  };
}
