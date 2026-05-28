/**
 * Shared locale-resolution helpers.
 *
 * Matches the pattern used by `query.ts` for content: an explicit locale wins,
 * otherwise we fall back to the request-context locale, otherwise to
 * `defaultLocale` when i18n is enabled, otherwise to `undefined` (meaning "do
 * not filter by locale" — legacy single-locale behaviour).
 */

import { getRequestContext } from "../request-context.js";
import { getFallbackChain, getI18nConfig, isI18nEnabled } from "./config.js";

/**
 * Resolve the locale to use for a query given an optional explicit value.
 * Returns `undefined` when no locale information is available; callers should
 * treat that as "do not filter by locale".
 */
export function resolveLocale(explicit?: string): string | undefined {
	if (explicit !== undefined) return explicit;
	const ctxLocale = getRequestContext()?.locale;
	if (ctxLocale !== undefined) return ctxLocale;
	const cfg = getI18nConfig();
	if (cfg && isI18nEnabled()) return cfg.defaultLocale;
	return undefined;
}

/**
 * Fallback chain to try when looking up a single item. When i18n is disabled
 * or the locale is unspecified, returns a single-element array (or empty when
 * no locale resolves) so callers can iterate uniformly.
 */
export function resolveLocaleChain(explicit?: string): string[] {
	const locale = resolveLocale(explicit);
	if (locale === undefined) return [];
	if (!isI18nEnabled()) return [locale];
	return getFallbackChain(locale);
}

const REPEATED_SLASHES = /\/{2,}/g;

/**
 * Interpolate a collection `url_pattern` with a row's slug and id.
 *
 * Falls back to `/{collection}/{slug}` when no pattern is configured.
 * Does NOT apply any locale prefix — pass the result through
 * Astro's `getRelativeLocaleUrl` / `getAbsoluteLocaleUrl` (or the
 * `localizePath` helper below) to add the locale segment.
 */
export function interpolateUrlPattern(options: {
	pattern: string | null;
	collection: string;
	slug: string;
	id: string;
}): string {
	const { pattern, collection, slug, id } = options;
	const basePattern = pattern ?? `/${encodeURIComponent(collection)}/{slug}`;
	let path = basePattern
		.replace("{slug}", encodeURIComponent(slug))
		.replace("{id}", encodeURIComponent(id));
	path = path.replace(REPEATED_SLASHES, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (!path.startsWith("/")) path = `/${path}`;
	return path;
}

/**
 * Apply a locale prefix to a path using Astro's i18n routing helpers
 * when available. Honours the user's `routing` config (`prefixDefaultLocale`,
 * custom `path` mappings, fallbacks).
 *
 * - When i18n is disabled, returns `path` unchanged.
 * - When i18n is enabled, dynamically imports `astro:i18n` and calls
 *   `getRelativeLocaleUrl(locale, path)`. Falls back to a manual prefix
 *   if the import fails (e.g. running outside an Astro context, or the
 *   user has `routing: "manual"` and the helpers are unavailable).
 *
 * Returns a path that always starts with `/` and has no trailing slash
 * (except for the root).
 */
export async function localizePath(path: string, locale: string): Promise<string> {
	const cfg = getI18nConfig();
	if (!cfg || !isI18nEnabled()) return path;

	try {
		// `@vite-ignore` defers resolution so non-i18n builds don't fail
		// at Astro's `i18nNotEnabled` resolver. Typed via `astro/client.d.ts`.
		const { getRelativeLocaleUrl } = await import(/* @vite-ignore */ "astro:i18n");
		return normalizePath(getRelativeLocaleUrl(locale, path));
	} catch {
		// Fall through to manual prefixing below.
	}

	const isDefault = locale === cfg.defaultLocale;
	if (isDefault && !cfg.prefixDefaultLocale) return normalizePath(path);
	return normalizePath(`/${locale}${path}`);
}

function normalizePath(path: string): string {
	let p = path.replace(REPEATED_SLASHES, "/");
	if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	if (!p.startsWith("/")) p = `/${p}`;
	return p;
}
