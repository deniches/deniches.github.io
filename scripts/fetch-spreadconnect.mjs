#!/usr/bin/env node
/**
 * Sync your Spreadconnect (SPOD) articles into data/spreadconnect.json.
 *
 * WHY THIS EXISTS
 * The Spreadconnect API requires a secret access token (X-SPOD-ACCESS-TOKEN
 * header). Spreadconnect's own documentation is explicit that this token
 * must stay secret and must never be exposed publicly (e.g. committed to
 * GitHub, or embedded in client-side JS on a public site).
 * This script runs server-side (locally, in a GitHub Action, or in n8n),
 * calls the API with the token, and writes a plain, public-safe JSON file
 * that index.html can fetch — exactly like data/products.json already does
 * for the Amazon catalog.
 *
 * REQUIRED ENV VAR
 *   SPOD_ACCESS_TOKEN   Your secret Spreadconnect API token.
 *                        Get/rotate it in the Spreadconnect App under
 *                        Integrations > Spreadconnect API.
 *
 * OPTIONAL ENV VARS
 *   SPOD_BASE_URL   Default: https://rest.spod.com
 *                   Use https://rest.spod-staging.com to test against the
 *                   staging environment. Double-check the exact production
 *                   URL shown in your Spreadconnect App > Integrations
 *                   screen — Spreadconnect has changed domains before.
 *   SPOD_STORE_URL  Base URL of your own public storefront, if you have one
 *                   (e.g. a Spreadshop/Shopify shop), used to build a
 *                   "View product" link: {SPOD_STORE_URL}/products/{id}.
 *                   Leave unset if you don't have a public product page yet:
 *                   the site will show "Coming soon" instead of a dead link.
 *   SPOD_CURRENCY   Display currency code shown next to prices. Default: EUR.
 *
 * USAGE
 *   SPOD_ACCESS_TOKEN=xxxxx node scripts/fetch-spreadconnect.mjs
 *
 * Requires Node.js 18+ (uses the built-in fetch).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.SPOD_ACCESS_TOKEN;
const BASE_URL = (process.env.SPOD_BASE_URL || 'https://rest.spod.com').replace(/\/$/, '');
const STORE_URL = (process.env.SPOD_STORE_URL || '').replace(/\/$/, '');
const CURRENCY = process.env.SPOD_CURRENCY || 'EUR';
const OUTPUT_PATH = path.join(process.cwd(), 'data', 'spreadconnect.json');

if (!TOKEN) {
  console.error(
    'Missing SPOD_ACCESS_TOKEN environment variable.\n' +
    'Set it as a secret (GitHub Actions secret, n8n credential, local .env) — never hardcode it in source files.'
  );
  process.exit(1);
}

async function fetchAllArticles() {
  const limit = 50;
  let offset = 0;
  let all = [];

  while (true) {
    const url = `${BASE_URL}/articles?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { 'X-SPOD-ACCESS-TOKEN': TOKEN } });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Spreadconnect API error ${res.status} on ${url}: ${body}`);
    }

    const payload = await res.json();
    const items = payload.items || [];
    all = all.concat(items);
    offset += items.length;

    const noMorePages = items.length < limit || (typeof payload.count === 'number' && offset >= payload.count);
    if (noMorePages) break;
  }

  return all;
}

function pickImage(article) {
  const images = article.images || [];
  const front = images.find((img) => img.perspective === 'FRONT');
  return (front || images[0] || {}).imageUrl || null;
}

function priceRange(article) {
  const prices = (article.variants || [])
    .map((v) => v.d2cPrice)
    .filter((p) => typeof p === 'number');
  if (prices.length === 0) return { priceMin: null, priceMax: null };
  return { priceMin: Math.min(...prices), priceMax: Math.max(...prices) };
}

function countDistinct(article, key) {
  const values = (article.variants || []).map((v) => v[key]).filter((v) => v !== undefined && v !== null);
  return new Set(values).size;
}

function buildUrl(article) {
  if (!STORE_URL) return null;
  return `${STORE_URL}/products/${article.id}`;
}

async function main() {
  console.log(`Fetching Spreadconnect articles from ${BASE_URL} ...`);
  const articles = await fetchAllArticles();
  console.log(`Fetched ${articles.length} article(s).`);

  const products = articles.map((a) => {
    const { priceMin, priceMax } = priceRange(a);
    return {
      id: a.id,
      title: a.title || null,
      image: pickImage(a),
      priceMin,
      priceMax,
      currency: CURRENCY,
      colors: countDistinct(a, 'appearanceId'),
      sizes: countDistinct(a, 'sizeId'),
      url: buildUrl(a),
    };
  });

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(products, null, 2), 'utf-8');
  console.log(`Wrote ${products.length} product(s) to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
