export const config = {
  maxDuration: 30
};

// ─── CORS HEADERS ──────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── SAFE NUMBER HELPERS ───────────────────────────────────────────────────
function safeNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = String(value ?? '').replace(/[^\d.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function extractPrices(text) {
  const matches = [...String(text || '').matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  return matches.filter((n) => Number.isFinite(n) && n > 0);
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function scoreOpportunity({ avgPrice = 0, bestCogs = 0, competitorCount = 0, query = '' }) {
  const marginPct = avgPrice > 0 ? Math.max(0, Math.round(((avgPrice - bestCogs) / avgPrice) * 100)) : 0;
  const demand = Math.min(95, 55 + Math.min(query.length, 20));
  const competition = Math.max(35, 80 - competitorCount * 6);
  const margin = Math.min(95, Math.max(25, marginPct));
  const total = Math.round(demand * 0.35 + competition * 0.25 + margin * 0.4);
  return { demand, competition, margin, total, marginPct };
}

function normalizeSerpOrganicResults(data) {
  return Array.isArray(data?.organic_results) ? data.organic_results : [];
}

function normalizeSerpShoppingResults(data) {
  return Array.isArray(data?.shopping_results) ? data.shopping_results : [];
}

// ─── SERPAPI REQUEST ───────────────────────────────────────────────────────
async function serpApiRequest(params, apiKey) {
  const url = new URL('https://serpapi.com/search.json');
  Object.entries({
    api_key: apiKey,
    gl: 'us',
    hl: 'en',
    google_domain: 'google.com',
    num: '10',
    ...params
  }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  let response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data.error) {
    const message = data?.error || text || `HTTP ${response.status}`;
    throw new Error(`SerpApi error: ${message}`);
  }

  return data;
}

async function serpGoogleSearch(query, apiKey, num = 8) {
  const data = await serpApiRequest({ engine: 'google', q: query, num }, apiKey);
  return normalizeSerpOrganicResults(data);
}

async function serpShoppingSearch(query, apiKey, num = 8) {
  const data = await serpApiRequest({ engine: 'google_shopping', q: query, num }, apiKey);
  return normalizeSerpShoppingResults(data);
}

function compactSearchItems(items) {
  return items.map((item) => ({
    title: item.title || '',
    link: item.link || item.product_link || '',
    snippet: item.snippet || item.extensions?.join(' • ') || item.source || '',
    source: hostname(item.link || item.product_link || '')
  }));
}

// ─── FALLBACK BUILDER ──────────────────────────────────────────────────────
function buildFallback(query, groups) {
  const demandItems = compactSearchItems(groups.demand || []);
  const productItems = compactSearchItems([...(groups.pricing || []), ...(groups.shopping || [])]);
  const supplierItems = compactSearchItems(groups.suppliers || []);
  const audienceItems = compactSearchItems(groups.audience || []);

  const allPrices = [
    ...productItems.flatMap((i) => extractPrices(`${i.title} ${i.snippet}`)),
    ...(groups.shopping || []).flatMap((item) => {
      const p = safeNumber(item.price, NaN);
      return Number.isFinite(p) && p > 0 ? [p] : [];
    })
  ];

  const supplierPrices = supplierItems.flatMap((i) => extractPrices(`${i.title} ${i.snippet}`));

  const avgPrice = allPrices.length
    ? Math.round((allPrices.reduce((a, b) => a + b, 0) / allPrices.length) * 100) / 100
    : 49;
  const lowPrice = allPrices.length ? Math.min(...allPrices) : Math.max(19, Math.round(avgPrice * 0.65));
  const highPrice = allPrices.length ? Math.max(...allPrices) : Math.round(avgPrice * 1.35);
  const bestCogs = supplierPrices.length
    ? Math.min(...supplierPrices)
    : Math.max(3, Math.round(avgPrice * 0.18));

  const competitors = demandItems.slice(0, 5).map((item, index) => ({
    rank: index + 1,
    brand: item.source || item.title.split(' - ')[0].slice(0, 36) || `Competitor ${index + 1}`,
    website: item.link,
    market_share_pct: Math.max(5, 28 - index * 3),
    avg_price: Math.max(lowPrice, Math.round(avgPrice + (index - 2) * 4)),
    strength_score: Math.max(5, 9 - index),
    weakness: 'Messaging appears broad and not tightly positioned around a single urgent buyer pain.',
    gap_opportunity: 'Sharper positioning, faster shipping promise, and stronger offer stack.',
    social_following: index === 0 ? 'High' : index <= 2 ? 'Medium' : 'Growing',
    founded_year: 2018 + index,
    key_products: [query]
  }));

  const products = productItems.slice(0, 8).map((item, index) => {
    const prices = extractPrices(`${item.title} ${item.snippet}`);
    const itemLow = prices.length ? Math.min(...prices) : lowPrice;
    const itemHigh = prices.length ? Math.max(...prices) : highPrice;
    const itemAvg =
      prices.length
        ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100
        : avgPrice;
    return {
      rank: index + 1,
      name: item.title.replace(/\s*[-|–].*$/, '').slice(0, 70) || `${query} option ${index + 1}`,
      brand: item.source || 'Market Source',
      platform: item.source.includes('amazon')
        ? 'amazon'
        : item.source.includes('etsy')
        ? 'etsy'
        : item.source.includes('walmart')
        ? 'walmart'
        : 'web',
      category: query,
      sku_type: /ebook|template|course|guide|digital/i.test(query) ? 'digital' : 'physical',
      avg_price: itemAvg,
      low_price: itemLow,
      high_price: itemHigh,
      units_sold_monthly: index === 0 ? 'High demand' : 'Active demand',
      rating: Math.max(4.1, 4.9 - index * 0.1),
      reviews: 250 + index * 90,
      trend: index < 3 ? 'hot' : 'rising',
      margin_pct:
        itemAvg > 0 ? Math.max(25, Math.round(((itemAvg - bestCogs) / itemAvg) * 100)) : 0,
      source_cost_est: bestCogs,
      why_hot:
        'Search results show repeated buyer intent, active listings, and clear problem-solution fit.'
    };
  });

  const suppliers = supplierItems.slice(0, 5).map((item, index) => {
    const prices = extractPrices(`${item.title} ${item.snippet}`);
    const cpu = prices.length ? Math.min(...prices) : Math.max(2, bestCogs + index);
    return {
      name: item.title.replace(/\s*[-|–].*$/, '').slice(0, 70) || `Supplier ${index + 1}`,
      platform: item.source || 'web',
      country: /usa|united states/i.test(item.snippet)
        ? 'United States'
        : /china/i.test(item.snippet)
        ? 'China'
        : 'Unknown',
      cost_per_unit: cpu,
      moq: index === 0 ? 'Low / flexible' : 'Varies',
      lead_time_days: index === 0 ? 5 : 7 + index,
      quality_rating: Math.max(3.8, 4.8 - index * 0.2),
      sample_available: true,
      certifications: [],
      notes: 'Verify true landed cost, shipping speed, and branding options before launch.'
    };
  });

  const { demand, competition, margin, total, marginPct } = scoreOpportunity({
    avgPrice,
    bestCogs,
    competitorCount: competitors.length,
    query
  });

  const nicheName = query.replace(/\b\w/g, (s) => s.toUpperCase());
  const productName = products[0]?.name || nicheName;
  const yourPrice = Math.max(9, Math.round(avgPrice * 0.88 * 100) / 100);
  const perceivedValue = Math.round(yourPrice * 2.4 * 100) / 100;

  return {
    query,
    scanned_at: new Date().toISOString(),
    debug: {
      data_source: 'serpapi',
      counts: {
        demand: demandItems.length,
        pricing: productItems.length,
        suppliers: supplierItems.length,
        audience: audienceItems.length
      }
    },
    niches: [
      {
        name: nicheName,
        industry: /ebook|template|course|guide|digital/i.test(query)
          ? 'Digital Products'
          : 'Consumer Products',
        type: /ebook|template|course|guide|digital/i.test(query) ? 'digital' : 'physical',
        monthly_searches: 'Search-backed demand detected',
        market_size_usd: Math.round(avgPrice * 1000),
        growth_rate_pct: 18,
        trend: 'rising',
        top_platforms: ['Google', 'Amazon', 'Etsy', 'Shopify'],
        real_competitors: competitors.map((c) => c.brand),
        avg_sell_price: avgPrice,
        demand_score: demand,
        competition_score: competition,
        margin_score: margin,
        opportunity_score: total,
        why_now:
          'Search results show active buyer intent, repeated listings, and room for a stronger offer.'
      }
    ],
    topNiche: null,
    products,
    competitors,
    suppliers,
    market_gap:
      'Most sellers compete on the product itself instead of packaging a stronger promise, bundle, and faster trust-building angle.',
    differentiation_angle:
      'Lead with the exact problem solved, tighten your niche message, and stack more perceived value than generic sellers.',
    best_cogs: bestCogs,
    recommended_supplier: suppliers[0]?.name || '',
    estimated_margin: marginPct,
    audience: {
      primary_demographic: /pregnan|maternity|baby/i.test(query)
        ? 'Expecting mothers and gift-buying partners'
        : 'Problem-aware shoppers actively searching for a direct solution',
      age_range: /pregnan|maternity|baby/i.test(query) ? '24-38' : '22-45',
      gender_split: /pregnan|maternity|baby/i.test(query) ? 'Mostly women, plus partners/family buyers' : 'Mixed',
      income_level: 'Middle income and above',
      core_pain: `They want a reliable solution for ${query} without wasting money on weak options.`,
      core_desire: 'A product or digital solution that feels proven, easy, and worth buying right now.',
      buying_trigger: 'Pain, urgency, convenience, trust, and a clear before/after transformation.',
      platforms: ['Google Search', 'YouTube', 'TikTok', 'Instagram'],
      content_they_consume: audienceItems.slice(0, 4).map((i) => i.title).filter(Boolean),
      buying_frequency: /digital|ebook|template|guide|course/i.test(query)
        ? 'As needed'
        : 'Triggered by life stage / recurring need',
      repeat_purchase: !/digital|ebook|template|guide|course/i.test(query)
    },
    market_insights: [
      'Search results show repeated commercial intent around this query.',
      'Pricing spreads suggest room for premium positioning or a stronger bundle.',
      'Supplier search results indicate possible margin if shipping and quality are validated.'
    ],
    ad_channels: ['Google Search', 'Meta Ads', 'TikTok', 'UGC Creators'],
    offer: {
      headline: `${nicheName} Offer Built Around Real Buyer Pain`,
      subheadline:
        'Use a stronger promise, clearer positioning, and a value stack that beats generic sellers on trust and transformation.',
      product_name: productName,
      your_price: yourPrice,
      market_price: avgPrice,
      perceived_value: perceivedValue,
      value_stack: [
        {
          item: productName,
          value: Math.round(avgPrice),
          description:
            'Core solution positioned around the exact problem your market is trying to solve.'
        },
        {
          item: 'Quick-start guide',
          value: 19,
          description: 'Helps buyers use the product faster and feel immediate progress.'
        },
        {
          item: 'Confidence guarantee',
          value: 29,
          description: 'Reduces hesitation and makes the offer feel safer to try.'
        }
      ],
      guarantee: 'Simple satisfaction promise with a clear support path.',
      cta: 'Launch this offer and test demand now',
      urgency_hook:
        'Position as a timely, high-clarity solution for people already searching right now.',
      pricing_angle:
        'Anchor against the market average, then justify your price with the full transformation stack.',
      target_roas: 2.5
    },
    launch: {
      platform: 'Shopify or landing page funnel',
      ad_format: 'UGC video + product page + retargeting',
      target_audience: 'High-intent searchers and problem-aware social audiences',
      content_angle: 'Show the pain, show the fix, show why your version is the smart buy.',
      first_month_goal: 'Validate one winning angle, one headline, and one offer stack.',
      kpis: ['CTR', 'CPC', 'Add-to-cart rate', 'Conversion rate', 'Gross margin'],
      outreach_message:
        'We are evaluating fulfillment partners for a fast-moving offer. Can you confirm landed cost, sample availability, branding options, and average delivery time?'
    },
    projection: {
      break_even_units:
        avgPrice > bestCogs
          ? Math.max(10, Math.round(250 / Math.max(1, avgPrice - bestCogs)))
          : 25,
      month1_revenue: Math.round(yourPrice * 50),
      month3_revenue: Math.round(yourPrice * 180),
      year1_revenue: Math.round(yourPrice * 1200),
      margin_pct: marginPct
    },
    sources: {
      demand: demandItems,
      pricing: productItems,
      suppliers: supplierItems,
      audience: audienceItems
    }
  };
}

// ─── ANTHROPIC ENRICHMENT ──────────────────────────────────────────────────
async function enrichWithAnthropic(payload, apiKey) {
  const sourceDigest = JSON.stringify(payload.sources).slice(0, 80000);
  const prompt = `You are a market-intelligence analyst. Convert the live search findings below into strict JSON for a dashboard. Keep competitor and supplier names grounded in the provided sources. If exact values are uncertain, estimate conservatively and keep claims modest. Return ONLY valid JSON — no markdown fences, no extra text — with this exact shape:
{"niches":[{"name":"","industry":"","type":"physical_or_digital","monthly_searches":"","market_size_usd":0,"growth_rate_pct":0,"trend":"rising","top_platforms":[],"real_competitors":[],"avg_sell_price":0,"demand_score":0,"competition_score":0,"margin_score":0,"opportunity_score":0,"why_now":""}],"products":[{"rank":1,"name":"","brand":"","platform":"","category":"","sku_type":"physical_or_digital","avg_price":0,"low_price":0,"high_price":0,"units_sold_monthly":"","rating":0,"reviews":0,"trend":"rising","margin_pct":0,"source_cost_est":0,"why_hot":""}],"competitors":[{"rank":1,"brand":"","website":"","market_share_pct":0,"avg_price":0,"strength_score":0,"weakness":"","gap_opportunity":"","social_following":"","founded_year":0,"key_products":[]}],"suppliers":[{"name":"","platform":"","country":"","cost_per_unit":0,"moq":"","lead_time_days":0,"quality_rating":0,"sample_available":true,"certifications":[],"notes":""}],"market_gap":"","differentiation_angle":"","best_cogs":0,"recommended_supplier":"","estimated_margin":0,"audience":{"primary_demographic":"","age_range":"","gender_split":"","income_level":"","core_pain":"","core_desire":"","buying_trigger":"","platforms":[],"content_they_consume":[],"buying_frequency":"","repeat_purchase":true},"market_insights":[],"ad_channels":[],"offer":{"headline":"","subheadline":"","product_name":"","your_price":0,"market_price":0,"perceived_value":0,"value_stack":[{"item":"","value":0,"description":""}],"guarantee":"","cta":"","urgency_hook":"","pricing_angle":"","target_roas":0},"launch":{"platform":"","ad_format":"","target_audience":"","content_angle":"","first_month_goal":"","kpis":[],"outreach_message":""},"projection":{"break_even_units":0,"month1_revenue":0,"month3_revenue":0,"year1_revenue":0,"margin_pct":0}}

User query: ${payload.query}

Live sources:
${sourceDigest}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic enrichment failed (${response.status}): ${text.slice(0, 180)}`);
  }

  const data = await response.json();
  const rawText = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Strip any accidental markdown fences
  const clean = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const parsed = JSON.parse(clean);
  parsed.query = payload.query;
  parsed.scanned_at = new Date().toISOString();
  parsed.topNiche = parsed.topNiche || (parsed.niches && parsed.niches[0]) || null;
  parsed.sources = payload.sources;
  return parsed;
}

// ─── HANDLER ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    // ── Parse body safely (handles both auto-parsed and raw string bodies) ──
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    if (!body || typeof body !== 'object') body = {};

    const query = String(body.query || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Missing query. Send { "query": "your market" }.' });
    }

    // ── Check SERPAPI key ──
    const serpApiKey = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
    if (!serpApiKey) {
      return res.status(500).json({
        error: 'Missing SERPAPI_KEY environment variable. Add it in your Vercel project settings under Environment Variables.'
      });
    }

    // ── Run all 5 SerpAPI searches in parallel ──
    const [demand, pricing, shopping, suppliers, audience] = await Promise.all([
      serpGoogleSearch(`${query} demand trends buyers best selling`, serpApiKey, 8).catch(() => []),
      serpGoogleSearch(`${query} price buy online best seller`, serpApiKey, 8).catch(() => []),
      serpShoppingSearch(query, serpApiKey, 8).catch(() => []),
      serpGoogleSearch(`${query} wholesale supplier manufacturer bulk`, serpApiKey, 8).catch(() => []),
      serpGoogleSearch(`${query} buyer pain points audience who buys`, serpApiKey, 8).catch(() => [])
    ]);

    // ── Build fallback (always works, no AI needed) ──
    const fallback = buildFallback(query, { demand, pricing, shopping, suppliers, audience });
    fallback.topNiche = fallback.niches[0] || null;

    // ── Optionally enrich with Anthropic ──
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      // Return SerpAPI-only data — still useful
      return res.status(200).json(fallback);
    }

    try {
      const enriched = await enrichWithAnthropic(fallback, anthropicApiKey);
      if (!enriched.topNiche && enriched.niches?.length) {
        enriched.topNiche = enriched.niches[0];
      }
      return res.status(200).json(enriched);
    } catch (enrichError) {
      // Anthropic failed — return SerpAPI data with a warning
      console.error('Anthropic enrichment error:', enrichError.message);
      return res.status(200).json({
        ...fallback,
        enrichment_warning: enrichError.message
      });
    }
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}
