export function normalizeWebsiteUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // Accept user input like "www.example.com" by adding https when missing.
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    return parsed.toString();
  } catch {
    return null;
  }
}

