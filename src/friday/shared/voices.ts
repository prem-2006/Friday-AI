// Friday: languages Friday speaks and the Timbre v2.5 voice for each.
// friday/services/friday_services/voices.py mirrors this list (its tests check).
export interface FridayLanguage {
  code: string;
  name: string;
  voice: string;
}

export const FRIDAY_LANGUAGES: FridayLanguage[] = [
  { code: 'en-IN', name: 'English (handles Hinglish)', voice: 'Kaveri' },
  { code: 'hi-IN', name: 'Hindi', voice: 'Bhavna' },
  { code: 'kn-IN', name: 'Kannada', voice: 'Saanvi' },
  { code: 'ta-IN', name: 'Tamil', voice: 'Trisha' },
  { code: 'te-IN', name: 'Telugu', voice: 'Lavanya' },
  { code: 'ml-IN', name: 'Malayalam', voice: 'Reshma' },
  { code: 'mr-IN', name: 'Marathi', voice: 'Zahira' },
  { code: 'bn-IN', name: 'Bengali', voice: 'Kirra' },
  { code: 'gu-IN', name: 'Gujarati', voice: 'Falak' },
  { code: 'pa-IN', name: 'Punjabi', voice: 'Mehuli' },
];

export const FRIDAY_DEFAULT_LANGUAGE = 'en-IN';

export function fridayLanguage(code: string): FridayLanguage | undefined {
  return FRIDAY_LANGUAGES.find((language) => language.code === code);
}
