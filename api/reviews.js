// Vercel Serverless Function: /api/reviews
// Resolves the Gospel Detailing place by name/address via Places API Text
// Search (no manual Place ID hunting required), then fetches Place Details
// (reviews + rating). The whole result is cached at the CDN edge so we call
// Google roughly once per cache window, not once per site visitor.
//
// Required environment variable (Vercel Project Settings -> Environment Variables):
//   GOOGLE_PLACES_API_KEY  - API key restricted to Places API (New)
//
// Optional:
//   GOOGLE_PLACE_ID    - if you already have a confirmed valid Place ID
//                         (starts with "ChIJ"), set this to skip the text
//                         search step entirely.
//   GOOGLE_PLACE_QUERY - override the default search text below.

// Gospel Detailing LLC is a Service-Area Business (mobile detailing, no
// storefront) -- confirmed on Google Maps: 5.0 stars, 7 reviews, "Car
// detailing service", no public street address shown on the listing card.
// SABs don't get a precise public pin, which is why coordinate-based Nearby
// Search can never reliably find them (there's no fixed point to search
// around). Text Search by name is the only approach that doesn't depend on
// a pin, so it's tried first here, with several query phrasings in case one
// wording doesn't match Google's Places index for this listing.
const TEXT_QUERIES = [
  'Gospel Detailing LLC, McDonough, GA',
  'Gospel Detailing McDonough Georgia',
  'Gospel Detailing LLC McDonough',
];
// Approximate coordinates from the GBP listing's service-area center, kept
// only as a last-resort fallback -- not reliable for an SAB (see above).
const BUSINESS_LAT = 33.326237;
const BUSINESS_LNG = -84.190745;
const NAME_MATCH = 'gospel';

async function searchNearby(apiKey) {
  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName',
    },
    body: JSON.stringify({
      locationRestriction: {
        circle: {
          center: { latitude: BUSINESS_LAT, longitude: BUSINESS_LNG },
          radius: 500.0,
        },
      },
      maxResultCount: 20,
    }),
  });

  const raw = await response.text();
  if (!response.ok) throw new Error('nearby search HTTP ' + response.status + ': ' + raw);

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('nearby search returned non-JSON: ' + raw.slice(0, 300));
  }

  const places = data.places || [];
  const match = places.find((p) => (p.displayName?.text || '').toLowerCase().includes(NAME_MATCH));
  if (match) return match.id;
  if (places.length === 1) return places[0].id;

  const names = places.map((p) => p.displayName?.text).join(', ');
  throw new Error(
    'nearby search found ' + places.length + ' place(s) near the business coordinates, none named "Gospel...": ' + (names || '(none)')
  );
}

async function searchTextOnce(apiKey, query) {
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify({
      textQuery: query,
      regionCode: 'US',
      languageCode: 'en',
      maxResultCount: 5,
    }),
  });

  const raw = await response.text();
  if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + raw);

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('non-JSON response: ' + raw.slice(0, 200));
  }

  const places = data.places || [];
  if (places.length === 0) throw new Error('no results (raw: ' + raw.slice(0, 100) + ')');

  // Google's text search can return a confident top match for a totally
  // different, unrelated business (this bit us once: a generic query
  // returned "PHNX Auto Detailing" as result #1 with zero relation to
  // Gospel Detailing). Never trust position -- only accept a result whose
  // name actually contains "gospel".
  const match = places.find((p) => (p.displayName?.text || '').toLowerCase().includes(NAME_MATCH));
  if (!match) {
    const names = places.map((p) => p.displayName?.text).join(', ');
    throw new Error('top results did not include a "Gospel..." match: ' + names);
  }
  return match.id;
}

async function searchText(apiKey) {
  const queries = process.env.GOOGLE_PLACE_QUERY ? [process.env.GOOGLE_PLACE_QUERY] : TEXT_QUERIES;
  const attempts = [];
  for (const query of queries) {
    try {
      return await searchTextOnce(apiKey, query);
    } catch (e) {
      attempts.push('"' + query + '": ' + e.message);
    }
  }
  throw new Error('all text search queries failed -- ' + attempts.join(' | '));
}

async function resolvePlaceId(apiKey) {
  const explicit = process.env.GOOGLE_PLACE_ID;
  if (explicit && explicit.startsWith('ChIJ')) return explicit;

  try {
    return await searchText(apiKey);
  } catch (textErr) {
    try {
      return await searchNearby(apiKey);
    } catch (nearbyErr) {
      throw new Error('Text search failed: ' + textErr.message + ' | Nearby search failed: ' + nearbyErr.message);
    }
  }
}

export default async function handler(req, res) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    res.status(200).json({ configured: false, rating: null, total: 0, reviews: [] });
    return;
  }

  try {
    const placeId = await resolvePlaceId(apiKey);

    const url = `https://places.googleapis.com/v1/places/${placeId}`;
    const response = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'displayName,rating,userRatingCount,reviews,googleMapsUri',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(200).json({ configured: true, error: true, detail: errText, rating: null, total: 0, reviews: [] });
      return;
    }

    const data = await response.json();

    // Final safety net: never publish reviews for a place that isn't
    // actually named "Gospel...", no matter how it was resolved.
    const resolvedName = data.displayName?.text || '';
    if (!resolvedName.toLowerCase().includes(NAME_MATCH)) {
      res.status(200).json({
        configured: true,
        error: true,
        detail: 'Resolved place "' + resolvedName + '" does not match Gospel Detailing -- refusing to publish its reviews.',
        rating: null,
        total: 0,
        reviews: [],
      });
      return;
    }

    const reviews = (data.reviews || []).map((r) => ({
      author: r.authorAttribution?.displayName || 'Google User',
      photo: r.authorAttribution?.photoUri || null,
      rating: r.rating || null,
      text: r.text?.text || '',
      relativeTime: r.relativePublishTimeDescription || '',
      time: r.publishTime || null,
    }));

    // Cache at the edge for 6 hours; serve stale for up to 24h while revalidating.
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({
      configured: true,
      placeName: data.displayName?.text || null,
      rating: data.rating || null,
      total: data.userRatingCount || 0,
      mapsUrl: data.googleMapsUri || null,
      reviews,
    });
  } catch (err) {
    res.status(200).json({ configured: true, error: true, detail: String(err), rating: null, total: 0, reviews: [] });
  }
}
