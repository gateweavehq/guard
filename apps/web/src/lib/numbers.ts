const number = new Intl.NumberFormat();

/** "1,234" or "1.234", as the reader's language writes it. */
export function formatNumber(value: number): string {
	return number.format(value);
}
