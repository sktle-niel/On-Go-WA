/**
 * A node:test reporter that turns every failed test into a GitHub Actions
 * annotation (`::error file=…,line=…::…`), so the failure is visible on the
 * run page and through the public Checks API even when the job log is not.
 * Used by `npm run test:ci` next to the normal spec reporter.
 */
export default async function* annotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const { name, file, line, details } = event.data;
    const error = details?.error;
    const cause = error?.cause instanceof Error ? error.cause : error;
    const message = String(cause?.message ?? cause ?? 'failed')
      .replace(/\r?\n/g, ' ')
      .replace(/%/g, '%25')
      .slice(0, 1000);
    yield `::error file=${file ?? ''},line=${line ?? 1},title=${name.replace(/,/g, ';')}::${message}\n`;
  }
}
