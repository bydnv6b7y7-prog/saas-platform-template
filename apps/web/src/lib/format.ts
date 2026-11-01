const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

type DateValue = string | number | Date;

/**
 * Bun and Chromium use different punctuation for the same en-US Intl date/time
 * options ("at" vs a comma). Build the small UTC surface explicitly so SSR and
 * hydration always emit identical text.
 */
export function formatUtcDate(
  value: DateValue,
  options: { year?: boolean } = {},
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  const base = `${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return options.year === false ? base : `${base}, ${date.getUTCFullYear()}`;
}

export function formatUtcDateTime(value: DateValue): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${formatUtcDate(date)}, ${hours}:${minutes} UTC`;
}

const EN_US_NUMBER = new Intl.NumberFormat("en-US");

export function formatEnUsNumber(value: number): string {
  return EN_US_NUMBER.format(value);
}
