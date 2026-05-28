/**
 * Per-collection sitemap endpoint
 *
 * GET /sitemap-{collection}.xml - Sitemap for a single content collection.
 *
 * Uses the collection's url_pattern to build URLs. Falls back to
 * /{collection}/{slug} when no pattern is configured.
 *
 * i18n behaviour: when Astro i18n is enabled, the locale prefix is
 * applied via Astro's own `getRelativeLocaleUrl` (which honours
 * `prefixDefaultLocale`, custom `path` mappings, and other `routing`
 * config). Each translation row is emitted as its own `<url>` with
 * `<xhtml:link rel="alternate" hreflang="...">` entries pointing to
 * its siblings (grouped by `translation_group`). The default-locale
 * variant is also linked as `hreflang="x-default"`.
 */

import type { APIRoute } from "astro";

import { handleSitemapData } from "#api/handlers/seo.js";
import { getPublicOrigin } from "#api/public-url.js";
import { getSiteSettingsWithDb } from "#settings/index.js";

import { getI18nConfig, isI18nEnabled } from "../../i18n/config.js";
import { interpolateUrlPattern, localizePath } from "../../i18n/resolve.js";

export const prerender = false;

const TRAILING_SLASH_RE = /\/$/;
const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const QUOT_RE = /"/g;
const APOS_RE = /'/g;

export const GET: APIRoute = async ({ params, locals, url }) => {
	const { emdash } = locals;
	const collectionSlug = params.collection;

	if (!emdash?.db || !collectionSlug) {
		return new Response("<!-- EmDash not configured -->", {
			status: 500,
			headers: { "Content-Type": "application/xml" },
		});
	}

	try {
		const settings = await getSiteSettingsWithDb(emdash.db);
		const siteUrl = (settings.url || getPublicOrigin(url, emdash?.config)).replace(
			TRAILING_SLASH_RE,
			"",
		);

		const result = await handleSitemapData(emdash.db, collectionSlug);

		if (!result.success || !result.data) {
			return new Response("<!-- Failed to generate sitemap -->", {
				status: 500,
				headers: { "Content-Type": "application/xml" },
			});
		}

		const col = result.data.collections[0];
		if (!col) {
			return new Response("<!-- Collection not found or empty -->", {
				status: 404,
				headers: { "Content-Type": "application/xml" },
			});
		}

		const i18nEnabled = isI18nEnabled();
		const i18nConfig = getI18nConfig();

		// Group entries by `translation_group` so each <url> can advertise
		// its sibling translations via xhtml:link. Rows without a group
		// (legacy/single-locale data) are emitted individually.
		type Entry = (typeof col.entries)[number];
		const groups = new Map<string, Entry[]>();
		const ungrouped: Entry[] = [];
		for (const entry of col.entries) {
			if (i18nEnabled && entry.translationGroup) {
				const list = groups.get(entry.translationGroup);
				if (list) list.push(entry);
				else groups.set(entry.translationGroup, [entry]);
			} else {
				ungrouped.push(entry);
			}
		}

		// Resolve every URL up-front. `localizePath` may be async (it
		// dynamically imports `astro:i18n` when available); doing this
		// in one pass lets us reference sibling URLs while emitting
		// hreflang alternates without re-resolving.
		const urlByEntry = new Map<string, string>();
		const resolveEntryUrl = async (entry: Entry): Promise<string> => {
			const cached = urlByEntry.get(entry.id);
			if (cached) return cached;
			const path = interpolateUrlPattern({
				pattern: col.urlPattern,
				collection: col.collection,
				slug: entry.slug || entry.id,
				id: entry.id,
			});
			const localized = await localizePath(path, entry.locale);
			const absolute = `${siteUrl}${localized}`;
			urlByEntry.set(entry.id, absolute);
			return absolute;
		};

		const useXhtml = i18nEnabled;
		const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
		lines.push(
			useXhtml
				? '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
				: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		);

		const writeUrl = async (entry: Entry, siblings: Entry[] | null) => {
			const loc = await resolveEntryUrl(entry);

			lines.push("  <url>");
			lines.push(`    <loc>${escapeXml(loc)}</loc>`);
			lines.push(`    <lastmod>${escapeXml(entry.updatedAt)}</lastmod>`);

			if (useXhtml && siblings && siblings.length > 1) {
				// Emit one xhtml:link per sibling (including self -- Google
				// recommends including the page's own hreflang annotation).
				for (const sib of siblings) {
					const sibLoc = await resolveEntryUrl(sib);
					lines.push(
						`    <xhtml:link rel="alternate" hreflang="${escapeXml(sib.locale)}" href="${escapeXml(sibLoc)}" />`,
					);
				}

				// x-default: prefer the default-locale sibling, otherwise
				// the first sibling (stable order: rows arrive sorted by
				// updated_at DESC from the handler).
				const xDefault =
					(i18nConfig && siblings.find((s) => s.locale === i18nConfig.defaultLocale)) ||
					siblings[0];
				if (xDefault) {
					const xLoc = await resolveEntryUrl(xDefault);
					lines.push(
						`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(xLoc)}" />`,
					);
				}
			}

			lines.push("  </url>");
		};

		for (const siblings of groups.values()) {
			for (const entry of siblings) {
				await writeUrl(entry, siblings);
			}
		}
		for (const entry of ungrouped) {
			await writeUrl(entry, null);
		}

		lines.push("</urlset>");

		return new Response(lines.join("\n"), {
			status: 200,
			headers: {
				"Content-Type": "application/xml; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		});
	} catch {
		return new Response("<!-- Internal error generating sitemap -->", {
			status: 500,
			headers: { "Content-Type": "application/xml" },
		});
	}
};

/** Escape special XML characters in a string */
function escapeXml(str: string): string {
	return str
		.replace(AMP_RE, "&amp;")
		.replace(LT_RE, "&lt;")
		.replace(GT_RE, "&gt;")
		.replace(QUOT_RE, "&quot;")
		.replace(APOS_RE, "&apos;");
}
