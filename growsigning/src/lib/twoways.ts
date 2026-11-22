// A number answer that reads two ways ("1.200" is 1200 in Germany and 1.2 in England), refused at Finish when the
// sender's rule would go one way or the other on it (assertClearRuleAnswers in src/server/routing.ts). The words the
// signer reads: about their answer only, short, and with the two plain ways to type it. Shared by the server and the
// signing page, which shows them under the field itself.

/** The refusal, said under the field: '"1.200" in Amount could mean 1200 or 1.2. Type the one you mean: 1200 or 1.2.' */
export function twoWaysWords(value: string, field: string, big: number, small: number): string {
  return `"${value}" in ${field} could mean ${big} or ${small}. Type the one you mean: ${big} or ${small}. Nothing was signed yet.`;
}

/** What the signing page shows under the field, while the answer is still the one that was refused. */
export const twoWaysUnderField = (msg: string) => String(msg || '').replace(/\s*Nothing was signed yet\.\s*$/, '');
